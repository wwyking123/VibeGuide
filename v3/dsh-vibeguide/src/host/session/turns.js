// Pure helpers that turn the host's session log into the shapes the features use.
// Event shapes verified in M0 against DSH 0.2.1-rc.2 (see docs/M0_REPORT.md).

export function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter((p) => p?.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('\n')
}

export function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw
  try { return JSON.parse(raw) } catch { return {} }
}

const READ = new Set(['read', 'read_image', 'glob', 'grep'])
const WRITE = new Set(['write', 'edit'])
const EXEC = new Set(['bash', 'pwsh'])

export function classifyTool(name, args = {}) {
  const paths = typeof args.file_path === 'string' ? [args.file_path] : typeof args.path === 'string' ? [args.path] : []
  if (EXEC.has(name) || (!READ.has(name) && !WRITE.has(name) && typeof args.command === 'string')) {
    return { kind: 'exec', paths: [], command: typeof args.command === 'string' ? args.command : '' }
  }
  if (WRITE.has(name) || (!READ.has(name) && typeof args.file_path === 'string' && typeof args.content === 'string')) return { kind: 'write', paths }
  if (READ.has(name)) return { kind: 'read', paths }
  return { kind: 'other', paths }
}

/** `bash` reports a non-zero exit as text, not as isError (M0). */
export function parseExit(text) {
  const all = [...String(text ?? '').matchAll(/\[exit code: (-?\d+)\]/g)]
  return all.length ? Number(all.at(-1)[1]) : undefined
}

export function resultOf(data) {
  const message = data?.message ?? {}
  const text = textOf(message.content)
  const exitCode = parseExit(text)
  const ok = !message.isError && (exitCode === undefined || exitCode === 0)
  return { ok, isError: !!message.isError, exitCode, text, meta: data?.meta, error: data?.error }
}

export const isUserMessage = (event) => event.type === 'user/message' && (event.data?.source?.kind ?? 'user') === 'user'

/** Groups a session log into turns. Tolerates events arriving out of their turn (e.g. resumes). */
export function buildTurns(events) {
  const turns = new Map()
  const calls = new Map()
  let pendingUser = []
  const turnOf = (n) => {
    if (!turns.has(n)) turns.set(n, { index: n, userText: '', steps: [], assistantText: '', end: undefined, retries: [], compacted: false, startedAt: undefined, endedAt: undefined, assistantMessageIds: [] })
    return turns.get(n)
  }
  let current
  for (const e of events) {
    const d = e.data ?? {}
    switch (e.type) {
      case 'user/message':
        if (isUserMessage(e)) pendingUser.push(textOf(d.content ?? d.message?.content))
        break
      case 'turn/start': {
        current = turnOf(d.turn)
        current.startedAt = e.time
        if (pendingUser.length) { current.userText = pendingUser.join('\n'); pendingUser = [] }
        break
      }
      case 'assistant/message': {
        const t = turnOf(d.turn ?? current?.index)
        const text = textOf(d.message?.content)
        if (text) t.assistantText = text
        if (d.message?.id) t.assistantMessageIds.push(d.message.id)
        break
      }
      case 'tool/call': {
        const t = turnOf(d.turn ?? current?.index)
        const args = parseArgs(d.arguments)
        const step = { callId: d.callId, tool: d.name, args, ...classifyTool(d.name, args), seq: e.seq, at: e.time, result: undefined }
        t.steps.push(step)
        calls.set(d.callId, step)
        break
      }
      case 'tool/result': {
        const callId = d.message?.toolCallId
        const step = calls.get(callId)
        if (step) {
          step.result = resultOf(d)
          if (step.kind === 'write' && d.meta?.path) step.paths = [d.meta.path]
        }
        break
      }
      case 'llm/retry':
        turnOf(d.turn ?? current?.index).retries.push({ retry: d.retry, max: d.maxRetries, code: d.failure?.code, at: e.time })
        break
      case 'compaction/end':
        if (current) current.compacted = true
        break
      case 'turn/end': {
        const t = turnOf(d.turn ?? current?.index)
        t.end = d.reason
        t.endedAt = e.time
        break
      }
    }
  }
  return [...turns.values()].sort((a, b) => a.index - b.index)
}

/** Compact transcript of the last turns for model context. */
export function transcript(turns, { maxTurns = 6, maxChars = 12000 } = {}) {
  const lines = []
  for (const t of turns.slice(-maxTurns)) {
    if (t.userText) lines.push(`用户：${t.userText}`)
    for (const s of t.steps) {
      const target = s.command || s.paths.join(', ')
      const status = s.result ? (s.result.ok ? '成功' : `失败${s.result.exitCode !== undefined ? `（退出码 ${s.result.exitCode}）` : ''}`) : '进行中'
      lines.push(`AI 操作：${s.tool} ${target} → ${status}`)
      if (s.result && !s.result.ok) lines.push(`  输出摘录：${s.result.text.slice(-400)}`)
    }
    if (t.assistantText) lines.push(`AI 回复：${t.assistantText}`)
    if (t.end?.kind === 'error') lines.push(`本轮报错：${t.end.error?.code ?? ''} ${t.end.error?.message ?? ''}`)
  }
  let text = lines.join('\n')
  if (text.length > maxChars) text = '…（更早的内容已省略）\n' + text.slice(-maxChars)
  return text
}
