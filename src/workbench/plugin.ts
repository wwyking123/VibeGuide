import { readFileSync } from 'node:fs';
import type { ProjectStore, Source } from '../continuity/store.js';
import type { Event } from '../continuity/sources.js';
import { bounded, digest, ensure, exact, identifier } from './ledger.js';
import { workbenchFor, kinds, strings, safeText, requireActive, requirementsHash, checkHash, evidenceStatus } from './state.js';
import type { Fact, Check, Workbench } from './state.js';
import { preferencesFor, preferenceValues, setPreference, changePreference, visiblePreferences, effectivePreferences } from './preferences.js';
import { readPage, taskContext, currentFacts } from './memory.js';
import { analyzeImpact } from './impact.js';
import { EvidenceObserver } from './evidence.js';
import { supabaseGuide, serviceStages } from './services.js';

const string = { type: 'string' }, list = { type: 'array', items: string };
const sourceSchema = { type: 'object', additionalProperties: false, properties: { seq: { type: 'integer' }, quote: string, questionId: string }, required: ['seq', 'quote'] };
export const workspaceSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    action: { type: 'string', enum: ['overview', 'read', 'fact', 'forget_fact', 'check', 'prepare', 'evidence', 'impact', 'guide', 'archive_task', 'select_task'] },
    id: string, expectedRevision: { type: 'integer' }, operationId: string, source: sourceSchema,
    collection: { type: 'string', enum: ['requirements', 'tasks', 'facts', 'checks', 'evidence'] }, cursor: string, limit: { type: 'integer' }, taskId: string, query: string, includeArchived: { type: 'boolean' },
    kind: { type: 'string', enum: kinds }, text: string, status: { type: 'string', enum: ['proposed', 'confirmed', 'observed'] },
    requirementIds: list, files: list, relatedIds: list, evidenceId: string, replaces: string,
    title: string, expected: string, external: { type: 'boolean' }, serviceStage: { type: 'string', enum: [...serviceStages] },
    checkId: string, seq: { type: 'integer' }, quote: string, interpretation: string,
    archive: { type: 'boolean' }, goal: string,
  }, required: ['action'],
};
export const preferenceSchema = {
  type: 'object', additionalProperties: false,
  properties: { action: { type: 'string', enum: ['read', 'set', 'forget', 'disable', 'enable', 'session'] },
    id: string, expectedRevision: { type: 'integer' }, operationId: string, source: sourceSchema,
    dimension: { type: 'string', enum: Object.keys(preferenceValues) }, value: string, scope: { type: 'string', enum: ['personal', 'project'] }, enabled: { type: 'boolean' } }, required: ['action'],
};
type Bindings = { storageRoot: string; storeFor: (agent: any) => Promise<ProjectStore>; source: (agent: any, reference: any, signal: AbortSignal) => Promise<Source>; events: (agent: any) => Promise<Event[]> };
const output = { schema: { type: 'object', additionalProperties: true }, render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }] };
function fields(args: any, allowed: string[], write = false) { exact(args, ['action', ...allowed, ...(write ? ['expectedRevision', 'operationId'] : [])]); }
function withoutDeletedDependencies(data: Workbench, deleted: Set<string>): Workbench {
  const checks = data.checks.filter(c => !c.requirementIds.some(id => deleted.has(id)));
  const checkIds = new Set(checks.map(c => c.id));
  const evidenceIds = new Set(data.evidence.filter(e => checkIds.has(e.checkId)).map(e => e.id));
  const forgotten = new Set(data.facts.filter(f => f.status === 'deleted' || f.requirementIds.some(id => deleted.has(id)) || f.evidenceId && !evidenceIds.has(f.evidenceId)).map(f => f.id));
  for (let added = true; added;) { added = false; for (const f of data.facts) if (!forgotten.has(f.id) && f.relatedIds.some(id => forgotten.has(id))) { forgotten.add(f.id); added = true; } }
  const facts = data.facts.map(f => {
    if (!forgotten.has(f.id)) return f;
    const { text: _text, source: _source, ...tombstone } = f;
    return { ...tombstone, status: 'deleted' as const };
  });
  return { ...data, facts, checks, preparations: data.preparations.filter(p => checkIds.has(p.checkId)), evidence: data.evidence.filter(e => checkIds.has(e.checkId)),
    ...(data.guide?.requirementIds.some(id => deleted.has(id)) ? { guide: undefined } : {}) };
}
export function registerWorkbench(ctx: any, bindings: Bindings) {
  const observer = new EvidenceObserver(bindings.storeFor);
  ctx.on('tools/result', (exec: any, result: any) => {
    if (!exec.agent) return;
    try { if (ctx.tools.get && !ctx.tools.get('vibeguide_workspace', exec.agent)) return; }
    catch { return; }
    observer.observe(exec, result);
  });
  ctx.systemPrompt.section({ name: 'vibeguide:workbench', order: 311, text: readFileSync(new URL('../../prompts/workbench.md', import.meta.url), 'utf8').trim() });
  const operation = (exec: any, args: any) => args.operationId ?? digest({ session: exec.agent.session.id, call: exec.callId });
  const load = async (agent: any) => {
    const store = await bindings.storeFor(agent), record = await store.read(), ledger = workbenchFor(store), book = await ledger.read();
    // A forgotten requirement must never return via an old associated summary/evidence page.
    const deleted = new Set(record.requirements.filter(r => r.status === 'deleted').map(r => r.id));
    return { store, record, ledger, book: { ...book, data: withoutDeletedDependencies(book.data, deleted) } };
  };
  ctx.tools.register({ name: 'vibeguide_workspace', parameters: workspaceSchema, output,
    description: 'Project consensus, paged memory, acceptance checks, native execution evidence, static impact and Supabase guidance. Read overview for revision. All writes need expectedRevision. fact requires id/kind/text/status/requirementIds/files/relatedIds (confirmed needs user source, observed needs evidenceId); check needs id/title/expected/requirementIds/files/external; prepare(checkId) BEFORE native bash, evidence(id,checkId,seq,quote,interpretation) AFTER. impact(files) is read-only. guide without goal returns instructions/templates; goal+requirementIds saves the service goal. Never writes application files, executes commands, contacts services or stores credentials.',
    execute: async (args: any, exec: any) => {
      ensure(exec.agent, 'Active agent required.');
      const { store, record, ledger, book } = await load(exec.agent);
      if (args.action === 'overview') {
        fields(args, []);
        const checks = await Promise.all(book.data.checks.map(async c => {
          const latest = book.data.evidence.filter(e => e.checkId === c.id).at(-1);
          const evidence = latest ? await evidenceStatus(store, book.data, record, latest) : undefined;
          return { id: c.id, title: c.title, requirementIds: c.requirementIds, evidence: evidence ? { id: evidence.id, execution: evidence.outcome, applicability: evidence.applicability, reasons: evidence.reasons, currentAvailability: evidence.currentAvailability, observedAt: evidence.observedAt } : null };
        }));
        return { revision: book.revision, projectRevision: record.revision, ...taskContext(record, book.data, exec.agent.session.id), counts: { facts: book.data.facts.filter(f => !['deleted', 'superseded'].includes(f.status)).length, checks: checks.length, evidence: book.data.evidence.length, archivedTasks: book.data.archivedTasks.length }, checks: checks.slice(0, 20), checksComplete: checks.length <= 20, guide: book.data.guide ?? null, note: 'execution=passed 只表示命令成功退出；业务是否满足 expected 需核对对应输出，不能据此把需求全部标为完成。' };
      }
      if (args.action === 'read') {
        fields(args, ['collection', 'taskId', 'query', 'includeArchived', 'cursor', 'limit']);
        const { action: _, ...input } = args; const page = readPage(record, book, input);
        if (args.collection === 'evidence') page.items = await Promise.all(page.items.map(e => evidenceStatus(store, book.data, record, e)));
        return page;
      }
      if (args.action === 'impact') { fields(args, ['files']); strings(args.files); return analyzeImpact(store, book.data, record, args.files); }
      if (args.action === 'guide' && args.goal === undefined) {
        fields(args, []);
        const guide = supabaseGuide();
        return { ...guide, savedGoal: book.data.guide ?? null, stages: await Promise.all(serviceStages.map(async stage => {
          const checks = book.data.checks.filter(c => c.serviceStage === stage);
          return { stage, checks: await Promise.all(checks.map(async c => { const latest = book.data.evidence.filter(e => e.checkId === c.id).at(-1); return { id: c.id, expected: c.expected, evidence: latest ? await evidenceStatus(store, book.data, record, latest) : null }; })), status: checks.length ? 'review_recorded_results' : 'not_checked' };
        })) };
      }
      const sessionId = exec.agent.session.id, now = new Date().toISOString();
      let source: Source | undefined;
      if (args.source) { source = await bindings.source(exec.agent, args.source, exec.signal); safeText(source.quote, 4000); }
      let mutate: (data: Workbench) => void | Promise<void>;
      switch (args.action) {
        case 'fact': {
          fields(args, ['id', 'kind', 'text', 'status', 'requirementIds', 'files', 'relatedIds', 'source', 'evidenceId', 'replaces'], true);
          identifier(args.id); ensure(kinds.includes(args.kind) && ['proposed', 'confirmed', 'observed'].includes(args.status), 'Invalid fact kind/status.'); safeText(args.text); requireActive(record, args.requirementIds); strings(args.files); strings(args.relatedIds, 100);
          for (const f of args.files) await store.stamp(f);
          ensure(args.status !== 'confirmed' || source, 'Confirmed consensus needs an actual user source.');
          const fact: Fact = { id: args.id, kind: args.kind, text: args.text, status: args.status, requirementIds: args.requirementIds, files: args.files, relatedIds: args.relatedIds, updatedAt: now,
            ...(source ? { source, sourceHash: digest({ messageId: source.messageId, questionId: source.questionId }) } : {}), ...(args.evidenceId ? { evidenceId: args.evidenceId } : {}), ...(args.replaces ? { replaces: args.replaces } : {}) };
          ensure(!fact.sourceHash || !record.requirements.some(r => r.status === 'deleted' && r.sourceHash === fact.sourceHash), 'This source was forgotten; do not recreate it as a project fact.');
          mutate = data => {
            ensure(!data.facts.some(f => f.id === fact.id || f.status === 'deleted' && fact.sourceHash && f.sourceHash === fact.sourceHash), 'Fact ID/source already used or forgotten.');
            ensure(fact.relatedIds.every(id => data.facts.some(f => f.id === id && !['deleted', 'superseded'].includes(f.status))), 'Unknown related fact.');
            if (args.replaces) { const prior = data.facts.find(f => f.id === args.replaces && !['deleted', 'superseded'].includes(f.status)); ensure(prior, 'Prior fact not active.'); ensure(prior.status !== 'confirmed' || fact.status === 'confirmed', 'An observation or proposal cannot replace confirmed consensus.'); prior.status = 'superseded'; }
            data.facts.push(fact);
          }; break;
        }
        case 'forget_fact': {
          fields(args, ['id', 'source'], true); ensure(source, 'User source required for forgetting.');
          mutate = data => { const found = data.facts.find(f => f.id === args.id && f.status !== 'deleted'); ensure(found, 'Unknown fact.'); const ids = new Set([found.id]);
            for (let changed = true; changed;) { changed = false; for (const f of data.facts) if (ids.has(f.id) && f.replaces && !ids.has(f.replaces)) { ids.add(f.replaces); changed = true; } }
            for (const f of data.facts) if (ids.has(f.id)) { delete f.text; delete f.source; f.status = 'deleted'; f.updatedAt = now; }
            Object.assign(data, withoutDeletedDependencies(data, new Set()));
          }; break;
        }
        case 'check': {
          fields(args, ['id', 'title', 'expected', 'requirementIds', 'files', 'external', 'serviceStage'], true);
          identifier(args.id); safeText(args.title, 300); safeText(args.expected); requireActive(record, args.requirementIds); ensure(args.requirementIds.length, 'Link the check to at least one requirement.'); strings(args.files); ensure(args.files.length && typeof args.external === 'boolean', 'Track the tested files/check script and explicitly mark external dependencies.');
          for (const f of args.files) await store.stamp(f);
          if (args.serviceStage) ensure((serviceStages as readonly string[]).includes(args.serviceStage), 'Unknown service stage.');
          const check: Check = { id: args.id, title: args.title, expected: args.expected, requirementIds: args.requirementIds, files: args.files, external: args.external, updatedAt: now, ...(args.serviceStage ? { serviceStage: args.serviceStage } : {}) };
          mutate = data => { const index = data.checks.findIndex(c => c.id === check.id); if (index < 0) data.checks.push(check); else data.checks[index] = check; }; break;
        }
        case 'prepare': {
          fields(args, ['checkId'], true); const check = book.data.checks.find(c => c.id === args.checkId); ensure(check, 'Create the check first.'); requireActive(record, check.requirementIds);
          const events = await bindings.events(exec.agent); const files = await Promise.all(check.files.map(f => store.stamp(f)));
          ensure(files.every(f => f.sha256 !== null), 'Implement the tested files/check script before preparing an execution.');
          const preparation = { checkId: check.id, sessionId, files, afterSeq: Math.max(-1, ...events.map(e => e.seq)), requirementsHash: requirementsHash(record, check.requirementIds), checkHash: checkHash(check), startedAt: now };
          mutate = data => { data.preparations = data.preparations.filter(p => !(p.checkId === check.id && p.sessionId === sessionId)); data.preparations.push(preparation); }; break;
        }
        case 'evidence': {
          fields(args, ['id', 'checkId', 'seq', 'quote', 'interpretation'], true); identifier(args.id); safeText(args.quote, 1000); safeText(args.interpretation); ensure(Number.isSafeInteger(args.seq) && args.seq >= 0, 'Native result seq required.');
          const proof = await observer.bind(store, sessionId, await bindings.events(exec.agent), args.seq, args.checkId, args.quote);
          const check = book.data.checks.find(c => c.id === args.checkId); ensure(check, 'Unknown check.');
          for (const f of proof.files) { try { proof.baselineValid &&= (await store.stamp(f.path)).sha256 === f.sha256; } catch { proof.baselineValid = false; } }
          proof.baselineValid &&= requirementsHash(await store.read(), check.requirementIds) === proof.requirementsHash;
          mutate = data => { ensure(!data.evidence.some(e => e.id === args.id), 'Evidence IDs are immutable.'); data.evidence.push({ id: args.id, checkId: args.checkId, ...proof, interpretation: args.interpretation }); }; break;
        }
        case 'archive_task': {
          fields(args, ['taskId', 'archive'], true); const task = record.tasks.find(t => t.id === args.taskId); ensure(task, 'Unknown task.'); ensure(typeof args.archive === 'boolean', 'Archive must be boolean.');
          ensure(!args.archive || ['completed', 'cancelled'].includes(task.status), 'Only completed/cancelled tasks can be archived; pausing is a separate user decision.');
          mutate = data => { data.archivedTasks = data.archivedTasks.filter(id => id !== task.id); if (args.archive) { data.archivedTasks.push(task.id); for (const [session, id] of Object.entries(data.selectedTasks)) if (id === task.id) delete data.selectedTasks[session]; } }; break;
        }
        case 'select_task': {
          fields(args, ['taskId'], true); ensure(record.tasks.some(t => t.id === args.taskId && ['in_progress', 'needs_check'].includes(t.status)) && !book.data.archivedTasks.includes(args.taskId), 'Select an active task. Inspect historical tasks with read; resume paused/cancelled work only with a new user instruction.');
          mutate = data => { data.selectedTasks[sessionId] = args.taskId; const keys = Object.keys(data.selectedTasks); if (keys.length > 100) delete data.selectedTasks[keys[0]!]; }; break;
        }
        case 'guide': {
          fields(args, ['goal', 'requirementIds'], true); safeText(args.goal); requireActive(record, args.requirementIds); ensure(args.requirementIds.length, 'Service guide needs a confirmed project requirement.');
          mutate = data => { data.guide = { service: 'supabase', goal: args.goal, requirementIds: args.requirementIds, startedAt: now }; }; break;
        }
        default: throw new Error('Unknown workspace action.');
      }
      return ledger.update(args.expectedRevision, operation(exec, args), { sessionId, args }, async data => {
        const current = await store.read(); ensure(current.revision === record.revision, 'Project requirements changed; reload before saving dependent records.');
        const filtered = withoutDeletedDependencies(data, new Set(current.requirements.filter(r => r.status === 'deleted').map(r => r.id)));
        Object.assign(data, filtered); await mutate(data);
      }, exec.signal);
    },
  });
  ctx.tools.register({ name: 'vibeguide_preferences', parameters: preferenceSchema, output,
    description: 'Explicit communication preferences only. read shows supported dimensions/values and revision. set requires id,dimension,value,scope(personal/project),source,expectedRevision; personal needs an explicit lasting instruction. Project overrides personal. session(enabled=false/true,source) temporarily ignores/restores preferences for this session only; requirements remain active. forget/disable/enable require id/source/revision. Never stores business rules or free-form global instructions.',
    execute: async (args: any, exec: any) => {
      ensure(exec.agent, 'Active agent required.'); const store = await bindings.storeFor(exec.agent), ledger = preferencesFor(bindings.storageRoot), book = await ledger.read(); const sessionId = exec.agent.session.id;
      if (args.action === 'read') { fields(args, []); return { revision: book.revision, supported: preferenceValues, enabledInThisSession: book.data.sessions?.[sessionId]?.enabled !== false, entries: visiblePreferences(book.data, store.projectId), effective: book.data.sessions?.[sessionId]?.enabled === false ? [] : effectivePreferences(book.data, store.projectId) }; }
      const source = await bindings.source(exec.agent, args.source, exec.signal); safeText(source.quote, 4000);
      if (args.action === 'session') {
        fields(args, ['enabled', 'source']); ensure(typeof args.enabled === 'boolean', 'Enabled must be boolean.');
        const result = await ledger.update(book.revision, operation(exec, args), { sessionId, args }, data => {
          data.sessions ??= {}; Object.defineProperty(data.sessions, sessionId, { value: { enabled: args.enabled, updatedAt: new Date().toISOString() }, enumerable: true, configurable: true, writable: true });
        }, exec.signal);
        return { ...result, status: ['saved', 'unchanged'].includes(result.status) ? 'session_only' : result.status, enabled: args.enabled, projectRequirementsUnchanged: true };
      }
      if (args.action === 'set') fields(args, ['id', 'dimension', 'value', 'scope', 'source'], true);
      else { fields(args, ['id', 'source'], true); ensure(['forget', 'disable', 'enable'].includes(args.action), 'Unsupported preference action.'); }
      return ledger.update(args.expectedRevision, operation(exec, args), { sessionId, args }, data => {
        if (args.action === 'set') setPreference(data, { id: args.id, dimension: args.dimension, value: args.value, scope: args.scope }, store.projectId, source);
        else changePreference(data, args.id, args.action, store.projectId);
      }, exec.signal);
    },
  });
  return {
    async context(agent: any) {
      const { store, record, book } = await load(agent), context = taskContext(record, book.data, agent.session.id);
      let preferences: unknown;
      try { const personal = (await preferencesFor(bindings.storageRoot).read()).data; preferences = personal.sessions?.[agent.session.id]?.enabled === false ? { temporarilyDisabled: true } : effectivePreferences(personal, store.projectId); }
      catch { preferences = { unavailable: true, note: '个人偏好暂不可读，遵循当前对话要求，不妨碍项目工作。' }; }
      const facts = currentFacts(record, book.data);
      const compact: Fact[] = []; let size = 0;
      for (const f of facts) { const n = JSON.stringify(f).length; if (size + n > 4500) break; compact.push(f); size += n; }
      return { ...context, revision: { project: record.revision, workbench: book.revision }, projectFacts: compact, factsComplete: compact.length === facts.length, factCount: facts.length,
        checks: { defined: book.data.checks.length, evidence: book.data.evidence.length, note: '需要完成说明或当前可用结论时，调用 overview/read evidence 核对适用性。' }, preferences,
        factsNeedingReview: book.data.facts.filter(f => !['deleted', 'superseded'].includes(f.status) && !facts.includes(f)).length,
        archivedTaskCount: book.data.archivedTasks.length, guide: book.data.guide ?? null };
    },
    async scrub(agent: any) {
      const { store, record, ledger } = await load(agent), latest = await ledger.read();
      const cleaned = withoutDeletedDependencies(latest.data, new Set(record.requirements.filter(r => r.status === 'deleted').map(r => r.id)));
      if (digest(cleaned) === digest(latest.data)) return { status: 'unchanged' };
      // Facts linked to forgotten requirements are removed; original source tombstones remain in project.json.
      return ledger.update(latest.revision, digest({ project: store.projectId, deletedRevision: record.revision }), { deletedRevision: record.revision }, data => { Object.assign(data, cleaned); });
    },
  };
}
