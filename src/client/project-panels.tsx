import { SupportPanel } from './support-panel.js';
import type { StructureComparison } from '../guide/structure.js';
import { useEffect, useRef, useState } from 'react';
import { WorkPanels } from './work-panels.js';
import { AnalysisCard } from './analysis-card.js';
import type { RequirementRef } from '../guide/work-types.js';
import type { Explanation, GuideSnapshot } from '../guide/contracts.js';
import type { Focus, HistoryItem, HistoryPage, ProjectView } from '../guide/project-types.js';

export type GuideTab = 'progress' | 'structure' | 'history';
type Rpc = <T>(method: string, request: unknown, signal: AbortSignal) => Promise<T>;
const date = (value: string) => new Date(value).toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export function ProjectPanels({ tab, snapshot, answers, rpc, onFocus, onChanged, background, onBackground, onQuestion }: {
  answers: Explanation[];
  tab: GuideTab; snapshot: GuideSnapshot; rpc: Rpc; onFocus: (focus: Focus) => void; onChanged: () => void; background?: RequirementRef[]; onBackground: (refs: RequirementRef[] | undefined) => void; onQuestion: (text: string) => void;
}) {
  const [view, setView] = useState<ProjectView>();
  const [history, setHistory] = useState<HistoryPage>();
  const [offset, setOffset] = useState(0);
  const [overviewId, setOverviewId] = useState('');
  const [compareFrom, setCompareFrom] = useState(''), [comparison, setComparison] = useState<StructureComparison>();
  const overviewSelection = useRef(overviewId); overviewSelection.current = overviewId;
  const [selected, setSelected] = useState<string>();
  const [zoom, setZoom] = useState(1);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [retry, setRetry] = useState<{ method: string; request: Record<string, unknown> }>();
  const [correction, setCorrection] = useState<{ item: HistoryItem; text: string }>();
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [showOldTrials, setShowOldTrials] = useState(false);
  const loadSequence = useRef(0), currentTab = useRef(tab), currentOffset = useRef(offset);
  currentTab.current = tab; currentOffset.current = offset;
  const epoch = useRef(0), reading = useRef<AbortController>(), writing = useRef<AbortController>();
  const scope = { sessionId: snapshot.scope.sessionId, projectId: snapshot.scope.projectId };
  const modelReady = snapshot.model.status === 'ready';

  async function load(signal: AbortSignal, page = currentOffset.current) {
    const generation = epoch.current, sequence = ++loadSequence.current, requestedTab = currentTab.current;
    const [nextView, nextHistory] = await Promise.all([
      rpc<ProjectView>('projectView', { ...scope, ...(overviewSelection.current ? { overviewId: overviewSelection.current } : {}) }, signal),
      requestedTab === 'history' ? rpc<HistoryPage>('history', { ...scope, offset: page }, signal) : Promise.resolve(undefined),
    ]);
    if (signal.aborted || generation !== epoch.current || sequence !== loadSequence.current) return;
    setView(nextView); if (nextHistory) setHistory(nextHistory);
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
  }, [snapshot.basis, snapshot.preferenceVersion, snapshot.inputs?.length, snapshot.explanations?.length, answers.length, tab, offset, overviewId]);

  async function run(method: string, fields: Record<string, unknown>, existing = false) {
    if (writing.current) return;
    const request = existing ? fields : { ...scope, ...fields, clientRequestId: crypto.randomUUID() };
    const controller = new AbortController(), generation = epoch.current;
    writing.current = controller; setBusy(method); setError(''); setRetry({ method, request });
    try {
      const result = await rpc<{ id?: string }>(method, request, AbortSignal.any([controller.signal, AbortSignal.timeout(55000)]));
      if (controller.signal.aborted || generation !== epoch.current) return;
      setRetry(undefined); if (method === 'annotate') setCorrection(undefined);
      await load(controller.signal); onChanged();
      if (method === 'prepareReview' && result.id) requestAnimationFrame(() => { document.querySelector(`[data-vg-trial="${CSS.escape(result.id!)}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }); });
      return true;
    } catch (e) {
      if (!controller.signal.aborted && generation === epoch.current) setError(e instanceof Error ? e.message : '暂时未收到结果，请刷新核对。');
    } finally {
      if (writing.current === controller) writing.current = undefined;
      if (generation === epoch.current) setBusy('');
    }
  }

  const overview = view?.overview, node = overview?.nodes.find(item => `${overview.id}:${item.id}` === selected);
  const latestTrials = new Map(view?.trials.map(card => [card.deliveryId, card.id]));
  const trials = view?.trials.filter(card => showOldTrials || latestTrials.get(card.deliveryId) === card.id) ?? [];
  const focusNode = (id: string) => {
    setSelected(`${overview?.id}:${id}`);
  };
  const goal = view?.work?.analyses.filter(row => row.kind === 'goal' && !row.historical && row.overviewId === overview?.id).at(-1);
  const goalNodes = new Set(goal?.nodes.map(row => row.id));
  return <>
    {error && <div role="alert" className="vg-notice"><p>{error}</p>{retry && !busy && <button onClick={() => void run(retry.method, retry.request, true)}>重试这次操作</button>}</div>}
    {busy && <p role="status" className="vg-muted">{busy === 'overview' ? '正在按你的请求整理项目概览…' : busy === 'prepareReview' ? '正在准备这条要求的试用步骤…' : busy === 'analyze' ? '正在解释实际影响…' : '正在保存你的记录…'} 主对话照常进行。</p>}
    {tab === 'history' && <SupportPanel scope={scope} rpc={rpc} onChanged={onChanged}/> }
    {tab === 'progress' && <ProgressAnswers answers={answers} view={view} onQuestion={onQuestion} onFocus={onFocus}/>}
    {tab === 'progress' && view?.work?.trouble && (!!view.work.trouble.failures.length || !!view.work.trouble.feedback.length) && <section className="vg-card" aria-label="失败与尝试">
      <h3>哪些地方还没有顺利通过</h3>
      {view.work.trouble.failures.map(row => <p key={row.id}>{row.count > 1 ? (view.work!.trouble!.incomplete ? `已观察到同一检查失败 ${row.count} 次` : `同一检查已连续失败 ${row.count} 次`) : '一项检查未通过'}{row.current ? '（对应当前文件）' : '（旧版本或范围尚未核对，需重新检查）'}。</p>)}
      {view.work.trouble.feedback.map(row => <p key={row.id}>你的试用反馈：{row.action} — 未符合预期{row.historical ? '（旧版本）' : ''}{row.note && `；${row.note}`}</p>)}
      <p className="vg-muted">只记录检查与反馈，不凭次数判断故障原因。{view.work.trouble.incomplete && '部分历史记录未能读取。'}</p>
      <button onClick={() => onQuestion('现在卡住在哪里？请结合实际尝试和失败记录，解释使用影响，并给出下一步的选择。')}>梳理这次卡住的情况</button>
      <details><summary>最近尝试的结果</summary><ul>{view.work.trouble.attempts.map(row => <li key={row.id}>{date(row.at)} · {row.changed ? `修改了 ${row.changed} 个文件` : '运行操作或检查'}：{row.result === 'failed' ? '未成功' : row.result === 'succeeded' ? '正常结束' : '结果未知'}</li>)}</ul><p className="vg-muted">先后顺序不表示这些修改都针对同一问题；正常结束不等于符合需求。</p></details>
    </section>}
    <WorkPanels view={view} tab={tab} busy={busy} modelReady={modelReady} run={run} background={background} onBackground={onBackground} onQuestion={onQuestion} onFocus={onFocus}/>
    {tab === 'structure' && <section aria-label="项目结构">
      <div className="vg-row"><h3>这个项目由哪些部分组成</h3><button disabled={!!busy || !modelReady} onClick={() => void run('overview', {})}>{overview ? '更新概览' : '生成项目概览'}</button></div>
      <p className="vg-muted">{view ? `已核对 ${view.fileCount} 个项目文件是否变化${view.complete ? '' : '，范围不完整'}。` : '正在读取项目范围…'} 点击生成时才使用 AI；相同资料会复用已有概览。</p>
      {!!view?.versions?.length && <div className="vg-card">
        <label>查看结构版本<select disabled={!!busy} value={overviewId} onChange={e => { setOverviewId(e.target.value); setSelected(undefined); setComparison(undefined); }}><option value="">最新保存的概览</option>{view.versions.slice().reverse().map((row, i) => <option key={row.id} value={row.id}>{date(row.createdAt)} · 版本 {view.versions!.length - i}</option>)}</select></label>
        {view.versions.length > 1 && <><label>与哪个旧概览比较<select disabled={!!busy} value={compareFrom} onChange={e => { setCompareFrom(e.target.value); setComparison(undefined); }}><option value="">选择一个版本</option>{view.versions.filter(row => row.id !== overview?.id).map((row, i) => <option key={row.id} value={row.id}>{date(row.createdAt)} · {row.summary.slice(0, 30)}</option>)}</select></label>
          <button disabled={!compareFrom || compareFrom === overview?.id || !!busy} onClick={() => { const target = overview?.id; if (!target) return; const controller = new AbortController(); writing.current = controller; setBusy('compareStructure'); setError(''); void rpc<StructureComparison>('compareStructure', { ...scope, from: compareFrom, to: target }, controller.signal).then(result => { if (!controller.signal.aborted) setComparison(result); }).catch(e => { if (!controller.signal.aborted) setError(e.message); }).finally(() => { if (writing.current === controller) writing.current = undefined; if (!controller.signal.aborted) setBusy(''); }); }}>比较两个已保存的概览</button></>}
        <p className="vg-muted">保留最近 30 版。查看和比较均不调用 AI，不恢复代码。</p>
        {comparison && comparison.to === overview?.id && comparison.from === compareFrom && <div role="status"><p>概览新增职责：{comparison.added.join('、') || '无'}；不再出现的职责：{comparison.removed.join('、') || '无'}。</p>{comparison.responsibilities.map((row, i) => <p key={i}>{row.before} → {row.after}：{[row.descriptionChanged && '职责说明变化', row.scopeChanged && '所含文件范围变化'].filter(Boolean).join('、')}</p>)}<p>已核对到 {comparison.sourceChanges} 个源文件变化。{comparison.incomplete && '读取范围不完整。'}职责变化是两次概览的描述差异，不证明已经重构或实现功能。</p></div>}
      </div>}
      {!overview && <p className="vg-card">还没有生成概览。准备好后，点上方按钮了解各部分可能承担的职责和使用影响。</p>}
      {overview && <>
        <article className="vg-card"><small>项目概览 · {date(overview.createdAt)} · AI 根据有限资料推测</small><p>{overview.summary}</p>
          <p className="vg-muted">这次参考了 {overview.sampledFiles} 个文件的内容摘录，不证明功能已经实现或可用。</p>
          {overview.historical && <p className="vg-notice">文件已有变化，仍保留你正在看的概览。标记仅表示相关文件发生变化，不代表功能已经改好。{overview.unmappedChanges > 0 && ` 另有 ${overview.unmappedChanges} 个变化文件尚未对应到图中。`}</p>}
        </article>
        <div className="vg-row"><small>选择任一部分查看影响</small><div><button aria-label="缩小结构图" onClick={() => setZoom(value => Math.max(.75, value - .25))}>−</button> <button aria-label="放大结构图" onClick={() => setZoom(value => Math.min(2, value + .25))}>＋</button></div></div>
        <div className="vg-graph-scroll">
          <svg role="group" aria-label="项目职责图，关系仅为观察到的代码引用" viewBox={`0 0 400 ${Math.ceil(overview.nodes.length / 2) * 105 + 20}`} style={{ width: `${zoom * 100}%`, minWidth: 300 }}>
            {overview.edges.map((edge, index) => {
              const a = overview.nodes.findIndex(row => row.id === edge.from), b = overview.nodes.findIndex(row => row.id === edge.to);
              return <line key={index} x1={a % 2 * 200 + 100} y1={Math.floor(a / 2) * 105 + 50} x2={b % 2 * 200 + 100} y2={Math.floor(b / 2) * 105 + 50} stroke="#789185" strokeDasharray="4 4"/>;
            })}
            {overview.nodes.map((item, index) => <g key={item.id} role="button" tabIndex={0} aria-label={`${item.title}${overview.changedNodes.includes(item.id) ? '，相关文件有变化' : ''}`} aria-pressed={`${overview.id}:${item.id}` === selected}
              transform={`translate(${index % 2 * 200 + 8},${Math.floor(index / 2) * 105 + 12})`} onClick={() => focusNode(item.id)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); focusNode(item.id); } }}>
              <rect width="184" height="76" rx="12" fill={goalNodes.has(item.id) ? '#dce9fa' : `${overview.id}:${item.id}` === selected ? '#d6e8dc' : '#edf2ee'} stroke={overview.changedNodes.includes(item.id) ? '#bc8a3d' : '#789185'} strokeWidth={`${overview.id}:${item.id}` === selected ? 2 : 1}/>
              <text x="12" y="30" fill="#263b35" fontSize="12">{item.title.length > 13 ? item.title.slice(0, 12) + '…' : item.title}</text>
              <text x="12" y="53" fill="#687b70" fontSize="10">{overview.changedNodes.includes(item.id) ? '相关文件有变化' : '职责待实际验证'}</text>
            </g>)}
          </svg>
        </div>
        <p className="vg-muted">连线表示观察到的代码引用，不是已验证的数据流；没有连线也不表示没有关联。</p>
        {goal && <p className="vg-muted">蓝色标记与“{goal.question}”可能相关的已有部分。关系由 AI 推测，尚未实际验证。</p>}
        <div className="vg-node-list" aria-label="项目结构列表">{overview.nodes.map(item => <button key={item.id} aria-pressed={`${overview.id}:${item.id}` === selected} onClick={() => focusNode(item.id)}>{item.title}{goalNodes.has(item.id) ? ' · 与目标相关' : ''}{overview.changedNodes.includes(item.id) ? ' · 有变化' : ''}</button>)}</div>
        {node && <article className="vg-card"><h3>{node.title}</h3><p>{node.purpose}</p><p><strong>对使用的影响：</strong>{node.impact}</p>
          <button onClick={() => onFocus({ ref: { kind: 'node', id: `${overview.id}:${node.id}`, version: overview.id }, label: node.title })}>追问这一部分</button>
          <small className="vg-muted"> 选择本身不调用 AI。</small>
        </article>}
        {!!overview.unknowns.length && <article className="vg-card"><h3>还不能确认</h3><ul>{overview.unknowns.map((item, index) => <li key={index}>{item}</li>)}</ul></article>}
      </>}
    </section>}
    {tab === 'history' && <section aria-label="了解过的">
      <h3>这个项目里，了解过的内容</h3><p className="vg-muted">包含本项目其他会话中的侧栏讲解。历史解释不是当前实现事实；纠正不会修改代码，也不会自动转交给主 AI。</p>
      {!history && <p>正在读取讲解记录…</p>}
      {history && !history.items.length && <p className="vg-card">还没有讲解记录。在下方问一个问题，回答就会保存在这里。</p>}
      {history?.incomplete && <p className="vg-notice">会话数量较多，本页只覆盖前 100 个会话的记录。</p>}
      {history?.items.map(item => <article key={item.id} className="vg-card">
        <small className="vg-muted">{date(item.createdAt)} · {item.fromCurrentSession ? '本会话' : '本项目的其他会话'} · {item.state === 'current' ? '对应当前进展' : '历史讲解'}</small>
        <h3>{item.contextLabel && <small className="vg-muted">关于 {item.contextLabel}<br/></small>}{item.question}</h3>
        {item.annotation ? <><p className="vg-notice">{item.annotation.action === 'retire' ? '已不再使用，不会作为追问材料或缓存答案。' : '已纠正，后续追问使用你的纠正内容。'}</p>
          {item.annotation.text && <p className="vg-text">我的纠正：{item.annotation.text}</p>}
          <details><summary>当时的侧栏讲解</summary><p className="vg-text">{item.text}</p></details>
        </> : <p className="vg-text">{item.text}</p>}
        <div className="vg-actions">
          {item.annotation?.action !== 'retire' && <button onClick={() => onFocus({ ref: { kind: 'explanation', id: item.id, version: item.contextVersion }, label: item.question })}>继续追问</button>}
          <button disabled={!!busy} onClick={() => setCorrection({ item, text: item.annotation?.text ?? '' })}>纠正理解</button>
          {item.annotation?.action !== 'retire' && <button disabled={!!busy} onClick={() => void run('annotate', { explanationId: item.id, version: item.contextVersion, action: 'retire' })}>不再使用</button>}
        </div>
        {correction?.item.id === item.id && <form onSubmit={event => { event.preventDefault(); void run('annotate', { explanationId: item.id, version: correction.item.contextVersion, action: 'correct', text: correction.text }); }}>
          <label>你希望如何纠正这条理解？<textarea value={correction.text} maxLength={2000} onChange={event => setCorrection({ ...correction, text: event.target.value })}/></label>
          <button disabled={!!busy || !correction.text.trim()}>保存纠正</button> <button type="button" onClick={() => setCorrection(undefined)}>取消</button>
        </form>}
      </article>)}
      <div className="vg-row"><button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 20))}>上一页</button><button disabled={history?.nextOffset === undefined} onClick={() => setOffset(history!.nextOffset!)}>下一页</button></div>
    </section>}
    {tab === 'progress' && <section aria-label="试用反馈">
      {(snapshot.deliveries?.some(row => row.state === 'accepted') || !!trials.length) && <h3>按你的要求试一试</h3>}
      {!view?.work && snapshot.deliveries?.filter(row => row.state === 'accepted').map(delivery => <article className="vg-card" key={delivery.id}>
        <p className="vg-text">{delivery.content}</p>
        <button disabled={!!busy || !modelReady} onClick={() => void run('prepareReview', { deliveryId: delivery.id })}>为这条要求准备试用步骤</button>
        <p className="vg-muted">点击才生成建议。收到要求不等于已经做好；等主对话完成相关修改后再实际试用。</p>
      </article>)}
      {trials.map(card => <article className="vg-card" key={card.id} data-vg-trial={card.id}>
        <small className="vg-muted">试用记录 · {date(card.createdAt)}{card.scope.sessionId !== snapshot.scope.sessionId ? ' · 来自本项目其他会话' : ''}</small>
        <h3 className="vg-text">{card.requirement}</h3>
        {card.historical && <p className="vg-notice">文件已变化，这些是旧版本的步骤和反馈。请在上方对应要求中，为当前版本重新准备试用。</p>}
        {!card.basis.complete && <p className="vg-notice">项目读取范围不完整；反馈只表示你试用时的体验，不能确认整个项目版本。</p>}
        <ol>{card.steps.map(step => {
          const feedback = card.feedback.filter(row => row.stepId === step.id).at(-1), key = `${card.id}:${step.id}`;
          return <li key={step.id}><strong>{step.action}</strong><p>预期看到：{step.expected}</p>
            {feedback && <p className="vg-notice">你的反馈：{feedback.result === 'pass' ? '这一步符合预期' : '这一步不符合预期'} · {date(feedback.createdAt)}{feedback.note && `；${feedback.note}`}</p>}
            {!card.historical && <><label className="vg-muted">补充实际情况（可选）<input value={notes[key] ?? ''} maxLength={2000} onChange={event => setNotes(previous => ({ ...previous, [key]: event.target.value }))}/></label>
              <div className="vg-actions">{(['pass', 'fail'] as const).map(result => <button key={result} disabled={!!busy} onClick={() => void run('feedback', { cardId: card.id, stepId: step.id, fileDigest: card.basis.digest, result, ...(notes[key]?.trim() ? { note: notes[key] } : {}) })}>{result === 'pass' ? '这一步符合预期' : '这一步不符合预期'}</button>)}</div></>}
          </li>;
        })}</ol>
        <p className="vg-muted">反馈只对应这一步体验。上方会结合已确认的范围、实际改动和适用检查核对这条要求。需要调整时，在下方明确提出修改要求。</p>
      </article>)}
      {view && view.trials.length > latestTrials.size && <button onClick={() => setShowOldTrials(value => !value)}>{showOldTrials ? '收起早期试用记录' : '查看早期试用记录'}</button>}
    </section>}
  </>;
}

/** Keep the latest trouble explanation and its actions together, above project-wide requirements. */
export function ProgressAnswers({ answers, view, onQuestion, onFocus }: {
  answers: Explanation[]; view?: ProjectView; onQuestion: (text: string) => void; onFocus: (focus: Focus) => void;
}) {
  const troubles = view?.work?.analyses.filter(row => row.kind === 'trouble') ?? [];
  const latest = troubles.at(-1), merged = new Set(troubles.map(row => row.id));
  return <>
    {latest && <section aria-label="卡住时的下一步"><AnalysisCard row={latest} onQuestion={onQuestion} onFocus={onFocus}/></section>}
    {answers.filter(answer => !answer.analysisId || !merged.has(answer.analysisId)).map(answer => <article key={answer.id} className="vg-card vg-answer">
      <h3>{answer.contextLabel && <small className="vg-muted">关于 {answer.contextLabel}<br/></small>}{answer.question}</h3>
      {answer.state === 'historical' && <p className="vg-notice">对话、项目文件或模型设置已有变化，下面保留的是当时的讲解。</p>}
      <p className="vg-text">{answer.text}</p>
      {answer.cached && <small className="vg-muted">沿用同一进展下已有的讲解，未重复生成。</small>}
    </article>)}
  </>;
}
