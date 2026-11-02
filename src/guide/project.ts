import { concepts, conceptText } from './glossary.js';
import { ProjectIndex, compareStructure } from './structure.js';
import { GuideSupport } from './support.js';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { GuideError, contextRef, object, requestId, text } from './contracts.js';
import type { ContextRef, GuideSnapshot } from './contracts.js';
import { captureFiles, changedFiles, hash } from './files.js';
import type { HarnessAdapter } from './host/adapter.js';
import { projectEvidence } from './project-scan.js';
import { redact } from './privacy.js';
import { WorkService, requirementBasis } from './work.js';
import { validateRequirementRefs } from './requirements.js';
import type { GuideStore } from './store.js';
import type { Annotation, HistoryItem, HistoryPage, Overview, ProjectView, Responsibility, TrialCard, TrialFeedback } from './project-types.js';

const now = () => new Date().toISOString();
const sameProject = (a: GuideSnapshot, b: GuideSnapshot) => a.scope.projectId === b.scope.projectId && a.scope.sessionId === b.scope.sessionId && b.enabled;
function invalid(): never { throw new GuideError('invalid_generation', '这次生成的内容无法可靠对应项目，未保存。可以稍后再试。'); }
function generatedText(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) return invalid();
  return redact(value.trim());
}
function json(raw: string): Record<string, unknown> {
  try { const value = JSON.parse(raw); if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid(); return value; }
  catch { return invalid(); }
}
const version = (row: HistoryItem | { id: string; text: string; annotation?: Annotation }) => hash({ id: row.id, text: row.text, annotation: row.annotation ?? null });

/** Local project knowledge. Only explicit overview/trial calls enter the independent model path. */
export class ProjectService {
  private index = new ProjectIndex();
  private lifetime = new AbortController();
  private flights = new Map<string, { digest: string; promise: Promise<unknown> }>();
  private closed = false;
  readonly work: WorkService;
  readonly support: GuideSupport;
  constructor(readonly host: HarnessAdapter, readonly store: GuideStore) { this.support = host.support ?? new GuideSupport(store); this.work = new WorkService(host, store, this.support); }
  private async current(value: Record<string, unknown>, signal: AbortSignal) {
    text(value.sessionId, 200); text(value.projectId, 100);
    signal.throwIfAborted();
    if (this.closed) throw new GuideError('unavailable', '侧栏服务正在关闭。');
    const snapshot = await this.host.snapshot(value.sessionId, signal);
    if (!snapshot.enabled) throw new GuideError('mode_required', '请回主对话选择 VibeGuide 模式。');
    if (snapshot.scope.projectId !== value.projectId) throw new GuideError('scope_changed', '会话已切换项目，请回原项目查看。');
    const project = await this.host.projectFor(value.sessionId);
    if (!project.enabled || project.scope.projectId !== snapshot.scope.projectId) throw new GuideError('scope_changed', '项目已变化，请刷新。');
    snapshot.preferenceVersion = (await this.support.preferences(snapshot.scope.projectId)).preferenceVersion;
    return { snapshot, root: project.root };
  }
  private async verify(snapshot: GuideSnapshot, signal: AbortSignal) {
    const current = await this.host.snapshot(snapshot.scope.sessionId, signal);
    signal.throwIfAborted();
    if (!sameProject(snapshot, current)) throw new GuideError('scope_changed', '项目已切换，这次结果没有写入新项目。');
    return current;
  }
  private scan(root: string) { return captureFiles(root, 250, [dirname(this.store.directory)]); }
  async analysisState(snapshot: GuideSnapshot) {
    const project = await this.host.projectFor(snapshot.scope.sessionId);
    if (!sameProject(snapshot, { ...snapshot, scope: project.scope, enabled: project.enabled })) throw new GuideError('scope_changed', '项目已变化，请刷新。');
    const [files, record] = await Promise.all([this.scan(project.root), this.store.readProject(snapshot.scope.projectId)]);
    return this.work.state(snapshot, files, record);
  }
  async excluded(projectId: string) { return (await this.store.readProject(projectId)).annotations.map(row => row.explanationId); }

  async concept(value: unknown, signal: AbortSignal) {
    object(value, ['sessionId', 'projectId', 'clientRequestId', 'id']); requestId(value.clientRequestId); text(value.id, 100);
    const { snapshot } = await this.current(value, signal), concept = concepts.find(row => row.id === value.id);
    if (!concept) throw new GuideError('invalid_input', '这个概念暂未收录。可在下方输入你的问题。');
    const prefs = await this.support.preferences(snapshot.scope.projectId); signal.throwIfAborted();
    await this.support.hit(snapshot, `${value.clientRequestId}:${concept.id}`, 'glossary');
    return { id: concept.id, text: conceptText(concept, prefs.preferences) };
  }
  async supportView(value: unknown, signal: AbortSignal) {
    object(value, ['sessionId', 'projectId']); const { snapshot } = await this.current(value, signal);
    return this.support.view(snapshot);
  }
  async saveSupport(value: unknown, signal: AbortSignal) {
    object(value, ['sessionId', 'projectId', 'clientRequestId', 'version', 'target', 'preferences', 'budget']);
    const { snapshot } = await this.current(value, signal); signal.throwIfAborted();
    return this.support.save(snapshot, value);
  }
  async view(value: unknown, signal: AbortSignal): Promise<ProjectView> {
    object(value, ['sessionId', 'projectId', 'overviewId']);
    if (value.overviewId !== undefined) text(value.overviewId, 200);
    const { snapshot, root } = await this.current(value, signal);
    const [files, structureFiles, record] = await Promise.all([this.scan(root), this.index.scan(root, [dirname(this.store.directory)]), this.store.readProject(snapshot.scope.projectId)]);
    await this.verify(snapshot, signal);
    const overview = value.overviewId ? record.overviews.find(row => row.id === value.overviewId) : record.overviews.at(-1), changes = overview ? changedFiles(overview.basis, structureFiles) : [];
    if (value.overviewId && !overview) throw new GuideError('context_changed', '这个结构版本已不在最近 30 版中，请选择其他版本。');
    const mapped = new Set(overview?.nodes.flatMap(node => node.files) ?? []);
    return { versions: record.overviews.map(({ id, createdAt, summary, sampledFiles }) => ({ id, createdAt, summary, sampledFiles })), projectId: snapshot.scope.projectId, fileDigest: structureFiles.digest, fileCount: Object.keys(structureFiles.files).length, complete: structureFiles.complete, work: await this.work.view(snapshot, files, record),
      overview: overview && { ...overview, historical: overview.basis.digest !== structureFiles.digest,
        changedNodes: overview.nodes.filter(node => node.files.some(file => changes.includes(file))).map(node => node.id),
        unmappedChanges: changes.filter(file => !mapped.has(file)).length },
      trials: record.trials.map(card => ({ ...card, historical: card.basis.digest !== files.digest || !!(card.requirementRef && record.requirementRevisions.some(row => row.id === card.requirementRef!.id && row.version !== card.requirementRef!.version && row.createdAt > card.createdAt)),
        feedback: record.feedback.filter(row => row.cardId === card.id) })) };
  }

  async compareStructure(value: unknown, signal: AbortSignal) {
    object(value, ['sessionId', 'projectId', 'from', 'to']); text(value.from, 200); text(value.to, 200);
    const { snapshot } = await this.current(value, signal), record = await this.store.readProject(snapshot.scope.projectId);
    const from = record.overviews.find(row => row.id === value.from), to = record.overviews.find(row => row.id === value.to);
    if (!from || !to) throw new GuideError('context_changed', '比较版本已不可用，请重新选择。');
    await this.verify(snapshot, signal); return compareStructure(from, to);
  }

  private async generate<T>(value: Record<string, unknown>, signal: AbortSignal, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    requestId(value.clientRequestId); text(value.projectId, 100); text(value.sessionId, 200);
    const key = `${value.projectId}:${value.clientRequestId}`, digest = hash(value), prior = this.flights.get(key);
    if (prior) {
      if (prior.digest !== digest) throw new GuideError('request_conflict', '同一生成请求不能更换内容。');
      return prior.promise as Promise<T>;
    }
    if (this.flights.size >= 1) throw new GuideError('explanation_busy', '已有项目讲解正在生成，请稍后再试。');
    const promise = operation(AbortSignal.any([signal, this.lifetime.signal, AbortSignal.timeout(45000)]));
    this.flights.set(key, { digest, promise });
    try { return await promise; } finally { this.flights.delete(key); }
  }

  async analyze(value: unknown, signal: AbortSignal) {
    object(value, ['sessionId', 'projectId', 'clientRequestId', 'kind', 'question']);
    return this.generate(value, signal, abort => this.work.analyze(value, abort));
  }

  async overview(value: unknown, signal: AbortSignal): Promise<Overview> {
    object(value, ['sessionId', 'projectId', 'clientRequestId']);
    return this.generate(value, signal, async abort => {
      const { snapshot, root } = await this.current(value, abort);
      if (snapshot.model.status !== 'ready') throw new GuideError('model_unavailable', '请先在主对话选择模型。');
      const evidence = await projectEvidence(root, [dirname(this.store.directory)], abort, { basis: await this.index.scan(root, [dirname(this.store.directory)]) });
      if (!evidence.snippets.length) throw new GuideError('project_empty', '还没有可读取的项目内容。可以先在主对话开始开发。');
      const record = await this.store.readProject(snapshot.scope.projectId), requestDigest = hash(value);
      const prior = record.overviews.find(row => row.requestId === value.clientRequestId);
      if (prior) { if (prior.requestDigest !== requestDigest) throw new GuideError('request_conflict', '这次请求的内容已变化。'); return prior; }
      const cacheKey = hash({ files: evidence.basis.digest, samples: evidence.snippets, model: snapshot.model.route, preferences: snapshot.preferenceVersion, prompt: 'overview-1' });
      const cached = record.overviews.find(row => row.cacheKey === cacheKey);
      if (cached) { await this.verify(snapshot, abort); await this.support.hit(snapshot, String(value.clientRequestId), 'cache'); return cached; }
      const parsed = json(await this.host.structured(snapshot, 'overview', { project: snapshot.projectName,
        coverage: { scanned: Object.keys(evidence.basis.files).length, complete: evidence.basis.complete, sampled: evidence.snippets.length },
        files: evidence.snippets }, abort));
      const summary = generatedText(parsed.summary, 600);
      if (!Array.isArray(parsed.nodes) || parsed.nodes.length < 1 || parsed.nodes.length > 8 || !Array.isArray(parsed.unknowns) || parsed.unknowns.length > 8) invalid();
      const allowed = new Set(evidence.snippets.map(row => row.file)), assigned = new Set<string>();
      const nodes: Responsibility[] = parsed.nodes.map((node: any, index) => {
        if (!node || !Array.isArray(node.files) || !node.files.length || node.files.some((file: unknown) => typeof file !== 'string' || !allowed.has(file) || assigned.has(file))) invalid();
        node.files.forEach((file: string) => assigned.add(file));
        return { id: `n${index + 1}`, title: generatedText(node.title, 50), purpose: generatedText(node.purpose, 500), impact: generatedText(node.impact, 500), files: [...new Set<string>(node.files)] };
      });
      const edges: Overview['edges'] = [];
      for (const link of evidence.links) {
        const from = nodes.find(node => node.files.includes(link.from)), to = nodes.find(node => node.files.includes(link.to));
        if (from && to && from.id !== to.id && !edges.some(edge => edge.from === from.id && edge.to === to.id)) edges.push({ from: from.id, to: to.id });
      }
      await this.verify(snapshot, abort);
      const result: Overview = { id: randomUUID(), projectId: snapshot.scope.projectId, scope: snapshot.scope,
        requestId: value.clientRequestId as string, requestDigest, cacheKey, createdAt: now(), model: snapshot.model.route, preferenceVersion: snapshot.preferenceVersion,
        basis: evidence.basis, sampledFiles: evidence.snippets.length, summary, nodes, edges,
        unknowns: parsed.unknowns.map(item => generatedText(item, 500)) };
      abort.throwIfAborted();
      await this.store.updateProject(result.projectId, state => { state.overviews.push(result); state.overviews = state.overviews.slice(-30); });
      return result;
    });
  }

  private async allHistory(snapshot: GuideSnapshot): Promise<{ items: HistoryItem[]; incomplete: boolean }> {
    const record = await this.store.readProject(snapshot.scope.projectId);
    const scopes = (await this.store.scopes()).filter(scope => scope.projectId === snapshot.scope.projectId).sort((a, b) => a.sessionId.localeCompare(b.sessionId));
    const items: HistoryItem[] = [];
    const workBasis = requirementBasis((await this.work.requirements.list(snapshot.scope)).items);
    const preferenceVersion = (await this.support.preferences(snapshot.scope.projectId)).preferenceVersion;
    const analyses = record.analyses.length ? (await this.analysisState(snapshot)).analyses : [];
    for (const scope of scopes.slice(0, 100)) {
      const session = await this.store.read(scope);
      for (const explanation of session.explanations) {
        const annotation = record.annotations.filter(row => row.explanationId === explanation.id).at(-1);
        const fromCurrentSession = explanation.scope.sessionId === snapshot.scope.sessionId;
        items.push({ ...explanation, annotation, contextVersion: version({ ...explanation, annotation }), fromCurrentSession,
          state: fromCurrentSession && explanation.basis === snapshot.basis && (!explanation.analysisId || analyses.some(row => row.id === explanation.analysisId && !row.historical)) && (!explanation.workBasis || explanation.workBasis === workBasis) && (!explanation.preferenceVersion || explanation.preferenceVersion === preferenceVersion) && !annotation ? 'current' : 'historical' });
      }
    }
    return { items: items.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)), incomplete: scopes.length > 100 };
  }
  async history(value: unknown, signal: AbortSignal): Promise<HistoryPage> {
    object(value, ['sessionId', 'projectId', 'offset']);
    const offset = value.offset ?? 0;
    if (!Number.isSafeInteger(offset) || (offset as number) < 0 || (offset as number) > 20000) throw new GuideError('invalid_input', '记录页码无效。');
    const { snapshot } = await this.current(value, signal), all = await this.allHistory(snapshot);
    await this.verify(snapshot, signal);
    const end = (offset as number) + 20;
    return { items: all.items.slice(offset as number, end), nextOffset: end < all.items.length ? end : undefined, incomplete: all.incomplete };
  }
  async resolve(snapshot: GuideSnapshot, ref: ContextRef): Promise<{ label: string; text: string }> {
    contextRef(ref);
    if (ref.kind === 'analysis') {
      const record = await this.store.readProject(snapshot.scope.projectId), analysis = record.analyses.find(row => row.id === ref.id && row.cacheKey === ref.version);
      if (!analysis) throw new GuideError('context_changed', '这条分析已不可用，请重新选择。');
      const sessions = (await this.work.requirements.records(snapshot.scope.projectId)).sessions;
      const explanationIds = new Set(sessions.flatMap(row => row.explanations).filter(row => row.analysisId === analysis.id).map(row => row.id));
      const annotation = record.annotations.filter(row => explanationIds.has(row.explanationId)).at(-1);
      if (annotation?.action === 'retire') throw new GuideError('context_changed', '这条分析已不再使用，请重新提问。');
      if (annotation?.action === 'correct') return { label: analysis.question, text: JSON.stringify({ kind: '用户纠正，尚未验证', correction: annotation.text }) };
      const state = await this.analysisState(snapshot), current = state.analyses.find(row => row.id === analysis.id);
      if (!current) throw new GuideError('context_changed', '这条分析不属于当前会话，请重新选择。');
      return { label: analysis.question, text: JSON.stringify({ kind: '按需分析，不是已验证的实现事实', historical: current.historical,
        summary: analysis.summary, impacts: analysis.impacts, unknowns: analysis.unknowns,
        ...(analysis.kind === 'trouble' ? { currentTrouble: { version: state.trouble.version, incomplete: state.trouble.incomplete,
          failures: state.trouble.failures, feedback: state.trouble.feedback, latestAttempts: state.trouble.attempts.slice(-3) },
          guidance: '旧分析仅用于回顾；当前检查结果以 currentTrouble 为准。没有失败记录不等于功能已验收。' } : {}) }) };
    }
    if (ref.kind === 'node') {
      const overview = (await this.store.readProject(snapshot.scope.projectId)).overviews.find(row => row.id === ref.version);
      const node = overview?.nodes.find(row => `${overview.id}:${row.id}` === ref.id);
      if (!overview || !node) throw new GuideError('context_changed', '这部分结构已经不可用，请重新选择。');
      const project = await this.host.projectFor(snapshot.scope.sessionId);
      if (project.scope.projectId !== snapshot.scope.projectId || !project.enabled) throw new GuideError('scope_changed', '项目已变化，请刷新。');
      const files = await this.scan(project.root);
      return { label: node.title, text: JSON.stringify({ kind: '推测职责，未经功能验证', historical: overview.basis.digest !== files.digest,
        title: node.title, purpose: node.purpose, impact: node.impact, unknowns: overview.unknowns }) };
    }
    const row = (await this.allHistory(snapshot)).items.find(item => item.id === ref.id);
    if (!row || row.contextVersion !== ref.version || row.annotation?.action === 'retire') throw new GuideError('context_changed', '这条讲解已更新或不再使用，请在记录中重新选择。');
    return { label: row.question, text: JSON.stringify(row.annotation ? { kind: '用户纠正，尚未验证', correction: row.annotation.text }
      : { kind: '历史讲解，不是当前实现事实', question: row.question, explanation: row.text, createdAt: row.createdAt }) };
  }
  async annotate(value: unknown, signal: AbortSignal): Promise<Annotation> {
    object(value, ['sessionId', 'projectId', 'clientRequestId', 'explanationId', 'version', 'action', 'text']);
    requestId(value.clientRequestId); text(value.explanationId, 200); text(value.version, 100);
    if (value.action !== 'correct' && value.action !== 'retire') throw new GuideError('invalid_input', '请选择纠正或不再使用。');
    if (value.action === 'correct') text(value.text, 2000);
    else if (value.text !== undefined) throw new GuideError('invalid_input', '不再使用无需填写纠正内容。');
    const { snapshot } = await this.current(value, signal), requestDigest = hash(value);
    const prior = (await this.store.readProject(snapshot.scope.projectId)).annotations.find(row => row.id === value.clientRequestId);
    if (prior) { if (prior.requestDigest !== requestDigest) throw new GuideError('request_conflict', '同一保存请求不能更换内容。'); return prior; }
    const target = (await this.allHistory(snapshot)).items.find(row => row.id === value.explanationId);
    if (!target || target.contextVersion !== value.version) throw new GuideError('context_changed', '这条记录已经变化，请刷新后再操作。');
    await this.verify(snapshot, signal);
    const result: Annotation = { id: value.clientRequestId, requestDigest, explanationId: target.id, action: value.action,
      ...(value.action === 'correct' ? { text: value.text as string } : {}), createdAt: now() };
    await this.store.updateProject(snapshot.scope.projectId, record => {
      const latest = record.annotations.filter(row => row.explanationId === target.id).at(-1);
      if (version({ ...target, annotation: latest }) !== value.version) throw new GuideError('context_changed', '这条记录刚刚发生变化，请刷新。');
      record.annotations.push(result);
    });
    return result;
  }

  async prepareReview(value: unknown, signal: AbortSignal): Promise<TrialCard> {
    object(value, ['sessionId', 'projectId', 'clientRequestId', 'deliveryId', 'requirement']);
    if (value.requirement !== undefined) validateRequirementRefs([value.requirement]); else text(value.deliveryId, 200);
    return this.generate(value, signal, async abort => {
      const { snapshot, root } = await this.current(value, abort);
      const knowledge = await this.work.requirements.list(snapshot.scope);
      const ref = value.requirement as { id: string; version: string } | undefined;
      const requirement = knowledge.items.find(row => row.state === 'active' && (ref ? row.id === ref.id && row.version === ref.version : row.deliveryId === value.deliveryId && row.scope.sessionId === snapshot.scope.sessionId));
      const delivery = requirement?.deliveryId ? knowledge.deliveries.find(row => row.id === requirement.deliveryId) : undefined;
      if (!requirement || (requirement.deliveryId && delivery?.state !== 'accepted')) throw new GuideError('delivery_unavailable', '请等这条要求送达主对话后，再准备试用。');
      if (snapshot.model.status !== 'ready') throw new GuideError('model_unavailable', '请先选择可用模型。');
      const basis = await this.scan(root), record = await this.store.readProject(snapshot.scope.projectId), requestDigest = hash(value);
      const prior = record.trials.find(row => row.requestId === value.clientRequestId);
      if (prior) { if (prior.requestDigest !== requestDigest) throw new GuideError('request_conflict', '同一生成请求不能更换内容。'); return prior; }
      const cacheKey = hash({ requirement: { id: requirement.id, version: requirement.version }, basis: basis.digest, model: snapshot.model.route, preferences: snapshot.preferenceVersion, prompt: 'trial-2' });
      const cached = record.trials.find(row => row.cacheKey === cacheKey);
      if (cached) { await this.verify(snapshot, abort); await this.support.hit(snapshot, String(value.clientRequestId), 'cache'); return cached; }
      const parsed = json(await this.host.structured(snapshot, 'trial', { originalRequirement: redact(requirement.text),
        progress: snapshot.progress, limitations: snapshot.limitations }, abort));
      if (!Array.isArray(parsed.steps) || !parsed.steps.length || parsed.steps.length > 6) invalid();
      const steps = parsed.steps.map((step: any, index) => ({ id: `s${index + 1}`, action: generatedText(step?.action, 500), expected: generatedText(step?.expected, 500) }));
      await this.verify(snapshot, abort);
      const result: TrialCard = { id: randomUUID(), projectId: snapshot.scope.projectId, scope: snapshot.scope, deliveryId: delivery?.id ?? requirement.id, requirementRef: { id: requirement.id, version: requirement.version },
        requestId: value.clientRequestId as string, requestDigest, cacheKey, requirement: requirement.text, basis, createdAt: now(), steps };
      abort.throwIfAborted();
      await this.store.updateProject(result.projectId, state => {
        if (hash(state.requirementRevisions) !== hash(record.requirementRevisions)) throw new GuideError('requirement_changed', '生成期间约定已更新，请重新准备试用。');
        state.trials.push(result);
      });
      return result;
    });
  }
  async feedback(value: unknown, signal: AbortSignal): Promise<TrialFeedback> {
    object(value, ['sessionId', 'projectId', 'clientRequestId', 'cardId', 'stepId', 'fileDigest', 'result', 'note']);
    requestId(value.clientRequestId); text(value.cardId, 200); text(value.stepId, 100); text(value.fileDigest, 100);
    if (value.result !== 'pass' && value.result !== 'fail') throw new GuideError('invalid_input', '请选择这一步的实际试用结果。');
    if (value.note !== undefined) text(value.note, 2000);
    const { snapshot, root } = await this.current(value, signal), requestDigest = hash(value);
    const record = await this.store.readProject(snapshot.scope.projectId), prior = record.feedback.find(row => row.id === value.clientRequestId);
    if (prior) { if (prior.requestDigest !== requestDigest) throw new GuideError('request_conflict', '同一反馈不能更换内容。'); return prior; }
    const card = record.trials.find(row => row.id === value.cardId);
    if (!card || !card.steps.some(step => step.id === value.stepId)) throw new GuideError('review_unavailable', '找不到这一步对应的试用记录。');
    if (card.requirementRef && !(await this.work.requirements.list(snapshot.scope)).items.some(row => row.id === card.requirementRef!.id && row.version === card.requirementRef!.version && row.state === 'active')) throw new GuideError('requirement_changed', '这条要求已变化，请为新要求重新准备试用。');
    const files = await this.scan(root);
    if (card.basis.digest !== files.digest || value.fileDigest !== files.digest) throw new GuideError('basis_changed', '项目文件已经变化，请先刷新并为当前版本准备试用步骤。旧反馈会保留。');
    await this.verify(snapshot, signal);
    const result: TrialFeedback = { id: value.clientRequestId, requestDigest, cardId: card.id, stepId: value.stepId,
      result: value.result, ...(value.note === undefined ? {} : { note: value.note as string }), createdAt: now() };
    await this.store.updateProject(snapshot.scope.projectId, state => {
      if (hash(state.requirementRevisions) !== hash(record.requirementRevisions)) throw new GuideError('requirement_changed', '保存时约定已经变化，请重新核对。');
      const duplicate = state.feedback.find(row => row.id === result.id);
      if (duplicate) { if (duplicate.requestDigest !== requestDigest) throw new GuideError('request_conflict', '这条反馈已经变化。'); return; }
      state.feedback.push(result);
    });
    return result;
  }
  async close() { this.closed = true; this.lifetime.abort(); await Promise.allSettled([...this.flights.values()].map(row => row.promise)); }
}
