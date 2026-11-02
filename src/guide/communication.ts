import { GuideError, contextRef, object, requestId, text } from './contracts.js';
import type { ContextRef, Delivery, Explanation, GuideInput, InputRequest, InputResult, Scope } from './contracts.js';
import type { HarnessAdapter } from './host/adapter.js';
import { hash } from './files.js';
import { GuideStore } from './store.js';
import { classifyInput, modificationContent } from './intent.js';
import { Requirements, validateRequirementRefs, withBackground } from './requirements.js';

const now = () => new Date().toISOString();
type Explain = (request: { sessionId: string; clientRequestId: string; basis: string; question: string; context?: ContextRef }, signal: AbortSignal) => Promise<Explanation>;

/** Durable admission and delivery. Model output is never a dispatch instruction. */
export class CommunicationService {
  private flights = new Map<string, { digest: string; promise: Promise<InputResult> }>();
  private lanes = new Map<string, Promise<unknown>>();
  private workers = new Map<string, Promise<void>>();
  private scopes = new Map<string, Scope>();
  private rerun = new Set<string>();
  private nativeCalls = new Set<Promise<unknown>>();
  private lifetime = new AbortController();
  private stopped = false;
  readonly requirements: Requirements;
  constructor(readonly host: HarnessAdapter, readonly store: GuideStore, readonly explain: Explain, readonly deliveryTimeoutMs = 15000) { this.requirements = new Requirements(store); }

  private serial<T>(scope: Scope, operation: () => Promise<T>) {
    const key = hash(scope), previous = this.lanes.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(operation); this.lanes.set(key, next);
    void next.finally(() => { if (this.lanes.get(key) === next) this.lanes.delete(key); }).catch(() => {});
    return next;
  }
  private async result(scope: Scope, id: string): Promise<InputResult> {
    const record = await this.store.read(scope), input = record.inputs.find(row => row.id === id);
    if (!input) throw new GuideError('input_unavailable', '这条输入的记录尚未确认，请保留原话后重试。');
    return { input, explanation: record.explanations.find(row => row.id === input.explanationId),
      delivery: record.deliveries.find(row => row.id === input.deliveryId) };
  }
  async submit(value: unknown, signal: AbortSignal): Promise<InputResult> {
    object(value, ['sessionId', 'projectId', 'clientRequestId', 'statement', 'basis', 'replyTo', 'context', 'background']);
    if (value.background !== undefined) validateRequirementRefs(value.background);
    if (value.context !== undefined) contextRef(value.context);
    text(value.sessionId, 200); text(value.projectId, 100); requestId(value.clientRequestId); text(value.statement); text(value.basis, 100);
    if (value.replyTo !== undefined) requestId(value.replyTo);
    if (this.stopped) throw new GuideError('unavailable', '侧栏服务正在关闭，请重开后查看记录。');
    signal.throwIfAborted();
    const request = value as InputRequest, scope = { sessionId: request.sessionId, projectId: request.projectId };
    const key = hash({ scope, id: request.clientRequestId }), digest = hash({ scope, id: request.clientRequestId,
      statement: request.statement, basis: request.basis, replyTo: request.replyTo, context: request.context, background: request.background }), prior = this.flights.get(key);
    if (prior) {
      if (prior.digest !== digest) throw new GuideError('request_conflict', '同一请求不能更换内容，请先核对原来的发送记录。');
      return prior.promise;
    }
    const promise = this.handle(request, scope, digest, AbortSignal.any([signal, this.lifetime.signal])); this.flights.set(key, { digest, promise });
    try { return await promise; } finally { this.flights.delete(key); }
  }
  private async handle(request: InputRequest, scope: Scope, digest: string, signal: AbortSignal): Promise<InputResult> {
    const input = await this.serial(scope, async () => {
      const snapshot = await this.host.snapshot(scope.sessionId, signal);
      if (!snapshot.enabled) throw new GuideError('mode_required', '请回主对话选择 VibeGuide 模式。');
      if (snapshot.scope.projectId !== scope.projectId || snapshot.scope.sessionId !== scope.sessionId) throw new GuideError('scope_changed', '会话已切换项目，请回原项目核对；这次输入没有转交。');
      // Keep the host-owned scope representation used by existing P1 record filenames.
      scope = snapshot.scope;
      const record = await this.store.read(scope), prior = record.inputs.find(row => row.id === request.clientRequestId);
      if (prior) {
        if (prior.statement !== request.statement || prior.basis !== request.basis || prior.replyTo !== request.replyTo || hash(prior.context ?? null) !== hash(request.context ?? null) || hash(prior.background ?? null) !== hash(request.background ?? null)) {
          throw new GuideError('request_conflict', '同一请求不能更换内容，请先核对原来的发送记录。');
        }
        return prior;
      }
      const reply = request.replyTo ? record.inputs.find(row => row.id === request.replyTo) : undefined;
      if (request.replyTo && (!reply || reply.kind !== 'clarify' || reply.resolvedBy)) {
        throw new GuideError('clarification_changed', '这次澄清已经结束或不存在，请刷新后提出新的要求。');
      }
      const statements = [...(reply?.statements ?? []), request.statement];
      if (statements.join('\n').length > 12000 || statements.length > 12) throw new GuideError('input_too_long', '这次补充内容过长，尚未转交。请重新整理为一条完整要求。');
      let decision = classifyInput(request.statement, snapshot, reply);
      if (decision.kind === 'modify' && snapshot.model.status !== 'ready') throw new GuideError('model_unavailable', '请先在主对话选择模型，这次要求尚未保存或发送。');
      if ((snapshot.basis !== request.basis && decision.kind === 'redirect')
        || (reply && (reply.candidateModification || decision.kind === 'modify') && (snapshot.basis !== request.basis || snapshot.basis !== reply.basis))) {
        decision = { kind: 'clarify', message: '原题或进展已经变化，请核对当前内容后说明希望达到的效果，旧选项不会自动套到新问题上。' };
      }
      const input: GuideInput = { id: request.clientRequestId, digest, statement: request.statement, statements, basis: request.basis,
        createdAt: now(), ...decision, state: decision.kind === 'explain' ? 'pending' : 'done', replyTo: request.replyTo, context: request.context, background: request.background };
      let delivery: Delivery | undefined;
      if (decision.kind === 'modify') {
        const id = `vg-${hash({ scope, id: input.id })}`, requirementContent = modificationContent(statements);
        const background = await this.requirements.background(scope, requirementContent, request.background ?? (() => { let parent = reply; while (parent) { if (parent.background !== undefined) return parent.background; parent = record.inputs.find(row => row.id === parent!.replyTo); } return undefined; })());
        const content = withBackground(requirementContent, background);
        delivery = { id, inputId: input.id, scope, requestId: id, contentDigest: hash(content), content, requirementContent, background,
          userStatement: statements[0], clarificationStatements: statements.slice(1), createdAt: now(), updatedAt: now(), state: 'pending' };
        input.deliveryId = id;
      }
      signal.throwIfAborted();
      // Input, clarification consumption and outgoing message are committed together before any host call.
      await this.store.update(scope, state => {
        state.inputs.push(input); if (delivery) state.deliveries.push(delivery);
        if (reply) state.inputs.find(row => row.id === reply.id)!.resolvedBy = input.id;
      });
      return input;
    });
    this.scopes.set(hash(scope), scope);
    if (input.kind === 'modify') { this.kick(scope); return this.result(scope, input.id); }
    if (input.kind !== 'explain' || input.state === 'done') {
      const result = await this.result(scope, input.id);
      if (result.explanation) {
        const current = await this.host.snapshot(scope.sessionId, signal);
        result.explanation = { ...result.explanation, state: current.basis === result.explanation.basis ? 'current' : 'historical' };
      }
      return result;
    }
    try {
      const answer = await this.explain({ sessionId: scope.sessionId, clientRequestId: `explain-${hash({ scope, id: input.id })}`, basis: input.basis,
        context: input.context, question: input.statements.length === 1 ? input.statement : modificationContent(input.statements) }, signal);
      await this.store.update(scope, state => {
        const target = state.inputs.find(row => row.id === input.id)!;
        target.state = 'done'; target.explanationId = answer.id; delete target.message;
      });
      return { ...await this.result(scope, input.id), explanation: answer };
    } catch (error) {
      await this.store.update(scope, state => {
        const target = state.inputs.find(row => row.id === input.id)!;
        target.state = 'failed'; target.message = '这次讲解未完成，没有转交修改。可以结合当前进展重新提问。';
      });
      throw error;
    }
  }
  kick(scope: Scope) {
    if (this.stopped) return;
    const key = hash(scope); this.scopes.set(key, scope);
    if (this.workers.has(key)) { this.rerun.add(key); return; }
    const work = this.process(scope).catch(() => { /* Durable pending/dispatching state remains visible and is reconciled later. */ })
      .finally(() => {
        this.workers.delete(key);
        if (this.rerun.delete(key) && !this.stopped) this.kick(scope);
      });
    this.workers.set(key, work);
  }
  wakeSession(sessionId: string) { for (const scope of this.scopes.values()) if (scope.sessionId === sessionId) this.kick(scope); }
  async records(scope: Scope) {
    const record = await this.store.read(scope); this.kick(scope);
    return { inputs: record.inputs, deliveries: record.deliveries };
  }
  private async reconcile(delivery: Delivery) {
    let result;
    try { result = await this.host.deliveryStatus(delivery.scope.sessionId, delivery.requestId, delivery); }
    catch { result = { state: 'unknown' as const }; }
    await this.store.update(delivery.scope, record => {
      const target = record.deliveries.find(row => row.id === delivery.id)!;
      const state = result.state === 'conflict' ? 'unknown' : result.state;
      const notice = result.state === 'conflict' ? result.notice : state === 'unknown'
        ? '暂时无法确认主对话是否收到，正在核对，不会自动重发。' : undefined;
      const source = 'source' in result ? result.source : target.source;
      if (target.state === state && target.notice === notice && hash(target.source ?? null) === hash(source ?? null)) return;
      target.state = state; target.notice = notice; target.source = source; target.updatedAt = now();
    });
  }
  private async process(scope: Scope) {
    const record = await this.store.read(scope);
    for (const delivery of record.deliveries) {
      if (this.stopped) return;
      if (['accepted', 'failed'].includes(delivery.state)) continue;
      if (delivery.state !== 'pending') { await this.reconcile(delivery); continue; }
      try {
        const projectRevision = await this.requirements.validateBackground(scope, delivery.background ?? []);
        await this.store.update(scope, state => {
          const target = state.deliveries.find(row => row.id === delivery.id)!;
          if (target.state !== 'pending') throw new GuideError('delivery_changed', '发送记录已变化，请刷新核对。');
          target.state = 'dispatching'; target.updatedAt = now();
        }, projectRevision);
      }
      catch (error) {
        await this.store.update(scope, state => {
          const target = state.deliveries.find(row => row.id === delivery.id)!;
          if (target.state !== 'pending') return;
          target.state = 'failed'; target.notice = error instanceof GuideError ? error.message : '历史约定暂时无法核对，这次未发送。'; target.updatedAt = now();
        });
        continue;
      }
      if (this.stopped) return;
      try {
        const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.deliveryTimeoutMs)]);
        const sending = this.host.queueModification(scope.sessionId, delivery.content, delivery.requestId, signal, scope);
        this.nativeCalls.add(sending);
        void sending.finally(() => { this.nativeCalls.delete(sending); if (!this.stopped) this.kick(scope); }).catch(() => {});
        // Some native admission steps cannot cancel after entry. A timeout makes the receipt unknown,
        // never authorizes another attempt; keep ownership until the original call actually settles.
        let cancel: () => void = () => {};
        const deadline = new Promise<never>((_, reject) => {
          const aborted = () => reject(signal.reason);
          if (signal.aborted) aborted(); else signal.addEventListener('abort', aborted, { once: true });
          cancel = () => signal.removeEventListener('abort', aborted);
        });
        try { await Promise.race([sending, deadline]); } finally { cancel(); }
      } catch (error) {
        if (error instanceof GuideError && ['scope_changed', 'mode_required'].includes(error.code)) {
          await this.store.update(scope, state => {
            const target = state.deliveries.find(row => row.id === delivery.id)!;
            target.state = 'failed'; target.notice = error.message; target.updatedAt = now();
          });
          continue;
        }
        // A thrown transport error is not proof that the host rejected the message.
      }
      await this.reconcile(delivery);
    }
  }
  async recover() {
    for (const scope of await this.store.scopes()) {
      try {
        await this.store.update(scope, state => {
          for (const input of state.inputs) if (input.kind === 'explain' && input.state === 'pending') {
            input.state = 'failed'; input.message = '上次讲解未完成；重新打开不会自动生成，可以重新提问。';
          }
          for (const delivery of state.deliveries) if (delivery.state === 'dispatching') {
            delivery.state = 'unknown'; delivery.notice = '上次发送已开始，正在核对接收结果，不会自动重发。'; delivery.updatedAt = now();
          }
        });
        this.scopes.set(hash(scope), scope);
      } catch { /* Corrupt scopes are not sent or replaced; their next explicit read reports the error. */ }
    }
    for (const scope of this.scopes.values()) this.kick(scope);
  }
  async settled() { while (this.workers.size) await Promise.all([...this.workers.values()]); }
  async close() {
    this.stopped = true; this.rerun.clear(); this.lifetime.abort();
    await Promise.allSettled([...this.flights.values()].map(row => row.promise));
    await Promise.allSettled([...this.lanes.values(), ...this.workers.values()]);
    await Promise.allSettled([...this.nativeCalls]);
  }
}
