import type { ReactNode } from 'react';
import type { Focus } from '../guide/project-types.js';
import type { WorkView } from '../guide/work-types.js';

export function AnalysisCard({ row, onQuestion, onFocus, children }: {
  row: WorkView['analyses'][number]; onQuestion: (text: string) => void; onFocus: (focus: Focus) => void; children?: ReactNode;
}) {
  return <article className="vg-card" data-vg-analysis={row.id}><h3>{row.question}</h3>
        {row.historical && <p className="vg-notice">这是之前的分析，情况可能已经变了。</p>}
        <p>{row.summary}</p>{!!row.impacts.length && <ul>{row.impacts.map((item, i) => <li key={i}>{item}</li>)}</ul>}
        {row.nodes.map((node, i) => <p key={i}><strong>{node.title}：</strong>{node.reason}</p>)}
        {!!row.possibleAdditions.length && <p>可能需要补充：{row.possibleAdditions.join('；')}</p>}
        {!!row.unknowns.length && <p className="vg-muted">还不能确认：{row.unknowns.join('；')}</p>}
        {children}
        {row.nextSteps?.map((step, i) => <div className="vg-card" key={i}><strong>{step.label}</strong><p>{step.reason}</p><button onClick={() => onQuestion(step.request)}>填入输入框</button></div>)}
        <button onClick={() => onFocus({ ref: { kind: 'analysis', id: row.id, version: row.cacheKey }, label: row.question })}>继续问这个影响</button>
      </article>;
}
