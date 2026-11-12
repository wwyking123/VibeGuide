// M0 spike, host half. Records what the host offers a third-party plugin.
// Read-only towards sessions: it never prompts, forks or edits anything.
export const name = 'vg-probe'
export const inject = []

const PREFIX = '/plugins/vg-probe'
const log = []
let seq = 0

function shape(value, depth = 0) {
  if (value === null || value === undefined) return value
  const t = typeof value
  if (t === 'string') return value.length > 300 ? value.slice(0, 300) + `…(${value.length})` : value
  if (t === 'number' || t === 'boolean') return value
  if (t === 'function') return `[fn ${value.name || 'anon'}]`
  if (t !== 'object') return `[${t}]`
  if (depth >= 3) return Array.isArray(value) ? `[array ${value.length}]` : `[object ${Object.keys(value).slice(0, 12).join(',')}]`
  if (Array.isArray(value)) return value.slice(0, 6).map(v => shape(v, depth + 1)).concat(value.length > 6 ? [`…+${value.length - 6}`] : [])
  const out = {}
  for (const key of Object.keys(value).slice(0, 30)) {
    try { out[key] = shape(value[key], depth + 1) } catch (e) { out[key] = `[throws ${e}]` }
  }
  return out
}

function record(kind, data) {
  log.push({ seq: ++seq, t: Date.now(), kind, data })
  if (log.length > 3000) log.shift()
}

function methods(obj) {
  if (!obj || typeof obj !== 'object') return typeof obj
  const names = new Set()
  let p = obj
  for (let i = 0; i < 4 && p && p !== Object.prototype; i++, p = Object.getPrototypeOf(p)) {
    for (const k of Object.getOwnPropertyNames(p)) if (k !== 'constructor' && !k.startsWith('_')) names.add(k)
  }
  return [...names].slice(0, 80)
}

function send(res, status, payload, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers })
  res.end(JSON.stringify(payload, null, 1))
}

async function body(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? JSON.parse(text) : {}
}

const SERVICES = ['webServer', 'connection', 'sessionQuery', 'sessions', 'sessionController', 'agents', 'llm',
  'agentDefaultModel', 'settings', 'storage', 'homePaths', 'dshHome', 'paths', 'workspaceRegistry', 'tools',
  'systemPrompt', 'userQuestions', 'approval', 'typertGateway', 'logger', 'timer']

export function apply(ctx) {
  // --- event subscriptions (observe only; waterfall listeners always call next) ---
  const plain = ['session/event', 'session/created', 'agent/status', 'agent/error', 'agent/inbox/claimed', 'tools/result']
  for (const ev of plain) {
    for (const opts of [{ global: true }, undefined]) {
      try {
        ctx.on(ev, (...args) => record(ev, args.map(a => shape(a))), opts)
        record('subscribed', { ev, opts: opts ?? null })
        break
      } catch (e) { record('subscribe-failed', { ev, opts: opts ?? null, error: String(e) }) }
    }
  }
  for (const ev of ['approval/request', 'user-questions/request', 'tools/execute']) {
    try {
      ctx.on(ev, (arg, next) => { record(ev, shape(arg)); return next() }, { global: true })
      record('subscribed', { ev })
    } catch (e) { record('subscribe-failed', { ev, error: String(e) }) }
  }

  const routes = {
    '/log': async (req, res, url) => {
      const since = Number(url.searchParams.get('since') || 0)
      const kind = url.searchParams.get('kind')
      send(res, 200, log.filter(e => e.seq > since && (!kind || e.kind === kind)).slice(-200))
    },
    '/services': async (req, res) => {
      const out = {}
      for (const n of SERVICES) {
        let s
        try { s = ctx.get(n) } catch (e) { out[n] = `[get throws ${e}]`; continue }
        out[n] = s === undefined ? null : methods(s)
      }
      out._env = { DSH_HOME: process.env.DSH_HOME ?? null, cwd: process.cwd(), node: process.version }
      send(res, 200, out)
    },
    '/admission': async (req, res) => {
      const c = ctx.get('connection')
      let rejection = 'no-connection-service'
      try { if (c) rejection = c.requestRejection(req) ?? null } catch (e) { rejection = `[throws ${e}]` }
      send(res, 200, { rejection, origin: req.headers.origin ?? null, host: req.headers.host, secFetchSite: req.headers['sec-fetch-site'] ?? null, cookie: !!req.headers.cookie, auth: !!req.headers.authorization })
    },
    '/session': async (req, res, url) => {
      const id = url.searchParams.get('id')
      const q = ctx.get('sessionQuery')
      const out = { sessionQueryMethods: methods(q) }
      try {
        const r = await q.readSession(id)
        out.readSessionKeys = Object.keys(r)
        const events = r.events ?? []
        out.eventCount = events.length
        const hist = {}
        const samples = {}
        for (const e of events) {
          hist[e.type] = (hist[e.type] ?? 0) + 1
          samples[e.type] ??= shape(e)
        }
        out.types = hist
        out.samples = samples
        out.header = shape(r.header)
        for (const k of Object.keys(r)) if (k !== 'events') out['r.' + k] = shape(r[k])
        r[Symbol.dispose]?.()
      } catch (e) { out.readSessionError = String(e && e.stack || e) }
      try {
        if (typeof q.observeSession === 'function') {
          const cut = await q.observeSession(id, { projectionMode: 'all' })
          out.observeKeys = Object.keys(cut)
          out.observeHeader = shape(cut.header)
          out.projectionKeys = Object.keys(cut.projections?.values ?? {})
          out.projections = shape(cut.projections?.values)
          cut[Symbol.dispose]?.()
        }
      } catch (e) { out.observeError = String(e && e.stack || e) }
      send(res, 200, out)
    },
    '/turn': async (req, res, url) => {
      const q = ctx.get('sessionQuery')
      const r = await q.readSession(url.searchParams.get('id'))
      const turn = Number(url.searchParams.get('turn'))
      const types = url.searchParams.get('types')?.split(',')
      const out = r.events.filter(e => (e.data?.turn === turn || !Number.isFinite(turn)) && (!types || types.includes(e.type)))
        .map(e => JSON.parse(JSON.stringify(e, (k, v) => k === 'stream' ? undefined : (typeof v === 'string' && v.length > 600 ? v.slice(0, 600) + '…' : v))))
      send(res, 200, out)
    },
    '/llm': async (req, res) => {
      const b = req.method === 'POST' ? await body(req) : {}
      const llm = ctx.get('llm')
      const sel = ctx.get('agentDefaultModel')?.currentSelection?.()
      const out = { llmMethods: methods(llm), selection: shape(sel), variants: {} }
      const variants = b.variants ?? ['plain', 'system', 'maxTokens']
      for (const v of variants) {
        const r = { chunks: {}, text: '', finish: null, usage: null }
        try {
          const params = { provider: b.provider ?? sel?.provider, model: b.model ?? sel?.model,
            messages: [{ role: 'user', content: [{ type: 'text', text: b.text ?? '只回复两个字：收到' }] }],
            signal: AbortSignal.timeout(60000) }
          if (v === 'system') params.system = '你是测试助手。无论问什么都只回复：系统提示生效'
          if (v === 'maxTokens') params.maxTokens = 16
          for await (const c of llm.stream(params)) {
            r.chunks[c.type] = (r.chunks[c.type] ?? 0) + 1
            if (c.type === 'text-delta') r.text += c.text
            if (c.type === 'finish') r.finish = shape(c)
            if (c.usage) r.usage = shape(c.usage)
          }
        } catch (e) { r.error = String(e && e.stack || e).slice(0, 600) }
        out.variants[v] = r
      }
      send(res, 200, out)
    },
    '/sse': async (req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
      for (let i = 1; i <= 3; i++) {
        res.write(`data: tick ${i} ${Date.now()}\n\n`)
        await new Promise(r => setTimeout(r, 700))
      }
      res.end()
    },
  }

  ctx.inject(['webServer'], (web) => {
    for (const [path, fn] of Object.entries(routes)) {
      web.effect(() => web.webServer.register({
        kind: 'exact', path: PREFIX + path,
        handler: (req, res) => {
          const url = new URL(req.url, 'http://local')
          fn(req, res, url).catch(e => { try { send(res, 500, { error: String(e && e.stack || e) }) } catch {} })
        },
      }), `vg-probe ${path}`)
    }
    record('routes', Object.keys(routes))
  })
}
