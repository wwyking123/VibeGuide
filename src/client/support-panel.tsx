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
      { update(result); if (method === 'saveSupport') { setMessage(fields.target === 'personal' ? '已保存个人默认偏好。单独设置过的项目继续使用各自设置。' : '已保存。之后主动请求的讲解使用新设置，已有内容不会自动重写。'); onChanged(); } }
    } catch (e) { if (alive.current && !controller.signal.aborted) setError(e instanceof Error ? e.message : '暂未保存，请刷新核对。'); }
    finally { if (active.current === controller) active.current = undefined; if (alive.current) setBusy(false); }
  }
  const save = (fields: Record<string, unknown>) => void request('saveSupport', { clientRequestId: crypto.randomUUID(), version: view?.version, ...fields });
  return <>
    <section className="vg-card" aria-label="讲解设置与用量"><h3>讲解设置与用量</h3>
      <p className="vg-muted">只影响侧栏的讲解。保存设置本身不调用 AI。</p>
      {!view && <p>正在读取本地设置…</p>}
      {view && preferences && <>
        <form onSubmit={e => { e.preventDefault(); save({ target, preferences }); }}>
          <label>保存范围<select value={target} onChange={e => { setTarget(e.target.value); if (e.target.value === 'personal') setPreferences(view.personal); else setPreferences(view.preferences); }}><option value="project">仅这个项目</option><option value="personal">我的默认偏好（未单独设置的项目）</option></select></label>
          <label>讲解语言<select value={preferences.language} onChange={e => setPreferences({ ...preferences, language: e.target.value as Preferences['language'] })}><option value="auto">跟随我的提问</option><option value="zh-CN">简体中文</option><option value="en">English</option></select></label>
          <label>说明程度<select value={preferences.detail} onChange={e => setPreferences({ ...preferences, detail: e.target.value as Preferences['detail'] })}><option value="brief">简短</option><option value="standard">适中</option><option value="detailed">展开影响与取舍</option></select></label>
          <label>表达方式<select value={preferences.style} onChange={e => setPreferences({ ...preferences, style: e.target.value as Preferences['style'] })}><option value="direct">直接说明</option><option value="example">带一个使用场景</option></select></label>
          <label>讲解顺序<select value={preferences.order} onChange={e => setPreferences({ ...preferences, order: e.target.value as Preferences['order'] })}><option value="impact">先讲对使用的影响</option><option value="process">先讲正在做什么</option></select></label>
          <div className="vg-actions"><button disabled={busy}>保存讲解偏好</button>{view.overridden && <button type="button" disabled={busy} onClick={() => save({ target: 'inherit' })}>本项目恢复使用默认偏好</button>}</div>
        </form>
        <h3>本项目今天的侧栏用量</h3>
        <p>{view.day}（本机日期）：调用尝试 {view.calls} / {view.budget.dailyCalls} 次；当前主对话轮次 {view.turnCalls} / {view.budget.turnCalls} 次。</p>
        <p>复用讲解 {view.cacheHits} 次 · 本地概念 {view.glossaryHits} 次。两者不消耗模型调用次数。</p>
        <p>已报告输入 {view.inputTokens.toLocaleString()} tokens（含提供方缓存输入），输出 {view.outputTokens.toLocaleString()} tokens；{view.missingUsage} 次尚无完整用量报告。</p>
        {!!(view.failed || view.unknown) && <p>失败或取消 {view.failed} 次；仍在生成或结果未确认 {view.unknown} 次。这些尝试也计入次数限制。</p>}
        <form onSubmit={e => { e.preventDefault(); save({ target: 'budget', budget: { dailyCalls: Number(daily), turnCalls: Number(turn) } }); }}>
          <label>本项目每天最多调用次数<input type="number" min="0" max="1000" step="1" required value={daily} onChange={e => setDaily(e.target.value)}/></label>
          <label>每个主对话轮次最多调用次数<input type="number" min="0" max="1000" step="1" required value={turn} onChange={e => setTurn(e.target.value)}/></label>
          <button disabled={busy}>保存次数限制</button>
        </form>
        <p className="vg-muted">设为 0 暂停新的侧栏模型调用；已开始的讲解不受影响。此处统计调用尝试，不是账单或金额。主对话用量由 Harness 管理；读旧讲解和常用概念不受限制。切换会话不重置本项目每日计数。</p>
        <button disabled={busy} onClick={() => void request('supportView')}>刷新设置与用量</button>
      </>}
    </section>
    {message && <p role="status" className="vg-notice">{message}</p>}{error && <p role="alert" className="vg-notice">{error}</p>}
  </>;
}
