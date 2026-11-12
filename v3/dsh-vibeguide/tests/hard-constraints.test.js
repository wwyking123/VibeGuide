// HC-1 … HC-12, API-1 … API-5, UI-2/UI-4/UI-6/UI-8 (static + unit). Integration checks are in docs/M1_REPORT.md.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { apply, observe } from '../src/host/index.js'
import { handler, rejection, PREFIX } from '../src/host/http.js'
import { compatibility } from '../src/host/compat.js'
import { GuideError } from '../src/host/errors.js'

const ROOT = new URL('../src/', import.meta.url).pathname
async function sources(dir = ROOT) {
  const out = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...await sources(p))
    else if (p.endsWith('.js')) out.push({ path: p.slice(ROOT.length), text: await readFile(p, 'utf8') })
  }
  return out
}
const code = (text) => text.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')

test('HC-1 static: no submit(, prompt(, fork( or inbox writes anywhere in the plugin', async () => {
  for (const f of await sources()) {
    assert.ok(!/\b(submit|prompt|fork)\s*\(/.test(code(f.text)), `${f.path} calls submit/prompt/fork`)
    assert.ok(!/inbox/i.test(code(f.text)), `${f.path} touches the inbox`)
  }
})

test('HC-4 static: llm.stream is called in exactly one place, without tools', async () => {
  const hits = (await sources()).filter((f) => /\.stream\(/.test(f.text))
  assert.deepEqual(hits.map((f) => f.path), ['host/runner.js'])
  assert.ok(!/tools\s*:/.test(hits[0].text))
})

test('HC-8 static: the host half makes no outbound requests; the client only calls its own routes', async () => {
  for (const f of await sources()) {
    if (f.path.startsWith('host/')) assert.ok(!/\bfetch\(|http\.request|https\.request|node:net|node:http'|undici|XMLHttpRequest/.test(code(f.text)), f.path)
  }
  const client = (await sources()).find((f) => f.path === 'client/client.js').text
  for (const m of client.matchAll(/(?:fetch|EventSource|sendBeacon)\(([^,)]+)/g)) assert.match(m[1], /BASE|^`\$\{BASE\}/, m[0])
})

test('HC-12 / UI-4 static: no reference to the old plugin, no private host structures, no runtime deps', async () => {
  for (const f of await sources()) {
    assert.ok(!/VibeGuide\/|vibeguide-p0-state|vibeguide-guide|sessions\.store|__vgProbe/.test(f.text), f.path)
    for (const m of f.text.matchAll(/from '([^'.][^']*)'/g)) assert.match(m[1], /^node:/, `${f.path} imports ${m[1]}`)
  }
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.dependencies, undefined)
  assert.equal(pkg.name, 'dsh-vibeguide')
})

test('UI-8 static: nothing is inserted as HTML', async () => {
  for (const f of await sources()) assert.ok(!/dangerouslySetInnerHTML|innerHTML\s*=|insertAdjacentHTML|eval\(|new Function\(/.test(code(f.text)), f.path)
})

test('HC-3 observers record and always delegate, even when recording throws', async () => {
  const next = () => Promise.resolve('allowed-once')
  assert.equal(await observe(() => { throw new Error('boom') }, () => {})({}, next), 'allowed-once')
  assert.equal(await observe(() => {}, () => {})({}, next), 'allowed-once')
})

test('HC-3 / HC-5 wired into apply(): host callbacks never throw and approvals pass straight through', async () => {
  const handlers = {}
  const effects = []
  const ctx = {
    on: (name, fn) => { handlers[name] = fn },
    effect: (fn) => effects.push(fn),
    inject: () => {},
    get: (name) => (name === 'sessionQuery' ? { readSession: async () => { throw new Error('no') } } : undefined),
  }
  process.env.DSH_HOME = (await import('node:os')).tmpdir() + '/vg-hc-' + Date.now()
  apply(ctx)
  const decided = await handlers['approval/request']({ agent: null, toolName: 'bash' }, async () => 'rejected')
  assert.equal(decided, 'rejected', 'the host decision is returned unchanged')
  assert.doesNotThrow(() => handlers['session/event']({ id: 's' }, { type: 'turn/end', seq: 1, data: { turn: 1, reason: { kind: 'error', error: { code: 'QUOTA' } } } }))
  assert.doesNotThrow(() => handlers['session/event'](null, null))
  assert.doesNotThrow(() => handlers['agent/status']({ agent: { id: 's' }, status: 'running' }))
  for (const fn of effects) { const dispose = fn(); if (typeof dispose === 'function') dispose() } // HC-11
})

// ---------------- API ----------------
function fakeReq({ method = 'GET', url = PREFIX + '/state?sessionId=a', headers = {}, body, remote = '127.0.0.1' } = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(body)])
  Object.assign(req, { method, url, headers: { host: '127.0.0.1:7689', ...headers }, socket: { remoteAddress: remote } })
  return req
}
function fakeRes() {
  const res = { status: 0, body: '', headersSent: false, writeHead(s) { this.status = s; this.headersSent = true }, end(b) { this.body = b ?? ''; this.done?.() } }
  res.finished = new Promise((r) => { res.done = r })
  return res
}
const ctxWith = (rejectionValue) => ({ get: (n) => (n === 'connection' ? { requestRejection: () => rejectionValue } : undefined) })

test('HC-9 / API-2 admission: 401, 403 and admit, before any handler code runs', async () => {
  let ran = 0
  const h = (c) => handler(c, ['GET'], async () => { ran++; return { ok: true } })
  for (const [value, status] of [[401, 401], [403, 403]]) {
    const res = fakeRes(); h(ctxWith(value))(fakeReq(), res); await res.finished
    assert.equal(res.status, status)
  }
  assert.equal(ran, 0)
  const res = fakeRes(); h(ctxWith(undefined))(fakeReq(), res); await res.finished
  assert.equal(res.status, 200)
  // Fallback fence when the connection service is missing.
  assert.equal(rejection({ get: () => undefined }, fakeReq({ remote: '10.0.0.2' })), 403)
  assert.equal(rejection({ get: () => undefined }, fakeReq({ headers: { origin: 'http://evil.example' } })), 403)
  assert.equal(rejection({ get: () => undefined }, fakeReq({ headers: { origin: 'http://127.0.0.1:7689', 'sec-fetch-site': 'same-origin' } })), undefined)
})

test('API-3 writes need JSON and stay under 256 KB; API-5 errors are user-facing Chinese without internals', async () => {
  const h = handler(ctxWith(undefined), ['POST'], async (req) => { const { readJson } = await import('../src/host/http.js'); return readJson(req) })
  const r1 = fakeRes(); h(fakeReq({ method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' }), r1); await r1.finished
  assert.equal(r1.status, 415)
  const r2 = fakeRes(); h(fakeReq({ method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(300 * 1024) }), r2); await r2.finished
  assert.equal(r2.status, 413)
  const boom = handler(ctxWith(undefined), ['GET'], async () => { throw new Error('ENOENT /Users/x/secret at foo.js:1') }, () => {})
  const r3 = fakeRes(); boom(fakeReq(), r3); await r3.finished
  const err = JSON.parse(r3.body).error
  assert.equal(err.code, 'internal')
  assert.ok(!/ENOENT|Users|\.js/.test(err.message))
  assert.match(err.message, /主对话不受影响/, 'TXT-3')
  const known = handler(ctxWith(undefined), ['GET'], async () => { throw new GuideError('session_not_found', '找不到这个会话，请刷新页面。', 404) })
  const r4 = fakeRes(); known(fakeReq(), r4); await r4.finished
  assert.equal(r4.status, 404)
  assert.deepEqual(JSON.parse(r4.body), { error: { code: 'session_not_found', message: '找不到这个会话，请刷新页面。' } })
})

test('API-1 every route is under /plugins/dsh-vibeguide', async () => {
  const text = (await readFile(new URL('../src/host/index.js', import.meta.url), 'utf8'))
  assert.match(text, /path: PREFIX \+ path/)
  assert.equal(PREFIX, '/plugins/dsh-vibeguide')
})

test('API-4 an unknown session id is refused with session_not_found', async () => {
  const { services } = await import('./helpers.js')
  const s = await services({ logs: {} })
  await assert.rejects(s.sessions.meta('nope'), (e) => e.code === 'session_not_found')
})

test('UI-6 version gate: tested, same minor, other, unreadable', () => {
  assert.equal(compatibility('0.2.1-rc.2').level, 'tested')
  assert.equal(compatibility('0.2.3').level, 'untested')
  assert.equal(compatibility('0.3.0').level, 'rules-only')
  assert.equal(compatibility(undefined).level, 'untested')
})

test('UI-2 static: conversation.* and shell.overlay register with { id, order }; the factory injects only slots', async () => {
  const client = await readFile(new URL('../src/client/client.js', import.meta.url), 'utf8')
  assert.match(client, /register\('conversation\.input\.dock', \{ id: '[^']+', order: \d+ \}/)
  assert.match(client, /register\('shell\.overlay', \{ id: '[^']+' \}/)
  assert.match(client, /register\('sidebar\.right\.pane\.tab', \{ key: TAB_ID \}/)
  assert.match(client, /return \{ inject: \['slots'\], apply \}/)
  assert.match(client, /class Boundary extends React\.Component/, 'UI-1 error boundary')
})
