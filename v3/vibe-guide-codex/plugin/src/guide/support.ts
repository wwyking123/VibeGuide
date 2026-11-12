import { randomUUID } from 'node:crypto';
import { GuideError, object, requestId, text } from './contracts.js';
import type { GuideSnapshot } from './contracts.js';
import type { GuideStore } from './store.js';
import type { ProjectRecord } from './project-types.js';
import { hash } from './files.js';
import { defaultPreferences, defaultBudget, validPreferences, validBudget } from './support-types.js';
import type { Preferences, SupportRecord, SupportView, Usage } from './support-types.js';
const personalId = '@vibeguide/personal-preferences';
const empty = (): SupportRecord => ({ usage: [], requests: [] });
const dayOf = (now: Date) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
const turnOf = (snapshot: GuideSnapshot) => `${snapshot.scope.sessionId}:${snapshot.turn ?? 'conversation'}`;
const versionOf = (personal: ProjectRecord, project: ProjectRecord) =>
  hash({ personal: personal.support?.preferences ?? defaultPreferences, project: project.support?.preferences, budget: project.support?.budget ?? defaultBudget });

/** Private settings and atomic admission. No automatic calls, timers or main-conversation writes. */
export class GuideSupport {
  private active = new Map<string, string>();
  constructor(readonly store: GuideStore, readonly clock = () => new Date()) {}
  async preferences(projectId: string) {
    const [personal, project] = await Promise.all([this.store.readProject(personalId), this.store.readProject(projectId)]);
    const own = personal.support?.preferences ?? defaultPreferences;
    const preferences = project.support?.preferences ?? own;
    return { preferences, personal: own, overridden: !!project.support?.preferences, preferenceVersion: hash(preferences), version: versionOf(personal, project) };
  }
  async view(snapshot: GuideSnapshot): Promise<SupportView> {
    const prefs = await this.preferences(snapshot.scope.projectId), support = (await this.store.readProject(snapshot.scope.projectId)).support ?? empty();
    const day = dayOf(this.clock()), rows = support.usage.filter(row => row.day === day), calls = rows.filter(row => row.kind === 'model');
    return { ...prefs, budget: support.budget ?? defaultBudget, day, calls: calls.length, turnCalls: support.usage.filter(row => row.kind === 'model' && row.turn === turnOf(snapshot)).length,
      cacheHits: rows.filter(row => row.kind === 'cache').length, glossaryHits: rows.filter(row => row.kind === 'glossary').length,
      failed: calls.filter(row => ['failed', 'cancelled'].includes(row.state)).length, unknown: calls.filter(row => row.state === 'unknown' || row.state === 'pending').length,
      inputTokens: calls.reduce((n, row) => n + (row.inputTokens ?? 0) + (row.cacheReadTokens ?? 0) + (row.cacheWriteTokens ?? 0), 0), outputTokens: calls.reduce((n, row) => n + (row.outputTokens ?? 0), 0),
      missingUsage: calls.filter(row => row.inputTokens === undefined || row.outputTokens === undefined).length };
  }
  async save(snapshot: GuideSnapshot, value: Record<string, unknown>) {
    object(value, ['sessionId', 'projectId', 'clientRequestId', 'version', 'target', 'preferences', 'budget']);
    requestId(value.clientRequestId); text(value.version, 100);
    if (!['personal', 'project', 'inherit', 'budget'].includes(String(value.target))) throw new GuideError('invalid_input', '请选择保存范围。');
    if (['personal', 'project'].includes(String(value.target)) ? !validPreferences(value.preferences) || value.budget !== undefined : value.preferences !== undefined || (value.target === 'budget' ? !validBudget(value.budget) : value.budget !== undefined)) throw new GuideError('invalid_input', '讲解设置格式不正确。');
    const personal = value.target === 'personal', target = personal ? personalId : snapshot.scope.projectId, digest = hash(value);
    // The version spans two records; check it inside the target's write so a save that lands in between is never overwritten.
    const other = await this.store.readProject(personal ? snapshot.scope.projectId : personalId);
    await this.store.updateProject(target, record => {
      const s = record.support ??= empty(), existing = s.requests.find(row => row.id === value.clientRequestId);
      if (existing) { if (existing.digest !== digest) throw new GuideError('request_conflict', '同一保存请求不能更换内容。'); return; }
      if ((personal ? versionOf(record, other) : versionOf(other, record)) !== value.version) throw new GuideError('context_changed', '设置已变化，请刷新设置后再保存。');
      if (value.target === 'inherit') delete s.preferences;
      else if (value.target === 'budget') s.budget = value.budget as SupportView['budget'];
      else s.preferences = value.preferences as Preferences;
      s.requests.push({ id: value.clientRequestId as string, digest }); s.requests = s.requests.slice(-500);
    });
    return this.view(snapshot);
  }
  async hit(snapshot: GuideSnapshot, id: string, kind: 'cache' | 'glossary') {
    await this.store.updateProject(snapshot.scope.projectId, record => {
      const s = record.support ??= empty(), key = `${snapshot.scope.sessionId}:${id}:${kind}`;
      if (s.usage.some(row => row.id === key)) return;
      this.prune(s, turnOf(snapshot));
      // Local reads remain usable even if the optional statistics ledger fills up.
      if (s.usage.length < 5000) s.usage.push({ id: key, kind, state: 'succeeded', day: dayOf(this.clock()), turn: turnOf(snapshot), sessionId: snapshot.scope.sessionId, createdAt: this.clock().toISOString() });
    });
  }
  private prune(s: SupportRecord, turn: string) {
    const cutoff = new Date(this.clock().getTime() - 30 * 86400000).toISOString();
    s.usage = s.usage.filter(row => row.createdAt >= cutoff || row.turn === turn || this.active.has(row.id));
  }
  async call<T>(snapshot: GuideSnapshot, run: (report: (usage: unknown) => void) => Promise<T>): Promise<T> {
    if (this.active.size >= 2 || [...this.active.values()].includes(snapshot.scope.projectId)) throw new GuideError('explanation_busy', '已有讲解正在生成，请稍后再试。');
    const id = randomUUID(); this.active.set(id, snapshot.scope.projectId);
    let reserved = false, usage: Partial<Usage> = {};
    try {
      await this.store.updateProject(snapshot.scope.projectId, record => {
        const s = record.support ??= empty(), day = dayOf(this.clock()), turn = turnOf(snapshot), budget = s.budget ?? defaultBudget;
        this.prune(s, turn);
        for (const row of s.usage) if (row.state === 'pending' && !this.active.has(row.id)) row.state = 'unknown';
        const calls = s.usage.filter(row => row.kind === 'model');
        if (calls.filter(row => row.day === day).length >= budget.dailyCalls || calls.filter(row => row.turn === turn).length >= budget.turnCalls) throw new GuideError('budget_reached', '本项目的侧栏讲解次数已用完。可在侧栏设置（齿轮）里调整；主对话开发继续，已有讲解和常用概念仍可查看。');
        if (s.usage.length >= 5000) throw new GuideError('record_full', '用量记录已满，本次没有调用模型。');
        s.usage.push({ id, kind: 'model', state: 'pending', day, turn, sessionId: snapshot.scope.sessionId, createdAt: this.clock().toISOString() });
      });
      reserved = true;
      const result = await run(raw => {
        if (!raw || typeof raw !== 'object') return;
        for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const) {
          const count = (raw as Record<string, unknown>)[key];
          if (Number.isSafeInteger(count) && (count as number) >= 0) usage[key] = count as number;
        }
      });
      await this.finish(snapshot, id, 'succeeded', usage); reserved = false; return result;
    } catch (error) {
      if (reserved) await this.finish(snapshot, id, error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name) ? 'cancelled' : 'failed', usage).catch(() => {});
      throw error;
    } finally { this.active.delete(id); }
  }
  private async finish(snapshot: GuideSnapshot, id: string, state: Usage['state'], usage: Partial<Usage>) {
    await this.store.updateProject(snapshot.scope.projectId, record => { const row = record.support?.usage.find(row => row.id === id); if (row) Object.assign(row, usage, { state }); });
  }
}
export function preferencePrompt(p: Preferences) {
  return `讲解偏好（只影响此次侧栏回答）：${p.language === 'auto' ? '跟随提问语言' : p.language === 'en' ? 'Answer in English' : '使用简体中文'}；${p.detail === 'brief' ? '尽量简短' : p.detail === 'detailed' ? '给出充分的影响、取舍和限制说明' : '保持适中篇幅'}；${p.style === 'example' ? '用一个生活或使用场景帮助理解' : '直接说明'}；${p.order === 'impact' ? '先讲使用影响' : '先讲正在做的过程，再讲影响'}。保留事实、否定、条件和未知；结构化输出仍遵守 JSON 格式与长度限制。`;
}
