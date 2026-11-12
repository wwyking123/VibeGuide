import { useEffect, useRef, useState } from 'react';
import { briefKeys } from '../v3/types.js';
import type { Brief, BriefKey, Task, View } from '../v3/types.js';
import { Markdown } from './markdown.js';
type Rpc = <T>(method: string, request: unknown, signal: AbortSignal) => Promise<T>;
const labels: Record<BriefKey, string> = { audience: '给谁使用', goal: '想解决什么问题', flow: '核心使用流程', scope: '首版要做什么', acceptance: '怎样算做成', constraints: '约束与首版不做什么', openQuestions: '尚待确认' };
const tabLabels = { think: '想清楚', work: '陪我做', recap: '回顾' };
function Copy({ text }: {
    text: string;
}) {
    const [message, setMessage] = useState('');
    return <><button type="button" disabled={!text.trim()} onClick={() => { void navigator.clipboard.writeText(text).then(() => setMessage('已复制，请到主对话粘贴并发送。')).catch(() => setMessage('未能复制，请手动选中文本复制。')); }}>复制完整内容</button>{message && <p role="status" className="v3-muted">{message}</p>}</>;
}
function BriefEditor({ task, save, disabled }: {
    task: Task;
    save: (brief: Brief) => Promise<boolean>;
    disabled: boolean;
}) {
    const [brief, setBrief] = useState(task.brief);
    const dirty=useRef(false);const [changed,setChanged]=useState(false);
    useEffect(()=>{if(dirty.current)setChanged(true);else setBrief(task.brief);},[JSON.stringify(task.brief)]);
    return <div className="v3-form">{briefKeys.map(k => <label key={k}>{labels[k]}<textarea rows={2} maxLength={3000} value={brief[k]} onChange={e => {dirty.current=true;setBrief({ ...brief, [k]: e.target.value });}}/></label>)}<button disabled={disabled || changed} onClick={() => void save(brief).then(ok=>{if(ok){dirty.current=false;setChanged(false);}})}>保存任务卡（需重新确认）</button>{changed&&<p className="v3-warning">任务卡有新内容，你正在编辑的文字已保留。<button onClick={()=>{setBrief(task.brief);dirty.current=false;setChanged(false);}}>使用最新任务卡，放弃这次编辑</button></p>}</div>;
}
function Transfer({ task }: {
    task: Task;
}) {
    const [value, setValue] = useState(task.transfer);
    const dirty=useRef(false);const [changed,setChanged]=useState(false);
    useEffect(()=>{if(dirty.current)setChanged(true);else setValue(task.transfer);},[task.transfer]);
    return <details className="v3-details"><summary>交给主 Agent 的任务说明</summary><p className="v3-muted">可编辑后复制。这里不会自动发送。</p><textarea aria-label="完整交接说明" rows={12} value={value} onChange={e => {dirty.current=true;setValue(e.target.value);}} maxLength={28000}/><Copy text={value}/>{changed&&<p className="v3-warning">任务说明有更新，保留了你的编辑。<button onClick={()=>{setValue(task.transfer);dirty.current=false;setChanged(false);}}>替换为最新说明</button></p>}</details>;
}
export function V3Panel({ sessionId, rpc }: {
    sessionId: string;
    rpc: Rpc;
}) {
    const [view, setView] = useState<View>();
    const [tab, setTab] = useState<keyof typeof tabLabels>('think');
    const [error, setError] = useState('');
    const [input, setInput] = useState('');
    const [busy, setBusy] = useState(false);
    const [settings, setSettings] = useState(false);
    const [report, setReport] = useState(false);
    const [selection, setSelection] = useState('');
    const [popup, setPopup] = useState(false);
    const [sideInput, setSideInput] = useState('');
    const [threadId, setThreadId] = useState(() => crypto.randomUUID());
    const [selectionButton, setSelectionButton] = useState<{
        x: number;
        y: number;
        text: string;
    }>();
    const active = useRef(true);
    const working = useRef(false);
    const generation = useRef(0);
    const controller = useRef<AbortController>();
    const panel = useRef<HTMLElement>(null);
    const current = useRef<View>();
    current.current = view;
    const initialTab = useRef(false);
    const task = view?.task;
    const outboxKey = `vibeguide:v3:pending:${sessionId}`;
    const pending = useRef<Record<string, unknown>>();
    const [hasPending, setHasPending] = useState(false);
    useEffect(() => { try {
        const raw = localStorage.getItem(outboxKey);
        if (raw) {
            const value = JSON.parse(raw);
            if (value.sessionId === sessionId && typeof value.requestId === 'string' && typeof value.action === 'string') {
                pending.current = value;
                setHasPending(true);
            }
        }
    }
    catch {
        setError('待核对请求无法读取，请保留输入后重试。');
    } }, [sessionId]);
    async function refresh() {
        if (working.current || !active.current)
            return;
        const epoch = generation.current;
        try {
            const next = await rpc<View>('v3View', { sessionId }, AbortSignal.timeout(10000));
            if (active.current && epoch === generation.current) {
                setView(next);
                if (!initialTab.current) {
                    initialTab.current = true;
                    if (next.task && next.task.state !== 'draft')
                        setTab('work');
                }
                setError('');
            }
        }
        catch (e) {
            if (active.current && epoch === generation.current)
                setError(e instanceof Error ? e.message : '暂时无法读取任务。');
        }
    }
    useEffect(() => { active.current = true; generation.current++; void refresh(); const timer = setInterval(() => { if (document.visibilityState === 'visible')
        void refresh(); }, 5000); return () => { active.current = false; generation.current++; controller.current?.abort(); clearInterval(timer); }; }, [sessionId]);
    async function act(action: string, payload: unknown = {}, target = task, retry = false) {
        if (working.current)
            return false;
        if (pending.current && !retry) {
            setError('有一条请求结果待核对，请先核对或放弃该请求。');
            return false;
        }
        working.current = true;
        setBusy(true);
        setError('');
        const epoch = generation.current;
        const c = new AbortController();
        controller.current = c;
        try {
            const request = retry ? pending.current! : { sessionId, ...(target ? { taskId: target.id, expectedRevision: target.revision } : {}), requestId: crypto.randomUUID(), action, payload };
            localStorage.setItem(outboxKey, JSON.stringify(request));
            pending.current = request;
            setHasPending(true);
            const next = await rpc<View>('v3Action', request, AbortSignal.any([c.signal, AbortSignal.timeout(95000)]));
            localStorage.removeItem(outboxKey);
            pending.current = undefined;
            setHasPending(false);
            if (active.current && epoch === generation.current) {
                setView(next);
                return true;
            }
            return false;
        }
        catch (e) {
            if (e instanceof Error && 'code' in e && typeof e.code === 'string' && e.code.startsWith('vibeguide/')) {
                localStorage.removeItem(outboxKey);
                pending.current = undefined;
                setHasPending(false);
            }
            if (active.current && epoch === generation.current)
                setError(c.signal.aborted ? '已停止等待；服务端取消情况取决于模型服务。' : e instanceof Error ? e.message : '操作未完成，输入已保留。');
            return false;
        }
        finally {
            working.current = false;
            if (active.current && epoch === generation.current)
                setBusy(false);
        }
    }
    useEffect(() => {
        function capture(e: MouseEvent) {
            if (!panel.current?.checkVisibility() || !current.current?.task)
                return;
            if ((e.target as HTMLElement)?.closest('.v3-root')) {
                setSelectionButton(undefined);
                return;
            }
            const sel = window.getSelection();
            const anchor = sel?.anchorNode?.parentElement;
            const focus = sel?.focusNode?.parentElement;
            const row = anchor?.closest('[data-chat-flow-key]');
            const end = focus?.closest('[data-chat-flow-key]');
            if (!sel || sel.isCollapsed || !row || row !== end || anchor?.closest('input,textarea,[contenteditable=true],.v3-root') || row.closest('[hidden]')) {
                if (!(e.target as HTMLElement)?.closest('.v3-selection-action'))
                    setSelectionButton(undefined);
                return;
            }
            const value = sel.toString().trim();
            if (!value || value.length > 12000)
                return;
            setSelectionButton({ x: Math.max(8, Math.min(e.clientX, window.innerWidth - 180)), y: Math.max(8, Math.min(e.clientY + 10, window.innerHeight - 50)), text: value });
        }
        document.addEventListener('mouseup', capture);
        return () => document.removeEventListener('mouseup', capture);
    }, [sessionId]);
    useEffect(() => { setSelection(''); setPopup(false); setSelectionButton(undefined); setThreadId(crypto.randomUUID()); setInput(''); setSideInput(''); }, [task?.id]);
    const answerList = task?.answers.filter(a => a.threadId === threadId) ?? [];
    const historical = (refs: string[]) => refs.map(id => task?.evidence.find(e => e.id === id) ?? view?.frame.evidence.find(e => e.id === id));
    const evidence = (refs: string[]) => <details className="v3-evidence"><summary>查看依据（{refs.length}）</summary>{refs.map((id, i) => { const ev = historical([id])[0]; const op = id.startsWith('op:') ? [...(task?.operations ?? []), ...(view?.frame.operations ?? [])].find(o => `op:${o.id}` === id) : undefined; return <p key={id + i}><code>{id}</code><br />{ev?.text ?? (op ? `${op.label} · ${op.outcome}\n${op.diagnostic ?? ''}` : id.startsWith('report:') ? '用户反馈的现象' : '当前窗口未包含该历史来源，记录可能不完整。')}</p>; })}</details>;
    return <section className="v3-root" ref={panel} data-testid="vibeguide-panel" aria-label="Vibe Guide 导航助手"><style>{css}</style>
  <header className="v3-header"><div><span className="v3-eyebrow">VIBE GUIDE</span><h2>把想法，一步步做出来</h2></div><button title="设置与历史" aria-label="设置与历史" onClick={() => setSettings(!settings)}>⋯</button></header>
  <nav className="v3-tabs" aria-label="任务阶段">{(Object.keys(tabLabels) as (keyof typeof tabLabels)[]).map((k, i) => <button key={k} aria-pressed={tab === k} onClick={() => setTab(k)}><span>0{i + 1}</span>{tabLabels[k]}</button>)}</nav>
  <main className="v3-main">
  {hasPending && <div className="v3-warning">上次请求的结果待核对，不会自动重发。<button disabled={busy} onClick={() => void act(String(pending.current?.action), {}, task, true)}>核对同一请求</button><button disabled={busy} onClick={() => { localStorage.removeItem(outboxKey); pending.current = undefined; setHasPending(false); setError('已放弃核对；已有服务端记录不会因此撤销。'); }}>放弃核对</button></div>}
  {error && <p role="alert" className="v3-warning">{error}<button disabled={busy} onClick={() => void refresh()}>刷新核对</button></p>}
  {!view && <p role="status">正在连接当前会话…</p>}
  {settings && view && <section className="v3-card"><h3>设置与任务记录</h3><p className="v3-muted">数据保存在本机。生成解释时，会把必要的任务及会话片段交给当前模型，消耗其额度。插件不自动发送开发任务。</p>
   {task && <><label><input type="checkbox" checked={task.settings.autoDiagnosis} disabled={busy} onChange={e => void act('settings', { ...task.settings, autoDiagnosis: e.target.checked })}/>自动解释卡点（每任务最多 5 次）</label><label><input type="checkbox" checked={task.settings.autoRecap} disabled={busy} onChange={e => void act('settings', { ...task.settings, autoRecap: e.target.checked })}/>自动生成阶段回顾（最多 2 次）</label><p className="v3-muted">本任务调用：自动诊断 {task.usage.diagnosis} · 自动回顾 {task.usage.recap} · 手动 {task.usage.manual}</p><button disabled={busy} onClick={() => { const blob = new Blob([JSON.stringify(task, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `vibeguide-${task.id}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }}>导出任务记录</button><button disabled={busy} onClick={() => { if (window.confirm('删除这个任务的插件记录？主对话和项目文件会保留。'))
            void act('delete'); }}>删除当前任务记录</button></>}
   <div className="v3-history">{view.tasks.map(t => <button disabled={busy} key={t.id} onClick={() => { void act('select', {}, { id: t.id, revision: t.revision } as Task); }}>{t.title} · {{draft:'梳理中',active:'进行中',review:'待核对',closed:'已确认完成',archived:'历史任务'}[t.state]}</button>)}</div><button disabled={busy} onClick={() => { void act('create').then(ok => { if (ok)
            setTab('think'); }); }}>开始一个新任务</button></section>}
  {view && !view.frame.enabled && <p className="v3-warning">访谈和侧问可以使用。自动跟踪工具操作，请在主对话切换到 VibeGuide 模式。</p>}
  {view && !view.frame.modelReady && <p className="v3-warning">尚未配置模型。仍可手动编辑任务卡、复制和查看已有记录。</p>}
  {view && !task && <section className="v3-empty"><div className="v3-orbit">✳</div><span className="v3-eyebrow">从一个小想法开始</span><h2>你想做什么？<br />我们一起把它说清楚。</h2><p>不用懂技术。先聊清楚给谁用、怎么用，以及怎样算做成。</p><button className="v3-primary" disabled={busy} onClick={() => void act('create')}>梳理我的想法 ↗</button><button disabled={busy} onClick={() => void act('create').then(async (ok) => { if (ok) {
        setTab('work');
    } })}>已经开工，直接使用帮助</button><p className="v3-muted">自动帮助会使用当前模型额度，可在设置关闭。</p></section>}
  {view?.needsBinding && <p className="v3-warning">这个想法尚未绑定到当前项目。<button disabled={busy} onClick={() => void act('bind')}>关联到 {view.frame.projectName}</button></p>}
  {task && <><div className="v3-task-heading"><span className="v3-status-dot"/><strong>{task.title}</strong><span className="v3-muted">{task.state === 'draft' ? '梳理中' : task.state === 'review' ? '阶段交付待核对' : task.state === 'closed' ? '你已确认完成' : task.state==='archived'?'历史任务':'当前任务'}</span></div>
  {tab === 'think' && <>
   <div className="v3-section-title"><span>先把目标说清楚</span><small>每次只解决一个关键问题</small></div>
   {task.turns.map((turn, i) => <div className="v3-turn" key={i}><p className="v3-muted">{turn.question}</p><p>{turn.answer}</p></div>)}
   <section className="v3-question"><span className="v3-eyebrow">{task.turns.length ? '接下来，确认一件事' : '说说你的想法'}</span><h3>{task.nextQuestion}</h3><div className="v3-options">{task.options.map(o => <button disabled={busy} key={o} onClick={() => setInput(o)}>{o}</button>)}<button disabled={busy} onClick={() => setInput('不确定，请给我一个具体例子和推荐选项，我再决定。')}>不确定，帮我推荐</button></div></section>
   {!!task.contradictions.length && <p className="v3-warning">待核对：{task.contradictions.join('；')}</p>}
   {task.turns.length >= 5 && <p className="v3-muted">已经聊了 {task.turns.length} 轮，可以按当前说明开始，也可以继续完善。</p>}
   <details className="v3-details"><summary>实时任务卡 · {task.confirmed ? '已由你确认' : '待你确认'}</summary><BriefEditor key={task.id} task={task} save={brief => act('revise', { brief })} disabled={busy}/><button disabled={busy} onClick={() => void act('confirm')}>我已核对任务卡，确认这些内容</button></details>
   {!!task.transfer && <Transfer key={task.id} task={task}/>}
   <div className="v3-actions"><button className="v3-primary" disabled={busy} onClick={() => void act('activate', task.confirmed ? {} : { allowIncomplete: true }).then(ok => { if (ok)
                setTab('work'); })}>{task.confirmed ? '按任务说明开始' : '带待定项开始'}</button><button disabled={busy} onClick={() => void act('activate', { allowIncomplete: true }).then(ok => { if (ok)
                setTab('work'); })}>跳过访谈</button></div>
  </>}
  {tab === 'work' && <>
   {task.state === 'draft' && <div className="v3-warning">可先使用侧问。启用自动帮助前，点击<button disabled={busy} onClick={() => void act('activate', { allowIncomplete: true })}>从当前任务开始跟踪</button>。</div>}
   <section className="v3-work-status"><span className="v3-eyebrow">现在的进展</span><h3>{view?.frame.busy ? '主 Agent 正在处理' : view?.frame.waiting ? '等待你在主对话操作' : '主 Agent 暂无运行中操作'}</h3><p className="v3-muted">{view?.frame.partial ? '当前记录可能不完整。' : '基于当前会话的可观察记录。'} 没有新消息不代表卡死。</p></section>
   {task.issues.filter(i => i.state === 'open').map(issue => <article className="v3-card v3-issue" key={issue.id}><span className="v3-eyebrow">{issue.category === 'reported' ? '你反馈的现象' : '发现一个卡点'}{issue.count > 1 ? ` · ${issue.count} 次失败` : ''}</span><h3>{issue.summary}</h3><p>{issue.impact}</p><p><strong>下一步：</strong>{issue.nextStep}</p>{issue.stale ? <p className="v3-warning">证据有更新，旧建议暂不适用，请重新分析。</p> : <details><summary>给主 Agent 的完整指令</summary><p className="v3-pre">{issue.transfer}</p><Copy text={issue.transfer}/></details>}{evidence(issue.evidenceRefs)}<div className="v3-actions"><button disabled={busy || !view?.frame.modelReady} onClick={() => void act('diagnose', { issueId: issue.id })}>结合记录解释</button><button disabled={busy} onClick={() => void act('dismiss', { issueId: issue.id })}>暂时忽略</button></div></article>)}
   {!task.issues.some(i => i.state === 'open') && <div className="v3-calm"><span>✓</span><p>目前没有待处理的明确卡点。</p><small>看不懂时可以划词，效果不对时告诉我。</small></div>}
   <button onClick={() => { setReport(!report); setInput(''); }}>{report ? '返回提问' : '这里不对，描述实际效果'}</button>
   <details className="v3-details"><summary>本次操作记录（{view?.frame.operations.length ?? 0}）</summary>{view?.frame.operations.map(op => <p key={op.id}>{op.label} · {op.outcome}</p>)}</details>
   {!!task.answers.length && <section><h3>侧问记录</h3>{task.answers.slice(-10).map(a => <details className="v3-details" key={a.id}><summary>{a.question}</summary>{a.selection && <blockquote>{a.selection}</blockquote>}<Markdown text={a.text}/>{evidence(a.evidenceRefs)}<Copy text={a.text}/></details>)}<button disabled={busy} onClick={() => void act('clearAnswers')}>清除侧问记录</button></section>}
  </>}
  {tab === 'recap' && <><div className="v3-section-title"><span>看看这次怎么做成的</span><small>把工程过程变成你能看懂的路线</small></div><button className="v3-primary" disabled={busy || !view?.frame.modelReady} onClick={() => void act('recap')}>生成截至当前的回顾</button><p className="v3-muted">回顾不等于完成验收。自动生成最多两次，可在设置关闭。</p>{!task.recaps.length && <div className="v3-calm"><span>↗</span><p>有实施记录后，这里会解释主要步骤。</p></div>}{[...task.recaps].reverse().map(r => <article className="v3-card" key={r.id}><span className="v3-eyebrow">{r.throughSeq < (view?.frame.seq ?? 0) ? '历史回顾 · 之后有新进展' : '最新记录'}</span><h3>{r.title}</h3><p className="v3-muted">{new Date(r.createdAt).toLocaleString()}</p><p className="v3-warning">{r.verification}</p>{r.sections.map((s, i) => <section className="v3-recap-step" key={i}><span>0{i + 1}</span><div><h4>{s.title}</h4><Markdown text={s.text}/>{evidence(s.evidenceRefs)}</div></section>)}<details><summary>仍未确认的事项</summary>{r.limitations.map((l, i) => <p key={i}>{l}</p>)}</details><Copy text={r.sections.map(s => `${s.title}\n${s.text}`).join('\n\n') + '\n\n' + r.verification + '\n' + r.limitations.join('\n')}/></article>)}<button disabled={busy} onClick={() => void act('close')}>我已试用，确认本任务完成</button></>}
  </>}
  </main>
  {task && tab !== 'recap' && <footer className="v3-composer"><label htmlFor={`v3-input-${sessionId}`}>{tab === 'think' ? '你的回答' : report ? '描述预期与实际效果' : '有哪里想弄明白？'}</label><form onSubmit={e => { e.preventDefault(); const value = input; void act(tab === 'think' ? 'answer' : report ? 'report' : 'ask', { text: value, ...(tab === 'work' && !report ? { threadId } : {}) }).then(ok => { if (ok)
        setInput(''); }); }}><textarea id={`v3-input-${sessionId}`} aria-label={tab === 'think' ? '你的回答' : '提问或问题现象'} value={input} onChange={e => setInput(e.target.value)} maxLength={4000} rows={3} placeholder={tab === 'think' ? '不用组织语言，直接说就好…' : report ? '你希望看到什么？实际出现了什么？' : '选中术语解释，或者在这里直接问…'}/><div className="v3-composer-bottom"><small>{tab === 'think' ? '只梳理，不会开始开发' : '独立侧问，不打断主对话'}</small>{busy ? <button type="button" onClick={() => controller.current?.abort()}>停止等待</button> : <button className="v3-primary" disabled={!input.trim() || view?.busy}>发送 ↗</button>}</div></form></footer>}
  {selectionButton && <button className="v3-selection-action" style={{ position: 'fixed', left: selectionButton.x, top: selectionButton.y, zIndex: 2147483000 }} onMouseDown={e => e.preventDefault()} onClick={() => { setSelection(selectionButton.text); setPopup(true); setThreadId(crypto.randomUUID()); setSideInput('请解释这段内容在当前任务中的含义，以及我现在是否需要做什么。'); setSelectionButton(undefined); }}>✳ 解释 / 追问</button>}
  {popup && task && <aside className="v3-popover" role="dialog" aria-label="划词解释与追问"><header><strong>看懂这段话</strong><button aria-label="关闭解释窗口" onClick={() => setPopup(false)}>×</button></header><blockquote>{selection}</blockquote><p className="v3-muted">选区来自当前窗口；无法匹配到记录时仅作为引用材料。</p><div className="v3-side-answers">{answerList.map(a => <div key={a.id}><p><strong>{a.question}</strong></p><Markdown text={a.text}/><Copy text={a.text}/></div>)}</div><form onSubmit={e => { e.preventDefault(); void act('ask', { text: sideInput, selection, threadId }).then(ok => { if (ok)
        setSideInput(''); }); }}><textarea aria-label="侧问追问" value={sideInput} maxLength={4000} onChange={e => setSideInput(e.target.value)} rows={3}/><button className="v3-primary" disabled={busy || !sideInput.trim()}>解释 / 继续问</button>{busy && <button type="button" onClick={() => controller.current?.abort()}>停止等待</button>}</form></aside>}
 </section>;
}
const css = `
.v3-root{--v3-ink:var(--dsw-alias-label-primary,#26362f);--v3-muted:#778078;--v3-line:rgba(105,124,110,.2);--v3-soft:rgba(134,158,141,.08);--v3-accent:#467a57;font:13px/1.65 -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;display:flex;flex-direction:column;height:100%;min-height:0;color:var(--v3-ink);position:relative}.v3-root *{box-sizing:border-box}.v3-root button,.v3-selection-action{font:inherit;color:inherit;background:transparent;border:1px solid var(--v3-line,#bfcac0);padding:7px 12px;border-radius:8px;cursor:pointer}.v3-root button:hover{background:var(--v3-soft)}.v3-root button:disabled{opacity:.45;cursor:default}.v3-root .v3-primary,.v3-selection-action{background:#467a57;color:#fff;border-color:#467a57}.v3-root h2{font-size:18px;line-height:1.5;font-weight:550;margin:5px 0}.v3-root h3{font-size:15px;line-height:1.6;margin:6px 0}.v3-root h4{font-size:13px;margin:0}.v3-root p{margin:7px 0;overflow-wrap:anywhere}.v3-header{display:flex;justify-content:space-between;align-items:center;padding:22px 20px 17px}.v3-eyebrow{font-size:10px;letter-spacing:1.6px;color:var(--v3-accent);font-weight:650}.v3-tabs{display:flex;padding:0 18px;border-bottom:1px solid var(--v3-line);gap:12px}.v3-root .v3-tabs button{flex:1;border:0;border-radius:0;border-bottom:2px solid transparent;padding:10px 0;color:var(--v3-muted);white-space:nowrap}.v3-tabs span{font-size:10px;margin-right:6px;opacity:.7}.v3-root .v3-tabs button[aria-pressed=true]{border-color:var(--v3-accent);color:var(--v3-accent);font-weight:600}.v3-main{overflow:auto;flex:1;min-height:0;padding:20px}.v3-muted,.v3-root small{font-size:11px;color:var(--v3-muted)}.v3-root textarea{display:block;width:100%;resize:vertical;border:1px solid var(--v3-line);background:transparent;color:inherit;font:inherit;line-height:1.6;padding:10px 12px;border-radius:8px;margin:7px 0;max-height:300px}.v3-root textarea:focus{outline:2px solid #7ca88a55;border-color:var(--v3-accent)}.v3-root label{display:block;margin:10px 0;font-size:12px}.v3-root input[type=checkbox]{margin-right:8px;accent-color:var(--v3-accent)}.v3-empty{padding:36px 0;display:flex;align-items:flex-start;flex-direction:column;gap:12px}.v3-empty h2{font-size:25px;line-height:1.6}.v3-empty>p{color:var(--v3-muted)}.v3-orbit{font-size:40px;color:#78a386;line-height:1.4;margin-bottom:22px}.v3-task-heading{display:flex;gap:8px;align-items:center;margin-bottom:24px}.v3-task-heading strong{flex:1;font-size:12px}.v3-status-dot{height:6px;width:6px;border-radius:50%;background:#78a386;flex-shrink:0}.v3-section-title{margin:12px 0 20px}.v3-section-title span{display:block;font-size:18px}.v3-question{padding:18px 0;border-bottom:1px solid var(--v3-line)}.v3-options{display:flex;flex-wrap:wrap;gap:7px;margin-top:14px}.v3-options button{font-size:12px}.v3-turn{border-left:2px solid var(--v3-line);padding:0 12px;margin:12px 0}.v3-card{border:1px solid var(--v3-line);border-radius:12px;padding:16px;margin:16px 0}.v3-issue{border-left:3px solid #b39057}.v3-warning{background:rgba(191,158,86,.12);border-radius:8px;padding:10px 12px;font-size:12px}.v3-warning button{margin:4px}.v3-details{border-top:1px solid var(--v3-line);padding:14px 0;margin-top:12px}.v3-root summary{cursor:pointer;font-size:12px}.v3-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}.v3-evidence{font-size:11px;margin:8px 0;color:var(--v3-muted)}.v3-evidence p{max-height:180px;overflow:auto;white-space:pre-wrap}.v3-pre{white-space:pre-wrap}.v3-work-status{padding:10px 0 18px}.v3-calm{padding:26px 12px;background:var(--v3-soft);border-radius:10px;text-align:center;margin:16px 0}.v3-calm>span{font-size:24px;color:var(--v3-accent)}.v3-composer{padding:12px 18px 18px;border-top:1px solid var(--v3-line)}.v3-composer label{margin:0;font-size:11px;color:var(--v3-muted)}.v3-composer-bottom{display:flex;justify-content:space-between;align-items:center;gap:8px}.v3-recap-step{display:flex;gap:12px;padding:14px 0;border-bottom:1px solid var(--v3-line)}.v3-recap-step>span{font-size:11px;color:var(--v3-accent)}.v3-recap-step>div{min-width:0;flex:1}.v3-root blockquote{margin:10px 0;padding:8px 12px;border-left:2px solid #78a386;background:var(--v3-soft);max-height:130px;overflow:auto;white-space:pre-wrap}.v3-popover{position:fixed;z-index:2147483001;right:24px;bottom:24px;width:min(420px,calc(100vw - 32px));max-height:80vh;overflow:auto;background:var(--dsw-alias-background-primary,#fff);border:1px solid var(--v3-line);box-shadow:0 16px 70px #0003;border-radius:14px;padding:18px}.v3-popover header{display:flex;justify-content:space-between;align-items:center}.v3-side-answers>div{padding:10px 0;border-top:1px solid var(--v3-line)}.v3-history{display:flex;flex-direction:column;gap:6px;margin:12px 0}@media(prefers-color-scheme:dark){.v3-root{--v3-ink:var(--dsw-alias-label-primary,#e5e9e3);--v3-muted:#a2aea3;--v3-accent:#9fc5a7}.v3-popover{background:var(--dsw-alias-background-primary,#202722)}}
`;
