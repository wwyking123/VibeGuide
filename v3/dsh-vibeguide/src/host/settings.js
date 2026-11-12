import { GuideError } from './errors.js'

export const DEFAULTS = Object.freeze({
  autoAnalysis: true,          // D11: analyse every turn with changes (M2 feature, setting lives here already)
  autoExplainUnknown: true,    // explain errors no template recognises with one model call
  alertLevel: 'warn',          // 'block' | 'warn' | 'all'
  dailyLimit: 80,
  perTurnLimit: 5,
  explainLength: 'short',      // 'short' | 'detailed'
  costNoticeShown: false,
})

const RULES = {
  autoAnalysis: (v) => typeof v === 'boolean',
  autoExplainUnknown: (v) => typeof v === 'boolean',
  alertLevel: (v) => ['block', 'warn', 'all'].includes(v),
  dailyLimit: (v) => Number.isInteger(v) && v >= 0 && v <= 1000,
  perTurnLimit: (v) => Number.isInteger(v) && v >= 0 && v <= 100,
  explainLength: (v) => ['short', 'detailed'].includes(v),
  costNoticeShown: (v) => typeof v === 'boolean',
}

export class Settings {
  constructor(store) { this.store = store }

  async get() { return { ...DEFAULTS, ...(await this.store.read('settings.json', {})) } }

  async set(patch) {
    if (!patch || typeof patch !== 'object') throw new GuideError('bad_request', '设置格式不对。')
    for (const [key, value] of Object.entries(patch)) {
      if (!(key in RULES)) throw new GuideError('bad_request', `未知设置：${key}`)
      if (!RULES[key](value)) throw new GuideError('bad_request', `设置「${key}」的值不合法。`)
    }
    const saved = await this.store.update('settings.json', {}, (draft) => ({ ...draft, ...patch }))
    return { ...DEFAULTS, ...saved }
  }
}

/** Which incident severities reach the user at a given alert level. */
export function severityVisible(level, severity) {
  if (level === 'all') return true
  if (level === 'warn') return severity !== 'info'
  return severity === 'block'
}
