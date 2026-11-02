import type { ReactNode } from 'react';
import type { Focus } from '../guide/project-types.js';
import type { WorkView } from '../guide/work-types.js';
import type { HandoffSource } from '../guide/contracts.js';

/** One-click sending: the sidebar writes the request and sends it as the owner's own words. */
export type Handoff = { send: (source: HandoffSource) => void; sending?: string; sent: Set<string>; ready: boolean };
export const handoffKey = (source: HandoffSource) => JSON.stringify(source);
export function SendButton({ source, handoff }: { source: HandoffSource; handoff?: Handoff }) {
  if (!handoff) return null;
  const mine = handoff.sending === handoffKey(source);
  if (handoff.sent.has(handoffKey(source))) return <button disabled>已发送到主对话</button>;
  return <button className="vg-primary" disabled={!!handoff.sending || !handoff.ready} onClick={() => handoff.send(source)}>{mine ? '正在写给主 AI…' : '把这个改法发到主对话'}</button>;
}

export function AnalysisCard({ row, onFocus, handoff, children }: {
  row: WorkView['analyses'][number]; onFocus: (focus: Focus) => void; handoff?: Handoff; children?: ReactNode;
}) {
  return <article className="vg-card" data-vg-analysis={row.id}><h3>{row.question}</h3>
        {row.historical && <p className="vg-notice">这是之前的分析，情况可能已经变了。</p>}
        <p>{row.summary}</p>{!!row.impacts.length && <ul>{row.impacts.map((item, i) => <li key={i}>{item}</li>)}</ul>}
        {row.nodes.map((node, i) => <p key={i}><strong>{node.title}：</strong>{node.reason}</p>)}
        {!!row.possibleAdditions.length && <p>可能需要补充：{row.possibleAdditions.join('；')}</p>}
        {!!row.unknowns.length && <p className="vg-muted">还不能确认：{row.unknowns.join('；')}</p>}
        {children}
        {row.nextSteps?.map((step, i) => <div className="vg-card" key={i}><strong>{step.label}</strong><p>{step.reason}</p>{!row.historical && <SendButton source={{ kind: 'step', id: row.id, index: i }} handoff={handoff}/>}</div>)}
        <button onClick={() => onFocus({ ref: { kind: 'analysis', id: row.id, version: row.cacheKey }, label: row.question })}>继续问这个影响</button>
      </article>;
}
