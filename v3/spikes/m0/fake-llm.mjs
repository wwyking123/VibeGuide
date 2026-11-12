// M0 spike: a scripted stand-in for the DeepSeek API as DSH 0.2.1-rc.2 calls it
// (Anthropic-style Messages API at POST /v1/messages, streamed). Lets the isolated host be
// driven into network, quota and rate-limit failures without a real account.
//
//   node fake-llm.mjs [port]            default 18080
//   POST /__script  [step, step, ...]   queue steps; each model request consumes one
//   GET  /__log                         requests seen so far
//   POST /__reset                       clear queue and log
//
// Steps:
//   { text: "..." }                              normal streamed reply
//   { tool: { name, args }, text? }              streamed tool_use block (stop_reason tool_use)
//   { status: 429, body: {...} }                 HTTP error with JSON body
//   { hang: 70000 }                              accept the request, never answer for N ms
//   { drop: true }                               destroy the socket immediately
//   { cut: "partial text" }                      stream some text, then destroy the socket
//   { maxTokens: "partial text" }                stream text, end with stop_reason max_tokens
// With an empty queue every request gets { text: "好的。" }.
import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? 18080)
let queue = []
let seen = []

const ev = (res, type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)

function open(res, model) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  ev(res, 'message_start', { message: { id: 'msg_fake_' + Date.now(), type: 'message', role: 'assistant', model, content: [],
    stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } } })
}
function textBlock(res, index, text) {
  ev(res, 'content_block_start', { index, content_block: { type: 'text', text: '' } })
  for (const piece of text.match(/.{1,6}/gsu) ?? []) ev(res, 'content_block_delta', { index, delta: { type: 'text_delta', text: piece } })
  ev(res, 'content_block_stop', { index })
}
function close(res, stop) {
  ev(res, 'message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 12 } })
  ev(res, 'message_stop', {})
  res.end()
}

createServer(async (req, res) => {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const raw = Buffer.concat(chunks).toString('utf8')
  const url = new URL(req.url, 'http://x')
  if (url.pathname === '/__script') { queue.push(...JSON.parse(raw)); res.end(JSON.stringify({ queued: queue.length })); return }
  if (url.pathname === '/__reset') { queue = []; seen = []; res.end('{}'); return }
  if (url.pathname === '/__log') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(seen, null, 1)); return }

  let body = {}
  try { body = raw ? JSON.parse(raw) : {} } catch {}
  const isMessages = url.pathname.endsWith('/messages')
  const step = isMessages ? (queue.shift() ?? { text: '好的。' }) : null
  const last = body.messages?.at(-1)
  seen.push({ t: Date.now(), method: req.method, path: url.pathname,
    auth: req.headers['x-api-key'] ? 'x-api-key' : req.headers.authorization ? 'bearer' : 'absent',
    model: body.model, stream: body.stream, system: typeof body.system === 'string' ? body.system.slice(0, 80) : Array.isArray(body.system) ? `[${body.system.length} blocks]` : null,
    maxTokens: body.max_tokens, messages: body.messages?.length, lastRole: last?.role,
    lastTypes: Array.isArray(last?.content) ? last.content.map(c => c.type) : typeof last?.content,
    tools: body.tools?.map(t => t.name), step })
  console.log(req.method, url.pathname, step ? JSON.stringify(step).slice(0, 120) : '')

  if (!isMessages) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{}'); return }
  const model = body.model ?? 'deepseek-chat'
  if (step.status) { res.writeHead(step.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(step.body ?? { type: 'error', error: { type: 'api_error', message: 'fake ' + step.status } })); return }
  if (step.hang) { setTimeout(() => res.socket?.destroy(), step.hang); return }
  if (step.drop) { res.socket?.destroy(); return }
  open(res, model)
  if (step.cut) { textBlock(res, 0, step.cut); setTimeout(() => res.socket?.destroy(), 50); return }
  if (step.maxTokens) { textBlock(res, 0, step.maxTokens); close(res, 'max_tokens'); return }
  if (step.tool) {
    let index = 0
    if (step.text) textBlock(res, index++, step.text)
    ev(res, 'content_block_start', { index, content_block: { type: 'tool_use', id: 'toolu_fake_' + Date.now(), name: step.tool.name, input: {} } })
    ev(res, 'content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(step.tool.args) } })
    ev(res, 'content_block_stop', { index })
    close(res, 'tool_use')
    return
  }
  textBlock(res, 0, step.text ?? '好的。')
  close(res, 'end_turn')
}).listen(port, '127.0.0.1', () => console.log('fake llm on', port))
