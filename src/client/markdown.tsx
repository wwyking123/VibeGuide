import type { ReactNode } from 'react';

const inline = (text: string): ReactNode[] => text.split(/(\*\*[^*]+\*\*)/g).map((part, i) => part.startsWith('**') && part.endsWith('**') && part.length > 4 ? <strong key={i}>{part.slice(2, -2)}</strong> : part);

/** Minimal rendering for model answers: paragraphs, bold, headings and bullet lists. Never interprets HTML. */
export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let list: string[] = [], paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push(<p key={blocks.length}>{paragraph.flatMap((line, i) => i ? [<br key={i}/>, ...inline(line)] : inline(line))}</p>);
    if (list.length) blocks.push(<ul key={blocks.length}>{list.map((item, i) => <li key={i}>{inline(item)}</li>)}</ul>);
    paragraph = []; list = [];
  };
  for (const raw of text.split('\n')) {
    const line = raw.trim(), item = /^(?:[-*•]|\d+[.)、])\s+(.*)$/.exec(line), heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (!line) flush();
    else if (item) { if (paragraph.length) { const keep = list; list = []; flush(); list = keep; } list.push(item[1]); }
    else if (heading) { flush(); blocks.push(<p key={blocks.length}><strong>{inline(heading[1])}</strong></p>); }
    else { if (list.length) flush(); paragraph.push(line); }
  }
  flush();
  return <div className="vg-md">{blocks}</div>;
}
