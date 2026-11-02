import { SupportPanel } from './support-panel.js';
import { useEffect, useRef, useState } from 'react';
import { WorkPanels } from './work-panels.js';
import { AnalysisCard, SendButton } from './analysis-card.js';
import type { Handoff } from './analysis-card.js';
import { Markdown } from './markdown.js';
import type { Explanation, GuideSnapshot } from '../guide/contracts.js';
import type { Focus, ProjectView } from '../guide/project-types.js';

export type GuideTab = 'progress' | 'structure' | 'settings';
type Rpc = <T>(method: string, request: unknown, signal: AbortSignal) => Promise<T>;
const date = (value: string) => new Date(value).toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export function ProjectPanels({ tab, snapshot, answers, rpc, onFocus, onChanged, onQuestion, handoff }: {
  answers: Explanation[];
  tab: GuideTab; snapshot: GuideSnapshot; rpc: Rpc; onFocus: (focus: Focus) => void; onChanged: () => void; onQuestion: (text: string) => void; handoff: Handoff;
}) {
  const [view, setView] = useState<ProjectView>();
  const [selected, setSelected] = useState<string>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [retry, setRetry] = useState<{ method: string; request: Record<string, unknown> }>();
  const loadSequence = useRef(0);
  const epoch = useRef(0), reading = useRef<AbortController>(), writing = useRef<AbortController>();
  const scope = { sessionId: snapshot.scope.sessionId, projectId: snapshot.scope.projectId };
  const modelReady = snapshot.model.status === 'ready';

  async function load(signal: AbortSignal) {
    const generation = epoch.current, sequence = ++loadSequence.current;
    const nextView = await rpc<ProjectView>('projectView', scope, signal);
    if (signal.aborted || generation !== epoch.current || sequence !== loadSequence.current) return;
    setView(nextView);
  }
  useEffect(() => {
    epoch.current++;
    return () => { epoch.current++; reading.current?.abort(); writing.current?.abort(); };
  }, []);
  useEffect(() => {
    reading.current?.abort(); const controller = new AbortController(); reading.current = controller;
    void load(AbortSignal.any([controller.signal, AbortSignal.timeout(15000)])).catch(e => {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : '暂时无法读取项目记录。');
    });
    return () => controller.abort();
  }, [snapshot.basis, snapshot.preferenceVersion, snapshot.inputs?.length, snapshot.explanations?.length, answers.length, tab]);

  async function run(method: string, fields: Record<string, unknown>, existing = false) {
    if (writing.current) return;
    const request = existing ? fields : { ...scope, ...fields, clientRequestId: crypto.randomUUID() };
    const controller = new AbortController(), generation = epoch.current;
    writing.current = controller; setBusy(method); setError(''); setRetry({ method, request });
    try {
      await rpc<unknown>(method, request, AbortSignal.any([controller.signal, AbortSignal.timeout(55000)]));
      if (controller.signal.aborted || generation !== epoch.current) return;
      setRetry(undefined);
      await load(controller.signal); onChanged();
      return true;
    } catch (e) {
      if (!controller.signal.aborted && generation === epoch.current) setError(e instanceof Error ? e.message : '暂时未收到结果，请刷新核对。');
    } finally {
      if (writing.current === controller) writing.current = undefined;
      if (generation === epoch.current) setBusy('');
    }
  }

  const overview = view?.overview, node = overview?.nodes.find(item => `${overview.id}:${item.id}` === selected);
  const focusNode = (id: string) => {
    setSelected(`${overview?.id}:${id}`);
  };
  const goal = view?.work?.analyses.filter(row => row.kind === 'goal' && !row.historical && row.overviewId === overview?.id).at(-1);
  const goalNodes = new Set(goal?.nodes.map(row => row.id));
  return <>
    {error && <div role="alert" className="vg-notice"><p>{error}</p>{retry && !busy && <button onClick={() => void run(retry.method, retry.request, true)}>重试这次操作</button>}</div>}
    {busy && <p role="status" className="vg-muted">{busy === 'overview' ? '正在整理项目概览…' : '正在保存…'}</p>}
    {tab === 'settings' && <SupportPanel scope={scope} rpc={rpc} onChanged={onChanged}/> }
    {tab === 'progress' && <ProgressAnswers answers={answers} view={view} onQuestion={onQuestion} onFocus={onFocus} handoff={handoff}/>}
    {tab === 'structure' && <section aria-label="项目结构">
      <div className="vg-row"><h3>这个项目由哪些部分组成</h3>{(!overview || overview.historical) && <button disabled={!!busy || !modelReady} onClick={() => void run('overview', {})}>{overview ? '更新概览' : '生成项目概览'}</button>}</div>
      {!overview && <p className="vg-card">还没有生成概览。点上方按钮，了解各部分承担什么、对使用有什么影响。</p>}
      {overview && <>
        <article className="vg-card"><p>{overview.summary}</p>
          {overview.historical && <p className="vg-notice">项目文件有变化，可以更新概览。</p>}
        </article>
        <small className="vg-muted">点一个部分，看它负责什么</small>
        <div className="vg-graph-scroll">
          <svg role="group" aria-label="项目职责图，关系仅为观察到的代码引用" viewBox={`0 0 400 ${Math.ceil(overview.nodes.length / 2) * 105 + 20}`} style={{ width: '100%' }}>
            {overview.edges.map((edge, index) => {
              const a = overview.nodes.findIndex(row => row.id === edge.from), b = overview.nodes.findIndex(row => row.id === edge.to);
              return <line key={index} x1={a % 2 * 200 + 100} y1={Math.floor(a / 2) * 105 + 50} x2={b % 2 * 200 + 100} y2={Math.floor(b / 2) * 105 + 50} stroke="#789185" strokeDasharray="4 4"/>;
            })}
            {overview.nodes.map((item, index) => <g key={item.id} role="button" tabIndex={0} aria-label={`${item.title}${overview.changedNodes.includes(item.id) ? '，相关文件有变化' : ''}`} aria-pressed={`${overview.id}:${item.id}` === selected}
              transform={`translate(${index % 2 * 200 + 8},${Math.floor(index / 2) * 105 + 12})`} onClick={() => focusNode(item.id)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); focusNode(item.id); } }}>
              <rect width="184" height="76" rx="12" fill={goalNodes.has(item.id) ? '#dce9fa' : `${overview.id}:${item.id}` === selected ? '#d6e8dc' : '#edf2ee'} stroke={overview.changedNodes.includes(item.id) ? '#bc8a3d' : '#789185'} strokeWidth={`${overview.id}:${item.id}` === selected ? 2 : 1}/>
              <text x="12" y={overview.changedNodes.includes(item.id) ? 32 : 43} fill="#263b35" fontSize="13">{item.title.length > 12 ? item.title.slice(0, 11) + '…' : item.title}</text>
              {overview.changedNodes.includes(item.id) && <text x="12" y="55" fill="#a0742f" fontSize="10">有变化</text>}
            </g>)}
          </svg>
        </div>
        {goal && <p className="vg-muted">蓝色是和“{goal.question}”可能相关的部分。</p>}
        {node && <article className="vg-card"><h3>{node.title}</h3><p>{node.purpose}</p><p><strong>对使用的影响：</strong>{node.impact}</p>
          <button onClick={() => onFocus({ ref: { kind: 'node', id: `${overview.id}:${node.id}`, version: overview.id }, label: node.title })}>追问这一部分</button>
        </article>}
        {!!overview.unknowns.length && <article className="vg-card"><h3>还不能确认</h3><ul>{overview.unknowns.map((item, index) => <li key={index}>{item}</li>)}</ul></article>}
      </>}
    </section>}
    <WorkPanels view={view} sessionId={snapshot.scope.sessionId} tab={tab} busy={busy} modelReady={modelReady} run={run} onFocus={onFocus} handoff={handoff}/>
  </>;
}

/** Keep the latest trouble explanation, the failures it is about and its actions in one card, above requirements. */
export function ProgressAnswers({ answers, view, onQuestion, onFocus, handoff }: {
  answers: Explanation[]; view?: ProjectView; onQuestion: (text: string) => void; onFocus: (focus: Focus) => void; handoff: Handoff;
}) {
  const troubles = view?.work?.analyses.filter(row => row.kind === 'trouble') ?? [];
  const latest = troubles.at(-1), merged = new Set(troubles.map(row => row.id)), trouble = view?.work?.trouble;
  const stuck = !!trouble && (!!trouble.failures.length || !!trouble.feedback.length);
  const facts = stuck && <>
    {trouble.failures.map(row => <p key={row.id}>{row.count > 1 ? `同一检查连续失败 ${row.count} 次` : '有一项检查没通过'}{row.current ? '' : '（旧版本，需要重新检查）'}</p>)}
    {trouble.feedback.map(row => <p key={row.id}>你试用时：{row.action} — 不符合预期{row.historical ? '（旧版本）' : ''}{row.note && `；${row.note}`}</p>)}
    <details><summary>最近尝试的结果</summary><ul>{trouble.attempts.map(row => <li key={row.id}>{date(row.at)} · {row.changed ? `修改了 ${row.changed} 个文件` : '运行操作或检查'}：{row.result === 'failed' ? '未成功' : row.result === 'succeeded' ? '正常结束' : '结果未知'}</li>)}</ul></details>
  </>;
  const shown = answers.filter(answer => !answer.analysisId || !merged.has(answer.analysisId));
  const newest = shown.filter(answer => answer.state !== 'historical').at(-1);
  const ask = <button onClick={() => onQuestion('现在卡住在哪里？请结合实际尝试和失败记录，解释使用影响，并给出下一步的选择。')}>{latest ? '重新梳理卡住的情况' : '梳理这次卡住的情况'}</button>;
  return <>
    {latest && !latest.historical ? <section aria-label="卡住时的下一步"><AnalysisCard row={latest} onFocus={onFocus} handoff={handoff}>{facts}</AnalysisCard></section>
      : stuck && <section className="vg-card" aria-label="卡住时的下一步"><h3>还没有顺利通过</h3>{facts}{ask}</section>}
    {shown.map(answer => <details key={answer.id} className="vg-card vg-answer" open={answer.id === newest?.id}>
      <summary>{answer.contextLabel && <small className="vg-muted">关于 {answer.contextLabel}<br/></small>}{answer.choiceId ? '这道选择题的各个选项' : answer.question}{answer.state === 'historical' && <small className="vg-muted"> · 之前的</small>}</summary>
      {answer.state === 'historical' && <p className="vg-notice">这是之前的讲解，情况可能已经变了。</p>}
      <Markdown text={answer.text}/>
      {answer.suggestion && answer.state !== 'historical' && <div className="vg-suggestion"><p><strong>可以这样改：</strong>{answer.suggestion}</p><SendButton source={{ kind: 'explanation', id: answer.id }} handoff={handoff}/></div>}
    </details>)}
  </>;
}
