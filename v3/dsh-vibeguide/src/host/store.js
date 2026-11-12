import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join, normalize, sep } from 'node:path'
import { GuideError } from './errors.js'

const FILE_LIMIT = 4 * 1024 * 1024

/**
 * Private JSON records under one root. Writes are atomic (temp file, fsync, rename) and
 * serialised per file, so concurrent updates in this process never interleave.
 */
export class Store {
  constructor(root) {
    this.root = root
    this.queues = new Map()
    this.corrupted = []
  }

  path(rel) {
    const full = normalize(join(this.root, rel))
    if (!full.startsWith(this.root + sep)) throw new Error('store path escapes root: ' + rel)
    return full
  }

  async read(rel, fallback) {
    const file = this.path(rel)
    let text
    try { text = await readFile(file, 'utf8') }
    catch (e) { if (e.code === 'ENOENT') return structuredClone(fallback); throw e }
    try { return JSON.parse(text) }
    catch {
      // Keep the damaged file for inspection and start clean, but say so.
      await rename(file, `${file}.corrupt-${Date.now()}`).catch(() => {})
      this.corrupted.push(rel)
      return structuredClone(fallback)
    }
  }

  async #writeNow(rel, value) {
    if (this.closed) return // HC-11: nothing is written once unloading starts
    const file = this.path(rel)
    const text = JSON.stringify(value)
    if (Buffer.byteLength(text) > FILE_LIMIT) throw new GuideError('storage_full', '本地记录已满，请在设置里清理当前项目的记录。', 507)
    await mkdir(dirname(file), { recursive: true, mode: 0o700 })
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    const handle = await open(tmp, 'w', 0o600)
    try { await handle.writeFile(text); await handle.sync() } finally { await handle.close() }
    await rename(tmp, file)
  }

  #enqueue(rel, job) {
    const prev = this.queues.get(rel) ?? Promise.resolve()
    const next = prev.catch(() => {}).then(job)
    this.queues.set(rel, next)
    next.finally(() => { if (this.queues.get(rel) === next) this.queues.delete(rel) }).catch(() => {})
    return next
  }

  write(rel, value) { return this.#enqueue(rel, () => this.#writeNow(rel, value)) }

  /** Read-modify-write under the file's queue. `fn` may mutate the draft or return a new value. */
  update(rel, fallback, fn) {
    return this.#enqueue(rel, async () => {
      const draft = await this.read(rel, fallback)
      const result = await fn(draft)
      const value = result === undefined ? draft : result
      await this.#writeNow(rel, value)
      return value
    })
  }

  async drain() { await Promise.allSettled([...this.queues.values()]) }

  /** Deletes a directory under the root, after pending writes to it settle. */
  async remove(relDir) {
    const dir = this.path(relDir)
    const prefix = relDir.endsWith('/') ? relDir : relDir + '/'
    await Promise.allSettled([...this.queues.entries()].filter(([k]) => k.startsWith(prefix)).map(([, p]) => p))
    await rm(dir, { recursive: true, force: true })
  }

  close() { this.closed = true }
}
