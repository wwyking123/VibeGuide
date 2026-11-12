import { createHash } from 'node:crypto'
import { classifyTool, parseArgs, resultOf } from '../session/turns.js'

// Pure detection (F2-1): the same event sequence always yields the same signals. No model calls.
// Each event yields `open` signals (detector + signature + vars + evidence) and `recover` instructions.
export const THRESHOLDS = { repeatFailures: 3, stallMs: 180_000, approvalMs: 30_000, questionMs: 60_000 }

const CODE_TO_DETECTOR = {
  TRANSPORT: 'A1', RATE_LIMIT: 'A3', QUOTA: 'A4', ACCOUNT_QUOTA: 'A4',
  AUTH: 'A5', FORBIDDEN: 'A5', MISSING_CREDENTIAL: 'A5', ACCOUNT_SIGN_IN_REQUIRED: 'A5', ACCOUNT_TOKEN_INVALID: 'A5',
  SERVER: 'A6', TIMEOUT: 'A7', EMPTY_RESPONSE: 'A8', STREAM_CLOSED: 'A8', MALFORMED_RESPONSE: 'A8', INVALID_RESPONSE: 'A8',
  CONTEXT_WINDOW_EXCEEDED: 'A9', INVALID_MODEL_CONTEXT: 'A9',
}
// F2-2: codes first, words only as a fallback.
const MESSAGE_FALLBACK = [
  [/\b402\b|insufficient (balance|quota)|余额不足|额度不足/i, 'A4'],
  [/\b429\b|rate.?limit|too many requests/i, 'A3'],
  [/\b401\b|unauthori[sz]ed|invalid api key|authentication fail/i, 'A5'],
  [/context.?(length|window)|maximum context|too many tokens/i, 'A9'],
  [/ECONNREFUSED|ENOTFOUND|ECONNRESET|fetch failed|transport failed/i, 'A1'],
]
export const MODEL_DETECTORS = ['A1', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'A10', 'X']
const SELF_RECOVERABLE = new Set(['B1', 'B2', 'B3', 'B4', 'B5'])

export function detectorForTurnError(error) {
  const byCode = CODE_TO_DETECTOR[error?.code]
  if (byCode) return byCode
  for (const [re, d] of MESSAGE_FALLBACK) if (re.test(error?.message ?? '')) return d
  return 'X'
}

const TOOL_PATTERNS = [
  ['B2', /EADDRINUSE|address already in use|port \d+ is (already )?in use/i],
  ['B5', /ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|npm ERR! network|Could not resolve host|Failed to establish a new connection|getaddrinfo/i],
  ['B1', /command not found|Cannot find module|ModuleNotFoundError|No module named|is not recognized as an internal|not found in PATH|ERR_MODULE_NOT_FOUND/i],
  ['B3', /EACCES|EPERM|permission denied|Operation not permitted/i],
  ['B4', /ENOENT|No such file or directory|cannot find the path/i],
]
const INSTALL = /\b(npm|pnpm|yarn|bun)\s+(i|install|add|ci)\b|\bpip3?\s+install\b|\bbrew\s+install\b|\bnpx\b/

/** Only ever called on a failed result (F2-4). */
export function classifyFailure(command, text, exitCode) {
  for (const [d, re] of TOOL_PATTERNS) {
    if (!re.test(text)) continue
    if (d === 'B5' && !INSTALL.test(command ?? '')) continue
    return { detector: d, detail: (text.match(re)?.[0] ?? '').slice(0, 80) }
  }
  if (exitCode === 127) return { detector: 'B1', detail: 'exit code 127' }
  return undefined
}

/** Same command with different paths, quotes or numbers counts as the same attempt. */
export function commandSignature(command) {
  const norm = String(command ?? '').trim().replace(/(["'])(?:(?=(\\?))\2.)*?\1/g, 's').replace(/\/[^\s]+/g, 'p').replace(/\d+/g, 'n').replace(/\s+/g, ' ')
  return createHash('sha1').update(norm).digest('hex').slice(0, 12)
}

export function newState() {
  return { calls: new Map(), failures: new Map(), approvals: new Map(), question: undefined, retries: 0, pending: [], lastSuccessSeq: -1 }
}

/**
 * B1–B5 wait until the turn ends (F2-5): a failure the main AI works around in the same turn is
 * normal, and reporting it would bury real problems. Only failures with no later successful step
 * are surfaced.
 */
function flushPending(state, open, turnFailed) {
  for (const p of state.pending) {
    if (!turnFailed && state.lastSuccessSeq > p.seq) continue
    open.push(p.signal)
  }
  state.pending = []
}

export function detect(state, event) {
  const open = []
  const recover = []
  const d = event.data ?? {}
  const ev = (extra) => ({ seq: event.seq, at: event.time, ...extra })
  switch (event.type) {
    case 'llm/retry': {
      state.retries = d.retry ?? state.retries + 1
      open.push({ detector: 'A2', signature: `turn${d.turn}`, vars: { retry: d.retry, max: d.maxRetries, code: d.failure?.code },
        evidence: ev({ excerpt: `${d.failure?.code ?? ''} ${d.failure?.message ?? ''}`.trim() }) })
      break
    }
    case 'assistant/message':
      recover.push({ detectors: ['A1', 'A2', 'A3', 'A6', 'A7', 'A8'] })
      break
    case 'turn/end': {
      const reason = d.reason ?? {}
      const failed = reason.kind === 'error' || reason.kind === 'aborted' || reason.kind === 'interrupted'
      flushPending(state, open, failed)
      recover.push({ detector: 'A2' }, { detector: 'D1' }, { detector: 'C8' }, { detector: 'D2' })
      state.question = undefined
      state.approvals.clear()
      if (reason.kind === 'error') {
        const detector = detectorForTurnError(reason.error)
        // The latest turn's error supersedes earlier model-side ones (yesterday's rate limit is moot).
        recover.push({ detectors: MODEL_DETECTORS.filter((x) => x !== detector) })
        open.push({ detector, signature: reason.error?.code ?? detector,
          vars: { code: reason.error?.code, message: reason.error?.message, retries: state.retries },
          evidence: ev({ excerpt: `${reason.error?.code ?? ''} ${reason.error?.message ?? ''}`.trim() }) })
      } else if (reason.kind === 'max-tokens') {
        open.push({ detector: 'A10', signature: `turn${d.turn}`, vars: {}, evidence: ev({ excerpt: '回复达到长度上限' }) })
      } else if (reason.kind === 'completed') {
        recover.push({ detectors: MODEL_DETECTORS.filter((x) => x !== 'A10') })
      }
      state.retries = 0
      break
    }
    case 'tool/call': {
      const args = parseArgs(d.arguments)
      state.calls.set(d.callId, { name: d.name, args, ...classifyTool(d.name, args) })
      if (d.name === 'ask_user_question') state.question = { at: event.time }
      break
    }
    case 'tool/result': {
      const callId = d.message?.toolCallId
      const call = state.calls.get(callId) ?? { name: 'tool', kind: 'other', command: '', paths: [] }
      state.calls.delete(callId)
      if (call.name === 'ask_user_question') { state.question = undefined; recover.push({ detector: 'D2' }) }
      if (state.approvals.delete(callId) && !state.approvals.size) recover.push({ detector: 'D1' })
      const r = resultOf(d)
      const subject = call.command || `${call.name} ${(call.paths ?? []).join(' ')}`.trim()
      const sig = commandSignature(subject)
      if (r.ok) {
        if (call.kind === 'exec' || call.kind === 'write') state.lastSuccessSeq = event.seq
        state.pending = state.pending.filter((p) => p.signal.signature !== sig)
        if (state.failures.has(sig)) { state.failures.delete(sig); recover.push({ detector: 'B6', signature: sig }) }
        recover.push({ detectors: [...SELF_RECOVERABLE], signature: sig })
        break
      }
      if (call.kind !== 'exec' && call.kind !== 'write') break // a failed read or search is routine
      const count = (state.failures.get(sig) ?? 0) + 1
      state.failures.set(sig, count)
      const excerpt = r.text.slice(-500)
      const hit = classifyFailure(call.command, r.text, r.exitCode)
      if (hit) {
        state.pending = state.pending.filter((p) => p.signal.signature !== sig)
        state.pending.push({ seq: event.seq, signal: { detector: hit.detector, signature: sig,
          vars: { command: subject, detail: hit.detail, escalate: hit.detector === 'B4' && count >= 2 }, evidence: ev({ excerpt }) } })
      }
      if (count >= THRESHOLDS.repeatFailures) open.push({ detector: 'B6', signature: sig, vars: { command: subject, count }, evidence: ev({ excerpt }) })
      break
    }
    case 'approval/asked': {
      const key = d.callId ?? d.requestId ?? d.id ?? 'approval'
      state.approvals.set(key, { at: event.time, tool: d.toolName ?? d.tool, reason: d.displayReason ?? d.reason })
      break
    }
    case 'approval/decided': {
      const key = d.callId ?? d.requestId ?? d.id ?? 'approval'
      state.approvals.delete(key)
      if (!state.approvals.size) recover.push({ detector: 'D1' })
      break
    }
  }
  if (event.type !== 'turn/end' && event.type !== 'llm/retry') recover.push({ detector: 'C8' })
  return { open, recover }
}

/** Time-based checks (F2-13); `now` is injected so replays are deterministic. */
export function detectByTime(state, { running, lastEventAt, now }) {
  const open = []
  if (running && lastEventAt && now - lastEventAt >= THRESHOLDS.stallMs) {
    open.push({ detector: 'C8', signature: 'stall', vars: { minutes: Math.floor((now - lastEventAt) / 60000) }, evidence: { at: now, excerpt: `主 AI 运行中，但 ${Math.floor((now - lastEventAt) / 1000)} 秒没有新事件` } })
  }
  for (const [key, a] of state.approvals) {
    if (a.at && now - a.at >= THRESHOLDS.approvalMs) open.push({ detector: 'D1', signature: String(key), vars: { tool: a.tool, reason: a.reason }, evidence: { at: a.at, excerpt: [a.tool, a.reason].filter(Boolean).join('：') || '授权请求' } })
  }
  if (state.question?.at && now - state.question.at >= THRESHOLDS.questionMs) {
    open.push({ detector: 'D2', signature: 'question', vars: {}, evidence: { at: state.question.at, excerpt: 'ask_user_question' } })
  }
  return open
}
