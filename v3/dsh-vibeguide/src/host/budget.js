import { GuideError } from './errors.js'

const day = (date) => {
  const d = new Date(date)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const EMPTY = { calls: 0, tokens: 0, perTurn: {}, byPurpose: {} }

/**
 * Counts model calls before they happen (ML-6). Every attempt counts, including retries, failures
 * and cancellations: a call that reached the provider may have been billed. The per-turn limit only
 * applies to automatic calls (ML-7); user-initiated calls are bound by the daily limit alone.
 */
export class Budget {
  constructor(store, settings, now = () => Date.now()) {
    this.store = store
    this.settings = settings
    this.now = now
  }

  #file() { return `usage/${day(this.now())}.json` }

  async reserve({ sessionId, turn, purpose, auto = false }) {
    const { dailyLimit, perTurnLimit } = await this.settings.get()
    const turnKey = `${sessionId}#${turn ?? 'none'}`
    let refusal
    await this.store.update(this.#file(), EMPTY, (u) => {
      u.perTurn ??= {}; u.byPurpose ??= {}
      if (u.calls >= dailyLimit) { refusal = `今天的 VibeGuide 模型调用次数（${dailyLimit} 次）已经用完，可以在设置里调整。规则类提醒照常工作。`; return }
      if (auto && (u.perTurn[turnKey] ?? 0) >= perTurnLimit) { refusal = `这一轮的自动分析次数（${perTurnLimit} 次）已经用完，可以在设置里调整。`; return }
      u.calls += 1
      if (auto) u.perTurn[turnKey] = (u.perTurn[turnKey] ?? 0) + 1
      u.byPurpose[purpose] = (u.byPurpose[purpose] ?? 0) + 1
    })
    if (refusal) throw new GuideError('budget_exhausted', refusal, 429)
  }

  async recordTokens(usage) {
    const total = usage?.totalTokens ?? ((usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0))
    if (!total) return
    await this.store.update(this.#file(), EMPTY, (u) => { u.tokens = (u.tokens ?? 0) + total })
  }

  async today() {
    const u = await this.store.read(this.#file(), EMPTY)
    const { dailyLimit, perTurnLimit } = await this.settings.get()
    return { calls: u.calls, limit: dailyLimit, perTurnLimit, tokens: u.tokens || null }
  }
}
