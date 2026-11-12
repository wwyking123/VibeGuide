import { GuideError } from './errors.js'

export const PREFIX = '/plugins/dsh-vibeguide'
const BODY_LIMIT = 256 * 1024

export function send(res, status, body) {
  if (res.headersSent) { res.end(); return }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

export async function readJson(req) {
  const type = req.headers['content-type'] ?? ''
  if (!type.includes('application/json')) throw new GuideError('bad_request', '请求格式不对。', 415)
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > BODY_LIMIT) throw new GuideError('too_large', '内容太长了，请缩短后再试。', 413)
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }
  catch { throw new GuideError('bad_request', '请求内容无法解析。', 400) }
}

/**
 * Host routes are not authenticated by the web server (M0 finding), so every handler asks the
 * connection service first. Returns an HTTP status to reject with, or undefined to admit.
 */
export function rejection(ctx, req) {
  const connection = ctx.get('connection')
  if (connection && typeof connection.requestRejection === 'function') {
    try { return connection.requestRejection(req) ?? undefined } catch { /* fall through to local fence */ }
  }
  const remote = req.socket?.remoteAddress ?? ''
  const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
  const origin = req.headers.origin
  const sameOrigin = !origin || origin === `http://${req.headers.host}` || origin === `https://${req.headers.host}`
  const site = req.headers['sec-fetch-site']
  if (!loopback || !sameOrigin || (site && site !== 'same-origin')) return 403
  return undefined
}

/** Wraps an async handler with admission, method check and uniform error replies. */
export function handler(ctx, methods, fn, log) {
  return (req, res) => {
    const denied = rejection(ctx, req)
    if (denied) { send(res, denied, { error: { code: 'forbidden', message: '没有权限访问。' } }); return }
    if (!methods.includes(req.method)) { send(res, 405, { error: { code: 'method', message: '不支持的请求方式。' } }); return }
    const url = new URL(req.url, 'http://local')
    Promise.resolve()
      .then(() => fn(req, res, url))
      .then((body) => { if (body !== undefined) send(res, 200, body) })
      .catch((e) => {
        if (e instanceof GuideError) { send(res, e.status, { error: { code: e.code, message: e.message, ...(e.extra ?? {}) } }); return }
        log?.('route failed', req.url, e)
        send(res, 500, { error: { code: 'internal', message: 'VibeGuide 出了点问题，主对话不受影响。' } })
      })
  }
}

export function requireString(value, name, max = 4000) {
  if (typeof value !== 'string' || !value.trim()) throw new GuideError('bad_request', `缺少${name}。`)
  if (value.length > max) throw new GuideError('too_large', `${name}太长了。`, 413)
  return value
}
