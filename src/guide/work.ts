import { troubleView } from './trouble.js';
import type { GuideSupport } from './support.js';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { GuideError, object, requestId, text } from './contracts.js';
import type { FileBasis, GuideSnapshot } from './contracts.js';
import type { HarnessAdapter } from './host/adapter.js';
import type { GuideStore } from './store.js';
import type { ProjectRecord } from './project-types.js';
import type { Analysis, OutcomeBinding, RequirementRevision, WorkView } from './work-types.js';
import { captureFiles, hash } from './files.js';
import { Requirements, applyRequirementRevisions, requirementVersion, validateRequirementRefs } from './requirements.js';
import { assessOutcome, currentChange, opKey } from './outcomes.js';
import { projectEvidence } from './project-scan.js';
import { redact } from './privacy.js';

export const requirementBasis = (items: WorkView['requirements']) => hash(items.map(row => ({ id: row.id, version: row.version })));
export function analysisKind(question: string): Analysis['kind'] | undefined {
  if (/(卡住|修不好|反复失败|连续失败|一直失败|报错|排查|为什么.*失败|stuck|keeps? failing|troubleshoot)/i.test(question)) return 'trouble';
  if (/(?:改了什么|改了哪些|实际改动|这次改动|刚才.*(?:改|变化)|最近.*(?:改|变化)|what.*chang)/i.test(question)) return 'changes';
  if (/(?:涉及哪些|哪些部分|哪些地方|改哪里|改哪|从哪里|需要.*(?:部分|模块)|哪些.*(?:影响|调整)|where.*chang)/i.test(question)) return 'goal';
}
function invalid(): never { throw new GuideError('invalid_generation', '这次讲解无法对应实际资料，未保存。可以换个具体问题再试。'); }
const string = (value: unknown, max = 1000): string => typeof value === 'string' && value.trim() && value.length <= max ? redact(value.trim()) : invalid();
const list = (value: unknown, max = 8): string[] => Array.isArray(value) && value.length <= max ? value.map(row => string(row)) : invalid();

/** Work meaning never comes from a model's claim of completion. */
export class WorkService {
  readonly requirements: Requirements;
  constructor(readonly host: HarnessAdapter, readonly store: GuideStore, readonly support?: GuideSupport) { this.requirements = new Requirements(store); }
  async current(value: Record<string, unknown>, signal: AbortSignal) {
    text(value.sessionId, 200); text(value.projectId, 100); signal.throwIfAborted();
    const snapshot = await this.host.snapshot(value.sessionId, signal), project = await this.host.projectFor(value.sessionId);
    if (!snapshot.enabled || !project.enabled) throw new GuideError('mode_required', '请回主对话选择 VibeGuide 模式。');
    if (snapshot.scope.projectId !== value.projectId || project.scope.projectId !== value.projectId) throw new GuideError('scope_changed', '项目已变化，请刷新后重试。');
    return { snapshot, root: project.root };
  }
  scan(root: string) { return captureFiles(root, 250, [dirname(this.store.directory)]); }
  /** One freshness decision for cards, history and follow-up material, before UI limits. */
  async state(snapshot: GuideSnapshot, files: FileBasis, project: ProjectRecord) {
    const { items, sessions, incomplete } = await this.requirements.list(snapshot.scope), basis = requirementBasis(items);
    const excluded = new Set(sessions.flatMap(row => row.explanations).filter(row => project.annotations.some(note => note.explanationId === row.id)).map(row => row.analysisId));
    const trouble = troubleView(snapshot.scope, sessions, project, files, incomplete);
    const prefs = (await this.support?.preferences(snapshot.scope.projectId))?.preferenceVersion;
    const analyses = project.analyses.filter(row => row.kind !== 'trouble' || row.scope.sessionId === snapshot.scope.sessionId).map(row => ({ ...row, historical: incomplete || !!(row.preferenceVersion && row.preferenceVersion !== prefs || row.troubleVersion && row.troubleVersion !== trouble.version) || row.basis.digest !== files.digest || row.requirementBasis !== basis || excluded.has(row.id) }));
    return { items, sessions, incomplete, trouble, analyses };
  }
  async view(snapshot: GuideSnapshot, files: FileBasis, project: ProjectRecord): Promise<WorkView> {
    const { items, sessions, incomplete, trouble, analyses } = await this.state(snapshot, files, project);
    return { requirements: items, historyIncomplete: incomplete, trouble,
      outcomes: items.filter(row => row.state === 'active').map(row => { const outcome = assessOutcome(row, project, sessions, files); if (incomplete && outcome.state === 'complete') { outcome.state = 'needs_checks'; outcome.message = '部分历史未能核对，暂不能确认完成'; outcome.missing.push('需要补齐缺失的操作记录'); } return outcome; }),
      analyses: analyses.slice(-20) };
  }
  async revise(value: unknown, signal: AbortSignal): Promise<RequirementRevision> {
    object(value, ['sessionId', 'projectId', 'clientRequestId', 'requirement', 'text', 'state', 'applicability']);
    requestId(value.clientRequestId); validateRequirementRefs([value.requirement]); text(value.text, 12000);
    if (!['active', 'retired'].includes(value.state as string) || !['related', 'project'].includes(value.applicability as string)) throw new GuideError('invalid_input', '请选择约定是否继续使用和适用范围。');
    const { snapshot } = await this.current(value, signal), requestDigest = hash(value), ref = value.requirement as { id: string; version: string };
    const project = await this.store.readProject(snapshot.scope.projectId), prior = project.requirementRevisions.find(row => row.requestId === value.clientRequestId);
    if (prior) { if (prior.requestDigest !== requestDigest) throw new GuideError('request_conflict', '同一保存请求不能更换内容。'); return prior; }
    const target = (await this.requirements.list(snapshot.scope)).items.find(row => row.id === ref.id && row.version === ref.version);
    if (!target) throw new GuideError('requirement_changed', '这条约定已变化，请刷新后核对。');
    const result: RequirementRevision = { id: target.id, requestId: value.clientRequestId, requestDigest, previous: target.version,
      version: '', text: value.text as string, state: value.state as RequirementRevision['state'], applicability: value.applicability as RequirementRevision['applicability'], createdAt: new Date().toISOString() };
    result.version = requirementVersion(result);
    await this.current(value, signal);
    await this.store.updateProject(snapshot.scope.projectId, record => {
      const latest = applyRequirementRevisions({ ...target, text: target.originalText }, record.requirementRevisions);
      if (latest.version !== ref.version) throw new GuideError('requirement_changed', '这条约定刚被修改，请刷新。');
      record.requirementRevisions.push(result);
    });
    return result;
  }
  async bind(value: unknown, signal: AbortSignal): Promise<OutcomeBinding> {
    object(value, ['sessionId', 'projectId', 'clientRequestId', 'requirement', 'trialId', 'evidenceVersion', 'coverage', 'scopeConfirmed']);
    requestId(value.clientRequestId); validateRequirementRefs([value.requirement]); text(value.trialId, 200); text(value.evidenceVersion, 100);
    if (value.scopeConfirmed !== true || !Array.isArray(value.coverage) || !value.coverage.length || value.coverage.length > 6) throw new GuideError('invalid_input', '请先核对这些步骤覆盖你的要求，以及对应的实际改动和检查。');
    const { snapshot, root } = await this.current(value, signal), requestDigest = hash(value), project = await this.store.readProject(snapshot.scope.projectId);
    const prior = project.bindings.find(row => row.id === value.clientRequestId);
    if (prior) { if (prior.requestDigest !== requestDigest) throw new GuideError('request_conflict', '同一核对请求不能更换内容。'); return prior; }
    const { items, sessions, incomplete } = await this.requirements.list(snapshot.scope), ref = value.requirement as { id: string; version: string };
    const requirement = items.find(row => row.id === ref.id && row.version === ref.version && row.state === 'active'), trial = project.trials.find(row => row.id === value.trialId);
    if (!requirement || !trial || trial.requirementRef?.id !== ref.id || trial.requirementRef.version !== ref.version) throw new GuideError('requirement_changed', '要求或试用范围已经变化，请重新核对。');
    const basis = await this.scan(root), outcome = assessOutcome(requirement, project, sessions, basis);
    if (!basis.complete || trial.basis.digest !== basis.digest || outcome.trialId !== trial.id || outcome.evidenceVersion !== value.evidenceVersion) throw new GuideError('basis_changed', '文件或检查已经变化，请刷新核对最新记录。');
    const coverage = value.coverage as OutcomeBinding['coverage'];
    if (coverage.length !== trial.steps.length || new Set(coverage.map(row => row.stepId)).size !== coverage.length) throw new GuideError('invalid_input', '需要逐项核对完整试用范围。');
    for (const row of coverage) {
      object(row, ['stepId', 'changes', 'checks']);
      if (!trial.steps.some(step => step.id === row.stepId)) throw new GuideError('invalid_input', '试用步骤无法对应。');
      for (const [kind, refs] of [['change', row.changes], ['check', row.checks]] as const) {
        if (!Array.isArray(refs) || !refs.length || refs.length > 20 || new Set(refs.map(opKey)).size !== refs.length) throw new GuideError('invalid_input', '每一步需要选择实际改动和对应检查。');
        for (const candidate of refs) {
          object(candidate, ['sessionId', 'id']); text(candidate.sessionId, 200); text(candidate.id, 300);
          if (!outcome.candidates.some(item => opKey(item.ref) === opKey(candidate) && item.kind === kind && item.current)) throw new GuideError('basis_changed', '选中的改动或检查不再适用于当前版本。');
        }
      }
    }
    await this.current(value, signal);
    const latest = await this.requirements.list(snapshot.scope), latestFiles = await this.scan(root);
    if (requirementBasis(items) !== requirementBasis(latest.items) || assessOutcome(requirement, project, latest.sessions, latestFiles).evidenceVersion !== value.evidenceVersion) throw new GuideError('basis_changed', '核对期间有新的变化，请刷新。');
    const result: OutcomeBinding = { id: value.clientRequestId, requestDigest, projectId: snapshot.scope.projectId, requirement: ref,
      trialId: trial.id, basis, createdAt: new Date().toISOString(), version: hash({ requestDigest, basis: basis.digest }), coverage, authority: 'owner-confirmed' };
    await this.store.updateProject(snapshot.scope.projectId, state => {
      if (hash(state.requirementRevisions) !== hash(project.requirementRevisions) || state.trials.filter(card => card.requirementRef?.id === ref.id).at(-1)?.id !== trial.id) throw new GuideError('requirement_changed', '要求已变化，请重新核对。');
      if (!state.bindings.some(row => row.id === result.id)) state.bindings.push(result);
    });
    return result;
  }
  async analyze(value: Record<string, unknown>, signal: AbortSignal): Promise<Analysis> {
    object(value, ['sessionId', 'projectId', 'clientRequestId', 'kind', 'question']); requestId(value.clientRequestId); text(value.question, 12000);
    if (value.kind !== 'goal' && value.kind !== 'changes' && value.kind !== 'trouble') throw new GuideError('invalid_input', '请选择改动影响或目标定位。');
    const { snapshot, root } = await this.current(value, signal);
    snapshot.preferenceVersion = (await this.support?.preferences(snapshot.scope.projectId))?.preferenceVersion;
    const project = await this.store.readProject(snapshot.scope.projectId), requestDigest = hash(value);
    const prior = project.analyses.find(row => row.requestId === value.clientRequestId);
    if (prior) { if (prior.requestDigest !== requestDigest) throw new GuideError('request_conflict', '同一讲解请求不能更换内容。'); return prior; }
    const { items, sessions, incomplete } = await this.requirements.list(snapshot.scope), workBasis = requirementBasis(items), basis = await this.scan(root);
    const trouble = troubleView(snapshot.scope, sessions, project, basis, incomplete);
    const operations = sessions.flatMap(row => row.operations).filter(op => op.changedFiles.length && op.endedAt).sort((a, b) => a.endedAt!.localeCompare(b.endedAt!)).slice(-12);
    let remaining = 16000;
    const changes = operations.filter(op => currentChange(op, basis)).flatMap(op => (op.sourceChanges ?? []).map(change => ({ ...change, operation: op.id })))
      .filter(change => { const size = change.before.length + change.after.length; if (size > remaining) return false; remaining -= size; return true; });
    const evidence = await projectEvidence(root, [dirname(this.store.directory)], signal, { basis, priority: operations.flatMap(op => op.changedFiles) });
    const overview = project.overviews.at(-1), cacheKey = hash({ basis: basis.digest, workBasis, changes, trouble: value.kind === 'trouble' ? trouble.version : undefined, model: snapshot.model, question: value.question, kind: value.kind, overview: overview?.id, preferences: snapshot.preferenceVersion, prompt: 'work-1' });
    const excludedAnalyses = new Set(sessions.flatMap(session => session.explanations).filter(answer => project.annotations.some(note => note.explanationId === answer.id)).map(answer => answer.analysisId));
    const cached = project.analyses.find(row => row.cacheKey === cacheKey && !excludedAnalyses.has(row.id));
    if (cached) { await this.support?.hit(snapshot, String(value.clientRequestId), 'cache'); return cached; }
    const source = { trouble: value.kind === 'trouble' ? { ...trouble, attempts: trouble.attempts.map(row => ({ ...row, diagnostic: row.diagnostic?.slice(0, 700) })) } : undefined, question: redact(value.question as string), kind: value.kind,
      requirements: items.filter(row => row.state === 'active').slice(0, 6).map(row => ({ text: redact(row.text).slice(0, 1000) })),
      coverage: { complete: basis.complete, sampled: evidence.snippets.length, observedChanges: operations.reduce((sum, op) => sum + op.changedFiles.length, 0), capturedBeforeAfter: changes.length },
      changes: value.kind === 'trouble' ? [] : changes, files: evidence.snippets.slice(0, value.kind === 'trouble' ? 4 : 8), overview: overview && { historical: overview.basis.digest !== basis.digest, nodes: overview.nodes } };
    let parsed: any;
    try { parsed = (value.kind === 'trouble' && !trouble.attempts.length && !trouble.feedback.length) || value.kind === 'changes' && !changes.length ? { summary: '无法确认实际改动', impacts: [], nodes: [], possibleAdditions: [], unknowns: [], sources: [] } : JSON.parse(await this.host.structured(snapshot, value.kind, source, signal)); } catch (e) { if (e instanceof GuideError || signal.aborted) throw e; invalid(); }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.nodes) || parsed.nodes.length > 8) invalid();
    const allowed = new Set([...source.files.map(row => row.file), ...source.changes.map(row => row.file)]), sources = list(parsed.sources, 24);
    if (sources.some(file => !allowed.has(file))) invalid();
    const nodes: Analysis['nodes'] = parsed.nodes.map((node: any) => {
      const files = list(node.files, 24);
      if (!files.length || files.some(file => !allowed.has(file))) invalid();
      const existing = node.id ? overview?.nodes.find(row => row.id === node.id) : undefined;
      if (node.id && (!existing || !files.some(file => existing.files.includes(file)))) invalid();
      return { ...(existing ? { id: existing.id } : {}), title: existing?.title ?? string(node.title, 50), reason: string(node.reason), files };
    });
    const result: Analysis = { id: randomUUID(), projectId: snapshot.scope.projectId, scope: snapshot.scope,
      requestId: value.clientRequestId as string, requestDigest, cacheKey, kind: value.kind, question: value.question as string,
      createdAt: new Date().toISOString(), basis, requirementBasis: workBasis, preferenceVersion: snapshot.preferenceVersion,
      ...(value.kind === 'trouble' ? { troubleVersion: trouble.version, nextSteps: [] } : {}), overviewId: overview?.id,
      summary: string(parsed.summary), impacts: list(parsed.impacts), unknowns: list(parsed.unknowns), nodes,
      possibleAdditions: list(parsed.possibleAdditions), sources, observedChanges: source.coverage.observedChanges, coveredChanges: changes.length };
    if (value.kind === 'trouble') {
      if (!trouble.attempts.length && !trouble.feedback.length) {
        result.summary = '目前没有可核对的尝试或失败记录。请描述你看到的现象、想达到的效果，以及试过什么。';
        result.unknowns = ['仅凭“卡住”还不能判断原因。'];
      } else {
        if (!Array.isArray(parsed.nextSteps) || parsed.nextSteps.length > 3) invalid();
        result.nextSteps = parsed.nextSteps.map((step: any) => ({ label: string(step.label, 80), reason: string(step.reason, 600), request: string(step.request, 2000) }));
        result.unknowns.push('建议尚未执行；连续失败只表示同一检查未通过，不证明同一原因。');
      }
    }
    if (value.kind === 'changes' && !changes.length) {
      result.summary = '目前没有可核对的改动前后内容，无法可靠说明这次具体改变了什么。'; result.impacts = []; result.nodes = [];
      result.unknowns.unshift('插件启用前的改动、并发改动或未能读取的内容，需要实际资料后才能解释。');
    }
    if (changes.some(row => !row.complete)) result.unknowns.push('部分改动前后只读取了摘录，未覆盖完整文件。');
    await this.current(value, signal); signal.throwIfAborted();
    await this.store.updateProject(snapshot.scope.projectId, state => state.analyses.push(result));
    return result;
  }
}
