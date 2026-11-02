import { useEffect, useRef, useState } from 'react';
import type { Scope } from '../guide/contracts.js';
import type { Preferences, SupportView } from '../guide/support-types.js';
type Rpc = <T>(method: string, request: unknown, signal: AbortSignal) => Promise<T>;
export function SupportPanel({ scope, rpc, onChanged }: { scope: Scope; rpc: Rpc; onChanged: () => void }) {
  const [view, setView] = useState<SupportView>(), [preferences, setPreferences] = useState<Preferences>();
  const [target, setTarget] = useState('project'), [daily, setDaily] = useState('100'), [turn, setTurn] = useState('20');
  const [error, setError] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  const targetRef = useRef(target); targetRef.current = target;
  const active = useRef<AbortController>(), alive = useRef(true);
  const update = (next: SupportView) => { setView(next); setPreferences(targetRef.current === 'personal' ? next.personal : next.preferences); setDaily(String(next.budget.dailyCalls)); setTurn(String(next.budget.turnCalls)); };
  useEffect(() => { alive.current = true; const controller = new AbortController();
    void rpc<SupportView>('supportView', scope, controller.signal).then(next => { if (!controller.signal.aborted) update(next); }).catch(e => { if (!controller.signal.aborted) setError(String(e.message)); });
    return () => { alive.current = false; controller.abort(); active.current?.abort(); };
  }, []);
  async function request(method: string, fields: Record<string, unknown> = {}) {
    if (active.current) return;
    const controller = new AbortController(); active.current = controller; setBusy(true); setError(''); setMessage('');
    try {
      const result = await rpc<any>(method, { ...scope, ...fields }, AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]));
      if (!alive.current || controller.signal.aborted) return;
      { update(result); if (method === 'saveSupport') { setMessage(fields.target === 'personal' ? '已设为默认。单独设置过的项目不受影响。' : '已保存，之后的讲解会按新设置。'); onChanged(); } }
    } catch (e) { if (alive.current && !controller.signal.aborted) setError(e instanceof Error ? e.message : '暂未保存，请刷新核对。'); }
    finally { if (active.current === controller) active.current = undefined; if (alive.current) setBusy(false); }
  }
  const save = (fields: Record<string, unknown>) => void request('saveSupport', { clientRequestId: crypto.randomUUID(), version: view?.version, ...fields });
  return <>
    <section className="vg-card" aria-label="讲解设置"><h3>讲解方式</h3>
      {!view && <p>正在读取设置…</p>}
      {view && preferences && <form onSubmit={e => { e.preventDefault(); save({ target, preferences }); }}>
        <label>讲解语言<select value={preferences.language} onChange={e => setPreferences({ ...preferences, language: e.target.value as Preferences['language'] })}><option value="auto">跟随我的提问</option><option value="zh-CN">简体中文</option><option value="en">English</option></select></label>
        <label>说明程度<select value={preferences.detail} onChange={e => setPreferences({ ...preferences, detail: e.target.value as Preferences['detail'] })}><option value="brief">简短</option><option value="standard">适中</option><option value="detailed">展开影响与取舍</option></select></label>
        <label>表达方式<select value={preferences.style} onChange={e => setPreferences({ ...preferences, style: e.target.value as Preferences['style'] })}><option value="direct">直接说明</option><option value="example">带一个使用场景</option></select></label>
        <label>讲解顺序<select value={preferences.order} onChange={e => setPreferences({ ...preferences, order: e.target.value as Preferences['order'] })}><option value="impact">先讲对使用的影响</option><option value="process">先讲正在做什么</option></select></label>
        <label><input type="checkbox" checked={target === 'personal'} onChange={e => { const next = e.target.checked ? 'personal' : 'project'; setTarget(next); setPreferences(next === 'personal' ? view.personal : view.preferences); }}/>设为我的默认（其他项目也用）</label>
        <div className="vg-actions"><button disabled={busy}>保存</button>{view.overridden && target === 'project' && <button type="button" disabled={busy} onClick={() => save({ target: 'inherit' })}>本项目改回默认</button>}</div>
      </form>}
    </section>
    {view && <section className="vg-card" aria-label="用量"><h3>今天已用 {view.calls} / {view.budget.dailyCalls} 次</h3>
      <form onSubmit={e => { e.preventDefault(); save({ target: 'budget', budget: { dailyCalls: Number(daily), turnCalls: Number(turn) } }); }}>
        <label>每天最多<input type="number" min="0" max="1000" step="1" required value={daily} onChange={e => setDaily(e.target.value)}/></label>
        <label>每轮对话最多<input type="number" min="0" max="1000" step="1" required value={turn} onChange={e => setTurn(e.target.value)}/></label>
        <button disabled={busy}>保存次数限制</button>
      </form>
      <p className="vg-muted">设为 0 可暂停新的讲解。</p>
      <details><summary>详细用量</summary>
        <p>当前这轮对话：{view.turnCalls} / {view.budget.turnCalls} 次。复用讲解 {view.cacheHits} 次、本地概念 {view.glossaryHits} 次，不计入次数。</p>
        <p>输入 {view.inputTokens.toLocaleString()} tokens，输出 {view.outputTokens.toLocaleString()} tokens{view.missingUsage ? `；${view.missingUsage} 次尚无完整用量` : ''}。</p>
        {!!(view.failed || view.unknown) && <p>失败或取消 {view.failed} 次，结果未确认 {view.unknown} 次，也计入次数。</p>}
        <p className="vg-muted">这里统计的是调用次数，不是账单金额；主对话的用量由 Harness 管理。</p>
      </details>
    </section>}
    {message && <p role="status" className="vg-notice">{message}</p>}{error && <p role="alert" className="vg-notice">{error}</p>}
  </>;
}
