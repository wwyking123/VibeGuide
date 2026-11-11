import { useEffect, useRef, useState } from 'react';
import type { Explanation, GuideSnapshot, HandoffSource, InputRequest, InputResult } from '../guide/contracts.js';
import { handoffKey } from './analysis-card.js';
import { guideCall, GuideCallError } from './rpc.js';
import { readOutbox, saveOutbox, clearOutbox } from './outbox.js';
import { ProjectPanels } from './project-panels.js';
import type { GuideTab } from './project-panels.js';
import type { Focus } from '../guide/project-types.js';

export const inject = ['slots', 'sidebarRightTabs', 'sidebarRight', 'connection'];
const TAB = 'vibeguide';
type Rpc = <T>(method: string, request: unknown, signal: AbortSignal) => Promise<T>;

function GuideIcon() {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 5c3-1 5-1 8 1 3-2 5-2 8-1v14c-3-1-5-1-8 1-3-2-5-2-8-1V5Zm8 1v14" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/></svg>;
}

function RefreshIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/></svg>;
}

/** One line of what is true now: a coloured dot, the most important fact, then the rest in grey. */
function Status({ progress }: { progress: NonNullable<GuideSnapshot['progress']> }) {
  const active = ['reading', 'editing', 'checking', 'working'].includes(progress.activity);
  const activity = { reading: '正在查看项目', editing: '正在修改', checking: '正在检查', working: 'AI 正在处理', waiting: '等你在主对话选择', idle: 'AI 已停下', unknown: '状态待确认' }[progress.activity];
  const check = progress.latestCheck && { pending: '', succeeded: '上次检查通过', failed: '上次检查没通过', unknown: '上次检查结果未知' }[progress.latestCheck.outcome];
  const headline = active || progress.activity === 'waiting' || !check ? activity : check;
  const tone = active || progress.activity === 'waiting' ? 'active' : progress.latestCheck?.outcome === 'failed' ? 'warn' : progress.latestCheck?.outcome === 'succeeded' ? 'ok' : 'idle';
  const rest = [headline === activity ? check : activity, progress.latestCheck?.applicability === 'changed' ? '检查之后又改过' : '', progress.changedFiles ? `改了 ${progress.changedFiles} 个文件` : ''].filter(Boolean);
  return <div className="vg-status" aria-label="当前进展">
    <div className="vg-status-line"><span className={`vg-dot vg-dot-${tone}`}/><h3>{headline}</h3></div>
    {!!rest.length && <p className="vg-sub">{rest.join(' · ')}</p>}
    {progress.notice && <p className="vg-notice">{progress.notice}</p>}
  </div>;
}

function GearIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.6"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg>;
}

export function GuidePanel({ sessionId, rpc }: { sessionId: string; rpc: Rpc }) {
  const [tab, setTab] = useState<GuideTab>('progress');
  const [sending, setSending] = useState<string>();
  const [productName, setProductName] = useState<string>();
  const [focus, setFocus] = useState<Focus>();
  const focusIdentity = useRef<string>();
  focusIdentity.current = focus ? JSON.stringify(focus.ref) : undefined;
  const [snapshot, setSnapshot] = useState<GuideSnapshot>();
  const [error, setError] = useState('');
  const [readError, setReadError] = useState('');
  const [question, setQuestion] = useState('');
  const [answers, setAnswers] = useState<Explanation[]>([]);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [outbox, setOutbox] = useState<InputRequest>();
  const outboxScope = useRef<string>();
  const generation = useRef(0);
  const explanation = useRef<AbortController>();
  const read = useRef<AbortController>();
  const active = useRef(true);
  const asking = useRef(false);
  const project = useRef<string>();
  const panel = useRef<HTMLElement>(null);

  async function refresh(manual = false) {
    if (!active.current) return;
    if (read.current) {
      if (!manual) return;
      read.current.abort(); read.current = undefined;
    }
    const controller = new AbortController();
    read.current = controller;
    const epoch = generation.current;
    if (manual) setRefreshing(true);
    try {
      const next = await rpc<GuideSnapshot>('getSnapshot', { sessionId }, AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]));
      if (!controller.signal.aborted && active.current && epoch === generation.current && read.current === controller) {
        if (project.current && project.current !== next.scope.projectId) {
          explanation.current?.abort(); setQuestion(''); setFocus(undefined); setTab('progress'); setProductName(undefined);
        }
        project.current = next.scope.projectId;
        setSnapshot(next); setReadError('');
        try {
          const saved = readOutbox(window.localStorage, next.scope);
          const recorded = saved && next.inputs?.find(row => row.id === saved.clientRequestId
            && row.statement === saved.statement && row.basis === saved.basis && row.replyTo === saved.replyTo && JSON.stringify(row.context ?? null) === JSON.stringify(saved.context ?? null) && JSON.stringify(row.background ?? null) === JSON.stringify(saved.background ?? null));
          if (saved && recorded) { clearOutbox(window.localStorage, saved); setOutbox(undefined); setQuestion(current => current === saved.statement ? '' : current); }
          else setOutbox(saved);
          if (outboxScope.current !== next.scope.projectId) {
            setQuestion(saved?.statement ?? ''); outboxScope.current = next.scope.projectId;
          }
        } catch (e) { setError(e instanceof Error ? e.message : '暂时无法读取提交记录。'); }
        setAnswers(previous => [...new Map([...(next.explanations ?? []), ...previous]
          .filter(answer => answer.scope.projectId === next.scope.projectId && answer.scope.sessionId === sessionId && !next.excludedExplanationIds?.includes(answer.id))
          .map(answer => [answer.id, answer.basis === next.basis && !next.explanations?.some(row => row.id === answer.id && row.state === 'historical') ? answer : { ...answer, state: 'historical' as const }] as const)).values()]);
      }
    } catch (e) {
      if (!controller.signal.aborted && active.current && epoch === generation.current) {
        setSnapshot(undefined); setReadError(e instanceof Error ? e.message : '暂时无法读取进展，请稍后刷新。');
      }
    } finally {
      if (read.current === controller) {
        read.current = undefined;
        if (active.current && epoch === generation.current) setRefreshing(false);
      }
    }
  }

  useEffect(() => {
    active.current = true; generation.current++;
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible' && panel.current?.checkVisibility({ checkVisibilityCSS: true })) void refresh();
    }, 5000);
    return () => {
      active.current = false; generation.current++;
      read.current?.abort(); explanation.current?.abort(); window.clearInterval(timer);
    };
  }, [sessionId]);

  async function ask(value: string, choice?: GuideSnapshot['choices'][number]) {
    if (!snapshot || asking.current || !value.trim()) return;
    asking.current = true; setBusy(true); setError('');
    const controller = new AbortController(); explanation.current = controller;
    const epoch = generation.current;
    try {
      const answer = await rpc<Explanation>('ask', {
        sessionId, clientRequestId: crypto.randomUUID(), question: value.trim(), basis: snapshot.basis,
        ...(choice ? { choiceId: choice.id, choiceVersion: choice.version } : {}),
      }, controller.signal);
      if (!controller.signal.aborted && active.current && epoch === generation.current && answer.scope.projectId === project.current) {
        setAnswers(previous => [...previous.filter(item => item.id !== answer.id), answer]); setQuestion('');
      }
    } catch (e) {
      if (!controller.signal.aborted && active.current && epoch === generation.current) {
        setError(e instanceof Error ? e.message : '这次讲解没有完成，可以稍后再试。');
      }
    } finally {
      if (explanation.current === controller) explanation.current = undefined;
      asking.current = false;
      if (active.current && epoch === generation.current) setBusy(false);
    }
  }

  async function submit() {
    if (!snapshot || asking.current || (!question.trim() && !outbox)) return;
    const request: InputRequest = outbox ?? { sessionId, projectId: snapshot.scope.projectId,
      clientRequestId: crypto.randomUUID(), statement: question, basis: snapshot.basis, ...(focus ? { context: focus.ref } : {}) };
    try { saveOutbox(window.localStorage, request); }
    catch (e) { setError(e instanceof Error ? e.message : '提交标识未能保存，这次尚未发送。'); return; }
    setOutbox(request); asking.current = true; setBusy(true); setSubmitting(true); setError('');
    const controller = new AbortController(); explanation.current = controller; const epoch = generation.current;
    try {
      const result = await rpc<InputResult>('submit', request, AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]));
      clearOutbox(window.localStorage, request);
      if (!controller.signal.aborted && active.current && generation.current === epoch && project.current === request.projectId) {
        setOutbox(undefined); setQuestion('');
        if (focusIdentity.current === (request.context ? JSON.stringify(request.context) : undefined)) { setFocus(undefined); setTab('progress'); }
        setSnapshot(current => current && ({ ...current,
          inputs: [...(current.inputs ?? []).filter(row => row.id !== result.input.id), result.input] }));
        if (result.explanation) setAnswers(previous => [...previous.filter(row => row.id !== result.explanation!.id), result.explanation!]);
        void refresh(true);
      }
    } catch (e) {
      if (!controller.signal.aborted && active.current && generation.current === epoch && project.current === request.projectId) {
        if (e instanceof GuideCallError && ['invalid_input', 'context_changed', 'basis_changed'].some(code => e.code === `vibeguide/${code}`)) {
          clearOutbox(window.localStorage, request); setOutbox(undefined); setQuestion(request.statement); setFocus(undefined);
          setError(`${e.message} 原话已放回输入框，请核对后再提交。`);
        } else {
          setError(`${e instanceof Error ? e.message : '提交响应未收到。'} 原话和提交标识已保留，重试会核对同一条记录。`);
          void refresh();
        }
      }
    } finally {
      if (explanation.current === controller) explanation.current = undefined;
      asking.current = false;
      if (active.current && generation.current === epoch) { setBusy(false); setSubmitting(false); }
    }
  }

  /** The click is the authorization; the request survives closing the sidebar once admitted. */
  async function handoff(source: HandoffSource) {
    if (!snapshot || sending) return;
    const projectId = snapshot.scope.projectId;
    setSending(handoffKey(source)); setError('');
    try {
      const result = await rpc<InputResult>('handoff', { sessionId, projectId, clientRequestId: crypto.randomUUID(), source }, AbortSignal.timeout(90000));
      if (active.current && project.current === projectId) setSnapshot(current => current && ({ ...current,
        inputs: [...(current.inputs ?? []).filter(row => row.id !== result.input.id), result.input],
        deliveries: result.delivery ? [...(current.deliveries ?? []).filter(row => row.id !== result.delivery!.id), result.delivery] : current.deliveries }));
      void refresh(true);
    } catch (e) {
      if (active.current) { setError(e instanceof Error ? e.message : '这次没有发送，可以再点一次。'); void refresh(); }
    } finally { if (active.current) setSending(undefined); }
  }

  return <section ref={panel} className="vg-panel" aria-label="VibeGuide 理解助手" data-testid="vibeguide-panel">
    <style>{styles}</style>
    <div className="vg-content">
    <div className="vg-top"><strong title={snapshot ? `项目文件夹：${snapshot.projectName}` : undefined}>{productName ?? snapshot?.projectName ?? '当前项目'}</strong><div className="vg-tools">
      <button className="vg-icon" aria-label="刷新进展" title="刷新进展" onClick={() => void refresh(true)} disabled={refreshing}><RefreshIcon/></button>
      {snapshot && <button className="vg-icon" aria-label="设置" title="设置" aria-pressed={tab === 'settings'} onClick={() => setTab(tab === 'settings' ? 'progress' : 'settings')}><GearIcon/></button>}</div></div>
    {snapshot && <nav className="vg-tabs" aria-label="侧栏内容">{(['progress', 'structure'] as const).map(item => <button key={item} aria-pressed={tab === item} onClick={() => setTab(item)}>{{ progress: '进展', structure: '项目结构' }[item]}</button>)}{tab === 'settings' && <span className="vg-tab-note">设置</span>}</nav>}
    {readError && <p role="alert" className="vg-notice">{readError}</p>}
    {error && <p role="alert" className="vg-notice">{error}</p>}
    {!snapshot && !error && !readError && <p role="status">正在读取当前会话…</p>}
    {snapshot && <>
      {tab === 'settings' && snapshot.untestedHost && <p className="vg-sub">Harness {snapshot.untestedHost} 还没和 VibeGuide 一起测试过。如果侧栏出错，请更新 VibeGuide；主对话不受影响。</p>}
      <div hidden={tab !== 'progress'}>
      {snapshot.progress && <Status progress={snapshot.progress}/>}
      {!snapshot.observations.length && <p className="vg-sub">先在主对话说说你想做什么，之后可以在这里问它的影响。</p>}
      {snapshot.choices.map(choice => <article className="vg-card vg-choice" key={choice.id}>
        <small>主对话正在等你选择</small><h3>{choice.question}</h3>
        <ul>{choice.options.map(option => <li key={option.id}><strong>{option.label}</strong>{option.description && <span>：{option.description}</span>}</li>)}</ul>
        <button disabled={busy} onClick={() => void ask('请解释这道题各个选项对使用体验的影响，并说明取舍，不要替我选择。', choice)}>帮我看懂这些选项</button>
        <p className="vg-muted">选好后，请回左侧主对话的原问题作答。</p>
      </article>)}
      {snapshot.inputs?.filter(input => input.kind === 'redirect' || input.state === 'failed' && (input.kind === 'explain' || !!input.handoff)).slice(-3).map(input => <article key={input.id} className="vg-receipt">
        <div className="vg-receipt-state">{input.statement}</div>
        <p className="vg-sub">{input.message ?? '这次没有完成。'}</p>
      </article>)}
      {snapshot.deliveries?.filter((delivery, i, rows) => delivery.state !== 'accepted' || rows.slice(i + 1).every(row => row.state !== 'accepted')).map(delivery => <article key={delivery.id} className="vg-receipt" aria-label="修改转交回执">
        <div className={`vg-receipt-state vg-receipt-${delivery.state}`}>{{ pending: '准备发送', dispatching: '正在发送', queued: '已发到主对话，排队中', accepted: '已发到主对话', unknown: '发送结果待核对', failed: '没有发送成功' }[delivery.state]}</div>
        <p className="vg-text">{delivery.userStatement}</p>
        {delivery.clarificationStatements.map((statement, i) => <p className="vg-text" key={i}>补充 {i + 1}：{statement}</p>)}
        {!!delivery.background?.length && <details className="vg-attached"><summary>同时带上了 {delivery.background.length} 条之前的约定</summary>{delivery.background.map(row => <p className="vg-text" key={row.id}>{row.text}</p>)}</details>}
        {delivery.notice && <p className="vg-notice">{delivery.notice}</p>}
      </article>)}
      </div>
      <ProjectPanels key={snapshot.scope.projectId} answers={answers} tab={tab} snapshot={snapshot} rpc={rpc} onFocus={value => { setFocus(value); panel.current?.querySelector<HTMLTextAreaElement>('.vg-composer textarea')?.focus(); }} onChanged={() => void refresh(true)} onName={setProductName} handoff={{ send: source => void handoff(source), sending, ready: snapshot.model.status === 'ready',
        sent: new Set(snapshot.inputs?.filter(row => row.handoff && row.state !== 'failed').map(row => handoffKey(row.handoff!))) }} onQuestion={value => { setQuestion(value); panel.current?.querySelector<HTMLTextAreaElement>('.vg-composer textarea')?.focus(); }}/>
    </>}
    </div>
    {snapshot && <footer className="vg-composer">
      <form onSubmit={event => { event.preventDefault(); void submit(); }}>
        {focus && <div className="vg-notice">正在追问：{focus.label} <button type="button" onClick={() => setFocus(undefined)} disabled={!!outbox}>取消关联</button></div>}
        {snapshot.model.status === 'not_configured' && <p className="vg-notice">主对话尚未选择模型，选择后即可请求 AI 讲解。</p>}
        {outbox && !submitting && <p className="vg-notice">上次提交的响应尚待核对。点“核对并重试”会使用同一个提交标识。</p>}
        <div className="vg-input"><textarea id={`vg-question-${sessionId}`} aria-label="提问" className={(outbox?.statement ?? question) ? 'vg-filled' : ''} value={outbox?.statement ?? question} disabled={!!outbox || submitting} onChange={event => setQuestion(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} maxLength={4000} rows={1} placeholder="想弄明白什么？要修改请在主对话说"/>
        {busy ? <button type="button" onClick={() => explanation.current?.abort()}>停止讲解</button>
          : <button className="vg-primary" disabled={busy || (!question.trim() && !outbox)}>{submitting ? '提交中…' : outbox ? '核对并重试' : '发送'}</button>}</div>
        {busy && <p role="status" className="vg-muted">正在讲解你的问题…</p>}
      </form>
    </footer>}
  </section>;
}

export function apply(ctx: any) {
  const rpc: Rpc = (method, request, signal) => guideCall(ctx.connection, method, request, signal);
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: TAB, kind: TAB, priority: 'extension', title: () => 'VibeGuide',
    guide: [{ id: TAB, order: 15, title: () => 'VibeGuide', description: () => '看懂改动，理解选择的影响', icon: GuideIcon }],
  }));
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: TAB,
  }, ({ sessionId }: { sessionId: string }) => <GuidePanel key={sessionId} sessionId={sessionId} rpc={rpc}/>)));
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title', key: TAB,
  }, () => <span>VibeGuide</span>)));
  ctx.effect(() => ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities', id: TAB, order: 10,
  }, () => <button type="button" title="打开 VibeGuide 理解助手" onClick={() => {
    if (ctx.sidebarRight.mounted.getSnapshot()) ctx.sidebarRight.openTab(TAB);
  }} style={{ border: '1px solid #71857c55', borderRadius: 8, padding: '4px 10px', fontSize: 12 }}>VibeGuide</button>)));
}

const styles = `
.vg-panel{--vg-text:var(--dsw-alias-label-primary,#1f1e1d);--vg-sub:#6b6a66;--vg-faint:#9a9893;--vg-line:rgba(20,20,19,.09);--vg-line-strong:rgba(20,20,19,.18);--vg-soft:rgba(20,20,19,.035);--vg-hover:rgba(20,20,19,.06);--vg-accent:#2563c9;--vg-ok:#2f8a57;--vg-warn:#b26b12;--vg-blue-bg:#e8f0fb;--vg-blue:#1d4f9c;--vg-violet-bg:#eeecfb;--vg-violet:#43389e;--vg-amber-bg:#fbf1df;--vg-amber:#7a4b0c}
@media (prefers-color-scheme:dark){.vg-panel{--vg-text:var(--dsw-alias-label-primary,#ecebe7);--vg-sub:#a9a7a0;--vg-faint:#7d7b75;--vg-line:rgba(255,255,255,.1);--vg-line-strong:rgba(255,255,255,.2);--vg-soft:rgba(255,255,255,.05);--vg-hover:rgba(255,255,255,.08);--vg-accent:#7aa7ef;--vg-ok:#6cc38f;--vg-warn:#e0a54f;--vg-blue-bg:#1d2f4a;--vg-blue:#b5cdf2;--vg-violet-bg:#2a2650;--vg-violet:#cbc6f4;--vg-amber-bg:#3a2a10;--vg-amber:#f0c98a}}
.vg-panel{font:13px/1.6 system-ui,-apple-system,"PingFang SC",sans-serif;color:var(--vg-text);display:flex;flex-direction:column;overflow:hidden;height:100%;min-height:0;box-sizing:border-box;min-width:0}
.vg-panel *{box-sizing:border-box}.vg-content{flex:1;min-height:0;overflow:auto;padding:16px 16px 20px;overflow-wrap:anywhere}
.vg-panel h3{font-size:13px;font-weight:600;margin:0}.vg-panel p{margin:6px 0}.vg-panel ul{padding-left:18px;margin:6px 0}.vg-panel li{margin:4px 0}
.vg-top,.vg-row{display:flex;align-items:center;justify-content:space-between;gap:10px}.vg-top strong{font-size:14px;font-weight:600}.vg-tools{display:flex;gap:2px}
.vg-panel button{cursor:pointer;border:1px solid var(--vg-line-strong);border-radius:7px;background:transparent;color:inherit;font:inherit;font-size:12px;padding:4px 10px}.vg-panel button:hover{background:var(--vg-hover)}.vg-panel button:disabled{opacity:.45;cursor:default}
.vg-panel .vg-icon{border:0;padding:5px;display:flex;color:var(--vg-sub);border-radius:6px}.vg-panel .vg-icon[aria-pressed=true]{color:var(--vg-text);background:var(--vg-hover)}
.vg-panel .vg-link{border:0;padding:0;color:var(--vg-accent);background:none;font-size:12px}.vg-panel .vg-link:hover{background:none;text-decoration:underline}
.vg-panel .vg-primary{background:var(--vg-text);color:var(--dsw-alias-background-primary,#fff);border-color:var(--vg-text)}.vg-panel .vg-primary:hover{background:var(--vg-text);opacity:.88}
.vg-tabs{display:flex;gap:18px;border-bottom:1px solid var(--vg-line);margin:12px 0 14px;align-items:flex-end}.vg-panel .vg-tabs button{border:0;border-radius:0;padding:0 0 8px;font-size:13px;color:var(--vg-sub);margin-bottom:-1px;border-bottom:2px solid transparent}.vg-panel .vg-tabs button:hover{background:none;color:var(--vg-text)}.vg-panel .vg-tabs button[aria-pressed=true]{color:var(--vg-text);font-weight:600;border-bottom-color:var(--vg-text)}.vg-tab-note{margin-left:auto;padding-bottom:8px;font-size:12px;color:var(--vg-faint)}
.vg-status{margin:0 0 16px}.vg-status-line{display:flex;align-items:center;gap:8px}.vg-status h3{font-size:15px}.vg-status .vg-sub{margin:2px 0 0 16px}
.vg-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;background:var(--vg-faint)}.vg-dot-ok{background:var(--vg-ok)}.vg-dot-warn{background:var(--vg-warn)}.vg-dot-active{background:var(--vg-accent)}
.vg-sub,.vg-muted{color:var(--vg-sub);font-size:12px}.vg-label{font-size:12px;color:var(--vg-faint);margin:16px 0 4px}
.vg-list{border-top:1px solid var(--vg-line)}.vg-item{padding:10px 0;border-bottom:1px solid var(--vg-line)}.vg-item .vg-row{align-items:flex-start}.vg-item .vg-sub{margin:4px 0 0}.vg-item .vg-link{margin-top:6px}
.vg-panel summary{cursor:pointer;list-style:none;font-weight:600}.vg-panel summary::-webkit-details-marker{display:none}.vg-answer summary{display:flex;justify-content:space-between;gap:8px}.vg-answer summary::after{content:"⌄";color:var(--vg-faint);font-weight:400}.vg-answer[open] summary::after{content:"⌃"}.vg-answer:not([open]) summary{font-weight:400;color:var(--vg-sub)}
.vg-card{padding:12px 14px;border-radius:10px;margin:0 0 12px;background:var(--vg-soft)}.vg-choice{border-left:3px solid var(--vg-accent);border-radius:0 10px 10px 0}
.vg-suggestion{background:var(--vg-soft);border-radius:8px;padding:8px 10px;margin:8px 0}.vg-suggestion p{margin:0 0 6px}
.vg-receipt{padding:2px 0 10px;margin:0 0 12px;border-bottom:1px solid var(--vg-line)}.vg-receipt-state{font-size:12px;color:var(--vg-ok);font-weight:600}.vg-receipt-unknown,.vg-receipt-pending,.vg-receipt-dispatching,.vg-receipt-queued{color:var(--vg-accent)}.vg-receipt-failed{color:var(--vg-warn)}.vg-receipt summary{font-weight:400;color:var(--vg-sub);font-size:12px}
.vg-badge{flex-shrink:0;font-size:11px;padding:1px 8px;border-radius:10px;white-space:nowrap;color:var(--vg-sub)}.vg-badge-try{background:var(--vg-blue-bg);color:var(--vg-blue)}.vg-badge-done{color:var(--vg-ok)}
.vg-text{white-space:pre-wrap;overflow-wrap:anywhere}.vg-notice{padding:8px 10px;border-radius:7px;background:var(--vg-amber-bg);color:var(--vg-amber);font-size:12px}.vg-md p:first-child{margin-top:6px}
.vg-summary{margin:0 0 6px}.vg-intro{padding:4px 0 8px}.vg-intro p{margin:0 0 6px}.vg-intro .vg-actions button{border-radius:14px}.vg-empty{padding:12px 0}.vg-empty button{margin-top:8px}
.vg-layers{margin:4px 0 12px}.vg-link-down{text-align:center;color:var(--vg-faint);font-size:12px;margin:4px 0 -6px}
.vg-panel .vg-part{display:flex;width:100%;justify-content:space-between;align-items:flex-start;gap:8px;text-align:left;padding:8px 10px;margin-top:6px;border:1px solid var(--vg-line);border-radius:8px;font-size:13px}
.vg-panel .vg-part[aria-pressed=true]{background:var(--vg-violet-bg);border-color:transparent;color:var(--vg-violet)}.vg-panel .vg-part[aria-pressed=true] .vg-part-sub{color:var(--vg-violet)}.vg-panel .vg-part-goal{border-color:var(--vg-blue);background:var(--vg-blue-bg)}
.vg-part-missing{border-style:dashed !important;color:var(--vg-sub);cursor:default}.vg-part-main{display:flex;flex-direction:column;min-width:0}.vg-part-title{font-weight:600}.vg-part-sub{font-size:12px;color:var(--vg-sub)}.vg-changed{color:var(--vg-warn);font-weight:400;font-size:12px}
.vg-tag{flex-shrink:0;font-size:11px;white-space:nowrap;color:var(--vg-faint)}.vg-tag-ok{color:var(--vg-ok)}.vg-tag-warn{color:var(--vg-warn)}.vg-legend{font-size:11px;color:var(--vg-faint);margin-top:10px}.vg-dev{margin-top:16px}.vg-dev .vg-part{opacity:.85}
.vg-detail{background:var(--vg-soft);border-radius:8px;padding:8px 10px;margin:4px 0 2px}.vg-more summary,.vg-card details summary{font-weight:400;color:var(--vg-sub);font-size:12px}
.vg-actions{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0}.vg-attached{margin:6px 0}
.vg-panel fieldset{border:1px solid var(--vg-line);border-radius:8px;margin:10px 0;min-width:0}.vg-panel label{display:block;margin:8px 0;overflow-wrap:anywhere;font-size:12px;color:var(--vg-sub)}.vg-panel input[type=checkbox]{display:inline-block;width:auto;margin-right:6px}
.vg-panel select,.vg-panel input{display:block;width:100%;background:transparent;color:var(--vg-text);border:1px solid var(--vg-line-strong);border-radius:7px;padding:6px 8px;font:inherit;font-size:13px;margin:4px 0 0}
.vg-composer{flex-shrink:0;padding:10px 16px 14px;border-top:1px solid var(--vg-line)}.vg-input{display:flex;gap:8px;align-items:flex-end}.vg-input button{flex-shrink:0}
.vg-panel textarea{font:inherit;line-height:1.5;background:transparent;color:inherit;border:1px solid var(--vg-line-strong);border-radius:18px;padding:8px 14px;width:100%;resize:none;min-height:36px;max-height:160px;margin:0;transition:min-height .15s}.vg-panel textarea:focus{outline:none;border-color:var(--vg-accent);min-height:80px;border-radius:12px}.vg-panel textarea.vg-filled{min-height:80px;border-radius:12px}
.vg-panel .vg-composer .vg-primary{border-radius:16px;padding:6px 14px}.vg-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}
@keyframes vg-in{from{opacity:0;transform:translateY(-4px)}}@keyframes vg-fade{from{opacity:0}}@keyframes vg-breathe{from{opacity:.5}}@keyframes vg-pulse{from{box-shadow:0 0 0 0 var(--vg-accent)}70%,to{box-shadow:0 0 0 7px transparent}}
.vg-panel button{transition:background-color .15s,border-color .15s,color .15s,opacity .15s,transform .1s}.vg-panel .vg-part:active,.vg-panel .vg-primary:active{transform:scale(.985)}.vg-badge,.vg-tag{transition:background-color .2s,color .2s}
.vg-content section,.vg-intro,.vg-item{animation:vg-fade .18s ease-out}.vg-detail,.vg-suggestion,.vg-notice,.vg-panel details[open]>:not(summary){animation:vg-in .18s ease-out}
.vg-dot-active{animation:vg-pulse 1.8s ease-out infinite}.vg-panel [role=status]:not(.vg-notice){animation:vg-breathe .9s ease-in-out infinite alternate}
@media (prefers-reduced-motion:reduce){.vg-panel *{animation:none !important;transition:none !important}}
`;
