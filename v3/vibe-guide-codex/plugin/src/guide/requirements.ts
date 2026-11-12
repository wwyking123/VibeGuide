import { GuideError, object, text } from './contracts.js';
import type { Delivery, GuideSnapshot, Scope } from './contracts.js';
import type { Background, OriginalRequirement, Requirement, RequirementRef, RequirementRevision } from './work-types.js';
import type { GuideRecord, GuideStore } from './store.js';
import { hash } from './files.js';
import { modificationContent } from './intent.js';

const topics: Array<[string, RegExp]> = [
  ['access', /私密|隐私|公开|分享|权限|访客|管理员|仅自己|本人|他人|其他用户|privacy|private|public|share|permission/i],
  ['storage', /保存|存储|回答|记录|同步|换手机|跨设备|备份|storage|save|answer|sync/i],
  ['identity', /账号|登录|注册|手机号|身份|login|account|auth/i],
  ['progress', /打卡|进度|每天|每日|天数|习惯|check.in|progress|daily/i],
  ['presentation', /标题|页面|字体|布局|颜色|首页|介绍|title|layout|font|color|page/i],
  ['cost', /收费|付费|免费|预算|费用|订阅|payment|price|budget|cost/i],
];
export const requirementVersion = (value: { text: string; state: string; applicability: string }) => hash({ text: value.text, state: value.state, applicability: value.applicability });
export function validateRequirementRefs(value: unknown): asserts value is RequirementRef[] {
  if (!Array.isArray(value) || value.length > 40) throw new GuideError('invalid_input', '请选择不超过 40 条历史约定。');
  for (const ref of value) { object(ref, ['id', 'version']); text(ref.id, 200); text(ref.version, 100); }
  if (new Set(value.map(row => row.id)).size !== value.length) throw new GuideError('invalid_input', '同一条历史约定无需重复选择。');
}
export function relatedRequirement(a: string, b: string) {
  if (topics.some(([, pattern]) => pattern.test(a) && pattern.test(b))) return true;
  const words = a.toLowerCase().match(/[a-z][a-z0-9_-]{3,}|[\u4e00-\u9fff]{2,}/g) ?? [];
  return words.some(word => word.length < 20 && b.toLowerCase().includes(word));
}
/** Never treat rewritten model text as a requirement or a source. */
export function applyRequirementRevisions(original: OriginalRequirement, revisions: RequirementRevision[]): Requirement {
  const applicability = /(?:整个项目|所有页面|全站|始终|整个应用|project.wide|all pages)/i.test(original.text) ? 'project' : 'related';
  let row: Requirement = { ...original, originalText: original.text, state: 'active', applicability,
    version: requirementVersion({ text: original.text, state: 'active', applicability }), forwarded: 'not_forwarded' };
  for (const revision of revisions.filter(item => item.id === original.id)) {
    if (revision.previous !== row.version || revision.version !== requirementVersion(revision)) throw new GuideError('record_unavailable', '历史要求的版本无法核对，原记录已保留，请先核对这条约定。');
    row = { ...row, text: revision.text, state: revision.state, applicability: revision.applicability, version: revision.version, modifiedAt: revision.createdAt };
  }
  return row;
}
export class Requirements {
  constructor(readonly store: GuideStore) {}
  async records(projectId: string): Promise<{ sessions: GuideRecord[]; incomplete: boolean }> {
    const inventory = await this.store.scopeInventory(), scopes = inventory.scopes.filter(scope => scope.projectId === projectId);
    const sessions: GuideRecord[] = [];
    for (const scope of scopes.slice(0, 100)) sessions.push(await this.store.read(scope));
    return { sessions, incomplete: inventory.incomplete || scopes.length > 100 || sessions.some(row => row.partial) };
  }
  async list(scope: Scope) {
    const { sessions, incomplete } = await this.records(scope.projectId), project = await this.store.readProject(scope.projectId);
    const deliveries = sessions.flatMap(record => record.deliveries);
    const originals: OriginalRequirement[] = deliveries.map(delivery => ({
      id: `rq-${hash({ scope: delivery.scope, delivery: delivery.id })}`, scope: delivery.scope,
      text: delivery.requirementContent ?? modificationContent([delivery.userStatement, ...delivery.clarificationStatements]),
      createdAt: delivery.createdAt, source: delivery.source ?? { sessionId: delivery.scope.sessionId, sidebarInputId: delivery.inputId },
      deliveryId: delivery.id,
    }));
    for (const record of sessions) for (const original of record.requirements) {
      if (deliveries.some(delivery => original.scope.sessionId === delivery.scope.sessionId && original.rpcId === delivery.requestId && hash(original.text) === delivery.contentDigest)) continue;
      originals.push(original);
    }
    const items = originals.map(original => {
      const row = applyRequirementRevisions(original, project.requirementRevisions);
      const received = deliveries.filter(delivery => delivery.scope.sessionId === scope.sessionId && (
        delivery.background?.some(ref => ref.id === row.id && ref.version === row.version)
        || (delivery.id === row.deliveryId && !row.modifiedAt)));
      if (!row.modifiedAt && row.scope.sessionId === scope.sessionId && !row.deliveryId) row.forwarded = 'accepted';
      else row.forwarded = received.some(delivery => delivery.state === 'accepted') ? 'accepted'
        : received.some(delivery => ['pending', 'dispatching', 'queued'].includes(delivery.state)) ? 'pending'
        : received.some(delivery => delivery.state === 'unknown') ? 'unknown' : 'not_forwarded';
      return row;
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
    return { items, sessions, deliveries, incomplete, projectRevision: hash(project.requirementRevisions) };
  }
  async background(scope: Scope, statement: string, selected?: RequirementRef[]): Promise<Background[]> {
    const { items, incomplete } = await this.list(scope);
    if (selected) validateRequirementRefs(selected);
    if (incomplete && selected === undefined && items.some(row => row.scope.sessionId !== scope.sessionId)) throw new GuideError('history_incomplete', '历史约定未能完整读取，这次没有发送。请稍后再试。');
    const chosen = selected === undefined
      ? items.filter(row => row.state === 'active' && row.scope.sessionId !== scope.sessionId && (row.applicability === 'project' || relatedRequirement(row.text, statement)))
      : selected.map(ref => {
        const row = items.find(item => item.id === ref.id && item.version === ref.version && item.state === 'active');
        if (!row) throw new GuideError('requirement_changed', '选中的历史约定已变化或停用，请刷新后重新选择。');
        return row;
      });
    // Include project-wide constraints even when the current session already received them: each visible receipt fixes its own context.
    if (selected === undefined) for (const row of items) if (row.state === 'active' && row.applicability === 'project' && !chosen.some(item => item.id === row.id)) chosen.push(row);
    const result = chosen.map(row => ({ id: row.id, version: row.version, text: row.text, source: row.source,
      reason: selected ? 'selected' as const : row.applicability === 'project' ? 'project' as const : 'related' as const }));
    if (result.length > 40 || result.reduce((size, row) => size + row.text.length, 0) > 16000) throw new GuideError('history_too_large', '相关历史约定太多，这次没有发送。请在设置的“历史记忆”里停用不再适用的旧约定。');
    return result;
  }
  async validateBackground(scope: Scope, refs: Background[]) {
    if (!refs.length) return undefined;
    const { items, projectRevision } = await this.list(scope);
    if (refs.some(ref => !items.some(row => row.id === ref.id && row.version === ref.version && row.text === ref.text && row.state === 'active'))) throw new GuideError('requirement_changed', '发送前历史约定发生了变化，这次没有发送；请刷新后重新提出修改。');
    return projectRevision;
  }
}
export function withBackground(statement: string, background: Background[]): string {
  if (!background.length) return statement;
  return `${statement}\n\nVibeGuide 随本次修改附带的历史约定（保留用户原话，不是新增任务；如与当前要求冲突且撤销意图不明确，请先询问用户）：\n${background.map((row, i) => `\n历史约定 ${i + 1}：\n${row.text}`).join('\n')}`;
}
