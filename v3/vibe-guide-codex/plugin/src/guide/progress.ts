import type { Activity, Explanation, FileBasis, Operation, Progress, Scope, GuideSnapshot } from './contracts.js';
import { GuideError } from './contracts.js';
import { captureFiles, changedFiles, hash } from './files.js';
import { GuideStore } from './store.js';
import type { EventJob, GuideRecord } from './store.js';
import { realpath } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { projectEvidence } from './project-scan.js';
import type { ProjectEvidence } from './project-scan.js';
import { executionOrigin } from './host/lineage.js';
import { isRequirement } from './intent.js';
import { redact } from './privacy.js';

export type NativeEvent = { seq: number; type: string; time?: number; data?: any; sourceEventSeqs?: number[]; surfaceOp?: string };
type Start = { scope: Scope; root: string; operation: Operation; before?: FileBasis; snippets?: ProjectEvidence['snippets']; peerRevision: number; executionRootMatches: boolean };
type Active = { scope: Scope; kind: Operation['kind'] };
const now = () => new Date().toISOString();
const eventTime = (event: NativeEvent) => Number.isFinite(event.time) ? new Date(event.time!).toISOString() : '时间未知';
const parseArgs = (args: unknown): Record<string, unknown> => {
  try { const v = typeof args === 'string' ? JSON.parse(args) : args; return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; }
};

/** Deliberately narrow: compound commands, arbitrary scripts and stdout are not test evidence. */
export function classifyTool(tool: string, args: unknown): Operation['kind'] {
  const input = parseArgs(args);
  if (tool === 'ask_user_question') return 'wait';
  if (['read', 'read_image', 'glob', 'grep', 'list_directory', 'search'].includes(tool)) return 'read';
  if (['edit', 'write', 'apply_patch'].includes(tool)) return 'edit';
  if (tool === 'str_replace_editor') return input.command === 'view' ? 'read'
    : ['create', 'str_replace', 'insert'].includes(String(input.command)) ? 'edit' : 'other';
  if (tool === 'bash' && typeof input.command === 'string') {
    const cmd = input.command.trim();
    if (/^(?:(?:npm|pnpm|yarn)\s+(?:test|run\s+(?:test|check|typecheck|lint|build)(?::[\w-]+)?)|node\s+--test|(?:python3?\s+-m\s+)?pytest|cargo\s+(?:test|check)|go\s+test)(?:\s+[\w./=:@-]+)*$/.test(cmd)) return 'check';
  }
  return 'other';
}
function operation(event: NativeEvent, id: string, name: string, args: unknown): Operation {
  return { id, tool: name.slice(0, 120), kind: classifyTool(name, args), startedAt: eventTime(event), callSeq: event.seq,
    outcome: 'pending', changedFiles: [], applicability: 'unknown' };
}
function jobFor(event: NativeEvent, calls: Map<string, NativeEvent>, scope: Scope, events: NativeEvent[]): EventJob {
  const job: EventJob = { seq: event.seq, fingerprint: hash(event), time: eventTime(event) };
  const data = event.data;
  if (event.type === 'tool/call' && typeof data?.callId === 'string' && typeof data.name === 'string') {
    job.operation = operation(event, data.callId, data.name, data.arguments);
    job.operation.origin = executionOrigin(events, data.callId);
  } else if (event.type === 'tool/result') {
    const m = data?.message, call = calls.get(m?.toolCallId);
    if (event.surfaceOp === 'append' && m?.role === 'tool' && m.source?.kind === 'tool'
      && m.toolCallId === m.source.callId && call && event.sourceEventSeqs?.includes(call.seq)) {
      job.result = { id: m.toolCallId, failed: m.isError === true, contentHash: hash(m.content) };
    }
  } else if (event.type === 'tool/ptc-dispatch' && typeof data?.subCallId === 'string' && typeof data.name === 'string') {
    // Nested tools have their own authoritative hook receipt. Never use the outer run_code success.
    job.operation = operation(event, data.subCallId, data.name, data.arguments);
    job.result = { id: data.subCallId, failed: data.isError === true, contentHash: hash(data.content) };
  }
  if (event.type === 'user/message' && event.surfaceOp === 'append' && data?.source?.kind === 'user') {
    const content = Array.isArray(data.content) ? data.content.filter((part: any) => part?.type === 'text' && typeof part.text === 'string').map((part: any) => part.text).join('\n') : '';
    const stub = { choices: [], basis: 'original-user-input' } as unknown as GuideSnapshot;
    if (content.trim() && content.length <= 12000 && isRequirement(content, stub)) job.requirement = {
      id: `rq-${hash({ scope, seq: event.seq, messageId: data.id ?? null })}`, scope, text: content, createdAt: eventTime(event),
      source: { sessionId: scope.sessionId, seq: event.seq }, nativeMessageId: data.id, rpcId: data.source.rpcId,
    };
  }
  return job;
}
function applyJobs(record: GuideRecord) {
  for (const job of record.jobs) {
    if (job.seq <= record.completed) continue;
    if (job.operation) {
      const existing = record.operations.find(op => op.id === job.operation!.id);
      if (!existing) record.operations.push(job.operation);
      else { existing.callSeq = job.operation.callSeq; existing.origin ??= job.operation.origin; }
    }
    if (job.requirement && !record.requirements.some(row => row.id === job.requirement!.id)) record.requirements.push(job.requirement);
    if (job.result) {
      const op = record.operations.find(row => row.id === job.result!.id);
      if (op) {
        op.resultSeq = job.seq; op.endedAt ??= job.time;
        if (!op.receiptHash) op.outcome = job.result.failed ? 'failed' : op.kind === 'check' ? 'unknown' : 'succeeded';
        else if (op.receiptHash !== job.result.contentHash) { op.outcome = 'unknown'; op.applicability = 'unknown'; }
      }
    }
    record.completed = job.seq; record.anchor = job.fingerprint;
  }
  record.jobs = [];
}

export class ProgressTracker {
  private active = new Map<string, Active>();
  private mutationRevision = new Map<string, number>();
  private errors = new Map<string, string>();
  private scans = new Map<string, { at: number; value: Promise<FileBasis> }>();
  private lanes = new Map<string, Promise<unknown>>();
  constructor(readonly store: GuideStore) {}
  private key(scope: Scope, callId: string) { return hash({ scope, callId }); }
  noteError(sessionId: string, error: unknown) {
    this.errors.set(sessionId, error instanceof GuideError ? error.message : '部分操作未能记录，当前进展可能不完整。');
  }
  private scan(root: string, fresh = false) {
    const cached = this.scans.get(root);
    if (!fresh && cached && performance.now() - cached.at < 1500) return cached.value;
    const value = captureFiles(root, 120, [dirname(this.store.directory)]); this.scans.set(root, { at: performance.now(), value });
    if (this.scans.size > 32) this.scans.delete(this.scans.keys().next().value!);
    return value;
  }
  async begin(scope: Scope, root: string, exec: any, origin?: Operation['origin']): Promise<Start> {
    const kind = classifyTool(exec.name, exec.arguments), key = this.key(scope, exec.callId);
    this.active.set(key, { scope, kind });
    if (kind === 'edit' || kind === 'other') this.mutationRevision.set(scope.projectId, (this.mutationRevision.get(scope.projectId) ?? 0) + 1);
    const op: Operation = { id: String(exec.callId), kind, tool: String(exec.name).slice(0, 120), startedAt: now(),
      outcome: 'pending', changedFiles: [], applicability: 'unknown', origin,
      checkKey: hash({ tool:exec.name, command:exec.arguments?.command, target:exec.arguments?.path ?? exec.arguments?.file_path ?? exec.arguments?.url, cwd:exec.arguments?.cwd ?? root, ...(kind==='check'?{}:{args:exec.arguments}) }),
      label: redact(String(exec.arguments?.description ?? exec.arguments?.command ?? exec.name)).slice(0, 600) };
    let executionRootMatches = true;
    if (typeof exec.arguments?.cwd === 'string') {
      try { executionRootMatches = await realpath(resolve(root, exec.arguments.cwd)) === root; } catch { executionRootMatches = false; }
    }
    const peerRevision = this.mutationRevision.get(scope.projectId) ?? 0;
    const before = kind === 'read' || kind === 'wait' ? undefined : await this.scan(root, true);
    if (before) { op.baseline = before; op.beforeDigest = before.digest; }
    const snippets = before && (kind === 'edit' || kind === 'other') ? (await projectEvidence(root, [dirname(this.store.directory)], new AbortController().signal, { basis: before })).snippets : undefined;
    await this.store.update(scope, value => {
      if (value.operations.some(row => row.id === op.id && row.endedAt)) throw new GuideError('duplicate_execution', '操作标识已存在，本次记录需要核对。');
      const existing = value.operations.findIndex(row => row.id === op.id);
      if (existing < 0) value.operations.push(op); else value.operations[existing] = { ...op, callSeq: value.operations[existing].callSeq };
    });
    return { scope, root, operation: op, before, snippets, peerRevision, executionRootMatches };
  }
  async finish(start: Start, result: any) {
    const { scope, operation: op } = start;
    try {
      const after = start.before ? await this.scan(start.root, true) : undefined;
      const code = result?.value?.exitCode;
      const interrupted = result?.value?.timedOut || result?.value?.aborted || result?.value?.signal || result?.value?.stopped
        || result?.value?.sandbox?.denied || result?.value?.sandbox?.runnerFailed;
      const nativeExit = op.tool === 'bash' && result?.isError === false && result.value?.kind === 'foreground' && Number.isInteger(code);
      const unknownError = ['TOOL_OUTCOME_UNKNOWN', 'TOOL_NOT_STARTED', 'ABORTED_BEFORE_DISPATCH'].includes(result?.error?.info?.code);
      const outcome = result?.isError === true ? unknownError ? 'unknown' : 'failed'
        : nativeExit ? interrupted || code !== 0 ? 'failed' : 'succeeded'
        : op.kind === 'check' ? 'unknown' : result?.isError === false ? 'succeeded' : 'unknown';
      const overlapping = start.peerRevision !== (this.mutationRevision.get(scope.projectId) ?? 0)
        || [...this.active.entries()].some(([key, active]) => key !== this.key(scope, op.id) && active.scope.projectId === scope.projectId && ['edit', 'other'].includes(active.kind));
      const changed = start.before && after ? changedFiles(start.before, after) : [];
      const afterSnippets = after && changed.length ? (await projectEvidence(start.root, [dirname(this.store.directory)], new AbortController().signal, { basis: after, only: changed })).snippets : [];
      const sourceChanges = changed.slice(0, 8).flatMap(file => {
        const a = start.snippets?.find(row => row.file === file), b = afterSnippets.find(row => row.file === file);
        const added = start.before?.complete && !(file in start.before.files), deleted = after?.complete && !(file in after.files);
        if ((!a && !added) || (!b && !deleted)) return [];
        return [{ file, before: a?.excerpt ?? '', after: b?.excerpt ?? '', complete: !(a?.clipped || b?.clipped) }];
      });
      await this.store.update(scope, value => {
        const saved = value.operations.find(row => row.id === op.id);
        if (!saved) throw new Error('Missing execution baseline.');
        Object.assign(saved, { endedAt: now(), outcome, receiptHash: hash(result?.content),
          ...(nativeExit ? { exitCode: code } : {}),
          ...(outcome === 'failed' ? { diagnostic: redact(Array.isArray(result?.content) ? result.content.filter((part: any) => part?.type === 'text' && typeof part.text === 'string').map((part: any) => part.text).join('\n') : '').slice(0, 2000) } : {}),
          changedFiles: changed, sourceChanges, afterFiles: after ? Object.fromEntries(changed.map(file => [file, after.files[file] ?? null])) : undefined,
          changeOwnership: !overlapping && start.executionRootMatches && start.before?.complete && after?.complete ? 'exclusive' : 'unknown',
          afterDigest: after?.digest,
          applicability: !start.executionRootMatches || overlapping || !start.before?.complete || !after?.complete ? 'unknown'
            : start.before.digest === after.digest ? 'unchanged' : 'changed' });
      });
    } finally { this.active.delete(this.key(scope, op.id)); }
  }
  abandon(scope: Scope, callId: string) { this.active.delete(this.key(scope, callId)); }

  /** Durable registration precedes processing; a crash between the writes replays the same jobs. */
  private async sync(scope: Scope, events: NativeEvent[], throughSeq: number, segmentStart: number) {
    const id = hash(scope), previous = this.lanes.get(id) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(async () => {
      let record = await this.store.read(scope);
      if (record.jobs.length) record = await this.store.update(scope, applyJobs);
      const anchor = events.find(event => event.seq === record.completed);
      if (anchor && record.anchor && hash(anchor) !== record.anchor) throw new GuideError('history_changed', '主对话历史已变化，已有记录需重新核对。');
      const applicable = events.filter(event => event.seq >= segmentStart);
      const calls = new Map<string, NativeEvent>();
      const duplicateCalls = new Set<string>();
      for (const event of applicable) if (event.type === 'tool/call' && typeof event.data?.callId === 'string') {
        if (calls.has(event.data.callId)) duplicateCalls.add(event.data.callId);
        else calls.set(event.data.callId, event);
      }
      for (const id of duplicateCalls) calls.delete(id);
      const pending = applicable.filter(event => event.seq > record.completed);
      for (let i = 0; i < pending.length; i += 128) {
        const batch: NativeEvent[] = [];
        let expected = Math.max(record.completed + 1, segmentStart), gap = false;
        for (const event of pending.slice(i, i + 128)) {
          if (event.seq !== expected) { gap = true; break; }
          batch.push(event); expected++;
        }
        await this.store.update(scope, value => {
          if (gap) value.partial = true;
          value.jobs = batch.map(event => jobFor(event, calls, scope, applicable));
          if (batch.length) value.registered = batch.at(-1)!.seq;
        });
        record = await this.store.update(scope, applyJobs);
        if (gap) break;
      }
      if (record.completed < throughSeq && throughSeq >= segmentStart) record = await this.store.update(scope, value => { value.partial = true; });
      return record;
    });
    this.lanes.set(id, run); try { return await run; } finally { if (this.lanes.get(id) === run) this.lanes.delete(id); }
  }
  async snapshot(input: { scope: Scope; root: string; events: NativeEvent[]; throughSeq: number; segmentStart: number; liveStatus?: string; waiting: boolean; fresh?: boolean }) {
    const { scope } = input;
    const [record, files] = await Promise.all([this.sync(scope, input.events, input.throughSeq, input.segmentStart), this.scan(input.root, input.fresh !== false)]);
    const active = [...this.active.values()].filter(value => hash(value.scope) === hash(scope));
    const pending = record.operations.filter(op => op.outcome === 'pending' && !op.endedAt);
    let activity: Activity = input.waiting ? 'waiting' : input.liveStatus === 'running' ? 'working' : pending.length ? 'unknown' : 'idle';
    if (!input.waiting && active.length) activity = active.some(op => op.kind === 'wait') ? 'waiting' : active.some(op => op.kind === 'check') ? 'checking'
      : active.some(op => op.kind === 'edit') ? 'editing' : active.every(op => op.kind === 'read') ? 'reading' : 'working';
    const ended = record.operations.filter(op => op.endedAt);
    const checks = ended.filter(op => op.kind === 'check');
    const check = checks.at(-1);
    const notice = this.errors.get(scope.sessionId) ?? (record.partial ? '部分历史未能完整跟踪，以下只展示已取得的记录。'
      : !files.complete ? '项目文件较多或部分文件无法读取，检查与当前版本的关系仍待核对。' : undefined);
    const progress: Progress = {
      activity, revision: record.revision, throughSeq: record.completed, tracking: record.partial || !!notice ? 'partial' : 'complete',
      changedFiles: new Set(ended.flatMap(op => op.changedFiles)).size,
      edits: ended.filter(op => op.kind === 'edit' && op.outcome === 'succeeded').length,
      checks: checks.length, notice,
      ...(check ? { latestCheck: { id: check.id, startedAt: check.startedAt, endedAt: check.endedAt, outcome: check.outcome,
        exitCode: check.exitCode, applicability: !check.baseline?.complete || !files.complete || check.applicability === 'unknown' ? 'unknown'
          : check.applicability === 'changed' || check.baseline.digest !== files.digest ? 'changed' : 'unchanged' } } : {}),
    };
    return { progress, files, explanations: record.explanations };
  }
  async saveExplanation(answer: Explanation) {
    await this.store.update(answer.scope, value => {
      if (!value.explanations.some(item => item.id === answer.id)) value.explanations.push({ ...answer, cached: false });
    });
  }
  async close() { await Promise.allSettled([...this.lanes.values()]); await this.store.close(); }
}
