// VibeGuide host half: event wiring, services and HTTP routes. Read-only towards sessions (HC-1):
// it never prompts, forks or edits the main conversation, and never changes the main AI (HC-3).
import { join } from 'node:path'
import { homedir } from 'node:os'
import { Store } from './store.js'
import { Settings } from './settings.js'
import { Budget } from './budget.js'
import { ModelRunner } from './runner.js'
import { SessionModel } from './session/model.js'
import { Watchdog } from './watch/watchdog.js'
import { IntakeEngine } from './intake/engine.js'
import { Lens } from './lens/lens.js'
import { GuideError } from './errors.js'
import { Inflight, ProjectGuard, projectDir } from './project.js'
import { compatibility, hostVersion } from './compat.js'
import { PREFIX, handler, readJson, requireString } from './http.js'

export const name = 'dsh-vibeguide'
export const inject = []

const TICK_MS = 5_000

/** Builds the services. Exported for tests; `apply` adds host wiring and routes. */
export function createServices({ home, getSessionQuery, getLlm, getDefaultModel, version = hostVersion(), log = () => {}, now }) {
  const compat = compatibility(version)
  const store = new Store(join(home, 'dsh-vibeguide'))
  const settings = new Settings(store)
  const budget = new Budget(store, settings, now)
  const guard = new ProjectGuard()
  const inflight = new Inflight()
  const sessions = new SessionModel({ getSessionQuery, now })
  const runner = new ModelRunner({ getLlm, getDefaultModel, sessions, budget,
    hostGate: () => compat.level === 'rules-only' ? compat.notice : undefined })
  const watchdog = new Watchdog({ sessions, store, settings, runner, guard, log, now })
  const intake = new IntakeEngine({ sessions, store, runner, guard, inflight, now })
  const lens = new Lens({ sessions, store, runner, intake, settings, guard, inflight })
  return { compat, store, settings, budget, guard, inflight, sessions, runner, watchdog, intake, lens }
}

/** Observe-only hook for waterfall events (HC-3): record synchronously, never block, always delegate. */
export function observe(record, log) {
  return (req, next) => {
    try { record(req) } catch (e) { log('observer failed', e) }
    return next()
  }
}

export function apply(ctx) {
  const log = (...args) => { try { console.warn('[dsh-vibeguide]', ...args) } catch { /* ignore */ } }
  const s = createServices({ home: process.env.DSH_HOME || join(homedir(), '.dsh'), log,
    getSessionQuery: () => ctx.get('sessionQuery'), getLlm: () => ctx.get('llm'), getDefaultModel: () => ctx.get('agentDefaultModel') })
  const { compat, store, settings, budget, guard, sessions, watchdog, intake, lens } = s

  // --- host events: observe only; nothing here awaits disk or a model (HC-5) ---
  const sessionIdOf = (agent) => agent?.session?.id ?? agent?.id
  ctx.on('session/event', (session, event) => { try { if (session?.id) sessions.append(session.id, event) } catch (e) { log('event', e) } })
  ctx.on('agent/status', (payload) => { try { const id = sessionIdOf(payload?.agent); if (id) watchdog.onStatus(id, payload.status) } catch (e) { log('status', e) } })
  ctx.on('approval/request', observe((req) => { const id = sessionIdOf(req?.agent); if (id) watchdog.onApproval(id, req) }, log))
  ctx.on('user-questions/request', observe((req) => { const id = sessionIdOf(req?.agent); if (id) watchdog.onQuestion(id) }, log))

  // --- lifecycle (HC-11): timers, SSE, in-flight generation and writes all stop on unload ---
  const streams = new Set()
  const timer = setInterval(() => { try { watchdog.tick() } catch (e) { log('tick', e) } }, TICK_MS)
  ctx.effect(() => () => {
    clearInterval(timer)
    watchdog.close()
    guard.abortAll()
    for (const end of streams) end()
    store.close()
  }, 'dsh-vibeguide: lifecycle')

  const sid = (url) => requireString(url.searchParams.get('sessionId'), '会话', 200)
  const body = async (req) => { const b = await readJson(req); return { b, sessionId: requireString(b.sessionId, '会话', 200) } }

  const routes = [
    ['GET', '/state', async (req, res, url) => {
      const sessionId = sid(url)
      const meta = await sessions.meta(sessionId) // API-4: unknown sessions → session_not_found
      const [st, usage, incidents, current] = await Promise.all([settings.get(), budget.today(), watchdog.view(sessionId), intake.current(sessionId)])
      return { projectName: meta.projectName, running: !!sessions.sessions.get(sessionId)?.running, incidents, intake: current.intake, brief: current.brief,
        settings: st, usage, compat, truncated: sessions.truncated(sessionId),
        storageNotice: store.corrupted.length ? '有一部分本地记录损坏了，已另存一份并重新开始记录。' : undefined }
    }],
    ['GET', '/watch/state', async (req, res, url) => ({ incidents: await watchdog.view(sid(url), Number(url.searchParams.get('since') || 0)) })],
    ['GET', '/watch/stream', async (req, res, url) => {
      const sessionId = sid(url)
      const snapshot = await watchdog.view(sessionId)
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' })
      const write = (type, data) => { try { res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`) } catch { /* closed */ } }
      write('snapshot', { incidents: snapshot })
      const unsubscribe = watchdog.subscribe(sessionId, (inc) => write('incident', inc))
      const beat = setInterval(() => write('ping', { t: Date.now() }), 25_000)
      const end = () => { clearInterval(beat); unsubscribe(); streams.delete(end); try { res.end() } catch { /* closed */ } }
      streams.add(end)
      req.on('close', end)
      return undefined
    }],
    ['POST', '/watch/feedback', async (req) => {
      const { b, sessionId } = await body(req)
      if (!['dismiss', 'mute', 'wrong', 'helpful'].includes(b.kind)) throw new GuideError('bad_request', '未知的反馈。')
      return { ok: await watchdog.feedback(sessionId, requireString(b.incidentId, '提醒', 100), b.kind) }
    }],
    ['POST', '/watch/client-signal', async (req) => {
      const { b, sessionId } = await body(req)
      if (!['offline', 'online'].includes(b.kind)) throw new GuideError('bad_request', '未知的信号。')
      await sessions.ensure(sessionId)
      watchdog.clientSignal(sessionId, b.kind)
      return { ok: true }
    }],
    ['POST', '/intake/start', async (req) => {
      const { b, sessionId } = await body(req)
      return intake.start({ sessionId, idea: requireString(b.idea, '想法', 2000), scenario: typeof b.scenario === 'string' ? b.scenario.slice(0, 40) : undefined, kind: ['new', 'revise'].includes(b.kind) ? b.kind : undefined })
    }],
    ['POST', '/intake/answer', async (req) => { const { b, sessionId } = await body(req); return intake.answer({ sessionId, answers: b.answers }) }],
    ['POST', '/intake/skip', async (req) => { const { sessionId } = await body(req); return intake.skip({ sessionId }) }],
    ['POST', '/intake/confirm', async (req) => { const { b, sessionId } = await body(req); return intake.confirm({ sessionId, correction: b.correction }) }],
    ['POST', '/intake/reset', async (req) => { const { sessionId } = await body(req); await intake.reset({ sessionId }); return { ok: true } }],
    ['POST', '/brief', async (req) => { const { b, sessionId } = await body(req); return intake.editBrief({ sessionId, text: requireString(b.text, '简报', 6000) }) }],
    ['POST', '/lens/explain', async (req) => {
      const { b, sessionId } = await body(req)
      return lens.explain({ sessionId, text: requireString(b.text, '选中的内容', 4000), contextualize: !!b.contextualize })
    }],
    ['GET', '/lens/thread', async (req, res, url) => ({ thread: await lens.thread(sid(url)) })],
    ['POST', '/lens/ask', async (req) => {
      const { b, sessionId } = await body(req)
      return lens.ask({ sessionId, quote: typeof b.quote === 'string' ? b.quote : undefined, question: requireString(b.question, '问题', 1000) })
    }],
    ['GET', '/settings', async () => ({ settings: await settings.get(), usage: await budget.today(), compat })],
    ['POST', '/settings', async (req) => ({ settings: await settings.set(await readJson(req)), usage: await budget.today(), compat })],
    ['POST', '/project/clear', async (req) => {
      // ST-7: only this project's records under the plugin's own folder; in-flight generation is cancelled first.
      const { sessionId } = await body(req)
      const meta = await sessions.meta(sessionId)
      guard.clear(meta.projectId)
      watchdog.clearProject(meta.projectId)
      await store.remove(projectDir(meta.projectId))
      return { ok: true }
    }],
  ]

  // One registration per path (duplicates throw); dispatch on method inside.
  const byPath = new Map()
  for (const [method, path, fn] of routes) byPath.set(path, { ...byPath.get(path), [method]: fn })
  ctx.inject(['webServer'], (web) => {
    for (const [path, fns] of byPath) {
      const dispatch = (req, res, url) => fns[req.method](req, res, url)
      web.effect(() => web.webServer.register({ kind: 'exact', path: PREFIX + path, handler: handler(ctx, Object.keys(fns), dispatch, log) }), `dsh-vibeguide ${path}`)
    }
  })
}
