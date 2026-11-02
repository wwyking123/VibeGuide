import { useState } from 'react';
import { AnalysisCard } from './analysis-card.js';
import type { Handoff } from './analysis-card.js';
import type { ProjectView, Focus } from '../guide/project-types.js';
import type { Requirement } from '../guide/work-types.js';
import type { GuideTab } from './project-panels.js';

type Run = (method: string, fields: Record<string, unknown>) => Promise<boolean | void>;
export function WorkPanels({ view, sessionId, tab, busy, run, onFocus, handoff }: {
  view?: ProjectView; sessionId: string; tab: GuideTab; busy: string; modelReady: boolean; run: Run;
  onFocus: (focus: Focus) => void; handoff: Handoff;
}) {
  const [edit, setEdit] = useState<{ row: Requirement; text: string; applicability: Requirement['applicability'] }>();
  const [showRetired, setShowRetired] = useState(false), [showAll, setShowAll] = useState(false);
  const work = view?.work, outcomes = work?.outcomes ?? [];
  const primary = new Set(outcomes.filter(row => row.requirement.scope.sessionId === sessionId && row.state !== 'complete'));
  const ref = (row: Requirement) => ({ id: row.id, version: row.version });
  return <>
    {tab === 'progress' && <section aria-label="逐条要求的完成情况">
      {(showAll ? !!outcomes.length : !!primary.size) && <h3>你的要求做到哪一步了</h3>}
      {outcomes.filter(outcome => showAll || primary.has(outcome)).map(outcome => {
        const row = outcome.requirement;
        const label = outcome.state === 'complete' ? '已完成' : outcome.state === 'needs_feedback' ? '可以试用了' : '还在做';
        const reason = { awaiting_delivery: '还没送到主对话', needs_scope: '', needs_changes: '', needs_checks: '还缺检查', check_failed: '检查没通过，可以在上面梳理卡住的情况',
          needs_feedback: '按主对话里说的重点试一试；不满意直接在主对话说', feedback_failed: '', stale: '', complete: '' }[outcome.state];
        return <article className="vg-card" key={row.id}>
          <div className="vg-row"><h3 className="vg-text">{row.text}</h3><span className={`vg-badge vg-badge-${label === '已完成' ? 'done' : label === '可以试用了' ? 'try' : 'doing'}`}>{label}</span></div>
          {reason && <p className="vg-muted">{reason}</p>}
          {outcome.state === 'needs_feedback' && <div className="vg-actions"><button disabled={!!busy} onClick={() => void run('confirmRequirement', { requirement: ref(row) })}>没问题了</button></div>}
        </article>;
      })}
      {outcomes.length > primary.size && <button onClick={() => setShowAll(value => !value)}>{showAll ? '只看本会话未完成的要求' : `另有 ${outcomes.length - primary.size} 条要求`}</button>}
    </section>}
    {tab === 'settings' && <section className="vg-card" aria-label="历史记忆"><h3>历史记忆</h3>
      <p className="vg-muted">你提过的要求和约定。从侧栏发送改法时，会自动带上相关的几条。</p>
      {work?.historyIncomplete && <p className="vg-notice">部分历史记录未能完整读取。</p>}
      {!work?.requirements.length && <p>还没有记录到明确要求。在主对话提出修改后，这里会保留下来。</p>}
      {work?.requirements.filter(row => showRetired || row.state === 'active').map(row => <article key={row.id} className="vg-card">
        <p className="vg-text">{row.text}</p>{(row.state === 'retired' || row.applicability === 'project') && <small className="vg-muted">{row.state === 'retired' ? '已停用' : '整个项目都要遵守'}</small>}
        <div className="vg-actions"><button disabled={!!busy} onClick={() => setEdit({ row, text: row.text, applicability: row.applicability })}>修改这条约定</button>
          <button disabled={!!busy} onClick={() => void run('reviseRequirement', { requirement: ref(row), text: row.text, state: row.state === 'active' ? 'retired' : 'active', applicability: row.applicability })}>{row.state === 'active' ? '不再使用' : '恢复使用'}</button></div>
        {edit?.row.id === row.id && <form onSubmit={event => { event.preventDefault(); void run('reviseRequirement', { requirement: ref(edit.row), text: edit.text, state: 'active', applicability: edit.applicability }).then(ok => { if (ok) setEdit(undefined); }); }}>
          <label>约定内容<textarea value={edit.text} maxLength={12000} onChange={event => setEdit({ ...edit, text: event.target.value })}/></label>
          <label><input type="checkbox" checked={edit.applicability === 'project'} onChange={event => setEdit({ ...edit, applicability: event.target.checked ? 'project' : 'related' })}/>整个项目都要遵守</label>
          <button disabled={!!busy || !edit.text.trim()}>保存约定</button> <button type="button" onClick={() => setEdit(undefined)}>关闭编辑</button>
        </form>}
      </article>)}
      {work?.requirements.some(row => row.state === 'retired') && <button onClick={() => setShowRetired(value => !value)}>{showRetired ? '收起已停用约定' : '查看已停用约定'}</button>}
    </section>}
    {tab === 'structure' && <section aria-label="目标与改动影响">
      {work?.analyses.filter(row => row.kind !== 'trouble' && !row.historical).slice(-1).map(row => <AnalysisCard key={row.id} row={row} onFocus={onFocus} handoff={handoff}/>)}
    </section>}
  </>;
}
