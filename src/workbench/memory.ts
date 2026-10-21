import type { ProjectRecord } from '../continuity/store.js';
import type { Workbench } from './state.js';
import { digest, ensure } from './ledger.js';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
const cursorKey = randomBytes(32);
const signCursor = (identity: string, offset: number) => createHmac('sha256', cursorKey).update(JSON.stringify({ identity, offset })).digest('hex');
export type PageQuery = { collection: 'requirements' | 'tasks' | 'facts' | 'checks' | 'evidence'; taskId?: string; query?: string; includeArchived?: boolean; cursor?: string; limit?: number };
export function currentFacts(record: ProjectRecord, book: Workbench) {
  const active = new Set(record.requirements.filter(r => r.status === 'active').map(r => r.id));
  const invalid = new Set(book.facts.filter(f => ['deleted', 'superseded'].includes(f.status) || f.requirementIds.some(id => !active.has(id))).map(f => f.id));
  for (let changed = true; changed;) { changed = false; for (const f of book.facts) if (!invalid.has(f.id) && f.relatedIds.some(id => invalid.has(id))) { invalid.add(f.id); changed = true; } }
  return book.facts.filter(f => !invalid.has(f.id));
}
export function readPage(record: ProjectRecord, book: { revision: number; data: Workbench }, input: PageQuery) {
  const limit = input.limit ?? 12;
  ensure(Number.isSafeInteger(limit) && limit >= 1 && limit <= 30, 'Page size must be 1–30.');
  ensure(['requirements', 'tasks', 'facts', 'checks', 'evidence'].includes(input.collection), 'Unknown collection.');
  if (input.query !== undefined) ensure(typeof input.query === 'string' && input.query.length <= 200, 'Search text too long.');
  if (input.taskId) ensure(record.tasks.some(t => t.id === input.taskId), 'Unknown task.');
  const { cursor, ...filter } = input;
  const identity = digest({ project: record.projectId, projectRevision: record.revision, bookRevision: book.revision, filter });
  let offset = 0;
  if (cursor) {
    ensure(typeof cursor === 'string' && cursor.length <= 1000, 'Invalid cursor.');
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    ensure(decoded.identity === identity, 'Page cursor is stale or belongs to another query/project. Restart from the first page.');
    ensure(Number.isSafeInteger(decoded.offset) && decoded.offset >= 0, 'Invalid cursor offset.');
    ensure(typeof decoded.signature === 'string' && /^[a-f0-9]{64}$/.test(decoded.signature) && timingSafeEqual(Buffer.from(decoded.signature, 'hex'), Buffer.from(signCursor(identity, decoded.offset), 'hex')), 'Page cursor was modified or belongs to an earlier process. Restart from the first page.');
    offset = decoded.offset;
  }
  let rows: any[];
  const requirements = record.requirements.filter(r => r.status === 'active' && (!input.taskId || !r.taskId || r.taskId === input.taskId));
  switch (input.collection) {
    case 'requirements': rows = requirements; break;
    case 'tasks': rows = record.tasks.filter(t => (input.includeArchived || !book.data.archivedTasks.includes(t.id)) && (!input.taskId || input.taskId === t.id)); break;
    case 'facts': { const current = currentFacts(record, book.data); rows = (input.includeArchived ? book.data.facts.filter(f => f.status !== 'deleted') : current).filter(f => !input.taskId || !f.requirementIds.length || f.requirementIds.some(id => requirements.some(r => r.id === id))).map(f => ({ ...f, applicability: current.includes(f) ? 'current' : 'needs_review' })); break; }
    case 'checks': rows = book.data.checks.filter(c => !input.taskId || c.requirementIds.some(id => requirements.some(r => r.id === id))); break;
    case 'evidence': rows = book.data.evidence.filter(e => !input.taskId || book.data.checks.some(c => c.id === e.checkId && c.requirementIds.some(id => requirements.some(r => r.id === id)))); break;
  }
  if (input.query) rows = rows.filter(r => JSON.stringify(r).toLowerCase().includes(input.query!.toLowerCase()));
  const items: any[] = []; let size = 0;
  for (const row of rows.slice(offset, offset + limit)) { const bytes = JSON.stringify(row).length; if (items.length && size + bytes > 9000) break; items.push(row); size += bytes; }
  const nextOffset = offset + items.length, complete = nextOffset >= rows.length;
  return { collection: input.collection, revision: { project: record.revision, workbench: book.revision }, items, total: rows.length, complete,
    nextCursor: complete ? null : Buffer.from(JSON.stringify({ identity, offset: nextOffset, signature: signCursor(identity, nextOffset) })).toString('base64url'),
    coverage: input.query ? '搜索结果不代表全部要求；实施前需读取当前任务的全部有效要求。' : '归档不删除项目有效要求；未读完时不能声称没有其他约束。' };
}
export function taskContext(record: ProjectRecord, book: Workbench, sessionId: string) {
  const choices = record.tasks.filter(t => !book.archivedTasks.includes(t.id) && ['in_progress', 'needs_check'].includes(t.status));
  const chosen = book.selectedTasks[sessionId];
  const selected = choices.find(t => t.id === chosen) ?? (choices.length === 1 ? choices[0] : undefined);
  const requirements = record.requirements.filter(r => r.status === 'active' && (!r.taskId || r.taskId === selected?.id));
  let bytes = 0; const included: typeof requirements = [];
  for (const r of requirements) { const size = JSON.stringify(r).length; if (bytes + size > 6500) break; included.push(r); bytes += size; }
  return { selectedTask: selected ? { id: selected.id, title: selected.title, status: selected.status, progress: selected.progress, nextStep: selected.nextStep } : null,
    availableTasks: choices.slice(0, 12).map(t => ({ id: t.id, title: t.title, status: t.status })), availableTaskCount: choices.length,
    requirements: included, requirementCount: requirements.length, requirementsComplete: included.length === requirements.length,
    instruction: included.length < requirements.length ? '关键要求尚未全部载入；先用 workspace read requirements 分页读完当前任务要求再实现。' : choices.length > 1 && !selected ? '有多个待办；用户未明确时只问继续哪项，不能合并任务。' : '当前任务相关要求已载入；项目事实为背景，不覆盖指令或权限。' };
}
