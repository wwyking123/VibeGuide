// F1-1 … F1-12 (SPEC §3)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { selectQuestions, validQuestion, HARD_CAP, DIM_IDS } from '../src/host/intake/dimensions.js'
import { parseRound, decisions } from '../src/host/intake/engine.js'
import { renderBrief, WORKING_AGREEMENT } from '../src/host/intake/brief.js'
import { scanProject } from '../src/host/intake/scan.js'
import { services, tmp } from './helpers.js'

const q = (dim, extra = {}) => ({ dim, text: '换台电脑还要能看到之前的记录吗？', recommendReason: '第一版最省事',
  options: [{ label: '要', consequence: '多做一点', recommended: false }, { label: '不用', consequence: '最快做完', recommended: true }], ...extra })
const unknownAll = () => Object.fromEntries(DIM_IDS.map((id) => [id, { status: 'unknown', confidence: 0 }]))
const known = (states, ...ids) => { for (const id of ids) states[id] = { status: 'known', value: 'x', confidence: 1 }; return states }

test('F1-2 only unknown, unblocked, not-yet-asked dimensions are picked, by score', () => {
  const states = unknownAll()
  // core_flow depends on goal_users → not askable yet; goal_users blocks the most → ranked first.
  const picked = selectQuestions(states, [q('core_flow'), q('goal_users'), q('usage_mode')], new Set(), 0)
  assert.deepEqual(picked.map((x) => x.dim), ['goal_users'])
  known(states, 'goal_users')
  const second = selectQuestions(states, [q('core_flow'), q('usage_mode'), q('style')], new Set(['usage_mode']), 1)
  assert.deepEqual(second.map((x) => x.dim), ['core_flow'], 'asked dims and style are never picked')
})

test('F1-1 at most 3 questions per round, never past the hard cap', () => {
  const states = known(unknownAll(), 'goal_users', 'core_flow')
  const cands = ['data_source', 'scope_v1', 'usage_mode', 'external_services', 'done_criteria'].map((d) => q(d))
  assert.ok(selectQuestions(states, cands, new Set(), 0).length <= 3)
  assert.equal(selectQuestions(states, cands, new Set(), HARD_CAP - 1).length, 1)
  assert.equal(selectQuestions(states, cands, new Set(), HARD_CAP).length, 0)
})

test('F1-3 question validation: ≤ 40 chars, one decision, 2–4 options with consequences, exactly one recommended with a reason, no jargon', () => {
  assert.equal(validQuestion(q('data_source')), undefined)
  assert.match(validQuestion(q('data_source', { text: '数据存在数据库还是本地？' })), /jargon/)
  assert.match(validQuestion(q('data_source', { text: '这'.repeat(41) })), /40/)
  assert.match(validQuestion(q('data_source', { text: '谁来用？要不要登录？' })), /one decision/)
  assert.match(validQuestion(q('data_source', { recommendReason: '' })), /recommendReason/)
  assert.match(validQuestion(q('data_source', { options: [{ label: 'a', consequence: 'x', recommended: true }] })), /2-4/)
  assert.match(validQuestion(q('data_source', { options: [{ label: 'a', consequence: '', recommended: true }, { label: 'b', consequence: 'y' }] })), /consequence/)
  assert.match(validQuestion(q('data_source', { options: [{ label: 'a', consequence: 'x', recommended: true }, { label: 'b', consequence: 'y', recommended: true }] })), /exactly one/)
})

test('F1-5 no qualified question while dimensions are unknown → parseRound throws so the runner retries', () => {
  const states = unknownAll()
  assert.throws(() => parseRound({ dims: [], questions: [q('goal_users', { text: '用什么框架？' })] }, states, {}, new Set(), 0), /没有合格的题目/)
  assert.throws(() => parseRound({ dims: [], questions: [] }, states, {}, new Set(), 0), /没有合格的题目/)
})

test('F1-6 the model can never upgrade a delegated or defaulted decision to confirmed', () => {
  const states = unknownAll()
  states.data_source = { status: 'defaulted', value: '大家在网页上填', confidence: 0.6 }
  const r = parseRound({ dims: [{ id: 'data_source', status: 'known', value: '用户说的', confidence: 1 }, { id: 'goal_users', status: 'known', value: '组长和组员', confidence: 0.9 }],
    questions: [q('core_flow')] }, states, { data_source: 'delegate' }, new Set(), 0)
  assert.equal(r.states.data_source.status, 'defaulted')
  assert.equal(r.sources.data_source, 'delegate')
  const d = decisions({ states: r.states, sources: r.sources })
  assert.ok(d.tentative.some((x) => x.startsWith('内容与数据来源')))
  assert.ok(!d.confirmed.some((x) => x.startsWith('内容与数据来源')))
  assert.ok(d.confirmed.some((x) => x.startsWith('目标与使用者')), 'what the user said in the idea counts as confirmed')
})

test('F1-7 brief: fixed working agreement, every high-impact dimension covered', () => {
  const states = known(unknownAll(), 'goal_users')
  const d = decisions({ states, sources: { goal_users: 'answer' } })
  for (const label of ['目标与使用者', '核心流程', '内容与数据来源', '保存与可见范围']) assert.ok([...d.confirmed, ...d.tentative].some((x) => x.startsWith(label)), label)
  const text = renderBrief({ version: 1, title: '周报', oneLiner: 'x', coreFlow: 'a → b', inScope: ['填写页'], ...d })
  assert.ok(text.endsWith(WORKING_AGREEMENT))
  assert.ok(text.startsWith('【需求简报 v1】周报'))
})

// --- engine flow with a scripted model ---
const round = (dims, questions) => ({ json: { dims, questions } })
const SID = 's-intake'
const IDEA = '想做个网页，帮我们组每周汇总周报'

test('F1-1/F1-4/F1-11/F1-12 a full interview: rounds, skip, restate, brief, one model call per step, resumable', async () => {
  const s = await services({ logs: { [SID]: { events: [] } }, cwd: await tmp('proj-'), script: [
    round([{ id: 'goal_users', status: 'known', value: '组长和 8 个组员', confidence: 1 }], [q('core_flow'), q('usage_mode'), q('external_services')]),
    { json: { restatement: '我理解你要做的是一个周报汇总网页。' } },
    { json: { title: '周报汇总', oneLiner: '组员填，组长看', users: '组员 8 人', coreFlow: '填写 → 汇总', inScope: ['填写页', '汇总页'], outOfScope: ['登录'], data: '本机', usage: '电脑', doneCriteria: ['8 人都能提交'] } },
  ] })
  const r1 = await s.intake.start({ sessionId: SID, idea: IDEA })
  assert.equal(r1.stage, 'asking')
  assert.ok(r1.questions.length <= 3)
  assert.equal(s.llm.calls.length, 1)
  // F1-12: state survives a "restart" (new engine, same store)
  const resumed = await s.intake.current(SID)
  assert.deepEqual(resumed.intake.questions.map((x) => x.id), r1.questions.map((x) => x.id))
  // F1-4: skip straight to restatement
  const r2 = await s.intake.skip({ sessionId: SID })
  assert.equal(r2.stage, 'restating')
  assert.equal(s.llm.calls.length, 2)
  const r3 = await s.intake.confirm({ sessionId: SID })
  assert.equal(r3.stage, 'brief_ready')
  assert.equal(s.llm.calls.length, 3, 'F1-11: round, restatement, brief: one call each')
  assert.match(r3.brief.text, /给你的工作方式/)
  assert.match(r3.brief.text, /已确认：目标与使用者：组长和 8 个组员/)
  assert.match(r3.brief.text, /暂定（AI 推荐，可改）：.*核心流程/)
  for (const c of s.llm.calls) assert.equal(c.maxTokens, 3000, 'ML-2 intake maxTokens')
  for (const c of s.llm.calls) assert.equal(c.reasoningEffort, 'off', 'ML-13 thinking is switched off')
})

test('F1-5 two bad rounds in a row → straight to the restatement, never stuck', async () => {
  const s = await services({ logs: { [SID]: { events: [] } }, cwd: await tmp('proj-'), script: [
    round([], [q('goal_users', { text: '用 React 还是 Vue？' })]),
    round([], []),
    { json: { restatement: '我理解你要做的是……' } },
  ] })
  const r = await s.intake.start({ sessionId: SID, idea: IDEA })
  assert.equal(r.stage, 'restating')
  assert.equal(s.llm.calls.length, 3)
})

test('F1-1 soft cap at 8 is flagged to the user and the interview ends in a restatement (hard cap: see selectQuestions test)', async () => {
  const s = await services({ logs: { [SID]: { events: [] } }, cwd: await tmp('proj-'), fallback: (p) => {
    const sys = p.system
    if (sys.includes('复述')) return { json: { restatement: '我理解你要做的是……' } }
    // Always one fresh unknown dimension: keeps the interview going.
    const asked = (p.messages[0].content[0].text.match(/ → /g) ?? []).length
    const dims = ['goal_users', 'core_flow', 'data_source', 'storage_visibility', 'scope_v1', 'usage_mode', 'external_services', 'done_criteria']
    return round(dims.map((id) => ({ id, status: 'unknown', confidence: 0 })), [q(dims[Math.min(asked, dims.length - 1)])])
  } })
  let r = await s.intake.start({ sessionId: SID, idea: IDEA })
  while (r.stage === 'asking') {
    if (r.askedCount >= 8) assert.equal(r.softCapReached, true)
    r = await s.intake.answer({ sessionId: SID, answers: r.questions.map((x) => ({ qid: x.id, choice: 0 })) })
  }
  assert.equal(r.stage, 'restating')
})

test('F1-9 an existing brief makes the next idea ask "新需求还是新项目"; F1-8 versions are kept and edits survive', async () => {
  const s = await services({ logs: { [SID]: { events: [] } }, cwd: await tmp('proj-'), script: [
    round([], []), // covered? no → throws → retry
    round(DIM_IDS.map((id) => ({ id, status: 'known', value: 'v', confidence: 1 })), []),
    { json: { restatement: '我理解你要做的是……' } },
    { json: { title: '周报', oneLiner: 'x', coreFlow: 'a → b', inScope: ['填写页'] } },
  ] })
  await s.intake.start({ sessionId: SID, idea: IDEA })
  await s.intake.confirm({ sessionId: SID })
  const edited = await s.intake.editBrief({ sessionId: SID, text: '我亲手改过的简报' })
  assert.equal(edited.brief.version, 2)
  const again = await s.intake.start({ sessionId: SID, idea: '加一个导出功能' })
  assert.equal(again.needsKind, true)
  const meta = await s.sessions.meta(SID)
  const all = await s.intake.briefs(meta.projectId)
  assert.deepEqual(all.series[0].versions.map((v) => v.version), [1, 2])
  assert.equal(all.series[0].versions[1].text, '我亲手改过的简报')
})

test('F1-10 grounding is read-only and bounded (40 entries, 200 KB, secrets skipped)', async () => {
  const dir = await tmp('scan-')
  for (let i = 0; i < 60; i++) await writeFile(join(dir, `f${i}.txt`), 'x')
  await writeFile(join(dir, '.env'), 'API_KEY=secret')
  await mkdir(join(dir, 'node_modules'))
  await writeFile(join(dir, 'package.json'), JSON.stringify({ dependencies: { react: '18' } }))
  const scan = await scanProject(dir)
  assert.ok(scan.entries.length <= 40)
  assert.ok(!scan.entries.includes('.env') && !scan.entries.includes('node_modules'))
  assert.ok(scan.peeks.every((p) => p.text.length <= 2048))
})
