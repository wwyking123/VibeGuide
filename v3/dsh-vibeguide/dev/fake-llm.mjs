// Integration helper (not shipped): a stand-in for the DeepSeek API as DSH 0.2.1-rc.2 calls it
// (Anthropic-style Messages at POST /v1/messages, streamed). It answers VibeGuide's own calls by
// role, and the main agent from a queue, so the isolated host can be driven end to end.
//
//   node dev/fake-llm.mjs [port]        default 18080
//   POST /__main  [step, ...]           queue main-agent steps: {text} | {status, body} | {tool:{name,args}} | {drop:true}
//   GET  /__log                          every request: who asked (main / vibeguide role) and with what
//   POST /__reset
import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? 18080)
let queue = []
let seen = []

const ev = (res, type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
function reply(res, model, { text, tool, stop }) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  ev(res, 'message_start', { message: { id: 'msg_' + Date.now(), type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 120, output_tokens: 1 } } })
  let index = 0
  if (text) {
    ev(res, 'content_block_start', { index, content_block: { type: 'text', text: '' } })
    for (const piece of text.match(/[\s\S]{1,8}/gu) ?? []) ev(res, 'content_block_delta', { index, delta: { type: 'text_delta', text: piece } })
    ev(res, 'content_block_stop', { index }); index++
  }
  if (tool) {
    ev(res, 'content_block_start', { index, content_block: { type: 'tool_use', id: 'toolu_' + Date.now(), name: tool.name, input: {} } })
    ev(res, 'content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(tool.args) } })
    ev(res, 'content_block_stop', { index })
  }
  ev(res, 'message_delta', { delta: { stop_reason: stop ?? (tool ? 'tool_use' : 'end_turn'), stop_sequence: null }, usage: { output_tokens: 30 } })
  ev(res, 'message_stop', {})
  res.end()
}

const q = (dim, text, a, b, reason = '第一版最省事') => ({ dim, text, recommendReason: reason,
  options: [{ label: a[0], consequence: a[1], recommended: true }, { label: b[0], consequence: b[1], recommended: false }] })

/** VibeGuide's calls, recognised by their system prompt. */
function vibeguide(system, user) {
  if (system.includes('需求梳理助手')) {
    const answered = (user.match(/ → /g) ?? []).length
    if (answered === 0) {
      return { role: 'intake-round-1', json: {
        dims: [{ id: 'goal_users', status: 'known', value: '组长和 8 个组员', confidence: 0.9 }, { id: 'external_services', status: 'inferred', value: '不需要', confidence: 0.8 }],
        questions: [
          q('core_flow', '周报从哪来？', ['大家在网页上填', '格式统一，最省事'], ['上传自己的文档', '要多做整理功能']),
          q('usage_mode', '大家怎么打开来填？', ['发一个链接，填名字即可', '不用登录，最快'], ['每人登录账号', '防冒名，但要多做登录']),
          q('storage_visibility', '汇总给谁看？', ['只有组长', '组员互相看不到'], ['全组都能看', '更透明，但要注意隐私']),
        ] } }
    }
    return { role: 'intake-round-2', json: {
      dims: ['data_source', 'scope_v1', 'done_criteria'].map((id) => ({ id, status: 'inferred', value: '按回答推断', confidence: 0.7 })), questions: [] } }
  }
  if (system.includes('复述')) return { role: 'restate', json: { restatement: '我理解你要做的是：一个周报汇总网页，组员通过链接填写本周内容，只有组长能看到全组汇总；第一版不做登录。' } }
  if (system.includes('需求简报的正文字段')) return { role: 'brief', json: { title: '周报汇总', oneLiner: '让组员每周在网页上填周报，组长一页看到全组汇总', users: '组员约 8 人填写；组长查看', coreFlow: '组员打开链接 → 填名字和本周内容 → 提交；组长打开汇总页查看', inScope: ['填写页', '汇总页'], outOfScope: ['账号登录', 'AI 总结'], data: '先存在这台电脑上，只有组长能看汇总', usage: '先在电脑上运行试用', doneCriteria: ['8 个人都能提交', '刷新后内容不丢'] } }
  if (system.includes('看懂 AI 编程助手遇到的报错') || system.includes('看懂报错')) return { role: 'explain-error', json: { title: '服务返回了一个没见过的错误', what: '服务返回了一个没见过的错误', why: '推测是模型服务那边的临时问题', impact: '这一步没做完，之前做好的不受影响', fill: '请说明刚才的报错原因并重试' } }
  if (system.includes('看懂 AI 编程助手说的话')) return { role: 'lens', json: { what: '一个让网页在本机跑起来的开发工具（Vite）', inYourProject: '主 AI 用它启动了你的周报页面，关掉终端页面就打不开了', needAction: 'none', actionHint: '', techName: 'Vite' } }
  if (system.includes('看懂开发过程')) return { role: 'ask', text: '端口就像门牌号，3000 被占了，就换个号码。\n【可以填入】请换一个端口启动，并告诉我新的打开地址' }
  return undefined
}

createServer(async (req, res) => {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const raw = Buffer.concat(chunks).toString('utf8')
  const url = new URL(req.url, 'http://x')
  if (url.pathname === '/__main') { queue.push(...JSON.parse(raw)); res.end(JSON.stringify({ queued: queue.length })); return }
  if (url.pathname === '/__reset') { queue = []; seen = []; res.end('{}'); return }
  if (url.pathname === '/__log') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(seen, null, 1)); return }
  if (!url.pathname.endsWith('/messages')) { res.writeHead(404); res.end('{}'); return }
  let body = {}
  try { body = JSON.parse(raw) } catch {}
  const system = typeof body.system === 'string' ? body.system : Array.isArray(body.system) ? body.system.map((b) => b.text ?? '').join('\n') : ''
  const user = JSON.stringify(body.messages?.at(-1)?.content ?? '')
  const vg = vibeguide(system, user)
  const step = vg ?? queue.shift() ?? { text: '好的，我已经处理完了。' }
  seen.push({ t: Date.now(), who: vg ? `vibeguide:${vg.role}` : 'main', maxTokens: body.max_tokens, tools: (body.tools ?? []).length, step: vg ? undefined : step })
  console.log(vg ? `vibeguide:${vg.role}` : 'main', JSON.stringify(step).slice(0, 100))
  const model = body.model ?? 'deepseek-chat'
  if (step.status) { res.writeHead(step.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(step.body ?? { error: { message: `fake ${step.status}` } })); return }
  if (step.drop) { res.socket?.destroy(); return }
  reply(res, model, { text: step.json ? JSON.stringify(step.json) : step.text, tool: step.tool })
}).listen(port, '127.0.0.1', () => console.log('fake llm on', port))
