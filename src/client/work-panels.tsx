import { useState } from 'react';
import { AnalysisCard } from './analysis-card.js';
import type { ProjectView, Focus } from '../guide/project-types.js';
import type { Outcome, Requirement, RequirementRef } from '../guide/work-types.js';
import type { GuideTab } from './project-panels.js';

type Run = (method: string, fields: Record<string, unknown>) => Promise<boolean | void>;
export function WorkPanels({ view, sessionId, tab, busy, modelReady, run, background, onBackground, onQuestion, onFocus }: {
  view?: ProjectView; sessionId: string; tab: GuideTab; busy: string; modelReady: boolean; run: Run;
  background?: RequirementRef[]; onBackground: (refs: RequirementRef[] | undefined) => void;
  onQuestion: (text: string) => void; onFocus: (focus: Focus) => void;
}) {
  const [edit, setEdit] = useState<{ row: Requirement; text: string; applicability: Requirement['applicability'] }>();
  const [binding, setBinding] = useState<{ outcome: Outcome; selected: Record<string, string[]>; confirmed: boolean }>();
  const [showRetired, setShowRetired] = useState(false), [showAll, setShowAll] = useState(false);
  const work = view?.work, outcomes = work?.outcomes ?? [];
  const primary = new Set(outcomes.filter(row => row.requirement.scope.sessionId === sessionId && row.state !== 'complete'));
  const ref = (row: Requirement) => ({ id: row.id, version: row.version });
  const opKey = (row: { sessionId: string; id: string }) => `${row.sessionId}:${row.id}`;
  const startBinding = (outcome: Outcome) => {
    const trial = view?.trials.find(row => row.id === outcome.trialId), selected: Record<string, string[]> = {};
    for (const step of trial?.steps ?? []) selected[step.id] = outcome.candidates.filter(row => row.current && row.linked).map(row => opKey(row.ref));
    setBinding({ outcome, selected, confirmed: false });
  };
  return <>
    {tab === 'progress' && <section aria-label="逐条要求的完成情况">
      {(showAll ? !!outcomes.length : !!primary.size) && <h3>你的要求做到哪一步了</h3>}
      {outcomes.filter(outcome => showAll || primary.has(outcome)).map(outcome => {
        const trial = view?.trials.find(row => row.id === outcome.trialId), row = outcome.requirement, current = !!trial && !trial.historical;
        const label = outcome.state === 'complete' ? '已完成' : outcome.state === 'needs_feedback' ? '可以试用了' : '还在做';
        const reason = { awaiting_delivery: '还没送到主对话', needs_scope: current ? '试用步骤已准备，等你核对范围' : '做完后可以准备试用步骤', needs_changes: '还没有对应的改动',
          needs_checks: '还缺检查', check_failed: '检查没通过', needs_feedback: '按下方步骤试一试', feedback_failed: '你试用时发现的问题还没解决', stale: '要求或文件变了，需要重新试用', complete: '' }[outcome.state];
        return <article className="vg-card" key={row.id}>
          <div className="vg-row"><h3 className="vg-text">{row.text}</h3><span className={`vg-badge vg-badge-${label === '已完成' ? 'done' : label === '可以试用了' ? 'try' : 'doing'}`}>{label}</span></div>
          {reason && <p className="vg-muted">{reason}</p>}
          {outcome.state !== 'complete' && <div className="vg-actions">
            {['check_failed', 'needs_checks'].includes(outcome.state) ? <button onClick={() => onQuestion(`请添加并运行针对以下要求的检查，保留原要求和限制，并在主对话说明检查对应的使用效果：\n${row.text}`)}>请主 AI 补齐检查</button>
              : outcome.state === 'needs_scope' && current ? <button disabled={!!busy} onClick={() => startBinding(outcome)}>核对范围</button>
              : outcome.state !== 'awaiting_delivery' && !current && <button disabled={!!busy || !modelReady} onClick={() => void run('prepareReview', { requirement: ref(row) })}>准备试用步骤</button>}
          </div>}
          {binding?.outcome.requirement.id === row.id && trial && <form onSubmit={event => {
            event.preventDefault(); void run('bindOutcome', { requirement: ref(binding.outcome.requirement), trialId: trial.id,
              evidenceVersion: binding.outcome.evidenceVersion, scopeConfirmed: binding.confirmed,
              coverage: trial.steps.map(step => ({ stepId: step.id,
                changes: binding.outcome.candidates.filter(item => item.kind === 'change' && binding.selected[step.id]?.includes(opKey(item.ref))).map(item => item.ref),
                checks: binding.outcome.candidates.filter(item => item.kind === 'check' && binding.selected[step.id]?.includes(opKey(item.ref))).map(item => item.ref) })) }).then(ok => { if (ok) setBinding(undefined); });
          }}>
            <p className="vg-muted">勾选确实对应这一步的改动和检查；不确定可以先不选。</p>
            {trial.steps.map(step => <fieldset key={step.id}><legend>{step.action}</legend><p>预期：{step.expected}</p>
              {binding.outcome.candidates.filter(item => item.current).map(item => <label key={opKey(item.ref)}><input type="checkbox" checked={binding.selected[step.id]?.includes(opKey(item.ref)) ?? false} onChange={event => {
                const key = opKey(item.ref), current = binding.selected[step.id] ?? [];
                setBinding({ ...binding, confirmed: false, selected: { ...binding.selected, [step.id]: event.target.checked ? [...current, key] : current.filter(value => value !== key) } });
              }}/>{item.kind === 'change' ? '实际改动' : '实际检查'}：{item.label}{item.outcome === 'failed' ? '（失败）' : ''}{item.linked ? ' · 同一条输入' : ''}</label>)}
              {!binding.outcome.candidates.some(item => item.current) && <p>还没有适用于当前版本的记录。可以先请主 AI 完成修改和检查。</p>}
            </fieldset>)}
            <label><input type="checkbox" checked={binding.confirmed} onChange={event => setBinding({ ...binding, confirmed: event.target.checked })}/>我已核对：步骤覆盖本次要求及限制，所选检查对应这些效果。</label>
            <div className="vg-actions"><button disabled={!!busy || !binding.confirmed}>保存对应范围</button><button type="button" onClick={() => setBinding(undefined)}>关闭核对</button></div>
          </form>}
        </article>;
      })}
      {outcomes.length > primary.size && <button onClick={() => setShowAll(value => !value)}>{showAll ? '只看本会话未完成的要求' : `另有 ${outcomes.length - primary.size} 条要求`}</button>}
    </section>}
    {tab === 'settings' && <section className="vg-card" aria-label="历史记忆"><h3>历史记忆</h3>
      <p className="vg-muted">你提过的要求和约定。提出修改时，会自动附带相关的几条；也可以自己指定。</p>
      {work?.historyIncomplete && <p className="vg-notice">部分历史记录未能完整读取，请明确选择本次约定。</p>}
      <div className="vg-actions"><button aria-pressed={background === undefined} onClick={() => onBackground(undefined)}>按相关性选取</button><button aria-pressed={background?.length === 0} onClick={() => onBackground([])}>这次不附带历史</button></div>
      {!work?.requirements.length && <p>还没有记录到明确要求。在主对话或侧栏提出修改后，这里会保留原话。</p>}
      {work?.requirements.filter(row => showRetired || row.state === 'active').map(row => <article key={row.id} className="vg-card">
        <p className="vg-text">{row.text}</p><small className="vg-muted">{row.state === 'retired' ? '已停用' : row.applicability === 'project' ? '整个项目适用' : '相关任务适用'} · {{ accepted: '当前版本已送达本会话', pending: '正在转交', unknown: '转交结果待核对', not_forwarded: '当前版本尚未转交本会话' }[row.forwarded]}</small>
        {row.state === 'active' && <label><input type="checkbox" checked={!!background?.some(item => item.id === row.id && item.version === row.version)} onChange={event => onBackground(event.target.checked ? [...(background ?? []).filter(item => item.id !== row.id), ref(row)] : (background ?? []).filter(item => item.id !== row.id))}/>下次修改附带这条约定</label>}
        {row.modifiedAt && <p className="vg-muted">已按你的修改更新；此前发到主对话的内容不会被撤回。</p>}
        <div className="vg-actions"><button disabled={!!busy} onClick={() => setEdit({ row, text: row.text, applicability: row.applicability })}>修改这条约定</button>
          <button disabled={!!busy} onClick={() => void run('reviseRequirement', { requirement: ref(row), text: row.text, state: row.state === 'active' ? 'retired' : 'active', applicability: row.applicability })}>{row.state === 'active' ? '不再使用' : '恢复使用'}</button></div>
        {edit?.row.id === row.id && <form onSubmit={event => { event.preventDefault(); void run('reviseRequirement', { requirement: ref(edit.row), text: edit.text, state: 'active', applicability: edit.applicability }).then(ok => { if (ok) setEdit(undefined); }); }}>
          <label>约定内容<textarea value={edit.text} maxLength={12000} onChange={event => setEdit({ ...edit, text: event.target.value })}/></label>
          <label><input type="checkbox" checked={edit.applicability === 'project'} onChange={event => setEdit({ ...edit, applicability: event.target.checked ? 'project' : 'related' })}/>整个项目都要遵守</label>
          <p className="vg-muted">保存只更新约定；下次明确修改并附带它时才交给主 AI。</p>
          <button disabled={!!busy || !edit.text.trim()}>保存约定</button> <button type="button" onClick={() => setEdit(undefined)}>关闭编辑</button>
        </form>}
      </article>)}
      {work?.requirements.some(row => row.state === 'retired') && <button onClick={() => setShowRetired(value => !value)}>{showRetired ? '收起已停用约定' : '查看已停用约定'}</button>}
    </section>}
    {tab === 'structure' && <section aria-label="目标与改动影响">
      {work?.analyses.filter(row => row.kind !== 'trouble' && !row.historical).slice(-1).map(row => <AnalysisCard key={row.id} row={row} onQuestion={onQuestion} onFocus={onFocus}/>)}
    </section>}
  </>;
}
