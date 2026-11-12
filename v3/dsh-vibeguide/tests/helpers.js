import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/host/store.js'
import { Settings } from '../src/host/settings.js'
import { Budget } from '../src/host/budget.js'
import { ModelRunner } from '../src/host/runner.js'
import { SessionModel } from '../src/host/session/model.js'
import { Watchdog } from '../src/host/watch/watchdog.js'
import { IntakeEngine } from '../src/host/intake/engine.js'
import { Lens } from '../src/host/lens/lens.js'
import { Inflight, ProjectGuard } from '../src/host/project.js'

export const tmp = (p = 'vg-test-') => mkdtemp(join(tmpdir(), p))

export async function fixture(name) {
  const text = await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
  return text.trim().split('\n').map((l) => JSON.parse(l)).filter((e) => typeof e.seq === 'number')
}

/**
 * Scripted stand-in for the host `llm` service. Each call consumes one step:
 *   { text } | { json } | { failure: { code } } | { maxTokens: true } | { throws: true } | { wait: ms, ...step }
 * `fallback` is used when the script runs out.
 */
export function fakeLlm(script = [], fallback) {
  const calls = []
  return {
    calls,
    async *stream(params) {
      calls.push(params)
      const step = script.shift() ?? (typeof fallback === 'function' ? fallback(params) : fallback) ?? { text: '好的' }
      if (step.wait) await new Promise((r, j) => { const t = setTimeout(r, step.wait); params.signal?.addEventListener('abort', () => { clearTimeout(t); j(new Error('aborted')) }) })
      if (step.throws) throw new Error('socket hang up')
      if (step.failure) { yield { type: 'finish', reason: { kind: 'error', failure: step.failure } }; return }
      if (step.maxTokens) { yield { type: 'text-delta', text: '一半' }; yield { type: 'finish', reason: { kind: 'max-tokens' } }; return }
      const text = step.json !== undefined ? JSON.stringify(step.json) : step.text
      yield { type: 'block-start' }
      yield { type: 'text-delta', text }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

export function fakeSessionQuery(logs = {}, { cwd = '/tmp', model = { provider: 'p', model: 'm' } } = {}) {
  return {
    async readSession(id) {
      if (!logs[id]) throw new Error('unknown session')
      return { session: { id, cwd: logs[id].cwd ?? cwd }, inheritedEventCount: 0, events: structuredClone(logs[id].events ?? []) }
    },
    async observeSession(id) {
      if (!logs[id]) throw new Error('unknown session')
      return { header: { cwd: logs[id].cwd ?? cwd }, projections: { values: { workingDirectory: logs[id].cwd ?? cwd, modelSelection: { lastUsed: model, next: model } } }, [Symbol.dispose]() {} }
    },
  }
}

/** Full service graph on a temp dir with fake host services. */
export async function services({ logs = {}, script = [], fallback, cwd, now, settings: initial } = {}) {
  const root = await tmp()
  const store = new Store(join(root, 'dsh-vibeguide'))
  const settings = new Settings(store)
  if (initial) await settings.set(initial)
  const budget = new Budget(store, settings, now)
  const guard = new ProjectGuard()
  const inflight = new Inflight()
  const llm = fakeLlm(script, fallback)
  const query = fakeSessionQuery(logs, { cwd })
  const sessions = new SessionModel({ getSessionQuery: () => query, now })
  const runner = new ModelRunner({ getLlm: () => llm, getDefaultModel: () => ({ currentSelection: () => ({ provider: 'p', model: 'm' }) }), sessions, budget, sleep: async () => {} })
  const watchdog = new Watchdog({ sessions, store, settings, runner, guard, now })
  const intake = new IntakeEngine({ sessions, store, runner, guard, inflight, now })
  const lens = new Lens({ sessions, store, runner, intake, settings, guard, inflight })
  return { root, store, settings, budget, guard, inflight, llm, query, sessions, runner, watchdog, intake, lens, logs }
}

/** Minimal event builders matching the shapes recorded in M0. */
let seq = 1000
export const ev = {
  reset(n = 1000) { seq = n },
  turnStart: (turn, t) => ({ type: 'turn/start', seq: seq++, time: t, data: { turn } }),
  user: (text, t) => ({ type: 'user/message', seq: seq++, time: t, data: { content: [{ type: 'text', text }], source: { kind: 'user' } } }),
  call: (turn, callId, name, args, t) => ({ type: 'tool/call', seq: seq++, time: t, data: { turn, step: 1, callId, name, arguments: JSON.stringify(args) } }),
  result: (turn, callId, text, { isError = false, meta } = {}, t) => ({ type: 'tool/result', seq: seq++, time: t, data: { turn, step: 1, message: { role: 'tool', toolCallId: callId, isError, content: [{ type: 'text', text }] }, ...(meta ? { meta } : {}) } }),
  assistant: (turn, text, t) => ({ type: 'assistant/message', seq: seq++, time: t, data: { turn, step: 1, message: { role: 'assistant', id: `m${seq}`, content: [{ type: 'text', text }] } } }),
  retry: (turn, n, code, t) => ({ type: 'llm/retry', seq: seq++, time: t, data: { turn, step: 1, retry: n, maxRetries: 5, failure: { code, message: code } } }),
  end: (turn, reason, t) => ({ type: 'turn/end', seq: seq++, time: t, data: { turn, reason } }),
  approvalAsked: (callId, tool, t) => ({ type: 'approval/asked', seq: seq++, time: t, data: { callId, toolName: tool } }),
  approvalDecided: (callId, t) => ({ type: 'approval/decided', seq: seq++, time: t, data: { callId } }),
}

/** A bash call + result pair. */
export function bash(turn, callId, command, output, exitCode) {
  return [ev.call(turn, callId, 'bash', { command }), ev.result(turn, callId, `${output}${exitCode === undefined ? '' : `\n[exit code: ${exitCode}]`}`)]
}

export const flush = () => new Promise((r) => setTimeout(r, 0))

/** Polls until `check()` is truthy (for work the watchdog finishes in the background). */
export async function waitFor(check, ms = 2000) {
  const end = Date.now() + ms
  for (;;) {
    const v = await check()
    if (v) return v
    if (Date.now() > end) return v
    await new Promise((r) => setTimeout(r, 10))
  }
}
