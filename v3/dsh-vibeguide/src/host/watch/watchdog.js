import { randomUUID } from 'node:crypto'
import { detect, detectByTime, newState } from './detectors.js'
import { render } from './templates.js'
import { severityVisible } from '../settings.js'
import { extractJson, sanitizeFill } from '../runner.js'
import { transcript } from '../session/turns.js'
import { sessionDir } from '../project.js'

const KEEP = 50
const WINDOW_MS = 10 * 60_000
const REPEATABLE = new Set(['B6', 'C1']) // F2-8: exempt from "one new incident per detector per 10 min"

/**
 * Turns detector signals into incidents, keeps them per session (under the session's project, so
 * clearing a project removes them, ST-7) and pushes changes to subscribers (SSE). Never acts on the
 * main session: every way out is something the user fills in themselves (F2-16).
 */
export class Watchdog {
  constructor({ sessions, store, settings, runner, guard, now = () => Date.now(), log = () => {} }) {
    this.sessions = sessions
    this.store = store
    this.settings = settings
    this.runner = runner
    this.guard = guard
    this.now = now
    this.log = log
    this.states = new Map()        // sessionId -> detector state
    this.incidents = new Map()     // sessionId -> Incident[]
    this.loaded = new Map()
    this.cursors = new Map()       // sessionId -> last processed seq (F2-18)
    this.projects = new Map()      // sessionId -> projectId
    this.subscribers = new Map()
    this.saveTimers = new Map()
    this.muted = undefined
    this.closed = false
    sessions.onEvent((sessionId, event) => this.onEvent(sessionId, event))
    sessions.onBackfill((sessionId, events) => this.onBackfill(sessionId, events))
  }

  #state(id) { let s = this.states.get(id); if (!s) { s = newState(); this.states.set(id, s) } return s }
  #listSync(id) { let l = this.incidents.get(id); if (!l) { l = []; this.incidents.set(id, l) } return l }

  async #dir(sessionId) {
    let pid = this.projects.get(sessionId)
    if (!pid) { pid = (await this.sessions.meta(sessionId)).projectId; this.projects.set(sessionId, pid) }
    return sessionDir(pid, sessionId)
  }

  async #list(id) {
    if (!this.loaded.has(id)) {
      this.loaded.set(id, this.#dir(id).then((dir) => this.store.read(`${dir}/incidents.json`, [])).then((saved) => {
        // Open problems are re-derived from new events; saved copies are history only.
        const live = this.incidents.get(id) ?? []
        const history = saved.filter((s) => !live.some((l) => l.id === s.id)).map((s) => s.state === 'open' ? { ...s, state: 'recovered' } : s)
        this.incidents.set(id, [...history, ...live])
      }).catch(() => {}))
    }
    await this.loaded.get(id)
    return this.#listSync(id)
  }

  async #mutedSet() { this.muted ??= new Set(await this.store.read('muted.json', [])); return this.muted }

  /** Live host event. Synchronous: no disk or model work is awaited here (HC-5). */
  onEvent(sessionId, event) {
    const result = detect(this.#state(sessionId), event)
    this.cursors.set(sessionId, Math.max(this.cursors.get(sessionId) ?? -1, event.seq))
    this.#apply(sessionId, result.open, result.recover)
  }

  /**
   * History replay after a (re)start (F2-18, ST-9): rebuild detector state from the log, but only
   * surface events newer than the persisted cursor. A session seen for the first time only surfaces
   * its latest turn: yesterday's rate limit is not news.
   */
  async onBackfill(sessionId, events) {
    const dir = await this.#dir(sessionId).catch(() => undefined)
    const saved = dir ? (await this.store.read(`${dir}/cursor.json`, { seq: undefined })).seq : undefined
    const lastStart = Math.max(-1, ...events.filter((e) => e.type === 'turn/start').map((e) => e.seq))
    const from = typeof saved === 'number' ? saved + 1 : lastStart
    const state = this.#state(sessionId)
    for (const e of events) {
      const r = detect(state, e)
      this.#apply(sessionId, e.seq >= from ? r.open : [], r.recover)
    }
    if (events.length) { this.cursors.set(sessionId, Math.max(this.cursors.get(sessionId) ?? -1, events.at(-1).seq)); this.#scheduleSave(sessionId) }
  }

  onStatus(sessionId, status) {
    this.sessions.setStatus(sessionId, status)
    if (status !== 'running') this.#apply(sessionId, [], [{ detector: 'C8' }])
  }

  /** Live approval hook: record only (HC-3). */
  onApproval(sessionId, req) {
    const key = req?.callId ?? 'approval'
    this.#state(sessionId).approvals.set(key, { at: this.now(), tool: req?.toolName, reason: req?.displayReason ?? req?.reason })
  }

  onQuestion(sessionId) { this.#state(sessionId).question ??= { at: this.now() } }

  /** Timer tick: stalls, unanswered approvals and questions (F2-13). */
  tick() {
    const now = this.now()
    for (const [id, state] of this.states) {
      const s = this.sessions.sessions.get(id)
      const open = detectByTime(state, { running: !!s?.running, lastEventAt: s?.lastEventAt, now })
      if (open.length) this.#apply(id, open, [])
    }
  }

  #apply(sessionId, opens, recovers) {
    if (this.closed) return
    const list = this.#listSync(sessionId)
    const changed = new Set()
    const now = this.now()
    for (const r of recovers) {
      const detectors = r.detectors ?? [r.detector]
      for (const inc of list) {
        if (inc.state !== 'open' || !detectors.includes(inc.detector)) continue
        if (r.signature && inc.signature !== r.signature) continue
        inc.state = 'recovered'; inc.updatedAt = now; changed.add(inc)
      }
    }
    for (const o of opens) {
      const vars = o.vars ?? {}
      // F2-8: dedupe on detector + session + signature …
      let target = list.find((i) => i.detector === o.detector && i.signature === o.signature && i.state === 'open')
      // … and at most one new incident per detector per 10 minutes (reuse the recent one instead).
      if (!target && !REPEATABLE.has(o.detector)) {
        const recent = list.findLast((i) => i.detector === o.detector && now - i.openedAt < WINDOW_MS)
        if (recent?.state === 'dismissed') continue
        if (recent) target = recent
      }
      if (target) {
        target.state = 'open'
        target.count += 1
        target.updatedAt = now
        target.signature = o.signature
        target.vars = { ...target.vars, ...vars }
        Object.assign(target, card(o.detector, target.vars, target.explanation))
        if (o.evidence) target.evidence = [...target.evidence, o.evidence].slice(-5)
        changed.add(target)
        continue
      }
      const inc = { id: randomUUID(), sessionId, detector: o.detector, signature: o.signature, state: 'open', count: 1,
        openedAt: now, updatedAt: now, vars, evidence: o.evidence ? [o.evidence] : [], ...card(o.detector, vars) }
      list.push(inc)
      changed.add(inc)
      if (o.detector === 'X') this.#explainUnknown(inc).catch((e) => this.log('explain unknown skipped:', e?.code ?? e))
    }
    if (!changed.size) return
    if (list.length > KEEP) list.splice(0, list.length - KEEP)
    this.#scheduleSave(sessionId)
    for (const inc of changed) this.#notify(sessionId, inc)
  }

  /** F2-15: at most one automatic model call per unknown error, behind its switch and the budget. */
  async #explainUnknown(inc) {
    const settings = await this.settings.get()
    if (!settings.autoExplainUnknown || !this.runner || this.closed) return
    const meta = await this.sessions.meta(inc.sessionId)
    const epoch = this.guard?.epoch(meta.projectId)
    const turns = await this.sessions.turns(inc.sessionId).catch(() => [])
    const scoped = this.guard?.signal(meta.projectId)
    try {
      const { data } = await this.runner.run({ sessionId: inc.sessionId, turn: turns.at(-1)?.index, purpose: 'explain-error', signal: scoped?.signal,
        system: '你是 VibeGuide，帮不懂代码的用户看懂 AI 编程助手遇到的报错。只输出一个 JSON 对象：{"what":"一句话说发生了什么","why":"白话原因；是推测的话说明是推测","impact":"对用户项目的影响，说明之前做好的东西有没有受影响","fill":"一句可以直接发给 AI 编程助手的话，以“请”开头，让它说明并处理这个问题"}。不说黑话，技术名放括号里。',
        material: `【报错】${inc.vars.code ?? ''} ${inc.vars.message ?? ''}\n\n【最近对话】\n${transcript(turns, { maxTurns: 3, maxChars: 6000 })}`,
        instruction: '请按要求输出 JSON。',
        parse: (t) => {
          const j = extractJson(t)
          for (const k of ['what', 'why', 'impact', 'fill']) if (typeof j[k] !== 'string' || !j[k].trim()) throw new Error(`缺少 ${k}`)
          return j
        } })
      if (this.closed || (this.guard && this.guard.epoch(meta.projectId) !== epoch)) return
      inc.explanation = { what: data.what.slice(0, 120), why: data.why.slice(0, 300), impact: data.impact.slice(0, 200), fill: sanitizeFill(data.fill) }
      Object.assign(inc, card(inc.detector, inc.vars, inc.explanation))
      inc.updatedAt = this.now()
      this.#scheduleSave(inc.sessionId)
      this.#notify(inc.sessionId, inc)
    } finally { scoped?.done() }
  }

  #scheduleSave(sessionId) {
    if (this.saveTimers.has(sessionId) || this.closed) return
    this.saveTimers.set(sessionId, setTimeout(() => {
      this.saveTimers.delete(sessionId)
      this.#save(sessionId).catch((e) => this.log('save incidents failed', e))
    }, 300))
  }

  async #save(sessionId) {
    const dir = await this.#dir(sessionId)
    await this.store.write(`${dir}/incidents.json`, this.incidents.get(sessionId) ?? [])
    if (this.cursors.has(sessionId)) await this.store.write(`${dir}/cursor.json`, { seq: this.cursors.get(sessionId) })
  }

  async flush() {
    for (const [id, t] of this.saveTimers) { clearTimeout(t); this.saveTimers.delete(id); await this.#save(id).catch(() => {}) }
  }

  close() {
    this.closed = true
    for (const t of this.saveTimers.values()) clearTimeout(t)
    this.saveTimers.clear()
    for (const subs of this.subscribers.values()) subs.clear()
  }

  /** ST-7: forget a cleared project's incidents in memory too. */
  clearProject(projectId) {
    for (const [sessionId, pid] of this.projects) {
      if (pid !== projectId) continue
      this.incidents.delete(sessionId)
      this.loaded.delete(sessionId)
      clearTimeout(this.saveTimers.get(sessionId))
      this.saveTimers.delete(sessionId)
    }
  }

  async #visible(inc) {
    const [settings, muted] = await Promise.all([this.settings.get(), this.#mutedSet()])
    if (inc.state === 'dismissed') return false
    if (muted.has(inc.detector)) return false // F2-17
    return severityVisible(settings.alertLevel, inc.severity)
  }

  #notify(sessionId, inc) {
    const subs = this.subscribers.get(sessionId)
    if (!subs?.size) return
    this.#visible(inc).then((visible) => { for (const fn of subs) fn({ ...publicView(inc), visible }) }).catch(() => {})
  }

  subscribe(sessionId, fn) {
    let subs = this.subscribers.get(sessionId)
    if (!subs) { subs = new Set(); this.subscribers.set(sessionId, subs) }
    subs.add(fn)
    return () => subs.delete(fn)
  }

  /** Incidents the user should see: open and visible ones, or anything changed since `since`. */
  async view(sessionId, since = 0) {
    await this.sessions.ensure(sessionId)
    this.tick()
    const list = await this.#list(sessionId)
    const out = []
    for (const inc of list) {
      if (since && inc.updatedAt <= since) continue
      const visible = inc.state === 'open' && await this.#visible(inc)
      if (!since && !visible) continue
      out.push({ ...publicView(inc), visible })
    }
    return out
  }

  async feedback(sessionId, incidentId, kind) {
    const list = await this.#list(sessionId)
    const inc = list.find((i) => i.id === incidentId)
    if (!inc) return false
    inc.feedback = kind // F2-17: 'wrong' stays on this machine, for tuning
    if (kind === 'dismiss' || kind === 'mute' || kind === 'wrong') { inc.state = 'dismissed'; inc.updatedAt = this.now() }
    if (kind === 'mute') {
      const muted = await this.#mutedSet()
      muted.add(inc.detector)
      await this.store.write('muted.json', [...muted])
    }
    this.#scheduleSave(sessionId)
    this.#notify(sessionId, inc)
    return true
  }

  /** Client offline/online signal: the only non-host source allowed to raise a block (F2-6). */
  clientSignal(sessionId, kind) {
    if (kind === 'offline') this.#apply(sessionId, [{ detector: 'A1', signature: 'client-offline', vars: {}, evidence: { at: this.now(), excerpt: '浏览器报告网络已断开' } }], [])
    if (kind === 'online') this.#apply(sessionId, [], [{ detector: 'A1', signature: 'client-offline' }])
  }
}

function card(detector, vars, explanation) {
  const t = render(detector, vars)
  if (vars?.escalate && t.severity === 'info') t.severity = 'warn'
  if (explanation) {
    t.title = explanation.what || t.title
    t.why = explanation.why || t.why
    t.impact = explanation.impact || t.impact
    if (explanation.fill) t.actions = [{ kind: 'fill', label: '让它处理', text: explanation.fill }, ...t.actions.filter((a) => a.kind !== 'fill' || a.safeword)]
    t.guessed = true
  }
  return t
}

function publicView(inc) {
  const { vars, signature, ...rest } = inc
  return rest
}
