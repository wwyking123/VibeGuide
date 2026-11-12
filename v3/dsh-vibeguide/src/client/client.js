// VibeGuide browser half. Loaded by DSH through window.__ModuleLoader__ (React comes from the host, UI-3).
// The only write to the main conversation is inputActions.setDraft, and only when the user clicks
// 「填入主对话」 (HC-1, HC-2). Everything rendered from the model is plain text (UI-8).
window.__ModuleLoader__.load({
  id: 'dsh-vibeguide',
  factory: (require) => {
    const React = require('react')
    const { useEffect, useRef, useState, useCallback } = React
    const h = React.createElement
    const BASE = '/plugins/dsh-vibeguide'
    const TAB_ID = 'dsh-vibeguide/panel'
    const TAB_KIND = 'dsh-vibeguide'

    // ---------- plumbing ----------
    async function api(path, body, signal) {
      const init = body === undefined ? { credentials: 'same-origin', signal }
        : { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal }
      let res
      try { res = await fetch(BASE + path, init) } catch (e) {
        if (e?.name === 'AbortError') throw e
        throw new Error('连不上 VibeGuide，请刷新页面。主对话不受影响。')
      }
      let data = {}
      try { data = await res.json() } catch { /* empty */ }
      if (!res.ok) throw new Error(data?.error?.message || 'VibeGuide 暂时不可用，主对话不受影响。')
      return data
    }
    const aborted = (e) => e?.name === 'AbortError'
    const local = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v) } catch { return null } }

    function emitter() {
      const subs = new Set()
      return { on: (fn) => { subs.add(fn); return () => subs.delete(fn) }, emit: (v) => subs.forEach((fn) => fn(v)) }
    }
    const bus = emitter()                 // { type: 'ask', quote } | { type: 'tab', tab } | { type: 'floating', open }
    let pendingAsk
    let sidebarRight
    // What this host actually offers (UI-5): shown in settings, drives the fallbacks.
    const caps = { sidebar: false, dock: false, overlay: false, chatFlow: undefined, live: 'connecting' }
    const capsBus = emitter()
    const setCap = (k, v) => { if (caps[k] !== v) { caps[k] = v; capsBus.emit() } }

    // Input bridge: one entry per session, captured from conversation.input.dock and the sidebar.
    const bridge = { sessions: new Map(), current: undefined }
    async function copy(text) {
      try { await navigator.clipboard.writeText(text) } catch {
        const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove()
      }
    }
    /** HC-2: fill only, never send. Ask when the composer has text. If filling fails, copy and say so. */
    async function fill(sessionId, text, mode) {
      const entry = bridge.sessions.get(sessionId)
      if (!entry?.actions?.setDraft) { await copy(text); return 'copied' }
      const draft = entry.draft ?? ''
      if (draft.trim() && !mode) return 'needs-choice'
      try { entry.actions.setDraft(mode === 'append' && draft.trim() ? `${draft.trimEnd()}\n\n${text}` : text) }
      catch { await copy(text); return 'copied' }
      setTimeout(() => { try { document.querySelector('[data-composer-card] textarea')?.focus() } catch { /* ignore */ } }, 30)
      return 'filled'
    }
    function openPanel(tab) {
      if (tab) bus.emit({ type: 'tab', tab })
      if (caps.sidebar && sidebarRight) { try { sidebarRight.openTab(TAB_KIND); return } catch { /* fall back */ } }
      bus.emit({ type: 'floating', open: true })
    }

    // Incident hub: one SSE stream per session, shared by panel, banner and tab title. Falls back to
    // polling /watch/state every 2 s while SSE is down (API-6).
    const hubs = new Map()
    function hubFor(sessionId) {
      let hub = hubs.get(sessionId)
      if (hub) return hub
      hub = { incidents: new Map(), ev: emitter(), refs: 0, since: 0 }
      const set = (inc) => {
        hub.since = Math.max(hub.since, inc.updatedAt ?? 0)
        if (inc.state === 'open' && inc.visible !== false) hub.incidents.set(inc.id, inc); else hub.incidents.delete(inc.id)
      }
      const startPolling = () => {
        if (hub.poll) return
        setCap('live', 'polling')
        hub.poll = setInterval(() => {
          api(`/watch/state?sessionId=${encodeURIComponent(sessionId)}&since=${hub.since}`).then((r) => { r.incidents.forEach(set); hub.ev.emit() }).catch(() => {})
        }, 2000)
      }
      const stopPolling = () => { clearInterval(hub.poll); hub.poll = undefined }
      hub.connect = () => {
        if (hub.source || hub.refs <= 0) return
        let es
        try { es = new EventSource(`${BASE}/watch/stream?sessionId=${encodeURIComponent(sessionId)}`) } catch { startPolling(); return }
        es.addEventListener('snapshot', (e) => { stopPolling(); setCap('live', 'sse'); hub.incidents.clear(); JSON.parse(e.data).incidents.forEach(set); hub.ev.emit() })
        es.addEventListener('incident', (e) => { set(JSON.parse(e.data)); hub.ev.emit() })
        es.onerror = () => { es.close(); hub.source = undefined; startPolling(); setTimeout(hub.connect, 10_000) }
        hub.source = es
      }
      hub.acquire = () => {
        hub.refs++; hub.connect()
        return () => { if (--hub.refs <= 0) { hub.source?.close(); hub.source = undefined; stopPolling() } }
      }
      hubs.set(sessionId, hub)
      return hub
    }
    const rank = (i) => ({ block: 0, warn: 1, info: 2 })[i.severity] ?? 3
    function useIncidents(sessionId) {
      const [, force] = useState(0)
      useEffect(() => {
        if (!sessionId) return
        const hub = hubFor(sessionId)
        const release = hub.acquire()
        const off = hub.ev.on(() => force((n) => n + 1))
        return () => { off(); release() }
      }, [sessionId])
      return sessionId ? [...hubFor(sessionId).incidents.values()].sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt) : []
    }
    function useCaps() { const [, force] = useState(0); useEffect(() => capsBus.on(() => force((n) => n + 1)), []); return caps }

    window.addEventListener('online', () => bridge.current && api('/watch/client-signal', { sessionId: bridge.current, kind: 'online' }).catch(() => {}))
    window.addEventListener('offline', () => bridge.current && navigator.sendBeacon?.(`${BASE}/watch/client-signal`, new Blob([JSON.stringify({ sessionId: bridge.current, kind: 'offline' })], { type: 'application/json' })))

    // ---------- error boundary (UI-1) ----------
    class Boundary extends React.Component {
      constructor(p) { super(p); this.state = { failed: false } }
      static getDerivedStateFromError() { return { failed: true } }
      componentDidCatch(e) { try { console.warn('[dsh-vibeguide] component failed', this.props.name, e) } catch { /* ignore */ } }
      render() {
        if (!this.state.failed) return this.props.children
        return this.props.quiet ? null : h('div', { className: 'vg-section vg-muted' }, 'VibeGuide 这部分出错了，刷新页面可以恢复。主对话不受影响。')
      }
    }
    const guarded = (name, Comp, quiet) => (props) => h(Boundary, { name, quiet }, h(Comp, props))

    // ---------- icons (UI-3: own SVG) ----------
    const svg = (d, size = 14) => h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, ...d.map((p, i) => h('path', { key: i, d: p })))
    const Icon = {
      gear: () => svg(['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z', 'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z']),
      alert: () => svg(['M12 9v4', 'M12 17h.01', 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z']),
      info: () => svg(['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z', 'M12 16v-4', 'M12 8h.01']),
      close: () => svg(['M18 6 6 18', 'M6 6l12 12'], 12),
    }

    // ---------- small components ----------
    function Btn({ kind = 'plain', onClick, children, disabled, title }) {
      return h('button', { type: 'button', className: `vg-btn vg-btn-${kind}`, onClick, disabled, title, 'aria-label': title }, children)
    }

    /** UI-7: the primary button is always 「填入主对话」, the secondary always 「复制」. */
    function FillButton({ sessionId, text, kind = 'primary' }) {
      const [state, setState] = useState()
      const run = async (mode) => {
        const r = await fill(sessionId, text, mode)
        setState(r)
        if (r !== 'needs-choice') setTimeout(() => setState(undefined), 3000)
      }
      if (state === 'needs-choice') {
        return h('span', { className: 'vg-choice' }, '输入框里已有内容：',
          h(Btn, { onClick: () => run('replace') }, '替换'), h(Btn, { onClick: () => run('append') }, '追加'), h(Btn, { kind: 'link', onClick: () => setState(undefined) }, '取消'))
      }
      return h('span', { className: 'vg-fill' },
        h(Btn, { kind, onClick: () => run() }, state === 'filled' ? '已填入，检查后按回车发送' : state === 'copied' ? '已复制，请粘贴到输入框' : '填入主对话'),
        h(Btn, { onClick: () => copy(text).then(() => setState('copied')) }, '复制'))
    }

    function FillAction({ sessionId, action, primary }) {
      const [open, setOpen] = useState(false)
      return h('div', { className: 'vg-action' },
        h('div', { className: 'vg-action-head' }, h('b', null, action.label), h(Btn, { kind: 'link', onClick: () => setOpen(!open) }, open ? '收起' : '看看要填入什么')),
        open ? h('div', { className: 'vg-preview' }, action.text) : null,
        h(FillButton, { sessionId, text: action.text, kind: primary ? 'primary' : 'plain' }))
    }

    function IncidentCard({ sessionId, inc }) {
      const [open, setOpen] = useState(false)
      const feedback = (kind) => api('/watch/feedback', { sessionId, incidentId: inc.id, kind }).catch(() => {})
      const fills = inc.actions.filter((a) => a.kind === 'fill')
      return h('div', { className: `vg-card vg-sev-${inc.severity}` },
        h('div', { className: 'vg-card-title' }, h('span', { className: 'vg-sev-icon' }, inc.severity === 'info' ? h(Icon.info) : h(Icon.alert)), inc.title,
          inc.count > 1 ? h('span', { className: 'vg-muted' }, ` ×${inc.count}`) : null),
        h('p', null, inc.why, inc.guessed ? h('span', { className: 'vg-muted' }, '（推测）') : null),
        inc.impact ? h('p', { className: 'vg-muted' }, inc.impact) : null,
        ...inc.actions.map((a, i) => a.kind === 'fill'
          ? h(FillAction, { key: i, sessionId, action: a, primary: a === fills[0] })
          : h('div', { key: i, className: 'vg-steps' }, h('b', null, a.label), h('ol', null, a.steps.map((s, j) => h('li', { key: j }, s))))),
        h('div', { className: 'vg-card-foot' },
          inc.evidence?.length ? h(Btn, { kind: 'link', onClick: () => setOpen(!open) }, open ? '收起依据' : '依据') : null,
          h(Btn, { kind: 'link', onClick: () => feedback('dismiss') }, '忽略'),
          h(Btn, { kind: 'link', onClick: () => feedback('mute') }, '这类不再提醒'),
          h(Btn, { kind: 'link', onClick: () => feedback('wrong') }, '提醒错了')),
        open ? h('pre', { className: 'vg-evidence' }, inc.evidence.map((e) => `${e.seq !== undefined ? `#${e.seq} ` : ''}${e.excerpt}`).join('\n---\n')) : null)
    }

    // ---------- 想清楚 (F1) ----------
    const SCENARIOS = ['小工具', '数据看板', '个人主页', '表单收集', '小游戏', '其他']
    function ThinkView({ sessionId, data, reload }) {
      const [idea, setIdea] = useState('')
      const [scenario, setScenario] = useState()
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [intake, setIntake] = useState(data.intake)
      const [answers, setAnswers] = useState({})
      const [correction, setCorrection] = useState('')
      const [editing, setEditing] = useState()
      const [needsKind, setNeedsKind] = useState()
      const [fresh, setFresh] = useState(false)
      const ctl = useRef()
      useEffect(() => { setIntake(data.intake) }, [data.intake])
      useEffect(() => () => ctl.current?.abort(), [])
      const call = async (path, body) => {
        ctl.current = new AbortController()
        setBusy(true); setError('')
        try {
          const r = await api(path, { sessionId, ...body }, ctl.current.signal)
          if (r.needsKind) { setNeedsKind(r.latest); return }
          setNeedsKind(undefined)
          setIntake(r.stage === 'brief_ready' ? undefined : r)
          setAnswers({}); setCorrection('')
          if (r.stage === 'brief_ready') { setFresh(false); reload() }
        } catch (e) { if (!aborted(e)) setError(e.message) } finally { setBusy(false) }
      }
      const brief = data.brief
      const showIdea = !intake && (!brief || fresh)
      const err = error ? h('p', { className: 'vg-error' }, error) : null

      if (needsKind) {
        return h('div', { className: 'vg-section' },
          h('p', null, `这个文件夹已经有需求简报「${needsKind.title}」（v${needsKind.version}）。这次是？`),
          h('div', { className: 'vg-row' },
            h(Btn, { kind: 'primary', disabled: busy, onClick: () => call('/intake/start', { idea, scenario, kind: 'revise' }) }, '这个项目的新需求'),
            h(Btn, { disabled: busy, onClick: () => call('/intake/start', { idea, scenario, kind: 'new' }) }, '另一个新项目')),
          h('p', { className: 'vg-muted' }, '新项目建议换一个文件夹，否则简报和路线会混在一起。'), err)
      }
      if (showIdea) {
        return h('div', { className: 'vg-section' },
          h('p', { className: 'vg-lead' }, '先用一句话说说你想做什么。我只问会影响结果的几个问题，再整理成一份需求简报，你检查后填进主对话。'),
          h('div', { className: 'vg-chips' }, SCENARIOS.map((s) => h('button', { key: s, type: 'button', className: `vg-chip${scenario === s ? ' vg-on' : ''}`, onClick: () => setScenario(scenario === s ? undefined : s) }, s))),
          h('textarea', { className: 'vg-input', rows: 4, value: idea, placeholder: '例如：想做个网页，帮我们组每周汇总周报', onChange: (e) => setIdea(e.target.value) }),
          h('div', { className: 'vg-row' }, h(Btn, { kind: 'primary', disabled: busy || !idea.trim(), onClick: () => call('/intake/start', { idea, scenario }) }, busy ? '思考中…' : '开始梳理'),
            brief ? h(Btn, { onClick: () => setFresh(false) }, '返回简报') : null),
          err)
      }
      if (intake?.stage === 'asking') {
        const qs = intake.questions
        const answered = qs.every((q) => answers[q.id] && (answers[q.id].free === undefined || answers[q.id].free.trim()))
        return h('div', { className: 'vg-section' },
          h('div', { className: 'vg-muted' }, `第 ${intake.round} 轮 · 已理清 ${intake.progress.settled}/${intake.progress.total} 个方面`),
          intake.softCapReached ? h('div', { className: 'vg-note' }, '已经够开工了，剩下的可以边做边定。', h(Btn, { kind: 'link', onClick: () => call('/intake/skip') }, '先这样，开做')) : null,
          qs.map((q) => h('div', { key: q.id, className: 'vg-q' },
            h('div', { className: 'vg-q-text' }, q.text, h('span', { className: 'vg-muted' }, ` · ${q.topic ?? ''}`)),
            q.options.map((o, i) => h('label', { key: i, className: `vg-opt${answers[q.id]?.choice === i ? ' vg-on' : ''}` },
              h('input', { type: 'radio', name: q.id, checked: answers[q.id]?.choice === i, onChange: () => setAnswers({ ...answers, [q.id]: { qid: q.id, choice: i } }) }),
              h('span', null, h('b', null, o.label), o.recommended ? h('span', { className: 'vg-badge' }, '推荐') : null, h('br'), h('span', { className: 'vg-muted' }, o.consequence)))),
            q.recommendReason ? h('div', { className: 'vg-muted vg-reason' }, '为什么推荐：', q.recommendReason) : null,
            h('div', { className: 'vg-row' },
              h(Btn, { kind: answers[q.id]?.delegate ? 'primary' : 'plain', onClick: () => setAnswers({ ...answers, [q.id]: { qid: q.id, delegate: true } }) }, '你来定'),
              h(Btn, { kind: answers[q.id]?.free !== undefined ? 'primary' : 'plain', onClick: () => setAnswers({ ...answers, [q.id]: { qid: q.id, free: answers[q.id]?.free ?? '' } }) }, '我来说')),
            answers[q.id]?.free !== undefined ? h('input', { className: 'vg-input', value: answers[q.id].free, placeholder: '用你自己的话说', onChange: (e) => setAnswers({ ...answers, [q.id]: { qid: q.id, free: e.target.value } }) }) : null)),
          h('div', { className: 'vg-row' },
            h(Btn, { kind: 'primary', disabled: busy || !answered, onClick: () => call('/intake/answer', { answers: Object.values(answers) }) }, busy ? '思考中…' : '下一步'),
            h(Btn, { disabled: busy, onClick: () => call('/intake/skip') }, '先这样，开做')),
          err)
      }
      if (intake?.stage === 'restating') {
        return h('div', { className: 'vg-section' },
          h('div', { className: 'vg-restate' }, intake.restatement),
          h('div', { className: 'vg-row' }, h(Btn, { kind: 'primary', disabled: busy, onClick: () => call('/intake/confirm', {}) }, busy ? '整理简报中…' : '对，生成简报')),
          h('textarea', { className: 'vg-input', rows: 2, value: correction, placeholder: '有不对的地方？直接写哪里要改', onChange: (e) => setCorrection(e.target.value) }),
          h('div', { className: 'vg-row' }, h(Btn, { disabled: busy || !correction.trim(), onClick: () => call('/intake/confirm', { correction }) }, '按我说的改')),
          err)
      }
      if (brief) {
        if (editing !== undefined) {
          return h('div', { className: 'vg-section' },
            h('textarea', { className: 'vg-input vg-brief-edit', rows: 16, value: editing, onChange: (e) => setEditing(e.target.value) }),
            h('div', { className: 'vg-row' },
              h(Btn, { kind: 'primary', disabled: busy, onClick: async () => { setBusy(true); try { await api('/brief', { sessionId, text: editing }); setEditing(undefined); reload() } catch (e) { setError(e.message) } finally { setBusy(false) } } }, '保存为新版本'),
              h(Btn, { onClick: () => setEditing(undefined) }, '取消')),
            err)
        }
        return h('div', { className: 'vg-section' },
          h('div', { className: 'vg-muted' }, `需求简报 v${brief.version}${brief.editedByUser ? ' · 你改过' : ''}`),
          h('pre', { className: 'vg-brief' }, brief.text),
          h('div', { className: 'vg-row' }, h(FillButton, { sessionId, text: brief.text })),
          h('div', { className: 'vg-row' },
            h(Btn, { kind: 'link', onClick: () => setEditing(brief.text) }, '编辑'),
            h(Btn, { kind: 'link', onClick: () => { setFresh(true); setIdea('') } }, '改需求 / 新想法')), err)
      }
      return null
    }

    // ---------- 问一问 (F3-7) ----------
    function AskView({ sessionId }) {
      const [thread, setThread] = useState([])
      const [quote, setQuote] = useState(pendingAsk)
      const [question, setQuestion] = useState('')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const end = useRef()
      const ctl = useRef()
      useEffect(() => {
        pendingAsk = undefined
        const c = new AbortController()
        api(`/lens/thread?sessionId=${encodeURIComponent(sessionId)}`, undefined, c.signal).then((r) => setThread(r.thread)).catch(() => {})
        return () => { c.abort(); ctl.current?.abort() }
      }, [sessionId])
      useEffect(() => bus.on((m) => { if (m.type === 'ask') { setQuote(m.quote); pendingAsk = undefined } }), [])
      useEffect(() => { end.current?.scrollIntoView({ block: 'end' }) }, [thread.length])
      const send = async () => {
        if (!question.trim() || busy) return
        ctl.current = new AbortController()
        setBusy(true); setError('')
        try { const entry = await api('/lens/ask', { sessionId, quote, question }, ctl.current.signal); setThread((t) => [...t, entry]); setQuestion(''); setQuote(undefined) }
        catch (e) { if (!aborted(e)) setError(e.message) } finally { setBusy(false) }
      }
      return h('div', { className: 'vg-ask' },
        h('div', { className: 'vg-thread' },
          thread.length ? null : h('p', { className: 'vg-muted' }, '看不懂的地方都可以问，这里的问答不会进入主对话。也可以在主对话里选中文字，点「继续问」。'),
          thread.map((t) => h('div', { key: t.id, className: 'vg-qa' },
            t.quote ? h('blockquote', null, t.quote.slice(0, 300)) : null,
            h('div', { className: 'vg-q-text' }, t.question),
            h('div', { className: 'vg-answer' }, t.answer),
            t.fill ? h(FillAction, { sessionId, action: { label: '可以让主 AI 这样做', text: t.fill }, primary: true }) : null)),
          h('div', { ref: end })),
        quote ? h('div', { className: 'vg-quote' }, h('span', null, '引用：', quote.slice(0, 120)), h(Btn, { kind: 'link', onClick: () => setQuote(undefined), title: '去掉引用' }, h(Icon.close))) : null,
        error ? h('p', { className: 'vg-error vg-section' }, error) : null,
        h('div', { className: 'vg-row vg-composer' },
          h('textarea', { className: 'vg-input', rows: 2, value: question, placeholder: '问点什么…（不会发到主对话）', onChange: (e) => setQuestion(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send() } } }),
          h(Btn, { kind: 'primary', disabled: busy || !question.trim(), onClick: send }, busy ? '…' : '发送')))
    }

    // ---------- 设置 (PRD 11, UI-5, UI-6) ----------
    function SettingsView({ sessionId, onClose }) {
      const [s, setS] = useState()
      const [usage, setUsage] = useState()
      const [compat, setCompat] = useState()
      const [msg, setMsg] = useState('')
      const c = useCaps()
      useEffect(() => { api('/settings').then((r) => { setS(r.settings); setUsage(r.usage); setCompat(r.compat) }).catch((e) => setMsg(e.message)) }, [])
      const save = async (patch) => { try { const r = await api('/settings', patch); setS(r.settings); setUsage(r.usage); setMsg('已保存') } catch (e) { setMsg(e.message) } }
      if (!s) return h('div', { className: 'vg-section' }, msg || '加载中…')
      const toggle = (key, label, hint) => h('label', { className: 'vg-setting' }, h('span', null, label, h('br'), h('span', { className: 'vg-muted' }, hint)), h('input', { type: 'checkbox', checked: s[key], onChange: (e) => save({ [key]: e.target.checked }) }))
      const number = (key, label, hint) => h('label', { className: 'vg-setting' }, h('span', null, label, h('br'), h('span', { className: 'vg-muted' }, hint)), h('input', { type: 'number', min: 0, max: 1000, className: 'vg-num vg-input', value: s[key], onChange: (e) => setS({ ...s, [key]: e.target.value }), onBlur: (e) => save({ [key]: Number(e.target.value) }) }))
      const degraded = [
        !c.sidebar && '侧栏：当前 DSH 不支持插件侧栏，改用悬浮面板',
        !c.dock && '填入主对话：当前 DSH 不支持，按钮会改为复制',
        c.chatFlow === false && '划词：没找到主对话区，只能在 VibeGuide 里划词',
        c.live === 'polling' && '实时提醒：推送连接断了，正在每 2 秒检查一次',
      ].filter(Boolean)
      return h('div', { className: 'vg-section vg-settings' },
        h('div', { className: 'vg-row' }, h('b', { className: 'vg-title' }, '设置'), h(Btn, { kind: 'link', onClick: onClose }, '完成')),
        compat?.notice ? h('p', { className: 'vg-note' }, compat.notice) : null,
        degraded.length ? h('div', { className: 'vg-note' }, h('b', null, '当前有些功能用的是替代方式'), h('ul', null, degraded.map((d, i) => h('li', { key: i }, d)))) : null,
        toggle('autoExplainUnknown', '自动解释不认识的报错', '每个报错最多 1 次模型调用，会用你的额度'),
        toggle('autoAnalysis', '自动分析每轮任务', '下一版本的「做了什么」会用到，同样消耗额度'),
        h('label', { className: 'vg-setting' }, h('span', null, '提醒范围'),
          h('select', { className: 'vg-input vg-select', value: s.alertLevel, onChange: (e) => save({ alertLevel: e.target.value }) },
            h('option', { value: 'block' }, '只提醒卡住的'), h('option', { value: 'warn' }, '卡住的 + 需要注意的'), h('option', { value: 'all' }, '全部'))),
        h('label', { className: 'vg-setting' }, h('span', null, '讲解长度'),
          h('select', { className: 'vg-input vg-select', value: s.explainLength, onChange: (e) => save({ explainLength: e.target.value }) }, h('option', { value: 'short' }, '简短'), h('option', { value: 'detailed' }, '详细'))),
        number('dailyLimit', '每日模型调用上限', '所有 VibeGuide 的模型调用都算'),
        number('perTurnLimit', '每轮自动调用上限', '只管自动的调用，你点按钮发起的不算'),
        usage ? h('p', { className: 'vg-muted' }, `今天已用 ${usage.calls}/${usage.limit} 次${usage.tokens ? `，约 ${usage.tokens} token` : ''}`) : null,
        h(Btn, { kind: 'link', onClick: async () => {
          if (!window.confirm('清除这个项目在 VibeGuide 里的记录（需求简报、提醒、讲解和追问）？项目文件和主对话不受影响。这一步不能撤销。')) return
          try { await api('/project/clear', { sessionId }); setMsg('已清除这个项目的记录') } catch (e) { setMsg(e.message) }
        } }, '清除当前项目的记录'),
        msg ? h('p', { className: 'vg-muted' }, msg) : null)
    }

    // ---------- 侧栏 ----------
    function Panel(props) {
      const sessionId = props.sessionId
      if (props.inputActions && sessionId) {
        const entry = bridge.sessions.get(sessionId) ?? {}
        entry.actions = props.inputActions
        bridge.sessions.set(sessionId, entry)
      }
      const [tab, setTab] = useState(() => local('vg.tab') || 'think')
      const [data, setData] = useState()
      const [error, setError] = useState('')
      const [settingsOpen, setSettingsOpen] = useState(false)
      const incidents = useIncidents(sessionId)
      const load = useCallback(() => {
        if (!sessionId) return () => {}
        const c = new AbortController()
        api(`/state?sessionId=${encodeURIComponent(sessionId)}`, undefined, c.signal).then((d) => { setData(d); setError('') }).catch((e) => { if (!aborted(e)) setError(e.message) })
        return () => c.abort()
      }, [sessionId])
      useEffect(load, [load])
      useEffect(() => bus.on((m) => { if (m.type === 'tab') setTab(m.tab); if (m.type === 'ask') setTab('ask') }), [])
      useEffect(() => { if (pendingAsk) setTab('ask') }, [])
      useEffect(() => { local('vg.tab', tab) }, [tab])
      if (!sessionId) return h('div', { className: 'vg-root vg-section' }, '先在主对话里开始一个会话。')
      return h('div', { className: 'vg-root' },
        h('div', { className: 'vg-head' },
          h('span', { className: `vg-dot ${data?.running ? 'vg-dot-run' : ''}` }),
          h('b', { className: 'vg-title' }, data?.brief?.title || data?.projectName || 'VibeGuide'),
          h('span', { className: 'vg-muted' }, data?.running ? 'AI 正在工作' : ''),
          h(Btn, { kind: 'link', onClick: () => setSettingsOpen(!settingsOpen), title: '设置' }, h(Icon.gear))),
        error ? h('p', { className: 'vg-error vg-section' }, error, ' ', h(Btn, { kind: 'link', onClick: load }, '重试')) : null,
        data?.compat?.notice ? h('p', { className: 'vg-note vg-inset' }, data.compat.notice) : null,
        data?.storageNotice ? h('p', { className: 'vg-note vg-inset' }, data.storageNotice) : null,
        data?.truncated ? h('p', { className: 'vg-muted vg-inset' }, '这个会话很长，更早的记录未读取。') : null,
        settingsOpen ? h(SettingsView, { sessionId, onClose: () => setSettingsOpen(false) }) : null,
        incidents.length ? h('div', { className: 'vg-incidents' }, incidents.map((inc) => h(IncidentCard, { key: inc.id, sessionId, inc }))) : null,
        h('div', { className: 'vg-tabs', role: 'tablist' }, [['think', '想清楚'], ['done', '做了什么'], ['ask', '问一问']].map(([id, label]) =>
          h('button', { key: id, type: 'button', role: 'tab', 'aria-selected': tab === id, className: `vg-tab${tab === id ? ' vg-on' : ''}`, onClick: () => setTab(id) }, label))),
        tab === 'think' ? (data ? h(ThinkView, { sessionId, data, reload: load }) : h('p', { className: 'vg-section vg-muted' }, error ? '' : '加载中…')) : null,
        tab === 'done' ? h('div', { className: 'vg-section vg-muted' }, '主 AI 每完成一轮有改动的任务，这里会出现白话版的技术路线（下一版本提供）。') : null,
        tab === 'ask' ? h(AskView, { sessionId }) : null)
    }

    /** Tab chip title with a red dot for warn/block incidents (F2-7). */
    function TabTitle(props) {
      const incidents = useIncidents(props.sessionId)
      const alert = incidents.some((i) => i.severity === 'block' || i.severity === 'warn')
      // Dot first: narrow tab chips truncate the end of the title.
      return h('span', { className: 'vg-tab-title' }, alert ? h('span', { className: 'vg-red-dot', 'aria-label': '有需要注意的提醒' }) : null, 'VibeGuide')
    }

    // ---------- 输入框上方：桥接 + 阻断提示条 (F2-7) ----------
    function Dock(props) {
      const { sessionId, inputActions, useInput } = props
      const draft = useInput ? useInput((s) => s.draft) : undefined
      useEffect(() => {
        if (!sessionId) return
        setCap('dock', !!inputActions?.setDraft)
        const entry = bridge.sessions.get(sessionId) ?? {}
        entry.actions = inputActions
        entry.draft = draft
        bridge.sessions.set(sessionId, entry)
        bridge.current = sessionId
        setCap('chatFlow', !!document.querySelector('[data-chat-flow]'))
      })
      const incidents = useIncidents(sessionId)
      const [hidden, setHidden] = useState({})
      const block = incidents.find((i) => i.severity === 'block' && !hidden[i.id])
      // The sidebar has no change event for plugins: check its state while a block is open.
      const readExpanded = () => { try { return !!sidebarRight?.isExpanded?.() } catch { return false } }
      const [expanded, setExpanded] = useState(readExpanded)
      useEffect(() => {
        if (!block) return
        setExpanded(readExpanded())
        const t = setInterval(() => setExpanded(readExpanded()), 700)
        return () => clearInterval(t)
      }, [block?.id])
      if (!block || expanded) return null
      return h('div', { className: 'vg-banner', role: 'alert' },
        h('span', { className: 'vg-sev-icon' }, h(Icon.alert)),
        h('span', { className: 'vg-banner-text' }, block.title),
        h(Btn, { kind: 'link', onClick: () => openPanel() }, '查看怎么办'),
        h(Btn, { kind: 'link', onClick: () => setHidden({ ...hidden, [block.id]: true }), title: '关闭提示' }, h(Icon.close)))
    }

    // ---------- 划词 (F3) + 悬浮面板降级 ----------
    function selectionInfo() {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed || !sel.rangeCount) return undefined
      const text = sel.toString().trim()
      if (text.length < 2 || text.length > 2000) return undefined // F3-1
      const node = sel.anchorNode?.nodeType === 1 ? sel.anchorNode : sel.anchorNode?.parentElement
      if (!node || node.closest('textarea, input, select, [contenteditable="true"], [data-composer-card], .vg-lens')) return undefined
      const inChat = node.closest('[data-chat-flow]')
      const inPanel = node.closest('.vg-root')
      if (!inChat && !inPanel) return undefined
      const rect = sel.getRangeAt(0).getBoundingClientRect()
      return { text, rect: { left: rect.left, top: rect.top, bottom: rect.bottom } }
    }

    function Overlay() {
      const [floating, setFloating] = useState(false)
      useEffect(() => bus.on((m) => { if (m.type === 'floating') setFloating(m.open) }), [])
      return h(React.Fragment, null,
        h(Boundary, { name: 'lens', quiet: true }, h(Lens)),
        floating && bridge.current ? h('div', { className: 'vg-floating' },
          h('div', { className: 'vg-floating-bar' }, h('b', null, 'VibeGuide'), h(Btn, { kind: 'link', onClick: () => setFloating(false), title: '收起' }, h(Icon.close))),
          h(Boundary, { name: 'floating-panel' }, h(Panel, { sessionId: bridge.current }))) : null)
    }

    function Lens() {
      const [sel, setSel] = useState()
      const [card, setCard] = useState()
      const [busy, setBusy] = useState(false)
      const timer = useRef()
      const ctl = useRef()
      useEffect(() => {
        const close = () => { ctl.current?.abort(); setSel(undefined); setCard(undefined); setBusy(false) }
        const update = () => {
          clearTimeout(timer.current)
          timer.current = setTimeout(() => {
            const s = selectionInfo()
            if (s) setSel((prev) => { if (prev?.text !== s.text) { ctl.current?.abort(); setCard(undefined) } return s })
            else close()
          }, 120)
        }
        const up = (e) => { if (!e.target?.closest?.('.vg-lens')) update() }
        const key = (e) => { if (e.key === 'Escape') close() } // F3-2
        const scroll = (e) => { if (!e.target?.closest?.('.vg-lens')) close() }
        document.addEventListener('pointerup', up, true)
        document.addEventListener('keyup', up, true)
        document.addEventListener('keydown', key, true)
        document.addEventListener('scroll', scroll, true)
        return () => { document.removeEventListener('pointerup', up, true); document.removeEventListener('keyup', up, true); document.removeEventListener('keydown', key, true); document.removeEventListener('scroll', scroll, true); ctl.current?.abort() }
      }, [])
      const sessionId = bridge.current
      if (!sel || !sessionId) return null
      const explain = async (contextualize) => {
        ctl.current?.abort()
        ctl.current = new AbortController()
        setBusy(true)
        try { setCard(await api('/lens/explain', { sessionId, text: sel.text, contextualize }, ctl.current.signal)) }
        catch (e) { if (!aborted(e)) setCard({ error: e.message }) } finally { setBusy(false) }
      }
      const ask = () => { pendingAsk = sel.text; bus.emit({ type: 'ask', quote: sel.text }); openPanel('ask'); setSel(undefined); setCard(undefined) }
      const below = sel.rect.bottom + 8
      const flip = below + (card ? 320 : 48) > window.innerHeight - 140 // keep clear of the composer (F3-2)
      const style = { position: 'fixed', left: Math.max(8, Math.min(sel.rect.left, window.innerWidth - 348)), top: flip ? Math.max(8, sel.rect.top - (card ? 330 : 48)) : below, zIndex: 2147483000 }
      return h('div', { className: 'vg-lens', style },
        h('div', { className: 'vg-lens-menu' },
          h(Btn, { kind: 'primary', disabled: busy, onClick: () => explain(false) }, busy ? '…' : '解释'),
          h(Btn, { onClick: ask }, '继续问'),
          h(Btn, { onClick: () => { copy(sel.text); setSel(undefined) } }, '复制')),
        card ? h('div', { className: 'vg-lens-card' }, card.error ? h('p', { className: 'vg-error' }, card.error) : h(LensCard, { card, sessionId, onContextualize: () => explain(true) })) : null)
    }

    function LensCard({ card, sessionId, onContextualize }) {
      if (card.kind === 'error') {
        const fills = (card.actions ?? []).filter((a) => a.kind === 'fill').slice(0, 2)
        return h('div', null, h('div', { className: 'vg-card-title' }, card.title),
          h('p', null, card.why, card.guessed ? h('span', { className: 'vg-muted' }, '（推测）') : null),
          card.impact ? h('p', { className: 'vg-muted' }, card.impact) : null,
          ...fills.map((a, i) => h(FillAction, { key: i, sessionId, action: a, primary: i === 0 })))
      }
      const need = { none: '不用，了解一下就好。', decide: '需要你决定：', do: '需要你做：' }[card.needAction ?? 'none']
      return h('div', null,
        card.techName ? h('div', { className: 'vg-muted' }, card.techName) : null,
        h('p', null, h('b', null, card.kind === 'passage' ? '这段在说什么：' : '这是什么：'), card.what),
        card.inYourProject ? h('p', null, h('b', null, card.source === 'glossary' ? '什么时候要注意：' : '在你的项目里：'), card.inYourProject) : null,
        h('p', null, h('b', null, '要你做什么吗：'), need, card.actionHint && card.needAction !== 'none' ? card.actionHint : ''),
        card.canContextualize ? h(Btn, { kind: 'link', onClick: onContextualize }, '结合我的项目讲') : null,
        card.cached ? h('span', { className: 'vg-muted' }, ' · 之前讲过') : null)
    }

    // ---------- styles (UI-3: host tokens, readable in dark mode) ----------
    function insertCss() {
      if (document.getElementById('vg-style')) return
      const s = document.createElement('style')
      s.id = 'vg-style'
      s.textContent = `
.vg-root{font-size:13px;line-height:1.55;color:var(--dsw-alias-label-primary,inherit);height:100%;display:flex;flex-direction:column;overflow:auto}
.vg-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.25))}
.vg-title{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.vg-dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--dsw-alias-label-tertiary,#999)}.vg-dot-run{background:var(--dsw-alias-brand-primary,#4d6bfe)}
.vg-muted{color:var(--dsw-alias-label-secondary,#888)}.vg-error{color:var(--dsw-alias-state-error-primary,#e5484d)}
.vg-section{padding:10px 12px}.vg-inset{margin:8px 12px 0}.vg-lead{margin:0 0 8px}
.vg-tabs{display:flex;gap:4px;padding:0 12px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.25))}
.vg-tab{background:none;border:0;border-bottom:2px solid transparent;padding:8px 6px;color:var(--dsw-alias-label-secondary,#888);cursor:pointer;font:inherit}
.vg-tab.vg-on{color:var(--dsw-alias-label-primary,inherit);border-bottom-color:var(--dsw-alias-brand-primary,#4d6bfe)}
.vg-btn{font:inherit;font-size:12px;border-radius:6px;padding:4px 10px;cursor:pointer;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.35));background:var(--dsw-alias-bg-layer-1,transparent);color:inherit;display:inline-flex;align-items:center;gap:4px}
.vg-btn:disabled{opacity:.5;cursor:default}.vg-btn-primary{background:var(--dsw-alias-button-primary-fill,#4d6bfe);border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#fff)}
.vg-btn-link{border:0;background:none;padding:2px 4px;color:var(--dsw-alias-label-secondary,#888)}.vg-btn-link:hover{color:var(--dsw-alias-label-primary,inherit)}
.vg-row{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:6px 0}.vg-fill,.vg-choice{display:inline-flex;gap:6px;align-items:center;flex-wrap:wrap}
.vg-incidents{padding:8px 12px 0}.vg-card{border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));border-left-width:3px;border-radius:8px;padding:8px 10px;margin-bottom:8px;background:var(--dsw-alias-bg-layer-1,transparent)}
.vg-card p{margin:4px 0}.vg-card-title{font-weight:600;display:flex;gap:6px;align-items:center}.vg-sev-icon{display:inline-flex}
.vg-sev-block{border-left-color:var(--dsw-alias-state-error-primary,#e5484d)}.vg-sev-block .vg-sev-icon{color:var(--dsw-alias-state-error-primary,#e5484d)}
.vg-sev-warn{border-left-color:var(--dsw-alias-state-warn-primary,#f5a524)}.vg-sev-warn .vg-sev-icon{color:var(--dsw-alias-state-warn-primary,#f5a524)}.vg-sev-info{border-left-color:var(--dsw-alias-label-tertiary,#999)}
.vg-action{margin:8px 0}.vg-action-head{display:flex;gap:6px;align-items:center}.vg-preview{white-space:pre-wrap;font-size:12px;margin:4px 0;padding:6px 8px;border-radius:6px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.1))}
.vg-card-foot{display:flex;flex-wrap:wrap;gap:2px;margin-top:4px}.vg-steps{margin:8px 0}.vg-steps ol{margin:2px 0 4px;padding-left:18px}
.vg-evidence{white-space:pre-wrap;font-size:11px;max-height:160px;overflow:auto;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.1));padding:6px;border-radius:6px}
.vg-input{width:100%;box-sizing:border-box;font:inherit;border-radius:8px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.35));background:var(--dsw-alias-bg-layer-1,transparent);color:inherit;resize:vertical}
.vg-select,.vg-num{width:auto;min-width:90px}
.vg-chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}.vg-chip{font:inherit;font-size:12px;border-radius:999px;padding:2px 10px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.35));background:none;color:inherit;cursor:pointer}.vg-chip.vg-on{border-color:var(--dsw-alias-brand-primary,#4d6bfe);color:var(--dsw-alias-brand-primary,#4d6bfe)}
.vg-q{margin:10px 0 14px}.vg-q-text{font-weight:600;margin-bottom:4px}.vg-opt{display:flex;gap:6px;align-items:flex-start;padding:6px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.25));margin:4px 0;cursor:pointer}.vg-opt.vg-on{border-color:var(--dsw-alias-brand-primary,#4d6bfe)}.vg-reason{font-size:12px;margin:2px 0}
.vg-badge{font-size:11px;margin-left:6px;padding:0 6px;border-radius:999px;background:var(--dsw-alias-button-primary-fill,#4d6bfe);color:var(--dsw-alias-label-primary-foreground,#fff)}
.vg-note{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.1));border-radius:8px;padding:6px 8px;margin:6px 0}.vg-note ul{margin:4px 0 0;padding-left:18px}
.vg-restate{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.1));border-radius:8px;padding:10px;margin-bottom:8px}
.vg-brief{white-space:pre-wrap;font:inherit;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.1));border-radius:8px;padding:10px;margin:4px 0 6px}
.vg-ask{display:flex;flex-direction:column;flex:1;min-height:0}.vg-thread{flex:1;overflow:auto;padding:10px 12px}.vg-qa{margin-bottom:14px}.vg-answer{white-space:pre-wrap}
.vg-qa blockquote,.vg-quote{margin:0 0 4px;padding:2px 8px;border-left:3px solid var(--dsw-alias-border-l2,rgba(127,127,127,.4));color:var(--dsw-alias-label-secondary,#888)}
.vg-quote{margin:0 12px;display:flex;justify-content:space-between;gap:6px}.vg-composer{padding:0 12px 10px;flex-wrap:nowrap}
.vg-setting{display:flex;gap:8px;align-items:center;justify-content:space-between;margin:10px 0}
.vg-banner{display:flex;align-items:center;gap:8px;margin:0 0 6px;padding:6px 10px;border-radius:8px;font-size:13px;background:var(--dsw-alias-bg-layer-1,transparent);border:1px solid var(--dsw-alias-state-error-primary,#e5484d);color:var(--dsw-alias-label-primary,inherit)}
.vg-banner .vg-sev-icon{color:var(--dsw-alias-state-error-primary,#e5484d)}.vg-banner-text{flex:1}
.vg-tab-title{display:inline-flex;align-items:center;gap:4px}.vg-red-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-error-primary,#e5484d)}
.vg-lens{pointer-events:auto;max-width:340px;font-size:13px;line-height:1.55;color:var(--dsw-alias-label-primary,#222)}
.vg-lens-menu{display:inline-flex;gap:4px;padding:4px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-layer-1,#fff));border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));box-shadow:0 4px 16px rgba(0,0,0,.18)}
.vg-lens-card{margin-top:6px;padding:10px 12px;border-radius:10px;max-height:300px;overflow:auto;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-layer-1,#fff));border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));box-shadow:0 6px 24px rgba(0,0,0,.2)}
.vg-lens-card p{margin:4px 0}
.vg-floating{pointer-events:auto;position:fixed;right:16px;top:64px;bottom:96px;width:360px;max-width:calc(100vw - 32px);display:flex;flex-direction:column;border-radius:12px;overflow:hidden;z-index:2147482000;background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));box-shadow:0 8px 32px rgba(0,0,0,.25)}
.vg-floating-bar{display:flex;justify-content:space-between;align-items:center;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.25))}`
      document.head.appendChild(s)
    }

    // ---------- registration (UI-1, UI-2) ----------
    function apply(ctx) {
      const slots = ctx.get('slots')
      if (!slots) return
      insertCss()
      const register = (name, desc, comp, cap) => {
        try { slots.inject(name, () => { const d = slots.register({ name, ...desc }, comp); if (cap) setCap(cap, true); return d }) }
        catch (e) { console.warn('[dsh-vibeguide] slot', name, e) }
      }
      register('conversation.input.dock', { id: 'dsh-vibeguide-dock', order: 50 }, guarded('dock', Dock, true))
      register('shell.overlay', { id: 'dsh-vibeguide-overlay' }, guarded('overlay', Overlay, true), 'overlay')
      register('sidebar.right.pane.tab', { key: TAB_ID }, guarded('panel', Panel))
      register('sidebar.right.pane.tab.title', { key: TAB_ID }, guarded('title', TabTitle, true))
      try { ctx.inject(['sidebarRight'], (c) => { sidebarRight = c.get('sidebarRight'); c.effect(() => () => { sidebarRight = undefined }) }) } catch { /* optional */ }
      try {
        ctx.inject(['sidebarRightTabs'], (c) => {
          // Guide entries take functions for title and description (a string crashes the host's start page).
          const dispose = c.get('sidebarRightTabs').register({ id: TAB_ID, kind: TAB_KIND, title: () => 'VibeGuide',
            guide: [{ id: 'dsh-vibeguide', title: () => 'VibeGuide', description: () => '想清楚需求 · 卡住时自救 · 看懂术语' }] })
          setCap('sidebar', true)
          c.effect(() => () => { setCap('sidebar', false); dispose() })
        })
      } catch (e) { console.warn('[dsh-vibeguide] sidebar tab', e) }
      ctx.effect?.(() => () => { for (const hub of hubs.values()) { hub.source?.close(); clearInterval(hub.poll) } hubs.clear() })
    }
    return { inject: ['slots'], apply }
  },
})
