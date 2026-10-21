import type { Event } from '../continuity/sources.js';
import type { ProjectStore } from '../continuity/store.js';
import { Ledger, digest, ensure, bounded } from './ledger.js';
import { checkHash, requirementsHash, workbenchFor, safeText } from './state.js';
import type { Evidence } from './state.js';

type Receipt = { sessionId: string; callId: string; toolName: string; contentHash: string; observedAt: string; outcome: Evidence['outcome']; checks: { checkId: string; preparationHash: string; baselineValid: boolean }[] };
const receiptsFor = (store: ProjectStore) => new Ledger<{ receipts: Receipt[] }>(store.directory, 'receipts.json', store.projectId, () => ({ receipts: [] }), data => {
  ensure(Array.isArray(data.receipts) && data.receipts.length <= 128, 'Invalid receipts.');
  for (const r of data.receipts) ensure(typeof r.sessionId === 'string' && typeof r.callId === 'string' && /^[a-f0-9]{64}$/.test(r.contentHash) && ['passed', 'failed', 'unknown'].includes(r.outcome) && Array.isArray(r.checks), 'Invalid execution receipt.');
}, store.storageRoot);
export function executionOutcome(name: string, result: any): Evidence['outcome'] {
  if (result?.isError === true) return ['TOOL_OUTCOME_UNKNOWN', 'TOOL_NOT_STARTED', 'ABORTED_BEFORE_DISPATCH'].includes(result.error?.info?.code) ? 'unknown' : 'failed';
  const v = result?.value;
  if (name !== 'bash' || result?.isError !== false || v?.kind !== 'foreground') return 'unknown';
  if (v.timedOut || v.aborted || v.signal || v.sandbox?.denied || v.sandbox?.runnerFailed || v.stopped) return 'failed';
  return Number.isInteger(v.exitCode) ? v.exitCode === 0 ? 'passed' : 'failed' : 'unknown';
}
export class EvidenceObserver {
  private pending = new Map<string, Promise<unknown>>();
  private queues = new Map<string, Promise<unknown>>();
  constructor(readonly storeFor: (agent: any) => Promise<ProjectStore>) {}
  observe(exec: any, result: any) {
    if (!exec.agent || exec.name?.startsWith('vibeguide_')) return;
    const key = `${exec.agent.session.id}:${exec.callId}`;
    // The host does not await observational hooks. Install the pending promise synchronously.
    const promise = this.capture(exec, result).catch(() => undefined);
    this.pending.set(key, promise);
    void promise.finally(() => { if (this.pending.get(key) === promise) this.pending.delete(key); });
  }
  private async capture(exec: any, result: any) {
    const store = await this.storeFor(exec.agent), book = await workbenchFor(store).read();
    const preparations = book.data.preparations.filter(p => p.sessionId === exec.agent.session.id && Date.now() - Date.parse(p.startedAt) < 60 * 60 * 1000);
    if (!preparations.length) return;
    const record = await store.read();
    const receipt: Receipt = { sessionId: exec.agent.session.id, callId: exec.callId, toolName: exec.name, contentHash: digest(result.content), observedAt: new Date().toISOString(), outcome: executionOutcome(exec.name, result), checks: [] };
    for (const p of preparations) {
      const check = book.data.checks.find(c => c.id === p.checkId);
      let valid = !!check && checkHash(check) === p.checkHash && requirementsHash(record, check.requirementIds) === p.requirementsHash;
      for (const f of p.files) { try { valid &&= (await store.stamp(f.path)).sha256 === f.sha256; } catch { valid = false; } }
      receipt.checks.push({ checkId: p.checkId, preparationHash: digest(p), baselineValid: valid });
    }
    const previous = this.queues.get(store.projectId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      const ledger = receiptsFor(store), latest = await ledger.read();
      return ledger.update(latest.revision, digest({ session: receipt.sessionId, call: receipt.callId }), receipt, data => {
        data.receipts = [...data.receipts.filter(r => !(r.sessionId === receipt.sessionId && r.callId === receipt.callId)), receipt].slice(-128);
      });
    });
    this.queues.set(store.projectId, next); await next;
    if (this.queues.get(store.projectId) === next) this.queues.delete(store.projectId);
  }
  async bind(store: ProjectStore, sessionId: string, events: Event[], seq: number, checkId: string, quote: string) {
    bounded(quote, 1000);
    const event = events.find(e => e.seq === seq), message = event?.data?.message;
    ensure(event?.type === 'tool/result' && (event as any).surfaceOp === 'append' && message?.role === 'tool' && message?.source?.kind === 'tool' && message.toolCallId === message.source.callId, 'Evidence must reference a native direct tool result, not assistant text or pasted logs.');
    const calls = events.filter(e => e.seq < seq && e.type === 'tool/call' && e.data?.callId === message.toolCallId);
    ensure(calls.length === 1 && event.sourceEventSeqs?.includes(calls[0]!.seq), 'Tool result is not linked to exactly one native call.');
    const content = (message.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
    ensure(content.includes(quote), 'Evidence excerpt must occur verbatim in the native tool result.');
    await this.pending.get(`${sessionId}:${message.toolCallId}`);
    const receipt = (await receiptsFor(store).read()).data.receipts.find(r => r.sessionId === sessionId && r.callId === message.toolCallId);
    ensure(receipt && receipt.toolName === calls[0]!.data.name && receipt.contentHash === digest(message.content), 'No matching captured execution receipt. Prepare and rerun the check; historical text alone cannot establish success.');
    const book = await workbenchFor(store).read();
    const preparation = book.data.preparations.find(p => p.checkId === checkId && p.sessionId === sessionId);
    const snapshot = receipt.checks.find(c => c.checkId === checkId);
    ensure(preparation && snapshot && snapshot.preparationHash === digest(preparation) && calls[0]!.seq > preparation.afterSeq, 'Result is outside the prepared check.');
    let command = '此工具没有可公开保存的 shell 命令；查阅原生调用。';
    try { const args = JSON.parse(calls[0]!.data.arguments); safeText(args.command); command = args.command; } catch { /* No credential-bearing or oversized arguments enter memory. */ }
    return { sessionId, seq, callId: receipt.callId, toolName: receipt.toolName, resultHash: receipt.contentHash, invocationHash: digest(calls[0]!.data.arguments), command, quote, outcome: receipt.outcome, observedAt: receipt.observedAt,
      files: preparation.files, requirementsHash: preparation.requirementsHash, checkHash: preparation.checkHash, baselineValid: snapshot.baselineValid };
  }
}
