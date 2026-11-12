import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { GuideError } from '../errors.js'
import { extractJson, sanitizeFill } from '../runner.js'
import { transcript } from '../session/turns.js'
import { classifyFailure, detectorForTurnError } from '../watch/detectors.js'
import { render } from '../watch/templates.js'
import { sessionDir } from '../project.js'

const GLOSSARY = JSON.parse(readFileSync(new URL('./glossary.zh.json', import.meta.url), 'utf8'))
const INDEX = new Map()
for (const e of GLOSSARY) for (const k of [e.term, ...e.aliases]) INDEX.set(norm(k), e)
function norm(s) { return String(s).trim().toLowerCase().replace(/[\s`"'“”‘’（）()【】[\]：:，,。.!！?？]+/g, '') }

const FILL_MARK = '【可以填入】'
const CACHE_MAX = 100
const CACHE_TTL = 24 * 3600_000      // F3-6
const THREAD_MAX = 50                // F3-7
const CONTEXT_MAX = 12_000           // F3-8

export function lookup(text) { return INDEX.get(norm(text)) }

const ERROR_LIKE = /\b(error|exception|traceback|failed|ENOENT|EACCES|EADDRINUSE|ECONN\w+|command not found|exit code: [1-9]|npm ERR!)|报错|失败|错误/i

export function classifySelection(text) {
  const t = text.trim()
  if (ERROR_LIKE.test(t) && (t.includes('\n') || [...t].length > 24 || /exit code|ERR|Error:/.test(t))) return 'error'
  if ([...t].length <= 24 && !/[。！？.!?]$/.test(t)) return 'term'
  if ([...t].length > 200) return 'passage'
  return 'sentence'
}

/** F3-8: the message containing the selection, if it can be found. */
export function messageContaining(turns, selection) {
  const probe = selection.trim().slice(0, 80)
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]
    if (t.assistantText?.includes(probe)) return t.assistantText
    for (const s of t.steps) if (s.result?.text?.includes(probe)) return s.result.text
    if (t.userText?.includes(probe)) return t.userText
  }
  return undefined
}

const LENGTH = { short: '每个字段一两句话，简短', detailed: '可以多解释一点，但每个字段不超过四句话' }

export class Lens {
  constructor({ sessions, store, runner, intake, settings, guard, inflight }) {
    this.sessions = sessions
    this.store = store
    this.runner = runner
    this.intake = intake
    this.settings = settings
    this.guard = guard
    this.inflight = inflight
  }

  async #context(sessionId, selection) {
    const [turns, meta] = await Promise.all([this.sessions.turns(sessionId).catch(() => []), this.sessions.meta(sessionId)])
    const brief = await this.intake.latestBrief(meta.projectId).catch(() => undefined)
    const head = `【项目】${meta.projectName}${brief ? `：${brief.oneLiner}${brief.inScope?.length ? `（第一版范围：${brief.inScope.join('、')}）` : ''}` : ''}`
    const message = selection ? messageContaining(turns, selection) : undefined
    const msg = message ? `【选中内容所在的消息】\n${message.slice(0, 3000)}` : ''
    const room = Math.max(1000, CONTEXT_MAX - head.length - msg.length - 40)
    const text = [head, msg, `【最近的对话】\n${transcript(turns, { maxTurns: 6, maxChars: room })}`].filter(Boolean).join('\n\n').slice(0, CONTEXT_MAX)
    return { turns, meta, text }
  }

  async explain({ sessionId, text, contextualize = false }) {
    const selection = text.trim().slice(0, 4000)
    const kind = classifySelection(selection)
    const meta = await this.sessions.meta(sessionId)
    const entry = kind === 'term' ? lookup(selection) : undefined
    // F3-3: a glossary hit answers instantly, with no model call.
    if (entry && !contextualize) {
      return { kind: 'term', source: 'glossary', techName: entry.term, what: entry.what, inYourProject: entry.whenItMatters, needAction: 'none', canContextualize: true }
    }
    if (kind === 'term' && !entry) this.#countMiss(selection).catch(() => {})
    if (kind === 'error') {
      const local = errorTemplate(selection)
      if (local) return local
    }
    const length = (await this.settings.get()).explainLength
    const key = createHash('sha1').update(`${kind}|${contextualize}|${norm(selection)}|${length}`).digest('hex')
    const cachePath = `${sessionDir(meta.projectId, sessionId)}/lens-cache.json`
    const now = Date.now()
    const hit = (await this.store.read(cachePath, [])).find((c) => c.key === key && now - c.at < CACHE_TTL)
    if (hit) return { ...hit.value, cached: true }

    return this.inflight.run(`lens:${sessionId}:${key}`, async () => {
      const epoch = this.guard.epoch(meta.projectId)
      const scoped = this.guard.signal(meta.projectId)
      try {
        const ctx = await this.#context(sessionId, selection)
        const turn = ctx.turns.at(-1)?.index
        let value
        if (kind === 'error') {
          const { data } = await this.runner.run({ sessionId, turn, purpose: 'lens', urgent: true, signal: scoped.signal,
            system: `你是 VibeGuide，帮不懂代码的用户看懂报错。只输出 JSON：{"title":"一句话说发生了什么","why":"白话原因，推测的说明是推测","impact":"对用户项目的影响，说明之前做好的东西有没有受影响","fill":"一句可以直接发给 AI 编程助手的话，以“请”开头"}。${LENGTH[length]}。技术名放括号里。`,
            material: `【用户选中的报错】\n${selection}\n\n${ctx.text}`, instruction: '请解释用户选中的报错，按要求输出 JSON。',
            parse: (t) => { const j = extractJson(t); for (const k of ['title', 'why', 'impact', 'fill']) if (typeof j[k] !== 'string' || !j[k].trim()) throw new Error(`缺少 ${k}`); return j } })
          const fill = sanitizeFill(data.fill)
          value = { kind: 'error', source: 'model', title: data.title, why: data.why, impact: data.impact, guessed: true,
            actions: fill ? [{ kind: 'fill', label: '让它处理', text: fill }] : [] }
        } else {
          const ask = kind === 'passage'
            ? '"what" 用不超过三句话概括这段在说什么；"inYourProject" 说这段对用户的项目意味着什么'
            : '"what" 用一句话说这是什么（技术名放括号里）；"inYourProject" 结合最近的对话说它在用户的项目里起什么作用、有什么影响'
          const { data } = await this.runner.run({ sessionId, turn, purpose: 'lens', urgent: true, signal: scoped.signal,
            system: `你是 VibeGuide，帮不懂代码的用户看懂 AI 编程助手说的话。只输出 JSON：{"what":"…","inYourProject":"…","needAction":"none|decide|do","actionHint":"needAction 不是 none 时，说用户需要决定或做什么","techName":"对应的技术名，没有就是空字符串"}。${ask}。${LENGTH[length]}。不教代码语法，不要求用户去读文件；不确定就说不确定。`,
            material: `【用户选中的内容】\n${selection}\n\n${ctx.text}`, instruction: '请解释用户选中的内容，按要求输出 JSON。',
            parse: (t) => { const j = extractJson(t); if (typeof j.what !== 'string' || !j.what.trim()) throw new Error('缺少 what'); return j } })
          value = { kind, source: 'model', what: data.what, inYourProject: typeof data.inYourProject === 'string' ? data.inYourProject : '',
            needAction: ['none', 'decide', 'do'].includes(data.needAction) ? data.needAction : 'none',
            actionHint: typeof data.actionHint === 'string' ? data.actionHint : '', techName: typeof data.techName === 'string' ? data.techName : '' }
        }
        this.guard.assert(meta.projectId, epoch)
        await this.store.update(cachePath, [], (c) => {
          const kept = c.filter((x) => x.key !== key && now - x.at < CACHE_TTL)
          kept.push({ key, at: now, value })
          return kept.slice(-CACHE_MAX) // least recently stored goes first (ST-4)
        })
        return value
      } finally { scoped.done() }
    })
  }

  /** F3-9: words only, never their context. */
  async #countMiss(word) {
    const w = word.trim().slice(0, 40)
    await this.store.update('lens-misses.json', {}, (m) => { m[w] = (m[w] ?? 0) + 1 })
  }

  async thread(sessionId) {
    const meta = await this.sessions.meta(sessionId)
    return this.store.read(`${sessionDir(meta.projectId, sessionId)}/thread.json`, [])
  }

  async ask({ sessionId, quote, question }) {
    const meta = await this.sessions.meta(sessionId)
    const path = `${sessionDir(meta.projectId, sessionId)}/thread.json`
    return this.inflight.run(`ask:${sessionId}:${createHash('sha1').update(`${quote}|${question}`).digest('hex')}`, async () => {
      const epoch = this.guard.epoch(meta.projectId)
      const scoped = this.guard.signal(meta.projectId)
      try {
        const history = await this.store.read(path, [])
        const ctx = await this.#context(sessionId, quote)
        const previous = history.slice(-6).map((h) => `${h.quote ? `（引用：${h.quote.slice(0, 200)}）` : ''}用户问：${h.question}\nVibeGuide 答：${h.answer}`).join('\n\n')
        const { text } = await this.runner.run({ sessionId, turn: ctx.turns.at(-1)?.index, purpose: 'ask', urgent: true, signal: scoped.signal,
          system: `你是 VibeGuide，在 DeepSeek Harness 旁边帮不懂代码的用户看懂开发过程。用用户的语言、白话回答，先说结论，再说对用户项目的影响；技术名放括号里；不教代码语法，不要求用户去读文件；不知道就说不知道。你不能修改项目，也不会替用户发消息。如果回答里有一件用户可以直接让主 AI 去做的具体事情，在最后另起一行，以“${FILL_MARK}”开头写一句给主 AI 的话（以“请”开头，保留用户的限制）；没有就不要写这一行。`,
          material: [previous && `【之前的问答】\n${previous}`, quote && `【用户引用的内容】\n${quote.slice(0, 2000)}`, ctx.text].filter(Boolean).join('\n\n'),
          instruction: `用户的问题：${question}` })
        const at = text.lastIndexOf(FILL_MARK)
        const answer = (at >= 0 ? text.slice(0, at) : text).trim()
        const fill = at >= 0 ? sanitizeFill(text.slice(at + FILL_MARK.length).replace(/^[\s:：]+/, '').split('\n')[0]) : undefined
        if (!answer) throw new GuideError('invalid_output', '这次没有生成回答，请重试。主对话不受影响。', 502)
        const entry = { id: randomUUID(), at: Date.now(), quote: quote ? quote.slice(0, 2000) : undefined, question, answer, fill }
        this.guard.assert(meta.projectId, epoch)
        await this.store.update(path, [], (h) => { h.push(entry); if (h.length > THREAD_MAX) h.splice(0, h.length - THREAD_MAX) })
        return entry
      } finally { scoped.done() }
    })
  }
}

export function errorTemplate(text) {
  let detector = classifyFailure('', text, undefined)?.detector
  if (!detector) {
    const d = detectorForTurnError({ message: text })
    if (d !== 'X') detector = d
  }
  if (!detector) return undefined
  const t = render(detector, { detail: text.slice(0, 80) })
  return { kind: 'error', source: 'template', title: t.title, why: t.why, impact: t.impact, actions: t.actions }
}
