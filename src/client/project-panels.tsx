import { SupportPanel } from './support-panel.js';
import { Fragment, useEffect, useRef, useState } from 'react';
import { clip, splitQuote } from '../guide/quote.js';
import { WorkPanels } from './work-panels.js';
import { AnalysisCard, SendButton } from './analysis-card.js';
import type { Handoff } from './analysis-card.js';
import { Markdown } from './markdown.js';
import type { Explanation, GuideSnapshot } from '../guide/contracts.js';
import type { Focus, Layer, ProjectView } from '../guide/project-types.js';

export type GuideTab = 'progress' | 'structure' | 'settings';
type Rpc = <T>(method: string, request: unknown, signal: AbortSignal) => Promise<T>;
const date = (value: string) => new Date(value).toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export function ProjectPanels({ tab, snapshot, answers, rpc, onFocus, onChanged, onQuestion, handoff, onName }: {
  answers: Explanation[];
  tab: GuideTab; snapshot: GuideSnapshot; rpc: Rpc; onFocus: (focus: Focus) => void; onChanged: () => void; onQuestion: (text: string) => void; handoff: Handoff;
  onName: (name: string | undefined) => void;
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

  const overview = view?.overview;
  useEffect(() => { onName(overview?.name); }, [overview?.name]);
  const quiet = !!view && !!snapshot.observations.length && !answers.length && !view.work?.trouble?.failures.length && !snapshot.choices.length;
  const focusNode = (id: string) => {
    const key = `${overview?.id}:${id}`;
    setSelected(current => current === key ? undefined : key);
  };
  const goal = view?.work?.analyses.filter(row => row.kind === 'goal' && !row.historical && row.overviewId === overview?.id).at(-1);
  const goalNodes = new Set(goal?.nodes.map(row => row.id));
  return <>
    {error && <div role="alert" className="vg-notice"><p>{error}</p>{retry && !busy && <button onClick={() => void run(retry.method, retry.request, true)}>重试这次操作</button>}</div>}
    {busy && <p role="status" className="vg-muted">{busy === 'overview' ? '正在整理项目概览…' : '正在保存…'}</p>}
    {tab === 'settings' && <SupportPanel scope={scope} rpc={rpc} onChanged={onChanged}/> }
    {tab === 'progress' && quiet && <div className="vg-intro">
      <p>在这里问看不懂的地方，比如 AI 给的方案、选项或报错。要修改请直接在主对话说。</p>
      <p className="vg-sub">“项目结构”里能看到项目分成哪几部分，各做到什么程度。</p>
      <div className="vg-actions">{['这个项目现在能做什么？', '下一步做什么比较好？'].map(text => <button key={text} onClick={() => onQuestion(text)}>{text}</button>)}</div>
    </div>}
    {tab === 'progress' && <ProgressAnswers answers={answers} view={view} onQuestion={onQuestion} onFocus={onFocus} handoff={handoff}/>}
    {tab === 'structure' && <section aria-label="项目结构">
      {!overview && <div className="vg-empty"><p>还没有生成概览。生成后能看到项目分成哪几部分、各自做到什么程度。</p>
        <button className="vg-primary" disabled={!!busy || !modelReady} onClick={() => void run('overview', {})}>生成项目概览</button></div>}
      {overview && <>
        <p className="vg-summary">{overview.summary}</p>
        {(overview.historical || !overview.nodes.some(row => row.layer)) && <p className="vg-sub">{overview.historical ? '项目文件有变化。' : '这是旧版概览，还没有分层和完成程度。'}<button className="vg-link" disabled={!!busy || !modelReady} onClick={() => void run('overview', {})}>{overview.historical ? '更新概览' : '按新方式整理'}</button></p>}
        <Layers overview={overview} selected={selected} goalNodes={goalNodes} onSelect={focusNode} onFocus={onFocus}/>
        {goal && <p className="vg-sub">蓝色是和“{goal.question}”可能相关的部分。</p>}
        {!!overview.unknowns.length && <details className="vg-more"><summary>还不能确认的地方</summary><ul>{overview.unknowns.map((item, index) => <li key={index}>{item}</li>)}</ul></details>}
      </>}
    </section>}
    <WorkPanels view={view} sessionId={snapshot.scope.sessionId} tab={tab} busy={busy} modelReady={modelReady} run={run} onFocus={onFocus} handoff={handoff}/>
  </>;
}

const LAYERS: Array<[Layer, string, string]> = [['page', '用户看到的', ''], ['logic', '背后的规则', '用到'], ['data', '数据存在哪里', '保存在'], ['external', '外部服务', '连接'], ['other', '其他部分', '']];
const DEV: Layer = 'dev';
const MATURITY = { works: ['能用', 'ok'], mock: ['模拟', 'warn'] } as const;

/** Parts grouped from what people see down to where data lives, each with an AI-inferred maturity. The selected part opens right below itself. */
function Layers({ overview, selected, goalNodes, onSelect, onFocus }: { overview: NonNullable<ProjectView['overview']>; selected?: string; goalNodes: Set<string | undefined>; onSelect: (id: string) => void; onFocus: (focus: Focus) => void }) {
  const groups = LAYERS.map(([layer, label, link]) => ({ layer, label, link,
    nodes: overview.nodes.filter(node => (node.layer ?? 'other') === layer), missing: (overview.missing ?? []).filter(row => row.layer === layer) }))
    .filter(group => group.nodes.length || group.missing.length);
  const rated = overview.nodes.some(node => node.maturity) || !!overview.missing?.length;
  const dev = overview.nodes.filter(node => node.layer === DEV);
  const part = (node: typeof overview.nodes[number]) => {
    const key = `${overview.id}:${node.id}`, changed = overview.changedNodes.includes(node.id), maturity = node.layer !== DEV && node.maturity && MATURITY[node.maturity];
    return <Fragment key={node.id}><button className={`vg-part${goalNodes.has(node.id) ? ' vg-part-goal' : ''}`} aria-pressed={key === selected} aria-expanded={key === selected} onClick={() => onSelect(node.id)}>
      <span className="vg-part-main"><span className="vg-part-title">{node.title}{changed && <span className="vg-changed"> · 刚改过</span>}</span><span className="vg-part-sub">{node.purpose}</span></span>
      {maturity && <span className={`vg-tag vg-tag-${maturity[1]}`}>{maturity[1] === 'ok' ? '●' : '◐'} {maturity[0]}</span>}
    </button>
    {key === selected && <div className="vg-detail">
      <p><span className="vg-sub">对使用的影响：</span>{node.impact}</p>
      {node.maturityReason && <p className="vg-sub">AI 推测：{node.maturityReason}</p>}
      <button className="vg-link" onClick={() => onFocus({ ref: { kind: 'node', id: key, version: overview.id }, label: node.title })}>问问这部分</button>
    </div>}</Fragment>;
  };
  return <div className="vg-layers">
    {groups.map((group, index) => <div key={group.layer}>
      {index > 0 && <div className="vg-link-down">↓{group.link && ` ${group.link}`}</div>}
      <div className="vg-label">{group.label}</div>
      {group.nodes.map(part)}
      {group.missing.map((row, i) => <div key={i} className="vg-part vg-part-missing">
        <span className="vg-part-main"><span className="vg-part-title">{row.title}</span>{row.purpose && <span className="vg-part-sub">{row.purpose}</span>}</span>
        <span className="vg-tag">○ 还没做</span>
      </div>)}
    </div>)}
    {!!dev.length && <details className="vg-more vg-dev"><summary>开发用的资料 · {dev.length} 项（文档、设计稿、测试等，用户用不到）</summary>{dev.map(part)}</details>}
    {rated && <p className="vg-legend">● 能用　◐ 模拟或示意　○ 还没做　· 由 AI 根据代码推测</p>}
  </div>;
}

/** Keep the latest trouble explanation, the failures it is about and its actions in one card, above requirements. */
/** A question asked about selected text shows the quote small and the question itself as the title. */
function quoted(question: string) {
  const parts = splitQuote(question);
  return parts ? <><small className="vg-sub">关于「{clip(parts.quote, 40)}」<br/></small>{parts.question}</> : question;
}

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
    {!!shown.length && <div className="vg-label">讲解</div>}
    <div className="vg-list">{shown.map(answer => <details key={answer.id} className="vg-item vg-answer" open={answer.id === newest?.id}>
      <summary><span>{answer.contextLabel && <small className="vg-sub">关于 {answer.contextLabel}<br/></small>}{answer.choiceId ? '这道选择题的各个选项' : quoted(answer.question)}{answer.state === 'historical' && <small className="vg-sub"> · 之前的</small>}</span></summary>
      <Markdown text={answer.text}/>
      {answer.suggestion && answer.state !== 'historical' && <div className="vg-suggestion"><p>可以这样改：{answer.suggestion}</p><SendButton source={{ kind: 'explanation', id: answer.id }} handoff={handoff}/></div>}
    </details>)}</div>
  </>;
}
