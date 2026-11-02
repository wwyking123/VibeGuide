import { useEffect, useRef, useState } from 'react';
import type { Explanation, GuideSnapshot, InputRequest, InputResult } from '../guide/contracts.js';
import { guideCall, GuideCallError } from './rpc.js';
import { readOutbox, saveOutbox, clearOutbox } from './outbox.js';
import { ProjectPanels } from './project-panels.js';
import type { GuideTab } from './project-panels.js';
import type { RequirementRef } from '../guide/work-types.js';
import type { Focus } from '../guide/project-types.js';

export const inject = ['slots', 'sidebarRightTabs', 'sidebarRight', 'connection'];
const TAB = 'vibeguide';
type Rpc = <T>(method: string, request: unknown, signal: AbortSignal) => Promise<T>;

function GuideIcon() {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 5c3-1 5-1 8 1 3-2 5-2 8-1v14c-3-1-5-1-8 1-3-2-5-2-8-1V5Zm8 1v14" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/></svg>;
}

function GearIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.6"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg>;
}

export function GuidePanel({ sessionId, rpc }: { sessionId: string; rpc: Rpc }) {
  const [tab, setTab] = useState<GuideTab>('progress');
  const [background, setBackground] = useState<RequirementRef[]>();
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
  const submittedId = useRef<string>();
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
          explanation.current?.abort(); setQuestion(''); setFocus(undefined); setBackground(undefined); setTab('progress');
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
    const pendingClarification = snapshot.inputs?.slice().reverse().find(input => input.kind === 'clarify' && !input.resolvedBy);
    const request: InputRequest = outbox ?? { sessionId, projectId: snapshot.scope.projectId,
      clientRequestId: crypto.randomUUID(), statement: question, basis: snapshot.basis,
      ...(pendingClarification ? { replyTo: pendingClarification.id } : {}),
      ...(focus ? { context: focus.ref } : {}), ...(background !== undefined ? { background } : {}) };
    try { saveOutbox(window.localStorage, request); }
    catch (e) { setError(e instanceof Error ? e.message : '提交标识未能保存，这次尚未发送。'); return; }
    setOutbox(request); asking.current = true; setBusy(true); setSubmitting(true); setError('');
    submittedId.current = request.clientRequestId;
    const controller = new AbortController(); explanation.current = controller; const epoch = generation.current;
    try {
      const result = await rpc<InputResult>('submit', request, AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]));
      clearOutbox(window.localStorage, request);
      if (!controller.signal.aborted && active.current && generation.current === epoch && project.current === request.projectId) {
        setOutbox(undefined); setQuestion('');
        if (focusIdentity.current === (request.context ? JSON.stringify(request.context) : undefined)) { setFocus(undefined); setTab('progress'); }
        setSnapshot(current => current && ({ ...current,
          inputs: [...(current.inputs ?? []).filter(row => row.id !== result.input.id).map(row => row.id === request.replyTo ? { ...row, resolvedBy: result.input.id } : row), result.input],
          deliveries: result.delivery ? [...(current.deliveries ?? []).filter(row => row.id !== result.delivery!.id), result.delivery] : current.deliveries }));
        if (result.explanation) setAnswers(previous => [...previous.filter(row => row.id !== result.explanation!.id), result.explanation!]);
        void refresh(true);
      }
    } catch (e) {
      if (!controller.signal.aborted && active.current && generation.current === epoch && project.current === request.projectId) {
        if (e instanceof GuideCallError && ['invalid_input', 'clarification_changed', 'input_too_long', 'context_changed', 'basis_changed', 'requirement_changed', 'history_incomplete', 'history_too_large'].some(code => e.code === `vibeguide/${code}`)) {
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

  return <section ref={panel} className="vg-panel" aria-label="VibeGuide 理解助手" data-testid="vibeguide-panel">
    <style>{styles}</style>
    <div className="vg-content">
    <div className="vg-row"><strong>{snapshot?.projectName ?? '当前项目'}</strong><div className="vg-tools"><button onClick={() => void refresh(true)} disabled={refreshing}>{refreshing ? '读取中…' : '刷新进展'}</button>
      {snapshot && <button className="vg-gear" aria-label="设置" title="设置" aria-pressed={tab === 'settings'} onClick={() => setTab(tab === 'settings' ? 'progress' : 'settings')}><GearIcon/></button>}</div></div>
    {snapshot && <nav className="vg-tabs" aria-label="侧栏内容">{(['progress', 'structure'] as const).map(item => <button key={item} aria-pressed={tab === item} onClick={() => setTab(item)}>{{ progress: '当前进展', structure: '项目结构' }[item]}</button>)}</nav>}
    {readError && <p role="alert" className="vg-notice">{readError}</p>}
    {error && <p role="alert" className="vg-notice">{error}</p>}
    {!snapshot && !error && !readError && <p role="status">正在读取当前会话…</p>}
    {snapshot && <>
      <div hidden={tab !== 'progress'}>
      {snapshot.progress && <article className="vg-card vg-status" aria-label="当前进展">
        <h3>{{ reading: '正在查看项目', editing: '正在修改', checking: '正在检查', working: 'AI 正在处理',
          waiting: '等你在主对话选择', idle: 'AI 已停下', unknown: '状态待确认' }[snapshot.progress.activity]}{snapshot.progress.latestCheck
          && { pending: '', succeeded: '，上次检查通过', failed: '，上次检查没通过', unknown: '，上次检查结果未知' }[snapshot.progress.latestCheck.outcome]}{snapshot.progress.latestCheck?.applicability === 'changed' ? '（之后又改过）' : ''}</h3>
        {snapshot.progress.changedFiles > 0 && <p className="vg-muted">改了 {snapshot.progress.changedFiles} 个文件</p>}
        {snapshot.progress.notice && <p className="vg-notice">{snapshot.progress.notice}</p>}
      </article>}
      {!snapshot.observations.length && <p className="vg-card">先在主对话说说你想做什么。有了对话内容，就可以在这里追问它的影响。</p>}
      {snapshot.choices.map(choice => <article className="vg-card vg-choice" key={choice.id}>
        <small>主对话正在等你选择</small><h3>{choice.question}</h3>
        <ul>{choice.options.map(option => <li key={option.id}><strong>{option.label}</strong>{option.description && <span>：{option.description}</span>}</li>)}</ul>
        <button disabled={busy} onClick={() => void ask('请解释这道题各个选项对使用体验的影响，并说明取舍，不要替我选择。', choice)}>帮我看懂这些选项</button>
        <p className="vg-muted">选好后，请回左侧主对话的原问题作答。</p>
      </article>)}
      {snapshot.inputs?.filter(input => input.kind !== 'modify' && (input.kind !== 'explain' || input.state !== 'done')).map(input => <article key={input.id} className="vg-card">
        <h3>{input.statement}</h3>
        <p>{input.message ?? '正在回答你的问题，没有转交修改。'}</p>
        {input.kind === 'clarify' && <small className="vg-muted">{input.resolvedBy ? '已收到后续补充。' : '在下方补充即可；不继续这次要求时可以输入“取消”。'}</small>}
      </article>)}
      {snapshot.deliveries?.filter((delivery, i, rows) => delivery.state !== 'accepted' || rows.slice(i + 1).every(row => row.state !== 'accepted')).map(delivery => <article key={delivery.id} className="vg-card" aria-label="修改转交回执">
        <h3>{{ pending: '要求已保存，准备发送', dispatching: '正在发送', queued: '已排队，等待主 AI 处理', accepted: '已送达主对话', unknown: '发送结果待核对', failed: '未发送成功' }[delivery.state]}</h3>
        <p className="vg-text">{delivery.userStatement}</p>
        {delivery.clarificationStatements.map((statement, i) => <p className="vg-text" key={i}>补充 {i + 1}：{statement}</p>)}
        {!!delivery.background?.length && <div className="vg-attached"><strong>本次附带的历史约定（{delivery.background.length} 条）</strong>{delivery.background.map(row => <p className="vg-text" key={row.id}>{row.text}</p>)}</div>}
        {delivery.notice && <p className="vg-notice">{delivery.notice}</p>}
        {(delivery.state === 'accepted' || delivery.state === 'queued') && <small className="vg-muted">已交给主对话，做完后可以在下方试用。</small>}
      </article>)}
      </div>
      <ProjectPanels key={snapshot.scope.projectId} answers={answers} tab={tab} snapshot={snapshot} rpc={rpc} onFocus={value => { setFocus(value); panel.current?.querySelector<HTMLTextAreaElement>('.vg-composer textarea')?.focus(); }} onChanged={() => void refresh(true)} background={background} onBackground={setBackground} onQuestion={value => { setQuestion(value); panel.current?.querySelector<HTMLTextAreaElement>('.vg-composer textarea')?.focus(); }}/>
    </>}
    </div>
    {snapshot && <footer className="vg-composer">
      <form onSubmit={event => { event.preventDefault(); void submit(); }}>
        <label htmlFor={`vg-question-${sessionId}`} className="vg-section-label">有哪里想弄明白？</label>
        {background !== undefined && <div className="vg-notice">下次修改附带 {background.length} 条你选定的历史约定。<button type="button" disabled={!!outbox} onClick={() => setBackground(undefined)}>恢复按相关性选取</button></div>}
        {focus && <div className="vg-notice">正在追问：{focus.label} <button type="button" onClick={() => setFocus(undefined)} disabled={!!outbox}>取消关联</button><small className="vg-muted"> 关联内容只用于讲解；修改要求请写清具体对象和效果。</small></div>}
        {snapshot.model.status === 'not_configured' && <p className="vg-notice">主对话尚未选择模型，选择后即可请求 AI 讲解。</p>}
        {snapshot.inputs?.slice().reverse().find(input => input.kind === 'clarify' && !input.resolvedBy) && <p className="vg-notice">正在补充上面那次要求；原话和限制会一起保留。输入“取消”可结束这次澄清。</p>}
        {outbox && !submitting && <p className="vg-notice">上次提交的响应尚待核对。点“核对并重试”会使用同一个提交标识。</p>}
        <textarea id={`vg-question-${sessionId}`} value={outbox?.statement ?? question} disabled={!!outbox || submitting} onChange={event => setQuestion(event.target.value)} maxLength={4000} rows={3} placeholder="例如：这个方案有什么影响？或：把回答改为仅自己可见。"/>
        <div className="vg-row"><small className="vg-muted">追问只讲解；明确的修改会转交。</small>{busy && (!submitting || snapshot.inputs?.some(input => input.id === submittedId.current && input.kind === 'explain')) ? <button type="button" onClick={() => explanation.current?.abort()}>停止讲解</button>
          : <button className="vg-primary" disabled={busy || (!question.trim() && !outbox)}>{submitting ? '提交中…' : outbox ? '核对并重试' : '发送'}</button>}</div>
        {busy && <p role="status" className="vg-muted">{submitting ? '正在处理你的输入…' : '正在讲解你的问题…'}</p>}
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
.vg-panel{font:13px/1.65 system-ui,sans-serif;color:var(--dsw-alias-label-primary,#263b35);display:flex;flex-direction:column;overflow:hidden;height:100%;min-height:0;box-sizing:border-box;min-width:0}
.vg-content{flex:1;min-height:0;overflow:auto;padding:20px 16px;overflow-wrap:anywhere}.vg-composer{flex-shrink:0;padding:12px 16px 16px;border-top:1px solid #78918530}.vg-composer .vg-section-label{display:block;margin:0 0 8px}.vg-panel .vg-composer textarea{max-height:160px}
.vg-badge{flex-shrink:0;font-size:11px;padding:2px 8px;border-radius:10px;white-space:nowrap}.vg-badge-doing{background:#c6a25c22;color:#8c7040}.vg-badge-try{background:#5c8ec622;color:#3d6390}.vg-badge-done{background:#36695222;color:#366952}.vg-row h3{margin:0}.vg-tools{display:flex;gap:6px;align-items:center}.vg-panel .vg-gear{display:flex;padding:5px 7px}.vg-panel .vg-gear[aria-pressed=true]{background:#366952;color:white;border-color:#366952}.vg-tabs{display:flex;gap:4px;margin:14px 0}.vg-tabs button{flex:1}.vg-panel .vg-tabs button[aria-pressed=true]{background:#366952;color:white}.vg-graph-scroll{overflow:auto;border:1px solid #78918530;border-radius:10px;margin:12px 0}.vg-graph-scroll svg{display:block}.vg-graph-scroll g[role=button]{cursor:pointer}.vg-graph-scroll g:focus{outline:2px solid #366952}.vg-node-list,.vg-actions{display:flex;gap:7px;flex-wrap:wrap;margin:12px 0}.vg-node-list button[aria-pressed=true]{border-color:#366952;background:#8eb89c30}.vg-panel input[type=checkbox]{display:inline-block;width:auto;margin-right:8px}.vg-attached{border-left:2px solid #789185;padding-left:10px;margin:10px 0}.vg-panel fieldset{border:1px solid #78918555;border-radius:8px;margin:10px 0;min-width:0}.vg-panel fieldset label{display:block;margin:7px 0;overflow-wrap:anywhere}.vg-panel select{display:block;width:100%;max-width:100%;background:var(--background,#fff);color:#263b35;border:1px solid #78918555;border-radius:6px;padding:8px;font:inherit;margin:6px 0 12px}.vg-panel label{overflow-wrap:anywhere}.vg-panel input{display:block;width:100%;background:transparent;color:inherit;border:1px solid #78918555;border-radius:6px;padding:8px;font:inherit}.vg-panel *{box-sizing:border-box}.vg-heading,.vg-row{display:flex;align-items:center;justify-content:space-between;gap:10px}.vg-heading small{letter-spacing:.15em;color:#5d7d6f;font-size:10px}.vg-panel h2{font-size:18px;line-height:1.4;margin:3px 0}.vg-panel h3{font-size:13px;margin:5px 0 8px}.vg-muted{color:#78857e;font-size:12px}.vg-panel p{margin:10px 0}.vg-section-label{font-size:12px;font-weight:600;color:#688576;margin:23px 0 9px}.vg-card{padding:13px;border:1px solid #78918530;border-radius:10px;margin:10px 0;background:#8eb89c08}.vg-card summary{cursor:pointer;font-weight:600}.vg-excerpt{display:block;font-weight:400;font-size:12px;opacity:.8;margin-top:7px}.vg-text{white-space:pre-wrap;overflow-wrap:anywhere}.vg-choice{border-left:3px solid #6a8b78}.vg-panel ul{padding-left:20px}.vg-panel li{margin:8px 0}.vg-panel button{cursor:pointer;border:1px solid #78918555;border-radius:7px;background:transparent;color:inherit;font:inherit;font-size:12px;padding:5px 10px}.vg-panel button:hover{background:#8eb89c20}.vg-panel button:disabled{opacity:.5;cursor:default}.vg-panel .vg-primary{background:#366952;color:white;border-color:#366952}.vg-panel textarea{font:inherit;line-height:1.6;background:transparent;color:inherit;border:1px solid #78918566;border-radius:9px;padding:11px;width:100%;resize:vertical;min-height:80px;margin-bottom:7px}.vg-panel textarea:focus{outline:2px solid #6a9d83;outline-offset:2px}.vg-notice{padding:9px 11px;border-radius:7px;background:#c6a25c18;color:#8c7040;font-size:12px}.vg-answer{background:#8eb89c10}.vg-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}
`;
