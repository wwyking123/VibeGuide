import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { basename } from 'node:path'
import { GuideError } from '../errors.js'
import { buildTurns } from './turns.js'

// ST-8: keep the last 30 turns or about 2 MB of events per session.
export const KEEP_TURNS = 30
export const KEEP_BYTES = 2 * 1024 * 1024

/** Trims a log to the window ST-8 allows. Returns { events, truncated }. */
export function window(events) {
  const starts = events.filter((e) => e.type === 'turn/start')
  let from = 0
  let truncated = false
  if (starts.length > KEEP_TURNS) { from = events.indexOf(starts[starts.length - KEEP_TURNS]); truncated = true }
  let kept = events.slice(from)
  let size = 0
  for (let i = kept.length - 1; i >= 0; i--) {
    size += JSON.stringify(kept[i]).length
    if (size > KEEP_BYTES) { kept = kept.slice(i + 1); truncated = true; break }
  }
  return { events: kept, truncated }
}

/**
 * Per-session view of the host log: a backfill from sessionQuery.readSession plus live
 * `session/event` appends. Seed history is not re-emitted on resume, so backfill dedupes by seq (ST-9).
 */
export class SessionModel {
  constructor({ getSessionQuery, now = () => Date.now() }) {
    this.getSessionQuery = getSessionQuery
    this.now = now
    this.sessions = new Map()
    this.listeners = new Set()
    this.backfillListeners = new Set()
  }

  #entry(id) {
    let s = this.sessions.get(id)
    if (!s) {
      s = { id, events: [], lastSeq: -1, loaded: undefined, running: false, lastEventAt: undefined, turnsCache: undefined, meta: undefined, truncated: false }
      this.sessions.set(id, s)
    }
    return s
  }

  onEvent(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  /** History loaded from the host log (not live): delivered once per load, as a batch. */
  onBackfill(listener) { this.backfillListeners.add(listener); return () => this.backfillListeners.delete(listener) }

  /** Live event from the host (called inside the host's event callback: must stay synchronous, HC-5). */
  append(sessionId, event) {
    const s = this.#entry(sessionId)
    if (typeof event?.seq !== 'number' || event.seq <= s.lastSeq) return false
    s.events.push(event)
    if (event.type === 'turn/start' || s.events.length % 200 === 0) Object.assign(s, window(s.events))
    s.lastSeq = event.seq
    s.lastEventAt = this.now()
    s.turnsCache = undefined
    if (event.type === 'working-directory/change' || event.type === 'model/selection' || event.type === 'request/header') s.meta = undefined
    for (const l of this.listeners) l(sessionId, event)
    return true
  }

  setStatus(sessionId, status) {
    const s = this.#entry(sessionId)
    s.running = status === 'running'
    if (s.running) s.lastEventAt = this.now()
  }

  /** Loads the log once; later calls only wait for that load. Unknown sessions → session_not_found (API-4). */
  async ensure(sessionId) {
    const s = this.#entry(sessionId)
    if (!s.loaded) {
      s.loaded = (async () => {
        const q = this.getSessionQuery()
        if (!q) throw new GuideError('host_unavailable', 'DSH 的会话服务暂时不可用，VibeGuide 稍后会再试。主对话不受影响。', 503)
        let snap
        try { snap = await q.readSession(sessionId) }
        catch { throw new GuideError('session_not_found', '找不到这个会话，请刷新页面。', 404) }
        s.header = snap.session
        const fresh = (snap.events ?? []).filter((e) => e.seq > s.lastSeq)
        const merged = [...fresh, ...s.events].sort((a, b) => a.seq - b.seq)
        Object.assign(s, window(merged))
        s.lastSeq = s.events.at(-1)?.seq ?? s.lastSeq
        s.lastEventAt ??= s.events.at(-1)?.time
        s.turnsCache = undefined
        for (const l of this.backfillListeners) await l(sessionId, fresh)
      })().catch((e) => {
        s.loaded = undefined
        if (this.sessions.get(sessionId) === s && !s.events.length) this.sessions.delete(sessionId)
        throw e
      })
    }
    await s.loaded
    return s
  }

  async turns(sessionId) {
    const s = await this.ensure(sessionId)
    s.turnsCache ??= buildTurns(s.events)
    return s.turnsCache
  }

  async currentTurn(sessionId) {
    const turns = await this.turns(sessionId)
    return turns.at(-1)?.index ?? 0
  }

  /** cwd, project id and the session's model. Projections win over the header (M0, ST-6, ML-1). */
  async meta(sessionId) {
    // During a load the header is already set; waiting on ensure() here would deadlock backfill listeners.
    let s = this.sessions.get(sessionId)
    if (!s?.header) s = await this.ensure(sessionId)
    if (s.meta) return s.meta
    let cwd = s.header?.cwd
    let model
    const q = this.getSessionQuery()
    if (q && typeof q.observeSession === 'function') {
      try {
        const cut = await q.observeSession(sessionId, { projectionMode: 'all' })
        try {
          const values = cut.projections?.values ?? {}
          cwd = values.workingDirectory ?? cut.header?.cwd ?? cwd
          const sel = values.modelSelection?.lastUsed ?? values.modelSelection?.next
          if (sel?.provider && sel?.model) model = { provider: sel.provider, model: sel.model }
        } finally { cut[Symbol.dispose]?.() }
      } catch { /* projections unavailable: fall back to the header */ }
    }
    let root = cwd
    try { if (cwd) root = await realpath(cwd) } catch { /* folder gone; keep the recorded path */ }
    s.meta = {
      cwd: root,
      projectId: createHash('sha256').update(root ?? `session:${sessionId}`).digest('hex').slice(0, 24),
      projectName: root ? basename(root) : '当前会话',
      model,
    }
    return s.meta
  }

  truncated(sessionId) { return !!this.sessions.get(sessionId)?.truncated }
}
