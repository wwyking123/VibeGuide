import { GuideError } from './errors.js'

export const safe = (id) => String(id).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120)

/** Everything a project owns lives under projects/<id>/ so "清除当前项目的记录" is one delete (ST-7). */
export const projectDir = (projectId) => `projects/${safe(projectId)}`
export const sessionDir = (projectId, sessionId) => `${projectDir(projectId)}/sessions/${safe(sessionId)}`

/**
 * Per-project epochs. Clearing a project bumps its epoch and aborts its in-flight generation, so a
 * late model result can never recreate records that were just cleared (ST-7).
 */
export class ProjectGuard {
  constructor() {
    this.epochs = new Map()
    this.controllers = new Map()
  }

  epoch(projectId) { return this.epochs.get(projectId) ?? 0 }

  assert(projectId, epoch) {
    if (this.epoch(projectId) !== epoch) throw new GuideError('cleared', '这个项目的记录刚被清除，这次的结果已丢弃。', 409)
  }

  /** An AbortSignal that fires when the project is cleared or the plugin unloads. */
  signal(projectId, outer) {
    const controller = new AbortController()
    let set = this.controllers.get(projectId)
    if (!set) { set = new Set(); this.controllers.set(projectId, set) }
    set.add(controller)
    const onOuter = () => controller.abort(outer.reason)
    outer?.addEventListener('abort', onOuter, { once: true })
    if (outer?.aborted) controller.abort(outer.reason)
    return { signal: controller.signal, done: () => { set.delete(controller); outer?.removeEventListener('abort', onOuter) } }
  }

  clear(projectId) {
    this.epochs.set(projectId, this.epoch(projectId) + 1)
    for (const c of this.controllers.get(projectId) ?? []) c.abort(new GuideError('cleared', '这个项目的记录已被清除。', 409))
    this.controllers.delete(projectId)
  }

  abortAll() { for (const id of [...this.controllers.keys()]) { for (const c of this.controllers.get(id)) c.abort(new Error('unloaded')) } this.controllers.clear() }
}

/** Concurrent identical requests share one generation and one charge (ML-9). */
export class Inflight {
  constructor() { this.map = new Map() }
  run(key, fn) {
    const existing = this.map.get(key)
    if (existing) return existing
    const p = Promise.resolve().then(fn).finally(() => this.map.delete(key))
    this.map.set(key, p)
    return p
  }
}
