// SPEC 12.1: every detector has ≥ 3 positive and ≥ 3 negative cases. F2-1 (pure), F2-2, F2-3,
// F2-4, F2-5, F2-6, F2-13. Detector ids follow the tech design 4.3.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detect, detectByTime, newState, THRESHOLDS } from '../src/host/watch/detectors.js'
import { render, TEMPLATES } from '../src/host/watch/templates.js'
import { ev, bash } from './helpers.js'

/** Runs events through the pure detector and returns the detectors that opened. */
function opened(events) {
  const state = newState()
  const out = []
  for (const e of events) out.push(...detect(state, e).open.map((o) => o.detector))
  return out
}
const turnError = (code, message = code) => [ev.turnStart(1), ev.end(1, { kind: 'error', error: { code, message } })]
const completed = () => [ev.turnStart(1), ev.end(1, { kind: 'completed' })]
const done = (turn = 1) => ev.end(turn, { kind: 'completed' })
const write = (callId, text, isError) => [ev.call(1, callId, 'write', { file_path: 'a.txt', content: 'x' }), ev.result(1, callId, text, { isError })]
const read = (callId, text) => [ev.call(1, callId, 'read', { file_path: 'a.txt' }), ev.result(1, callId, text, { isError: true })]

const CASES = {
  A1: {
    yes: [turnError('TRANSPORT', 'DeepSeek Messages transport failed'), turnError('HTTP_0', 'fetch failed ECONNREFUSED'), turnError(undefined, 'DeepSeek Messages transport failed')],
    no: [completed(), [ev.retry(1, 1, 'TRANSPORT')], [...bash(1, 'c', 'curl x', 'ECONNREFUSED in a log line', 0), done()]],
  },
  A2: {
    yes: [[ev.retry(1, 1, 'RATE_LIMIT')], [ev.retry(1, 2, 'TRANSPORT')], [ev.retry(1, 1, 'SERVER')]],
    no: [turnError('RATE_LIMIT'), [ev.assistant(1, 'hi')], [...bash(1, 'c', 'npm test', 'fail', 1)]],
  },
  A3: {
    yes: [turnError('RATE_LIMIT', 'Rate limit reached'), turnError('HTTP_X', '429 Too Many Requests'), turnError(undefined, 'rate limit exceeded')],
    no: [[ev.retry(1, 1, 'RATE_LIMIT')], turnError('QUOTA'), completed()],
  },
  A4: {
    yes: [turnError('QUOTA', 'Insufficient Balance'), turnError('ACCOUNT_QUOTA'), turnError('HTTP_402', 'Insufficient Balance')],
    no: [turnError('RATE_LIMIT'), turnError('AUTH'), completed()],
  },
  A5: {
    yes: [turnError('AUTH'), turnError('MISSING_CREDENTIAL', 'no API key'), turnError('FORBIDDEN')],
    no: [turnError('QUOTA'), turnError('SERVER'), completed()],
  },
  A6: {
    yes: [turnError('SERVER', 'internal error'), turnError('SERVER', 'Server overloaded'), turnError('SERVER', '503')],
    no: [turnError('TIMEOUT'), turnError('TRANSPORT'), completed()],
  },
  A7: {
    yes: [turnError('TIMEOUT'), turnError('TIMEOUT', 'stream idle'), turnError('TIMEOUT', 'request timed out')],
    no: [turnError('SERVER'), [ev.turnStart(1), ev.end(1, { kind: 'aborted', reason: { kind: 'user' } })], completed()],
  },
  A8: {
    yes: [turnError('EMPTY_RESPONSE'), turnError('STREAM_CLOSED'), turnError('MALFORMED_RESPONSE')],
    no: [turnError('TRANSPORT'), completed(), [ev.turnStart(1), ev.end(1, { kind: 'max-tokens' })]],
  },
  A9: {
    yes: [turnError('CONTEXT_WINDOW_EXCEEDED'), turnError('INVALID_MODEL_CONTEXT'), turnError('HTTP_400', "This model's maximum context length is 131072 tokens")],
    no: [turnError('INVALID_REQUEST', 'bad field'), completed(), [ev.turnStart(1), ev.end(1, { kind: 'max-tokens' })]],
  },
  A10: {
    yes: [[ev.turnStart(1), ev.end(1, { kind: 'max-tokens' })], [ev.turnStart(2), ev.end(2, { kind: 'max-tokens' })], [ev.turnStart(3), ev.assistant(3, '很长'), ev.end(3, { kind: 'max-tokens' })]],
    no: [completed(), turnError('SERVER'), [ev.turnStart(1), ev.end(1, { kind: 'aborted', reason: { kind: 'user' } })]],
  },
  B1: {
    yes: [[...bash(1, 'c', 'vite', 'bash: vite: command not found', 127), done()], [...bash(1, 'c', 'node app.js', "Error: Cannot find module 'express'", 1), done()], [...bash(1, 'c', 'python main.py', "ModuleNotFoundError: No module named 'pandas'", 1), done()]],
    // F2-4: words in a successful result; F2-5: worked around in the same turn; failed reads are routine.
    no: [[...bash(1, 'c', 'cat log.txt', 'old line: command not found', 0), done()],
      [...bash(1, 'c', 'vite', 'vite: command not found', 127), ...bash(1, 'd', 'npm i -D vite && npx vite', 'ready', 0), done()],
      [...read('r', 'command not found'), done()]],
  },
  B2: {
    yes: [[...bash(1, 'c', 'npm run dev', 'Error: listen EADDRINUSE: address already in use :::3000', 1), done()], [...bash(1, 'c', 'python -m http.server', 'OSError: address already in use', 1), done()], [...bash(1, 'c', 'npx next dev', 'Port 3000 is already in use', 1), done()]],
    no: [[...bash(1, 'c', 'cat notes', 'EADDRINUSE was fixed last week', 0), done()],
      [...bash(1, 'c', 'npm run dev', 'EADDRINUSE :::3000', 1), ...bash(1, 'd', 'npm run dev -- --port 3001', 'ready on 3001', 0), done()],
      [...read('r', 'EADDRINUSE'), done()]],
  },
  B3: {
    yes: [[...bash(1, 'c', 'mkdir /opt/x', 'mkdir: /opt/x: Permission denied', 1), done()], [...bash(1, 'c', 'npm i -g x', 'npm ERR! code EACCES', 243), done()], [...write('w', 'EPERM: operation not permitted', true), done()]],
    no: [[...bash(1, 'c', 'cat log', 'permission denied (old)', 0), done()],
      [...bash(1, 'c', 'mkdir /opt/x', 'Permission denied', 1), ...bash(1, 'd', 'mkdir ./x', '', 0), done()],
      [...read('r', 'EACCES'), done()]],
  },
  B4: {
    yes: [[...bash(1, 'c', 'cat a.txt', 'cat: a.txt: No such file or directory', 1), done()], [...bash(1, 'c', 'node x.js', 'Error: ENOENT: no such file', 1), done()], [...write('w', 'ENOENT: no such file or directory', true), done()]],
    no: [[...bash(1, 'c', 'ls', 'ENOENT.md', 0), done()],
      [...bash(1, 'c', 'cat a.txt', 'No such file or directory', 1), ...bash(1, 'd', 'cat src/a.txt', 'ok', 0), done()],
      [...read('r', 'No such file or directory'), done()]],
  },
  B5: {
    yes: [[...bash(1, 'c', 'npm install', 'npm ERR! network ETIMEDOUT', 1), done()], [...bash(1, 'c', 'pip install pandas', 'Failed to establish a new connection', 1), done()], [...bash(1, 'c', 'pnpm add vite', 'getaddrinfo ENOTFOUND registry.npmjs.org', 1), done()]],
    no: [[...bash(1, 'c', 'curl http://x', 'Could not resolve host: x', 6), done()],
      [...bash(1, 'c', 'npm install', 'added 10 packages', 0), done()],
      [...bash(1, 'c', 'npm install', 'npm ERR! network', 1), ...bash(1, 'd', 'npm install --registry=https://registry.npmmirror.com', 'added 10', 0), done()]],
  },
  B6: {
    yes: [[...bash(1, 'a', 'npm test', 'fail', 1), ...bash(1, 'b', 'npm test', 'fail', 1), ...bash(1, 'c', 'npm test', 'fail', 1)],
      [...bash(1, 'a', 'npm run dev --port 3000', 'x', 1), ...bash(1, 'b', 'npm run dev --port 3001', 'x', 1), ...bash(1, 'c', 'npm run dev --port 3002', 'x', 1)],
      [...bash(1, 'a', 'pytest', 'x', 1), done(1), ev.turnStart(2), ...bash(2, 'b', 'pytest', 'x', 1), ...bash(2, 'c', 'pytest', 'x', 1)]],
    no: [[...bash(1, 'a', 'npm test', 'fail', 1), ...bash(1, 'b', 'npm test', 'fail', 1)],
      [...bash(1, 'a', 'npm test', 'x', 1), ...bash(1, 'b', 'npm run lint', 'x', 1), ...bash(1, 'c', 'npm run build', 'x', 1)],
      [...bash(1, 'a', 'npm test', 'x', 1), ...bash(1, 'b', 'npm test', 'ok', 0), ...bash(1, 'c', 'npm test', 'x', 1), ...bash(1, 'd', 'npm test', 'x', 1)]],
  },
  X: {
    yes: [turnError('WEIRD_NEW_CODE', 'something odd'), turnError('UNKNOWN', 'boom'), turnError('INVALID_REQUEST', 'unexpected field')],
    no: [completed(), turnError('RATE_LIMIT'), [ev.turnStart(1), ev.end(1, { kind: 'max-tokens' })]],
  },
}

for (const [detector, { yes, no }] of Object.entries(CASES)) {
  test(`F2-1/F2-2 detector ${detector}: ${yes.length} positive cases open it`, () => {
    for (const [i, events] of yes.entries()) assert.ok(opened(events).includes(detector), `${detector} positive #${i + 1} did not open`)
  })
  test(`F2-1/F2-4/F2-5 detector ${detector}: ${no.length} negative cases do not open it`, () => {
    for (const [i, events] of no.entries()) assert.ok(!opened(events).includes(detector), `${detector} negative #${i + 1} opened`)
  })
}

test('F2-1 detection is deterministic: same events, same signals', () => {
  const events = [...bash(1, 'a', 'npm test', 'fail', 1), ...bash(1, 'b', 'npm test', 'fail', 1), ...bash(1, 'c', 'npm test', 'fail', 1), ev.end(1, { kind: 'error', error: { code: 'RATE_LIMIT' } })]
  assert.deepEqual(opened(events), opened(events))
})

test('F2-3 failure is the exit code, not the word "error"', () => {
  const s = newState()
  detect(s, ev.call(1, 'c', 'bash', { command: 'npm test' }))
  const r = detect(s, ev.result(1, 'c', 'Error: 0 errors found\n[exit code: 0]'))
  assert.equal(s.failures.size, 0)
  assert.equal(r.open.length, 0)
})

test('F2-5 a single failure the AI works around opens nothing at turn end', () => {
  const events = [ev.turnStart(1), ...bash(1, 'a', 'npm run dev', 'EADDRINUSE', 1), ...bash(1, 'b', 'npm run dev -- --port 5174', 'ready', 0), ev.assistant(1, '好了'), done()]
  assert.deepEqual(opened(events), [])
})

test('F2-5 B-class waits for the turn to end before surfacing', () => {
  const s = newState()
  const pre = [ev.turnStart(1), ...bash(1, 'a', 'vite', 'vite: command not found', 127)].flatMap((e) => detect(s, e).open)
  assert.deepEqual(pre, [])
  assert.deepEqual(detect(s, done()).open.map((o) => o.detector), ['B1'])
})

test('F2-6 only host errors or client offline make a block; model-side and rule-side B are never block', () => {
  for (const d of ['A2', 'A10', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'C8', 'D1', 'D2', 'X']) assert.notEqual(render(d, { count: 3, minutes: 3 }).severity, 'block', d)
  for (const d of ['A1', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9']) assert.equal(render(d, {}).severity, 'block', d)
})

test('F2-10/F2-11 every template has an exit and no unfilled placeholders', () => {
  for (const d of Object.keys(TEMPLATES)) {
    const t = render(d, { command: 'npm test', count: 3, minutes: 4, tool: 'bash', code: 'X1', message: 'm', retry: 1, max: 5 })
    assert.ok(t.title && t.why && t.impact, d)
    assert.ok(t.actions.length >= 1, `${d} has no way out`)
    for (const a of t.actions) {
      const text = a.kind === 'fill' ? a.text : a.steps.join(' ')
      assert.ok(!/\{|\}|undefined|null|<[^>]+>|xxx|TODO/i.test(text), `${d} placeholder: ${text}`)
    }
  }
})

// --- time-based (F2-13): C8, D1, D2 with an injected clock ---
const T0 = 1_000_000
test('F2-13 detector C8: ≥ 180 s silent while running → opens (3 positive)', () => {
  for (const gap of [THRESHOLDS.stallMs, 181_000, 600_000]) assert.ok(detectByTime(newState(), { running: true, lastEventAt: T0, now: T0 + gap }).some((o) => o.detector === 'C8'), String(gap))
})
test('F2-13 detector C8: not running, < 180 s, or no events → silent (3 negative)', () => {
  assert.ok(!detectByTime(newState(), { running: false, lastEventAt: T0, now: T0 + 600_000 }).length)
  assert.ok(!detectByTime(newState(), { running: true, lastEventAt: T0, now: T0 + 179_000 }).length)
  assert.ok(!detectByTime(newState(), { running: true, lastEventAt: undefined, now: T0 }).length)
})
test('F2-13 detector D1: approval pending ≥ 30 s → opens (3 positive)', () => {
  const s1 = newState(); detect(s1, ev.approvalAsked('k', 'bash', T0))
  assert.ok(detectByTime(s1, { now: T0 + 30_000 }).some((o) => o.detector === 'D1'))
  const s2 = newState(); s2.approvals.set('hook', { at: T0, tool: 'bash' })
  assert.ok(detectByTime(s2, { now: T0 + 31_000 }).some((o) => o.detector === 'D1'))
  const s3 = newState(); detect(s3, ev.approvalAsked('a', 'bash', T0)); detect(s3, ev.approvalAsked('b', 'write', T0))
  assert.equal(detectByTime(s3, { now: T0 + 40_000 }).filter((o) => o.detector === 'D1').length, 2)
})
test('F2-13 detector D1: decided, < 30 s, or resolved by the tool result → silent (3 negative)', () => {
  const s1 = newState(); detect(s1, ev.approvalAsked('k', 'bash', T0)); detect(s1, ev.approvalDecided('k', T0 + 5_000))
  assert.ok(!detectByTime(s1, { now: T0 + 60_000 }).length)
  const s2 = newState(); detect(s2, ev.approvalAsked('k', 'bash', T0))
  assert.ok(!detectByTime(s2, { now: T0 + 29_000 }).length)
  const s3 = newState(); detect(s3, ev.call(1, 'k', 'bash', { command: 'x' })); detect(s3, ev.approvalAsked('k', 'bash', T0)); detect(s3, ev.result(1, 'k', 'ok\n[exit code: 0]'))
  assert.ok(!detectByTime(s3, { now: T0 + 60_000 }).length)
})
test('F2-13 detector D2: unanswered question ≥ 60 s → opens (3 positive)', () => {
  for (const gap of [60_000, 61_000, 300_000]) {
    const s = newState(); detect(s, ev.call(1, 'q', 'ask_user_question', { questions: [] }, T0))
    assert.ok(detectByTime(s, { now: T0 + gap }).some((o) => o.detector === 'D2'), String(gap))
  }
})
test('F2-13 detector D2: answered, < 60 s, or turn ended → silent (3 negative)', () => {
  const s1 = newState(); detect(s1, ev.call(1, 'q', 'ask_user_question', {}, T0)); detect(s1, ev.result(1, 'q', 'answer'))
  assert.ok(!detectByTime(s1, { now: T0 + 120_000 }).length)
  const s2 = newState(); detect(s2, ev.call(1, 'q', 'ask_user_question', {}, T0))
  assert.ok(!detectByTime(s2, { now: T0 + 59_000 }).length)
  const s3 = newState(); detect(s3, ev.call(1, 'q', 'ask_user_question', {}, T0)); detect(s3, done())
  assert.ok(!detectByTime(s3, { now: T0 + 120_000 }).length)
})
