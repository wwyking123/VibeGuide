import { createHash, randomUUID } from 'node:crypto'
import { GuideError } from '../errors.js'
import { extractJson } from '../runner.js'
import { projectDir, sessionDir } from '../project.js'
import { DIMENSIONS, DIM_IDS, HARD_CAP, SOFT_CAP, byId, covered, selectQuestions, validQuestion } from './dimensions.js'
import { parseBriefFields, renderBrief } from './brief.js'
import { describeScan, scanProject } from './scan.js'

const DIM_GUIDE = DIMENSIONS.map((d) => `${d.id}（${d.label}）`).join('、')

const ROUND_SYSTEM = `你是 VibeGuide 的需求梳理助手，帮不懂技术的用户把一个想法变成可以开工的需求。你不写代码，也不替用户定技术方案。
根据材料判断每个需求维度的状态，并为还不清楚、而且会影响做出来的东西的维度各起草一道选择题。只输出一个 JSON 对象：
{"dims":[{"id":"维度id","status":"known|inferred|unknown","value":"已知或推断出的内容，一句话","confidence":0到1之间的数}],
 "questions":[{"dim":"维度id","text":"问题","recommendReason":"为什么推荐那个选项，一句话","options":[{"label":"选项","consequence":"选了会怎样","recommended":true或false}]}]}
规则：
- known：用户在想法或回答里明确说过；inferred：能从项目文件可靠推断；unknown：不知道，而且不同答案会做出不一样的东西。
- 只给 unknown 的维度出题，每个维度最多一道，一轮最多出 4 道：按下面维度列出的先后顺序，先出排在前面的。一道题只问一个决定，题目不超过 40 个字。
- 题目、选项和推荐理由都用日常语言，不出现技术名词（数据库、接口、框架、服务器、部署、前端后端等）。技术选择要换成后果来问，例如问"换台电脑还要能看到之前的记录吗"，不要问存哪种数据库。
- 每题 2–4 个选项，每个选项写清"选了会怎样"，恰好一个 recommended=true：推荐最省事、最适合第一版的那个，并在 recommendReason 里说明理由。
- style（风格、配色、文案）不出题，第一版用占位。
- 用户没提到登录、支付、地图、AI、通知的，external_services 标 inferred（不是 known），value 写"不需要"。只有用户亲口说过的才标 known。
维度：${DIM_GUIDE}。`

const RESTATE_SYSTEM = '你是 VibeGuide。用用户自己的话复述你理解的需求，让用户确认。只输出 JSON：{"restatement":"以“我理解你要做的是”开头，120 字以内，说清给谁用、怎么用、第一版做什么不做什么、用户强调过的限制"}。不加用户没说过的功能。'

const BRIEF_SYSTEM = `你是 VibeGuide。根据确认过的需求写需求简报的正文字段，主 AI 会照着它开工，用户也要看得懂。只输出 JSON：
{"title":"产品名，10 字以内","oneLiner":"一句话：为谁解决什么","users":"谁用、大约几个人、各自做什么","coreFlow":"用 → 连接的核心流程","inScope":["第一版要做的"],"outOfScope":["第一版明确不做的"],"data":"数据存在哪、谁能看到（按用户的选择写，不指定具体技术）","usage":"在哪用、怎么打开","doneCriteria":["怎样算做好，可以检验"]}
规则：用日常语言，技术名词最多放在括号里；不指定技术方案；不编造用户没说过的功能；用户的否定、数字、人数、权限和隐私要求必须原样保留。`

const fresh = () => Object.fromEntries(DIM_IDS.map((id) => [id, { status: 'unknown', confidence: 0 }]))
const CONFIRMED_SOURCES = new Set(['answer', 'idea'])
const hash = (v) => createHash('sha1').update(JSON.stringify(v)).digest('hex').slice(0, 16)

export class IntakeEngine {
  constructor({ sessions, store, runner, guard, inflight, now = () => Date.now() }) {
    this.sessions = sessions
    this.store = store
    this.runner = runner
    this.guard = guard
    this.inflight = inflight
    this.now = now
  }

  #statePath(meta, sessionId) { return `${sessionDir(meta.projectId, sessionId)}/intake.json` }
  #briefPath(projectId) { return `${projectDir(projectId)}/briefs.json` }

  async briefs(projectId) { return this.store.read(this.#briefPath(projectId), { series: [], current: undefined }) }

  async latestBrief(projectId) {
    const all = await this.briefs(projectId)
    return all.series.find((s) => s.id === all.current)?.versions.at(-1)
  }

  /** F1-12: resume where the user left off. */
  async current(sessionId) {
    const meta = await this.sessions.meta(sessionId)
    const state = await this.store.read(this.#statePath(meta, sessionId), null)
    const brief = await this.latestBrief(meta.projectId)
    return { intake: state && state.stage !== 'brief_ready' ? view(state) : undefined, brief: brief ? briefView(brief) : undefined }
  }

  /** Wraps every model-backed step: dedupe identical requests (ML-9), scope to the project (ST-7). */
  async #step(sessionId, action, body, fn) {
    const meta = await this.sessions.meta(sessionId)
    return this.inflight.run(`intake:${sessionId}:${action}:${hash(body)}`, async () => {
      const epoch = this.guard.epoch(meta.projectId)
      const scoped = this.guard.signal(meta.projectId)
      // ST-7: every write first checks the project was not cleared meanwhile.
      const scope = { signal: scoped.signal, check: () => this.guard.assert(meta.projectId, epoch) }
      try { return await fn(meta, scope) } finally { scoped.done() }
    })
  }

  start({ sessionId, idea, scenario, kind }) {
    return this.#step(sessionId, 'start', { idea, scenario, kind }, async (meta, sig) => {
      const existing = await this.latestBrief(meta.projectId)
      if (existing && !kind) return { needsKind: true, latest: { title: existing.title, version: existing.version } } // F1-9
      const revise = kind === 'revise' && existing
      const states = fresh()
      const sources = {}
      if (revise) {
        for (const id of DIM_IDS) {
          const prev = existing.dimStates?.[id]
          if (prev && prev.status !== 'unknown') { states[id] = { ...prev }; sources[id] = existing.dimSources?.[id] ?? 'default' }
        }
      }
      const scan = await scanProject(meta.cwd) // F1-10: read-only, bounded
      const state = {
        id: randomUUID(), projectId: meta.projectId, idea: idea.trim(), scenario: scenario ?? null, kind: revise ? 'revise' : 'new',
        baseVersion: revise ? existing.version : null, baseBrief: revise ? existing.text : null, baseEdited: revise ? !!existing.editedByUser : false,
        scan: describeScan(scan).slice(0, 8000), stage: 'asking', round: 0, askedCount: 0, askedDims: [], qa: [], states, sources,
        questions: [], restatement: null, createdAt: this.now(),
      }
      return this.#advance(meta, sessionId, state, sig)
    })
  }

  answer({ sessionId, answers }) {
    return this.#step(sessionId, 'answer', { answers }, async (meta, sig) => {
      const state = await this.#load(meta, sessionId, 'asking')
      if (!Array.isArray(answers) || !answers.length) throw new GuideError('bad_request', '还没有选择答案。')
      for (const a of answers) {
        const q = state.questions.find((x) => x.id === a?.qid)
        if (!q) throw new GuideError('stale', '这道题已经过期了，请刷新。', 409)
        const rec = q.options.find((o) => o.recommended)
        if (a.delegate) {
          // F1-6: "你来定" is the AI's pick, so it stays tentative.
          state.states[q.dim] = { status: 'defaulted', value: rec?.label, confidence: 0.6 }
          state.sources[q.dim] = 'delegate'
          state.qa.push({ round: state.round, dim: q.dim, question: q.text, answer: `你来定（按推荐：${rec?.label ?? ''}）` })
          continue
        }
        let text
        if (Number.isInteger(a.choice) && q.options[a.choice]) text = q.options[a.choice].label
        else if (typeof a.free === 'string' && a.free.trim()) text = a.free.trim().slice(0, 500)
        else throw new GuideError('bad_request', '有一道题还没回答。')
        state.states[q.dim] = { status: 'known', value: text, confidence: 1 }
        state.sources[q.dim] = 'answer'
        state.qa.push({ round: state.round, dim: q.dim, question: q.text, answer: text })
      }
      return this.#advance(meta, sessionId, state, sig)
    })
  }

  skip({ sessionId }) {
    return this.#step(sessionId, 'skip', {}, async (meta, sig) => this.#restate(meta, sessionId, await this.#load(meta, sessionId), sig))
  }

  confirm({ sessionId, correction }) {
    return this.#step(sessionId, 'confirm', { correction }, async (meta, sig) => {
      const state = await this.#load(meta, sessionId, 'restating')
      if (typeof correction === 'string' && correction.trim()) {
        state.qa.push({ round: state.round, dim: 'correction', question: '复述里需要改的地方', answer: correction.trim().slice(0, 500) })
        state.corrections = [...(state.corrections ?? []), correction.trim().slice(0, 200)]
        return this.#restate(meta, sessionId, state, sig)
      }
      const turn = await this.sessions.currentTurn(sessionId).catch(() => undefined)
      const { data } = await this.runner.run({ sessionId, turn, purpose: 'intake', signal: sig.signal, system: BRIEF_SYSTEM,
        material: this.#material(state, true), instruction: '请按要求输出简报字段的 JSON。',
        parse: (t) => parseBriefFields(extractJson(t)) })
      sig.check()
      const brief = await this.#saveBrief(state, data)
      state.stage = 'brief_ready'
      state.briefVersion = brief.version
      await this.store.write(this.#statePath(meta, sessionId), state)
      return { stage: 'brief_ready', brief: briefView(brief) }
    })
  }

  /** F1-8: the user's own edit is kept verbatim as a new version. */
  async editBrief({ sessionId, text }) {
    const meta = await this.sessions.meta(sessionId)
    const latest = await this.latestBrief(meta.projectId)
    if (!latest) throw new GuideError('not_found', '还没有需求简报。', 404)
    const brief = { ...latest, version: latest.version + 1, text: text.trim().slice(0, 6000), editedByUser: true, createdAt: this.now() }
    await this.store.update(this.#briefPath(meta.projectId), { series: [], current: undefined }, (all) => {
      all.series.find((s) => s.id === all.current)?.versions.push(brief)
    })
    return { brief: briefView(brief) }
  }

  async reset({ sessionId }) {
    const meta = await this.sessions.meta(sessionId)
    await this.store.write(this.#statePath(meta, sessionId), null)
  }

  async #load(meta, sessionId, stage) {
    const state = await this.store.read(this.#statePath(meta, sessionId), null)
    if (!state) throw new GuideError('not_found', '还没有开始梳理。', 404)
    if (stage && state.stage !== stage) throw new GuideError('stale', '梳理已经进入下一步了，请刷新。', 409)
    return state
  }

  #material(state, withRestatement = false) {
    const parts = [`【用户的想法】${state.idea}`]
    if (state.scenario) parts.push(`【场景】${state.scenario}`)
    parts.push(`【项目文件夹】${state.scan}`)
    if (state.baseBrief) parts.push(`【现有需求简报（这次是在它基础上改需求）${state.baseEdited ? '：其中有用户亲手改过的内容，除非用户这次明确要改，否则原样保留' : ''}】\n${state.baseBrief}`)
    if (state.qa.length) parts.push('【已经问过的问题和用户的回答】\n' + state.qa.map((x) => `- ${x.question} → ${x.answer}`).join('\n'))
    parts.push('【当前各维度判断】\n' + DIM_IDS.map((id) => `- ${id}: ${state.states[id].status}${state.states[id].value ? `，${state.states[id].value}` : ''}`).join('\n'))
    if (withRestatement && state.restatement) parts.push(`【用户已确认的复述】${state.restatement}`)
    return parts.join('\n\n')
  }

  async #advance(meta, sessionId, state, signal) {
    if (state.askedCount >= HARD_CAP) return this.#restate(meta, sessionId, state, signal) // F1-1
    const turn = await this.sessions.currentTurn(sessionId).catch(() => undefined)
    const askedDims = new Set(state.askedDims)
    let result
    try {
      result = await this.runner.run({ sessionId, turn, purpose: 'intake', signal: signal.signal, system: ROUND_SYSTEM,
        material: this.#material(state), instruction: '请按要求输出这一轮的 JSON。',
        parse: (t) => parseRound(extractJson(t), state.states, state.sources, askedDims, state.askedCount) })
    } catch (e) {
      // F1-5: still no qualified question after one retry → go to the restatement, never stall.
      if (e instanceof GuideError && e.code === 'invalid_output') return this.#restate(meta, sessionId, state, signal)
      throw e
    }
    state.states = result.data.states
    state.sources = result.data.sources
    const picked = result.data.picked
    if (!picked.length || covered(state.states)) return this.#restate(meta, sessionId, state, signal)
    state.round += 1
    state.questions = picked.map((q, i) => ({ id: `${state.round}-${i}`, dim: q.dim, text: q.text, recommendReason: q.recommendReason,
      options: q.options.map((o) => ({ label: o.label, consequence: o.consequence, recommended: o.recommended === true })) }))
    state.askedCount += picked.length
    state.askedDims = [...askedDims, ...picked.map((q) => q.dim)]
    state.stage = 'asking'
    signal.check()
    await this.store.write(this.#statePath(meta, sessionId), state)
    return view(state)
  }

  async #restate(meta, sessionId, state, signal) {
    for (const id of DIM_IDS) {
      if (state.states[id].status !== 'unknown' || !byId[id].defaultable) continue
      const q = state.questions.find((x) => x.dim === id)
      state.states[id] = { status: 'defaulted', value: q?.options.find((o) => o.recommended)?.label ?? '按常见做法', confidence: 0.5 }
      state.sources[id] = 'default'
    }
    const turn = await this.sessions.currentTurn(sessionId).catch(() => undefined)
    const { data } = await this.runner.run({ sessionId, turn, purpose: 'intake', signal: signal.signal, system: RESTATE_SYSTEM,
      material: this.#material(state), instruction: '请按要求输出复述的 JSON。',
      parse: (t) => { const j = extractJson(t); if (typeof j.restatement !== 'string' || !j.restatement.trim()) throw new Error('缺少 restatement'); return j.restatement.trim().slice(0, 300) } })
    state.restatement = data
    state.stage = 'restating'
    state.questions = []
    signal.check()
    await this.store.write(this.#statePath(meta, sessionId), state)
    return view(state)
  }

  async #saveBrief(state, fields) {
    const { confirmed, tentative } = decisions(state)
    const all = await this.store.update(this.#briefPath(state.projectId), { series: [], current: undefined }, (all) => {
      let series = state.kind === 'revise' ? all.series.find((s) => s.id === all.current) : undefined
      if (!series) { series = { id: randomUUID(), createdAt: this.now(), versions: [] }; all.series.push(series); all.current = series.id }
      const version = (series.versions.at(-1)?.version ?? 0) + 1
      const brief = { ...fields, confirmed, tentative, version, seriesId: series.id, dimStates: state.states, dimSources: state.sources, createdAt: this.now() }
      brief.text = renderBrief(brief)
      series.versions.push(brief)
    })
    return all.series.find((s) => s.id === all.current).versions.at(-1)
  }
}

/**
 * F1-6 / F1-7: "已确认" is built by the server from what the user chose or said; everything the AI
 * inferred, defaulted or was delegated is "暂定". Every high/medium dimension lands in one of them.
 */
export function decisions(state) {
  const confirmed = []
  const tentative = []
  for (const d of DIMENSIONS) {
    if (d.id === 'style') continue
    const s = state.states[d.id]
    const line = `${d.label}：${s?.value ?? '还没定，请先问我'}`
    if (s?.status === 'known' && CONFIRMED_SOURCES.has(state.sources?.[d.id])) confirmed.push(line)
    else if (d.weight >= 2) tentative.push(line)
  }
  for (const c of state.corrections ?? []) confirmed.push(`补充：${c}`)
  return { confirmed, tentative }
}

/** Validates one interview round and picks the questions (F1-2, F1-3). Throws so the runner retries once (F1-5). */
export function parseRound(j, previous, prevSources, askedDims, askedCount) {
  if (!Array.isArray(j.dims)) throw new Error('缺少 dims 数组')
  const states = structuredClone(previous)
  const sources = { ...prevSources }
  for (const d of j.dims) {
    if (!DIM_IDS.includes(d?.id) || !['known', 'inferred', 'unknown'].includes(d.status)) continue
    if (['answer', 'delegate', 'default', 'idea'].includes(sources[d.id])) continue // the model never overrides recorded decisions
    states[d.id] = { status: d.status, value: typeof d.value === 'string' ? d.value.slice(0, 160) : undefined,
      confidence: Math.min(1, Math.max(0, Number(d.confidence) || 0)) }
    if (d.status === 'known') sources[d.id] = 'idea'
    else if (d.status === 'inferred') sources[d.id] = 'inferred'
    else delete sources[d.id]
  }
  if (states.style.status === 'unknown') { states.style = { status: 'defaulted', value: '第一版用占位', confidence: 1 }; sources.style = 'default' }
  const reasons = []
  const valid = (Array.isArray(j.questions) ? j.questions : []).filter((q) => { const why = validQuestion(q); if (why) reasons.push(`${q?.dim}: ${why}`); return !why })
  const picked = selectQuestions(states, valid, askedDims, askedCount)
  const needsQuestion = askedCount < HARD_CAP && !covered(states) && DIMENSIONS.some((d) => d.weight >= 2 && states[d.id].status === 'unknown' && !askedDims.has(d.id)
    && d.dependsOn.every((p) => states[p].status !== 'unknown'))
  if (!picked.length && needsQuestion) throw new Error('没有合格的题目' + (reasons.length ? '：' + reasons.slice(0, 4).join('；') : '：请为还不清楚的维度出题'))
  return { states, sources, picked }
}

function view(state) {
  const settledCount = DIMENSIONS.filter((d) => d.weight >= 2 && state.states[d.id]?.status !== 'unknown').length
  const total = DIMENSIONS.filter((d) => d.weight >= 2).length
  return {
    stage: state.stage, round: state.round, askedCount: state.askedCount, softCapReached: state.askedCount >= SOFT_CAP,
    progress: { settled: settledCount, total }, idea: state.idea,
    questions: state.stage === 'asking' ? state.questions.map((q) => ({ ...q, topic: byId[q.dim]?.label })) : [],
    restatement: state.stage === 'restating' ? state.restatement : undefined,
  }
}

function briefView(b) {
  return { version: b.version, title: b.title, oneLiner: b.oneLiner, text: b.text, createdAt: b.createdAt, editedByUser: !!b.editedByUser }
}
