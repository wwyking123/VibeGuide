import { useEffect, useRef, useState } from 'react';
import { cleanSelection } from '../guide/quote.js';

// Select text in the main conversation, then ask about it in the sidebar.
// The approach (watch the document selection inside the chat flow, float a control above it)
// follows suiyideali/dsh-selection-toolbar. Harness has no selection extension point, so the
// chat-flow marker is undocumented: when it is missing the control simply never appears and
// the sidebar's own question box keeps working.

/** The composer slot knows which session is on screen; the overlay does not reliably. */
let current: string | undefined;
export function SessionProbe({ sessionId }: { sessionId?: string }) {
  useEffect(() => {
    current = sessionId;
    return () => { if (current === sessionId) current = undefined; };
  }, [sessionId]);
  return null;
}

let pending: { sessionId: string; text: string; at: number } | undefined;
const waiting = new Set<() => void>();
/** The sidebar panel may mount only after the click, so the quote waits here briefly. */
export function takeQuote(sessionId: string): string | undefined {
  const found = pending;
  if (!found || found.sessionId !== sessionId || Date.now() - found.at > 15000) return undefined;
  pending = undefined;
  return found.text;
}
export function onQuote(listener: () => void) {
  waiting.add(listener);
  return () => { waiting.delete(listener); };
}

type Found = { text: string; left: number; top: number; above: boolean };
const element = (node: Node | null) => !node ? null : node.nodeType === 1 ? node as Element : node.parentElement;

function selection(): Found | undefined {
  const selected = document.getSelection();
  if (!selected || selected.isCollapsed || !selected.rangeCount) return undefined;
  const from = element(selected.anchorNode), to = element(selected.focusNode), flow = from?.closest('[data-chat-flow]');
  if (!from || !to || !flow || !flow.contains(to)) return undefined;
  if (from.closest('textarea, input, [contenteditable="true"], [data-composer-card]')) return undefined;
  const range = selected.getRangeAt(0), rect = range.getBoundingClientRect();
  if (!rect.width && !rect.height) return undefined;
  // Off-screen messages are virtualized, which can leave Selection.toString() empty.
  const text = cleanSelection(selected.toString() || range.cloneContents().textContent || '');
  if (!text) return undefined;
  const above = rect.top > 56, edge = 64;
  return { text, above, top: above ? rect.top - 8 : rect.bottom + 8,
    left: Math.max(edge, Math.min(rect.left + rect.width / 2, window.innerWidth - edge)) };
}

export function SelectionAsk({ allowed, open }: { allowed: (sessionId: string) => Promise<boolean>; open: () => void }) {
  const [at, setAt] = useState<Found & { sessionId: string }>();
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let dragging = false, run = 0;
    const inside = (event: Event) => !!button.current?.contains(event.target as Node);
    const hide = () => { run++; setAt(undefined); };
    const read = () => {
      const id = ++run, found = selection(), sessionId = current;
      if (!found || !sessionId) { setAt(undefined); return; }
      void allowed(sessionId).then(ok => { if (id === run) setAt(ok ? { ...found, sessionId } : undefined); });
    };
    const down = (event: Event) => { if (!inside(event)) { dragging = true; hide(); } };
    const up = (event: Event) => { if (!inside(event)) { dragging = false; read(); } };
    const change = () => { if (!dragging) read(); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') hide(); };
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('pointerup', up, true);
    document.addEventListener('selectionchange', change);
    document.addEventListener('keydown', key);
    document.addEventListener('scroll', hide, { capture: true, passive: true });
    window.addEventListener('resize', hide);
    return () => {
      run++;
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('pointerup', up, true);
      document.removeEventListener('selectionchange', change);
      document.removeEventListener('keydown', key);
      document.removeEventListener('scroll', hide, { capture: true });
      window.removeEventListener('resize', hide);
    };
  }, []);

  if (!at) return null;
  return <>
    <style>{styles}</style>
    <button ref={button} type="button" className="vg-ask" data-above={at.above} data-testid="vibeguide-ask-selection" style={{ left: at.left, top: at.top }}
      onMouseDown={event => event.preventDefault()} onClick={() => {
        pending = { sessionId: at.sessionId, text: at.text, at: Date.now() };
        open();
        for (const listener of waiting) listener();
        document.getSelection()?.removeAllRanges();
        setAt(undefined);
      }}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 5c3-1 5-1 8 1 3-2 5-2 8-1v14c-3-1-5-1-8 1-3-2-5-2-8-1V5Zm8 1v14" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/></svg>
      问问这个
    </button>
  </>;
}

const styles = `
.vg-ask{position:fixed;z-index:60;pointer-events:auto;transform:translate(-50%,-100%);display:inline-flex;align-items:center;gap:6px;font:500 12px/1 system-ui,-apple-system,"PingFang SC",sans-serif;padding:7px 12px;border-radius:999px;border:1px solid rgba(255,255,255,.14);background:#262624;color:#fff;box-shadow:0 4px 14px rgba(0,0,0,.2);cursor:pointer;white-space:nowrap;animation:vg-ask-in .14s ease-out;transition:background-color .15s}
.vg-ask[data-above=false]{transform:translate(-50%,0)}.vg-ask:hover{background:#3d3c39}
@keyframes vg-ask-in{from{opacity:0}}
@media (prefers-color-scheme:dark){.vg-ask{background:#ecebe7;color:#1f1e1d;border-color:rgba(0,0,0,.1)}.vg-ask:hover{background:#fff}}
@media (prefers-reduced-motion:reduce){.vg-ask{animation:none;transition:none}}
`;
