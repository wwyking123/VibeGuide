import { lookupConcept, conceptText } from './glossary.js';
import { randomUUID } from 'node:crypto';
import { GuideError, contextRef, object, requestId, text } from './contracts.js';
import type { AskRequest, Explanation, GuideSnapshot } from './contracts.js';
import { digest, HarnessAdapter } from './host/adapter.js';
import { CommunicationService } from './communication.js';
import { ProjectService } from './project.js';
import { analysisKind, requirementBasis } from './work.js';

/** Independent explanations and owner-submitted communication; no business execution tools. */
export class GuideService {
  private readonly requests = new Map<string, { digest: string; result: Promise<Explanation>; controller: AbortController; done: boolean }>();
  private readonly cache = new Map<string, Explanation>();
  private disposed = false;
  readonly communication?: CommunicationService;
  readonly project?: ProjectService;
  constructor(readonly host: HarnessAdapter) {
    if (host.tracker) this.project = new ProjectService(host, host.tracker.store);
    if (host.tracker) this.communication = new CommunicationService(host, host.tracker.store, (request, signal) => this.ask(request, signal));
  }

  async getSnapshot(value: unknown, signal?: AbortSignal): Promise<GuideSnapshot> {
    object(value, ['sessionId']); text(value.sessionId, 200);
    if (this.disposed) throw new GuideError('unavailable', '侧栏服务已关闭，请重新打开。');
    signal?.throwIfAborted();
    const snapshot = await this.host.snapshot(value.sessionId, signal);
    signal?.throwIfAborted();
    if (!snapshot.enabled) throw new GuideError('mode_required', '请在主对话选择 VibeGuide 模式后使用侧栏。');
    const excludedExplanationIds = await this.project?.excluded(snapshot.scope.projectId) ?? [];
    const workBasis = this.project && snapshot.explanations?.some(row => row.workBasis) ? requirementBasis((await this.project.work.requirements.list(snapshot.scope)).items) : undefined;
    const prefs = await this.project?.support.preferences(snapshot.scope.projectId);
    const analyses = this.project && snapshot.explanations?.some(row => row.analysisId) ? (await this.project.analysisState(snapshot)).analyses : undefined;
    return { ...snapshot, preferenceVersion: prefs?.preferenceVersion, ...(this.communication ? await this.communication.records(snapshot.scope) : {}),
      excludedExplanationIds, explanations: snapshot.explanations?.filter(row => !excludedExplanationIds.includes(row.id)).map(row => (row.analysisId && !analyses?.some(analysis => analysis.id === row.analysisId && !analysis.historical) || row.workBasis && row.workBasis !== workBasis || row.preferenceVersion && row.preferenceVersion !== prefs?.preferenceVersion) ? { ...row, state: 'historical' as const } : row) };
  }

  async submit(value: unknown, signal: AbortSignal) {
    if (!this.communication || this.disposed) throw new GuideError('unavailable', '当前转交服务尚未就绪，请稍后刷新。');
    const result = await this.communication.submit(value, signal);
    if (result.explanation) {
      const current = await this.getSnapshot({ sessionId: result.explanation.scope.sessionId }, signal);
      if (current.excludedExplanationIds?.includes(result.explanation.id)) return { ...result, explanation: undefined };
      const saved = current.explanations?.find(row => row.id === result.explanation!.id);
      if (saved?.state === 'historical') return { ...result, explanation: { ...result.explanation, state: 'historical' as const } };
    }
    return result;
  }

  async ask(value: unknown, signal: AbortSignal): Promise<Explanation> {
    object(value, ['sessionId', 'clientRequestId', 'question', 'basis', 'choiceId', 'choiceVersion', 'context']);
    if (value.context !== undefined) contextRef(value.context);
    text(value.sessionId, 200); requestId(value.clientRequestId); text(value.question, 12000); text(value.basis, 100);
    if (value.choiceId !== undefined) text(value.choiceId, 300);
    if (value.choiceVersion !== undefined) text(value.choiceVersion, 100);
    if ((value.choiceId === undefined) !== (value.choiceVersion === undefined)) {
      throw new GuideError('invalid_input', '请选择当前问题后再请求解释。');
    }
    signal.throwIfAborted();
    const request = value as AskRequest;
    const key = `${request.sessionId}:${request.clientRequestId}`;
    const contentDigest = digest(request);
    const prior = this.requests.get(key);
    if (prior) {
      if (prior.digest !== contentDigest) throw new GuideError('request_conflict', '同一请求的内容发生变化，请重新提交。');
      const answer = await prior.result;
      const current = await this.getSnapshot({ sessionId: request.sessionId }, signal);
      if (answer.scope.projectId !== current.scope.projectId) throw new GuideError('basis_changed', '当前会话已切换项目，请在新项目中重新提问。');
      if (current.excludedExplanationIds?.includes(answer.id)) throw new GuideError('context_changed', '原讲解已被纠正或停用，请重新提问。');
      const context = request.context ? await this.project?.resolve(current, request.context) : undefined;
      return answer.basis === current.basis && (!request.context || answer.contextDigest === digest(context)) && !current.explanations?.some(row => row.id === answer.id && row.state === 'historical') ? answer : { ...answer, state: 'historical' };
    }
    if ([...this.requests.values()].filter(row => !row.done).length >= 2) {
      throw new GuideError('explanation_busy', '已有讲解正在生成，请稍后再问。');
    }
    if (this.requests.size >= 100) {
      const completed = [...this.requests].find(([, row]) => row.done);
      if (completed) this.requests.delete(completed[0]);
    }
    const controller = new AbortController();
    const lifetime = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(45_000)]);
    const result = this.generate(request, lifetime);
    const entry = { digest: contentDigest, result, controller, done: false };
    this.requests.set(key, entry);
    void result.then(() => { entry.done = true; }, () => {
      entry.done = true;
      if (this.requests.get(key) === entry) this.requests.delete(key);
    });
    return result;
  }

  private async generate(request: AskRequest, signal: AbortSignal): Promise<Explanation> {
    const snapshot = await this.getSnapshot({ sessionId: request.sessionId }, signal);
    signal.throwIfAborted();
    if (snapshot.basis !== request.basis) throw new GuideError('basis_changed', '已有新的进展，请查看最新状态后再提问。');
    if (request.choiceId && !snapshot.choices.some(choice => choice.id === request.choiceId && choice.version === request.choiceVersion)) {
      throw new GuideError('choice_changed', '这道题已变化，请回到当前问题。');
    }
    const concept = !request.context && !request.choiceId ? lookupConcept(request.question) : undefined;
    if (concept && this.project) {
      const prefs = await this.project.support.preferences(snapshot.scope.projectId);
      const prior = snapshot.explanations?.find(row => row.id === `glossary-${request.clientRequestId}`);
      if (prior) { if (prior.question !== request.question) throw new GuideError('request_conflict', '同一请求不能更换问题。'); return { ...prior, cached: true }; }
      const answer: Explanation = { id: `glossary-${request.clientRequestId}`, scope: snapshot.scope, basis: snapshot.basis, preferenceVersion: snapshot.preferenceVersion, question: request.question,
        text: conceptText(concept, prefs.preferences, request.question), state: 'current', model: { provider: 'local', model: 'glossary-v1' }, sourceKind: 'glossary',
        createdAt: new Date().toISOString(), cached: false };
      await this.host.saveExplanation?.(answer); await this.project.support.hit(snapshot, request.clientRequestId, 'glossary'); return answer;
    }
    if (snapshot.model.status !== 'ready') throw new GuideError('model_unavailable', '请先在主对话选择可用模型。');
    const kind = !request.choiceId && !request.context ? analysisKind(request.question) : undefined;
    if (kind && this.project) {
      const analysis = await this.project.analyze({ sessionId: snapshot.scope.sessionId, projectId: snapshot.scope.projectId,
        clientRequestId: request.clientRequestId, kind, question: request.question }, signal);
      const current = await this.getSnapshot({ sessionId: request.sessionId }, signal);
      const view = await this.project.view({ sessionId: request.sessionId, projectId: snapshot.scope.projectId }, signal);
      const stored = view.work?.analyses.find(row => row.id === analysis.id);
      const existing = current.explanations?.find(row => row.analysisId === analysis.id);
      if (existing) return { ...existing, cached: true, state: stored?.historical || current.basis !== existing.basis ? 'historical' : 'current' };
      const result: Explanation = { id: randomUUID(), scope: snapshot.scope, basis: snapshot.basis, preferenceVersion: snapshot.preferenceVersion, question: request.question,
        text: [analysis.summary, ...analysis.impacts, ...analysis.nodes.map(row => `${row.title}：${row.reason}`),
          ...analysis.possibleAdditions.map(row => `可能还需要：${row}`), ...analysis.unknowns.map(row => `还不能确认：${row}`)].join('\n\n'),
        state: stored?.historical || current.basis !== snapshot.basis ? 'historical' : 'current', createdAt: new Date().toISOString(),
        model: snapshot.model.route, cached: false, promptVersion: 'work-1', analysisId: analysis.id, workBasis: analysis.requirementBasis };
      await this.host.saveExplanation?.(result); return result;
    }
    const context = request.context ? await this.project?.resolve(snapshot, request.context) : undefined;
    if (request.context && !context) throw new GuideError('context_changed', '当前无法读取这条关联内容。');
    const contextDigest = request.context ? digest(context) : undefined;
    const cacheKey = digest({ scope: snapshot.scope, basis: snapshot.basis, preferenceVersion: snapshot.preferenceVersion, question: request.question,
      choiceId: request.choiceId, choiceVersion: request.choiceVersion, route: snapshot.model.route, context: request.context, contextDigest, prompt: request.context ? 'p3-1' : 'p1-1' });
    const memoryCached = this.cache.get(cacheKey);
    const cached = (memoryCached && !snapshot.excludedExplanationIds?.includes(memoryCached.id) ? memoryCached : undefined) ?? snapshot.explanations?.find(answer => answer.basis === snapshot.basis
      && answer.preferenceVersion === snapshot.preferenceVersion && answer.contextDigest === contextDigest && answer.state === 'current' && answer.question === request.question && answer.promptVersion === (request.context ? 'p3-1' : 'p1-1') && digest(answer.context ?? null) === digest(request.context ?? null)
      && answer.choiceId === request.choiceId && answer.choiceVersion === request.choiceVersion
      && digest(answer.model) === digest(snapshot.model.status === 'ready' ? snapshot.model.route : null));
    if (cached) { await this.project?.support.hit(snapshot, request.clientRequestId, 'cache'); return { ...cached, cached: true }; }
    const focused = request.choiceId ? { ...snapshot,
      choices: snapshot.choices.filter(choice => choice.id === request.choiceId) } : snapshot;
    const answer = await this.host.explain({ ...focused, context }, request.question, signal);
    signal.throwIfAborted();
    const current = await this.getSnapshot({ sessionId: request.sessionId }, signal);
    if (current.scope.projectId !== snapshot.scope.projectId) throw new GuideError('basis_changed', '当前会话已切换项目，请在新项目中重新提问。');
    const currentContext = request.context ? await this.project?.resolve(current, request.context) : undefined;
    const result: Explanation = {
      id: randomUUID(), scope: snapshot.scope, preferenceVersion: snapshot.preferenceVersion, question: request.question, text: answer, basis: snapshot.basis,
      state: current.basis === snapshot.basis && current.preferenceVersion === snapshot.preferenceVersion && (!request.context || digest(currentContext) === contextDigest) ? 'current' : 'historical',
      model: snapshot.model.route, createdAt: new Date().toISOString(), cached: false,
      choiceId: request.choiceId, choiceVersion: request.choiceVersion, promptVersion: request.context ? 'p3-1' : 'p1-1', context: request.context, contextLabel: context?.label, contextDigest,
    };
    await this.host.saveExplanation?.(result);
    if (result.state === 'current') {
      if (this.cache.size >= 32) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(cacheKey, result);
    }
    return result;
  }

  dispose() {
    this.disposed = true;
    for (const request of this.requests.values()) request.controller.abort();
    this.requests.clear(); this.cache.clear();
  }
}
