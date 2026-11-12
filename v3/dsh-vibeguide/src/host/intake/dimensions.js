// The requirement dimensions of PRD 6.4. weight 3 = high impact, 1 = low (style is never asked).
export const DIMENSIONS = [
  { id: 'goal_users', label: '目标与使用者', weight: 3, dependsOn: [], defaultable: false },
  { id: 'core_flow', label: '核心流程', weight: 3, dependsOn: ['goal_users'], defaultable: false },
  { id: 'data_source', label: '内容与数据来源', weight: 3, dependsOn: ['core_flow'], defaultable: true },
  { id: 'storage_visibility', label: '保存与可见范围', weight: 3, dependsOn: ['goal_users', 'data_source'], defaultable: true },
  { id: 'scope_v1', label: '第一版范围', weight: 2, dependsOn: ['core_flow'], defaultable: true },
  { id: 'usage_mode', label: '使用方式', weight: 2, dependsOn: ['goal_users'], defaultable: true },
  { id: 'external_services', label: '外部服务', weight: 2, dependsOn: ['core_flow'], defaultable: true },
  { id: 'done_criteria', label: '完成标准', weight: 2, dependsOn: ['core_flow'], defaultable: true },
  { id: 'style', label: '风格与内容细节', weight: 1, dependsOn: [], defaultable: true },
]

export const DIM_IDS = DIMENSIONS.map((d) => d.id)
export const byId = Object.fromEntries(DIMENSIONS.map((d) => [d.id, d]))

export const SOFT_CAP = 8
export const HARD_CAP = 12
export const PER_ROUND = 3

/** Words that must be turned into consequences before they reach the user (PRD 6.4). */
export const JARGON = /数据库|database|\bAPI\b|接口|框架|framework|前端|后端|服务器|server|部署|deploy|localStorage|cookie|token|SQL|JSON|React|Vue|Node|Python|后台管理系统|鉴权|OAuth|CRUD|云函数|云服务/i

const settled = (states, id) => ['known', 'inferred', 'defaulted'].includes(states[id]?.status)

/**
 * Picks this round's questions from the model's candidates (PRD 6.4, tech design 4.2).
 * score = weight × (1 − confidence) × (1 + dimensions it unblocks)
 */
export function selectQuestions(states, candidates, askedDims, askedCount) {
  const remaining = HARD_CAP - askedCount
  if (remaining <= 0) return []
  const blocks = (id) => DIMENSIONS.filter((d) => d.dependsOn.includes(id) && !settled(states, d.id)).length
  const askable = (id) => byId[id] && byId[id].weight >= 2 && !settled(states, id) && !askedDims.has(id)
    && byId[id].dependsOn.every((p) => settled(states, p))
  const seen = new Set()
  const scored = []
  for (const q of candidates) {
    if (!q || !askable(q.dim) || seen.has(q.dim)) continue
    seen.add(q.dim)
    const conf = Math.min(1, Math.max(0, Number(states[q.dim]?.confidence ?? 0)))
    scored.push({ q, score: byId[q.dim].weight * (1 - conf) * (1 + blocks(q.dim)) })
  }
  scored.sort((a, b) => b.score - a.score)
  if (!scored.length) return []
  // One clearly dominant question is asked alone.
  const k = scored.length > 1 && scored[0].score >= 2 * scored[1].score ? 1 : Math.min(PER_ROUND, scored.length)
  return scored.slice(0, Math.min(k, remaining)).map((s) => s.q)
}

/**
 * F1-3: one decision, ≤ 40 characters, 2–4 options each with a consequence, exactly one
 * recommended option with a reason, no jargon (technical choices must be asked as consequences).
 */
export function validQuestion(q) {
  if (!q || typeof q.text !== 'string' || !DIM_IDS.includes(q.dim)) return 'bad shape'
  if ([...q.text].length > 40) return 'question longer than 40 characters'
  if (/[？?].+[？?]/.test(q.text) || /还是.*还是|以及.*[？?]/.test(q.text)) return 'more than one decision'
  if (JARGON.test(q.text)) return 'jargon in question'
  if (typeof q.recommendReason !== 'string' || !q.recommendReason.trim()) return 'missing recommendReason'
  if (JARGON.test(q.recommendReason)) return 'jargon in recommendReason'
  if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 4) return 'need 2-4 options'
  for (const o of q.options) {
    if (typeof o?.label !== 'string' || !o.label.trim() || o.label.length > 40) return 'bad option label'
    if (typeof o.consequence !== 'string' || !o.consequence.trim()) return 'option without consequence'
    if (JARGON.test(o.label)) return 'jargon in option'
  }
  if (q.options.filter((o) => o.recommended === true).length !== 1) return 'need exactly one recommended option'
  return undefined
}

/** Ready to stop asking: every high/medium dimension is settled. */
export function covered(states) {
  return DIMENSIONS.filter((d) => d.weight >= 2).every((d) => settled(states, d.id))
}
