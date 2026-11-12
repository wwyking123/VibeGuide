export type Preferences = { language: 'auto' | 'zh-CN' | 'en'; detail: 'brief' | 'standard' | 'detailed'; style: 'direct' | 'example'; order: 'impact' | 'process' };
export type Budget = { dailyCalls: number; turnCalls: number };
export type Usage = { id: string; day: string; turn: string; sessionId: string; createdAt: string; kind: 'model' | 'cache' | 'glossary'; state: 'pending' | 'succeeded' | 'failed' | 'cancelled' | 'unknown'; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
export type SupportRecord = { preferences?: Preferences; budget?: Budget; usage: Usage[]; requests: { id: string; digest: string }[] };
export type SupportView = { preferences: Preferences; preferenceVersion: string; personal: Preferences; overridden: boolean; version: string; budget: Budget; day: string; calls: number; turnCalls: number; cacheHits: number; glossaryHits: number; failed: number; unknown: number; inputTokens: number; outputTokens: number; missingUsage: number };
export const defaultPreferences: Preferences = { language: 'auto', detail: 'standard', style: 'direct', order: 'impact' };
export const defaultBudget: Budget = { dailyCalls: 100, turnCalls: 20 };
const oneOf = (value: unknown, choices: string[]) => typeof value === 'string' && choices.includes(value);
export const validPreferences = (p: any): p is Preferences => !!p && Object.keys(p).length === 4 && oneOf(p.language, ['auto', 'zh-CN', 'en']) && oneOf(p.detail, ['brief', 'standard', 'detailed']) && oneOf(p.style, ['direct', 'example']) && oneOf(p.order, ['impact', 'process']);
export const validBudget = (b: any): b is Budget => !!b && Object.keys(b).length === 2 && [b.dailyCalls, b.turnCalls].every(n => Number.isInteger(n) && n >= 0 && n <= 1000);
export function validSupport(s: SupportRecord): boolean {
  return !!s && (!s.preferences || validPreferences(s.preferences)) && (!s.budget || validBudget(s.budget)) && Array.isArray(s.requests) && s.requests.length <= 500
    && s.requests.every(r => typeof r.id === 'string' && typeof r.digest === 'string') && Array.isArray(s.usage) && s.usage.length <= 5000
    && s.usage.every(r => typeof r.id === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.day) && typeof r.turn === 'string' && typeof r.sessionId === 'string' && typeof r.createdAt === 'string' && ['model', 'cache', 'glossary'].includes(r.kind) && ['pending', 'succeeded', 'failed', 'cancelled', 'unknown'].includes(r.state)
      && [r.inputTokens, r.outputTokens, r.cacheReadTokens, r.cacheWriteTokens].every(n => n === undefined || Number.isSafeInteger(n) && n >= 0));
}
