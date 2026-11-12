// ST-1 … ST-8 (SPEC §8) and F3-3 … F3-9 (SPEC §5)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Store } from '../src/host/store.js'
import { window, KEEP_TURNS } from '../src/host/session/model.js'
import { classifySelection, lookup, messageContaining } from '../src/host/lens/lens.js'
import { projectDir } from '../src/host/project.js'
import { services, tmp, ev } from './helpers.js'

test('ST-1 paths cannot escape the plugin root', async () => {
  const s = new Store(join(await tmp(), 'dsh-vibeguide'))
  assert.throws(() => s.path('../outside.json'), /escapes/)
  assert.throws(() => s.path('projects/../../x'), /escapes/)
})

test('ST-2 / ST-3 atomic, serialised writes; 0700 directories, 0600 files', async () => {
  const root = join(await tmp(), 'dsh-vibeguide')
  const s = new Store(root)
  await Promise.all(Array.from({ length: 50 }, (_, i) => s.update('c.json', { n: 0 }, (d) => { d.n += 1 })))
  assert.equal((await s.read('c.json', {})).n, 50)
  assert.equal((await readdir(root)).filter((f) => f.endsWith('.tmp')).length, 0, 'no temp files left')
  assert.equal((await stat(root)).mode & 0o777, 0o700)
  assert.equal((await stat(join(root, 'c.json'))).mode & 0o777, 0o600)
})

test('ST-4 a file over 4 MB is refused with a user-facing message', async () => {
  const s = new Store(join(await tmp(), 'dsh-vibeguide'))
  await assert.rejects(s.write('big.json', 'x'.repeat(4 * 1024 * 1024 + 10)), (e) => e.code === 'storage_full' && /清理/.test(e.message))
})

test('ST-5 a corrupt file is kept aside, reading starts clean, and it is reported', async () => {
  const root = join(await tmp(), 'dsh-vibeguide')
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'settings.json'), '{oops')
  const s = new Store(root)
  assert.deepEqual(await s.read('settings.json', {}), {})
  assert.ok((await readdir(root)).some((f) => f.startsWith('settings.json.corrupt-')))
  assert.deepEqual(s.corrupted, ['settings.json'])
})

test('HC-11 writes stop once the store is closed', async () => {
  const s = new Store(join(await tmp(), 'dsh-vibeguide'))
  s.close()
  await s.write('late.json', { x: 1 })
  assert.deepEqual(await s.read('late.json', null), null)
})

test('ST-8 only the last 30 turns are kept and the cut is flagged', () => {
  ev.reset()
  const events = []
  for (let t = 1; t <= KEEP_TURNS + 5; t++) events.push(ev.turnStart(t), ev.end(t, { kind: 'completed' }))
  const w = window(events)
  assert.equal(w.truncated, true)
  assert.equal(w.events.filter((e) => e.type === 'turn/start').length, KEEP_TURNS)
  assert.equal(window(events.slice(0, 10)).truncated, false)
})

test('ST-6 the project id comes from the session folder, never from the client', async () => {
  const cwd = await tmp('proj-')
  const s = await services({ logs: { a: { events: [] }, b: { events: [] } }, cwd })
  const [ma, mb] = await Promise.all([s.sessions.meta('a'), s.sessions.meta('b')])
  assert.equal(ma.projectId, mb.projectId, 'same folder, same project')
  assert.match(ma.projectId, /^[0-9a-f]{24}$/)
})

test('ST-7 clearing a project removes only its records and a late result does not recreate them', async () => {
  const cwd = await tmp('proj-')
  const s = await services({ logs: { a: { events: [] } }, cwd, script: [{ text: '这是答案', wait: 60 }] })
  const meta = await s.sessions.meta('a')
  await s.store.write(`${projectDir(meta.projectId)}/briefs.json`, { series: [] })
  await s.store.write('settings.json', { dailyLimit: 9 })
  const outcome = s.lens.ask({ sessionId: 'a', question: '这是什么？' }).then(() => 'written', (e) => e.code)
  await new Promise((r) => setTimeout(r, 10))
  s.guard.clear(meta.projectId)
  s.watchdog.clearProject(meta.projectId)
  await s.store.remove(projectDir(meta.projectId))
  assert.equal(await outcome, 'cleared', 'the in-flight generation was cancelled')
  await new Promise((r) => setTimeout(r, 80))
  await assert.rejects(stat(s.store.path(projectDir(meta.projectId))), 'project folder stays gone')
  assert.equal((await s.store.read('settings.json', {})).dailyLimit, 9, 'other records untouched')
})

// ---------------- F3 ----------------
test('F3-3 a glossary hit answers at once, without a model call', async () => {
  const s = await services({ logs: { a: { events: [] } } })
  const t0 = Date.now()
  const r = await s.lens.explain({ sessionId: 'a', text: 'localStorage' })
  assert.ok(Date.now() - t0 < 300)
  assert.equal(r.source, 'glossary')
  assert.equal(s.llm.calls.length, 0)
  assert.equal(r.canContextualize, true)
  assert.ok(lookup('端口号') && lookup('PORT'))
})

test('F3-4 selection kinds: term, sentence, passage, error (error uses the alert format)', async () => {
  assert.equal(classifySelection('Vite'), 'term')
  assert.equal(classifySelection('我用 localStorage 保存了数据，所以刷新后还在。'), 'sentence')
  assert.equal(classifySelection('长'.repeat(201)), 'passage')
  assert.equal(classifySelection('Error: listen EADDRINUSE: address already in use :::3000'), 'error')
  const s = await services({ logs: { a: { events: [] } } })
  const r = await s.lens.explain({ sessionId: 'a', text: 'Error: listen EADDRINUSE: address already in use :::3000' })
  assert.equal(r.kind, 'error')
  assert.ok(r.title && r.why && r.impact && r.actions.length)
  assert.equal(s.llm.calls.length, 0, 'known error shapes use the template')
})

test('F3-6 same selection in the same session reuses the explanation (no second call)', async () => {
  const s = await services({ logs: { a: { events: [] } }, fallback: { json: { what: '一种打包工具', inYourProject: '让网页能跑起来', needAction: 'none', techName: 'Vite' } } })
  const a = await s.lens.explain({ sessionId: 'a', text: '这里用 Vite 启动了开发服务器。' })
  const b = await s.lens.explain({ sessionId: 'a', text: '这里用 Vite 启动了开发服务器。' })
  assert.equal(s.llm.calls.length, 1)
  assert.equal(b.cached, true)
  assert.equal(a.what, b.what)
})

test('F3-7 follow-up thread: per session, capped at 50, never sent to the main conversation', async () => {
  const s = await services({ logs: { a: { events: [] }, b: { events: [] } }, fallback: { text: '回答\n【可以填入】请把端口改成 3001' } })
  for (let i = 0; i < 52; i++) await s.lens.ask({ sessionId: 'a', question: `问题 ${i}` })
  const thread = await s.lens.thread('a')
  assert.equal(thread.length, 50)
  assert.equal(thread.at(-1).question, '问题 51')
  assert.ok(thread.at(-1).fill.startsWith('请把端口改成 3001'))
  assert.deepEqual(await s.lens.thread('b'), [], 'not carried to another session')
})

test('F3-8 context sent to the model stays within 12k characters and includes the containing message', async () => {
  ev.reset()
  const events = [ev.turnStart(1), ev.user('做个网页'), ev.assistant(1, '我用 Vite 搭了骨架。' + '很长的说明'.repeat(3000)), ev.end(1, { kind: 'completed' })]
  const s = await services({ logs: { a: { events } }, fallback: { json: { what: 'x', inYourProject: 'y', needAction: 'none' } } })
  await s.lens.explain({ sessionId: 'a', text: '我用 Vite 搭了骨架。' })
  const sent = s.llm.calls[0].messages[0].content[0].text
  assert.ok(sent.length < 12000 + 4000 + 400, `material length ${sent.length}`)
  assert.match(sent, /选中内容所在的消息/)
  const turns = await s.sessions.turns('a')
  assert.ok(messageContaining(turns, '我用 Vite 搭了骨架。'))
})

test('F3-9 glossary misses are counted locally as words only', async () => {
  const s = await services({ logs: { a: { events: [] } }, fallback: { json: { what: 'x', inYourProject: '', needAction: 'none' } } })
  await s.lens.explain({ sessionId: 'a', text: 'Zustand' })
  await new Promise((r) => setTimeout(r, 20))
  const misses = await s.store.read('lens-misses.json', {})
  assert.deepEqual(misses, { Zustand: 1 })
})
