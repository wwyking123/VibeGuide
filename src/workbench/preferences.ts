import { join } from 'node:path';
import type { Source } from '../continuity/store.js';
import { Ledger, digest, ensure, exact, identifier } from './ledger.js';

export const preferenceValues = {
  language: ['zh', 'en'], detail: ['concise', 'balanced', 'detailed'],
  explanation: ['action_first', 'reason_first'], technicality: ['plain', 'mixed', 'technical'],
  workflow: ['plan_first', 'prototype_first', 'small_steps'],
} as const;
export type Dimension = keyof typeof preferenceValues;
type Preference = { id: string; dimension: Dimension; value?: string; scope: 'personal' | 'project'; projectId?: string; state: 'active' | 'disabled' | 'deleted' | 'superseded'; source?: Source; sourceHash: string; updatedAt: string; replacedBy?: string };
type Preferences = { entries: Preference[]; sessions?: Record<string, { enabled: boolean; updatedAt: string }> };
function validate(data: Preferences) {
  exact(data, ['entries', 'sessions']); ensure(Array.isArray(data.entries) && data.entries.length <= 1000, 'Preference capacity reached.');
  if (data.sessions !== undefined) ensure(data.sessions && typeof data.sessions === 'object' && !Array.isArray(data.sessions) && Object.keys(data.sessions).length <= 1000 && Object.values(data.sessions).every(s => typeof s.enabled === 'boolean' && typeof s.updatedAt === 'string'), 'Invalid session preferences.');
  ensure(new Set(data.entries.map(p => p.id)).size === data.entries.length, 'Duplicate preference ID.');
  for (const p of data.entries) {
    exact(p, ['id', 'dimension', 'value', 'scope', 'projectId', 'state', 'source', 'sourceHash', 'updatedAt', 'replacedBy']); identifier(p.id);
    ensure(p.dimension in preferenceValues && ['personal', 'project'].includes(p.scope) && ['active', 'disabled', 'deleted', 'superseded'].includes(p.state), 'Invalid preference.');
    ensure(p.scope === 'personal' ? p.projectId === undefined : /^[a-f0-9]{64}$/.test(p.projectId ?? ''), 'Invalid preference scope.');
    ensure(/^[a-f0-9]{64}$/.test(p.sourceHash), 'Invalid preference source.');
    if (p.state !== 'deleted') ensure((preferenceValues[p.dimension] as readonly string[]).includes(p.value ?? '') && p.source?.messageId, 'Preference requires a supported value and native source.');
    else ensure(p.value === undefined && p.source === undefined, 'Deleted preference retains content.');
  }
}
export const preferencesFor = (storageRoot: string) => new Ledger<Preferences>(join(storageRoot, 'personal'), 'preferences.json', 'vibeguide-personal-preferences', () => ({ entries: [] }), validate, storageRoot);
const sourceHash = (s: Source) => digest({ messageId: s.messageId, questionId: s.questionId });
export function setPreference(data: Preferences, input: { id: string; dimension: Dimension; value: string; scope: 'personal' | 'project' }, projectId: string, source: Source) {
  identifier(input.id); ensure(input.dimension in preferenceValues && (preferenceValues[input.dimension] as readonly string[]).includes(input.value), 'Only supported communication preferences may be shared; business rules belong to the project.');
  ensure(['personal', 'project'].includes(input.scope), 'Specify preference scope.');
  if (input.scope === 'personal') ensure(/以后|今后|每次|默认|一直|始终|长期|所有项目|跨项目|从现在起|记住.*(?:喜欢|习惯|偏好)|always|by default|from now on|all projects|remember.*(?:prefer|like)/i.test(source.quote)
    && !/这次|此次|本次|本项目|这个项目|当前项目|该项目|this project|this workspace|this time/i.test(source.quote), 'Personal preferences need an explicit lasting instruction without a project/session-only restriction; otherwise use a session or project preference.');
  const fingerprint = sourceHash(source);
  ensure(!data.entries.some(p => p.id === input.id || p.state === 'deleted' && p.sourceHash === fingerprint), 'ID/source was already used or forgotten. A new user statement is required.');
  const scopeProject = input.scope === 'project' ? projectId : undefined;
  for (const p of data.entries) if (p.scope === input.scope && p.projectId === scopeProject && p.dimension === input.dimension && ['active', 'disabled'].includes(p.state)) { p.state = 'superseded'; p.replacedBy = input.id; }
  data.entries.push({ ...input, ...(scopeProject ? { projectId: scopeProject } : {}), state: 'active', source, sourceHash: fingerprint, updatedAt: new Date().toISOString() });
}
export function changePreference(data: Preferences, id: string, action: 'forget' | 'disable' | 'enable', projectId: string) {
  const found = data.entries.find(p => p.id === id && (p.scope === 'personal' || p.projectId === projectId));
  ensure(found && ['active', 'disabled'].includes(found.state), 'No applicable live preference.');
  if (action !== 'forget') { found.state = action === 'disable' ? 'disabled' : 'active'; found.updatedAt = new Date().toISOString(); return; }
  const ids = new Set([id]);
  for (let changed = true; changed;) { changed = false; for (const p of data.entries) if (p.replacedBy && ids.has(p.replacedBy) && !ids.has(p.id)) { ids.add(p.id); changed = true; } }
  for (const p of data.entries) if (ids.has(p.id)) { delete p.source; delete p.value; p.state = 'deleted'; p.updatedAt = new Date().toISOString(); }
}
export function visiblePreferences(data: Preferences, projectId: string) { return data.entries.filter(p => p.scope === 'personal' || p.projectId === projectId).map(p => {
  // A global preference's original sentence can contain unrelated project information.
  // Cross-project retrieval exposes only the bounded value and source location.
  const { source, ...entry } = p;
  return { ...entry, ...(source ? { provenance: { sessionId: source.sessionId, messageId: source.messageId, seq: source.seq, ...(source.questionId ? { questionId: source.questionId } : {}) } } : {}) };
}); }
export function effectivePreferences(data: Preferences, projectId: string) {
  const active = visiblePreferences(data, projectId).filter(p => p.state === 'active');
  const result = new Map<string, { dimension: string; value: string; scope: string }>();
  for (const scope of ['personal', 'project']) for (const p of active.filter(p => p.scope === scope)) result.set(p.dimension, { dimension: p.dimension, value: p.value!, scope: p.scope });
  return [...result.values()];
}
