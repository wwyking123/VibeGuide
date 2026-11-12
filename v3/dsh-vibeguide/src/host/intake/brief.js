// Renders the requirement brief (PRD 6.5). The closing paragraph is fixed text, never model output:
// it is how the brief tells the main AI how to work without changing the main AI (D9).
export const WORKING_AGREEMENT = '给你的工作方式：请按以上需求开始；只有影响结果、而这里没写到的，才问我，最多 2 个问题；技术选择由你决定，但请用白话告诉我它对使用有什么影响。'

const list = (items) => (items ?? []).filter(Boolean).join('、')

export function renderBrief(b) {
  const lines = [`【需求简报 v${b.version}】${b.title}`, '', `一句话：${b.oneLiner}`]
  const row = (label, value) => { if (value && String(value).trim()) lines.push(`${label}：${value}`) }
  row('谁用', b.users)
  row('核心流程', b.coreFlow)
  row('第一版要做', list(b.inScope))
  row('第一版不做', list(b.outOfScope))
  row('数据', b.data)
  row('在哪用', b.usage)
  row('怎么算做好', list(b.doneCriteria))
  if (b.confirmed?.length || b.tentative?.length) lines.push('')
  row('已确认', list(b.confirmed))
  row('暂定（AI 推荐，可改）', list(b.tentative))
  lines.push('', WORKING_AGREEMENT)
  return lines.join('\n')
}

const str = (v, max) => typeof v === 'string' ? v.trim().slice(0, max) : ''
const arr = (v, n, max) => Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).slice(0, n).map((x) => x.trim().slice(0, max)) : []

/** Validates model output for the brief; throws with a reason the runner can feed back. */
export function parseBriefFields(j) {
  const b = {
    title: str(j.title, 30), oneLiner: str(j.oneLiner, 120), users: str(j.users, 120), coreFlow: str(j.coreFlow, 300),
    inScope: arr(j.inScope, 8, 60), outOfScope: arr(j.outOfScope, 8, 60), data: str(j.data, 160), usage: str(j.usage, 120),
    doneCriteria: arr(j.doneCriteria, 6, 80),
    // confirmed / tentative are never taken from the model: the server builds them (F1-6).
  }
  for (const k of ['title', 'oneLiner', 'coreFlow']) if (!b[k]) throw new Error(`缺少 ${k}`)
  if (!b.inScope.length) throw new Error('inScope 不能为空')
  return b
}
