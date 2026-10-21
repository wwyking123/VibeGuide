import type { Source, FileStamp, ProjectRecord } from '../continuity/store.js';
import { Ledger, bounded, digest, ensure, exact, identifier } from './ledger.js';
import type { ProjectStore } from '../continuity/store.js';

export type FactKind = 'audience' | 'role' | 'workflow' | 'data_location' | 'term' | 'module';
export type Fact = { id: string; kind: FactKind; text?: string; status: 'proposed' | 'confirmed' | 'observed' | 'superseded' | 'deleted'; source?: Source; sourceHash?: string; requirementIds: string[]; files: string[]; relatedIds: string[]; evidenceId?: string; replaces?: string; updatedAt: string };
export type Check = { id: string; requirementIds: string[]; title: string; expected: string; files: string[]; external: boolean; serviceStage?: string; updatedAt: string };
export type Preparation = { checkId: string; sessionId: string; afterSeq: number; files: FileStamp[]; requirementsHash: string; checkHash: string; startedAt: string };
export type Evidence = { id: string; checkId: string; sessionId: string; seq: number; callId: string; toolName: string; resultHash: string; invocationHash: string; command: string; quote: string; outcome: 'passed' | 'failed' | 'unknown'; interpretation: string; observedAt: string; files: FileStamp[]; requirementsHash: string; checkHash: string; baselineValid: boolean };
export type Workbench = { facts: Fact[]; checks: Check[]; preparations: Preparation[]; evidence: Evidence[]; archivedTasks: string[]; selectedTasks: Record<string, string>; guide?: { service: 'supabase'; goal: string; requirementIds: string[]; startedAt: string } };
export const blankWorkbench = (): Workbench => ({ facts: [], checks: [], preparations: [], evidence: [], archivedTasks: [], selectedTasks: {} });
export const kinds = ['audience', 'role', 'workflow', 'data_location', 'term', 'module'];
export function strings(value: unknown, max = 20): asserts value is string[] { ensure(Array.isArray(value) && value.length <= max && value.every(s => typeof s === 'string' && !!s.trim() && s.length <= 500) && new Set(value).size === value.length, 'Invalid or duplicate list.'); }
export function safeText(value: unknown, max = 2000): asserts value is string {
  bounded(value, max);
  ensure(!/(?:sb_secret_|sb_publishable_|sk_live_|sk_test_|eyJ[a-zA-Z0-9_-]{15,}\.|-----BEGIN [\w ]*PRIVATE KEY-----|(?:api[_-]?key|access[_-]?token|password|密码|密钥)\s*[:=]\s*\S{8,})/i.test(value), 'Credentials must stay in the host credential mechanism, not project records.');
}
function refs(value: unknown) { strings(value, 100); for (const id of value) identifier(id); }
export function validateWorkbench(data: Workbench) {
  exact(data, ['facts', 'checks', 'preparations', 'evidence', 'archivedTasks', 'selectedTasks', 'guide']);
  for (const field of ['facts', 'checks', 'preparations', 'evidence'] as const) ensure(Array.isArray(data[field]) && data[field].length <= (field === 'preparations' ? 100 : 2000), 'Workbench capacity exceeded.');
  for (const field of ['facts', 'checks', 'evidence'] as const) ensure(new Set(data[field].map(v => v.id)).size === data[field].length, 'Duplicate record IDs.');
  for (const f of data.facts) {
    exact(f, ['id', 'kind', 'text', 'status', 'source', 'sourceHash', 'requirementIds', 'files', 'relatedIds', 'evidenceId', 'replaces', 'updatedAt']); identifier(f.id);
    ensure(kinds.includes(f.kind) && ['proposed', 'confirmed', 'observed', 'superseded', 'deleted'].includes(f.status), 'Invalid project fact.');
    if (f.status !== 'deleted') safeText(f.text); else ensure(f.text === undefined && f.source === undefined, 'Deleted fact retains content.');
    if (f.status === 'confirmed') ensure(f.source && typeof f.source.messageId === 'string', 'Confirmed fact needs a native user source.');
    if (f.status === 'observed') ensure(f.evidenceId && data.evidence.some(e => e.id === f.evidenceId), 'Observed fact needs evidence.');
    refs(f.requirementIds); strings(f.files); refs(f.relatedIds); bounded(f.updatedAt, 100);
  }
  for (const c of data.checks) { exact(c, ['id', 'requirementIds', 'title', 'expected', 'files', 'external', 'serviceStage', 'updatedAt']); identifier(c.id); refs(c.requirementIds); ensure(c.requirementIds.length, 'Check must reference requirements.'); safeText(c.title, 300); safeText(c.expected); strings(c.files); ensure(typeof c.external === 'boolean', 'Invalid external flag.'); if (c.serviceStage) ensure(['configuration', 'connection', 'permissions', 'business', 'recovery'].includes(c.serviceStage), 'Invalid guide stage.'); }
  for (const e of data.evidence) { identifier(e.id); ensure(data.checks.some(c => c.id === e.checkId), 'Evidence check missing.'); safeText(e.quote, 1000); safeText(e.interpretation); ensure(['passed', 'failed', 'unknown'].includes(e.outcome), 'Invalid evidence outcome.'); ensure(/^[a-f0-9]{64}$/.test(e.resultHash) && Array.isArray(e.files) && typeof e.baselineValid === 'boolean', 'Corrupt evidence.'); }
  strings(data.archivedTasks, 1000); for (const id of data.archivedTasks) identifier(id); ensure(data.selectedTasks && typeof data.selectedTasks === 'object' && !Array.isArray(data.selectedTasks) && Object.values(data.selectedTasks).every(v => typeof v === 'string'), 'Invalid task selection.');
  if (data.guide) { ensure(data.guide.service === 'supabase', 'Unsupported service.'); safeText(data.guide.goal); refs(data.guide.requirementIds); }
}
export const workbenchFor = (store: ProjectStore) => new Ledger(store.directory, 'workbench.json', store.projectId, blankWorkbench, validateWorkbench, store.storageRoot);
export function requirementsHash(record: ProjectRecord, ids: string[]) {
  return digest(ids.map(id => { const r = record.requirements.find(r => r.id === id); return r ? { id: r.id, text: r.text, kind: r.kind, status: r.status, replacedBy: r.replacedBy } : { id, missing: true }; }));
}
export function checkHash(check: Check) { const { updatedAt, ...definition } = check; return digest(definition); }
export function requireActive(record: ProjectRecord, ids: string[]) { refs(ids); ensure(ids.every(id => record.requirements.some(r => r.id === id && r.status === 'active')), 'Reference only current active requirements.'); }
export async function evidenceStatus(store: ProjectStore, state: Workbench, record: ProjectRecord, evidence: Evidence) {
  const check = state.checks.find(c => c.id === evidence.checkId);
  const reasons: string[] = [];
  if (!check || checkHash(check) !== evidence.checkHash) reasons.push('验收条件已更新');
  if (!check || requirementsHash(record, check.requirementIds) !== evidence.requirementsHash) reasons.push('对应要求已改变或删除');
  if (!evidence.baselineValid) reasons.push('检查前后的文件或要求不一致，无法绑定到当前版本');
  for (const f of evidence.files) { try { if ((await store.stamp(f.path)).sha256 !== f.sha256) reasons.push(`文件已变化：${f.path}`); } catch { reasons.push(`文件无法核对：${f.path}`); } }
  return { ...evidence, applicability: reasons.length ? 'stale' : 'unchanged_scope', reasons, currentAvailability: check?.external ? 'needs_live_check' : 'not_a_runtime_check', note: '工具执行结果与业务解释分别保存；范围未变不代表服务现在可用，也不代表所有业务已通过。' };
}
