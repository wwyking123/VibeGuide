import type { Focus } from '../guide/project-types.js';
import type { WorkView } from '../guide/work-types.js';

export function AnalysisCard({ row, onQuestion, onFocus }: {
  row: WorkView['analyses'][number]; onQuestion: (text: string) => void; onFocus: (focus: Focus) => void;
}) {
  return <article className="vg-card" data-vg-analysis={row.id}><h3>{row.question}</h3>
        {row.historical && <p className="vg-notice">资料或讲解设置已有变化，这是当时的分析。重新提问才会更新。</p>}
        <p>{row.summary}</p>{!!row.impacts.length && <ul>{row.impacts.map((item, i) => <li key={i}>{item}</li>)}</ul>}
        {row.nodes.map((node, i) => <p key={i}><strong>{node.title}：</strong>{node.reason}</p>)}
        {!!row.possibleAdditions.length && <p>可能需要补充：{row.possibleAdditions.join('；')}</p>}
        {!!row.unknowns.length && <p className="vg-muted">还不能确认：{row.unknowns.join('；')}</p>}
        {row.kind === 'changes' && <p className="vg-muted">参考了 {row.coveredChanges} 份实际改动前后摘录。可观察到的文件变化共 {row.observedChanges} 次；未读取的部分不会当作已解释。</p>}
        {row.nextSteps?.map((step, i) => <div className="vg-card" key={i}><strong>{step.label}</strong><p>{step.reason}</p><button onClick={() => onQuestion(step.request)}>将这项建议填入输入框</button><p className="vg-muted">可先修改，再由你发送。现在尚未转交。</p></div>)}
        <button onClick={() => onFocus({ ref: { kind: 'analysis', id: row.id, version: row.cacheKey }, label: row.question })}>继续问这个影响</button>
      </article>;
}
