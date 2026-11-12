import { contextRef } from '../guide/contracts.js';
import type { InputRequest, Scope } from '../guide/contracts.js';
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>;
const key = (scope: Scope) => `vibeguide:outbox:v2:${scope.sessionId}:${scope.projectId}`;
/** A restored draft is never automatically sent. Only an explicit submit can reuse its ID. */
export function readOutbox(storage: Storage, scope: Scope): InputRequest | undefined {
  const raw = storage.getItem(key(scope)); if (!raw) return;
  const value = JSON.parse(raw);
  if (value?.sessionId !== scope.sessionId || value?.projectId !== scope.projectId
    || typeof value.statement !== 'string' || value.statement.length > 4000
    || typeof value.clientRequestId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(value.clientRequestId)
    || typeof value.basis !== 'string' || value.basis.length > 100
    || (value.replyTo !== undefined && typeof value.replyTo !== 'string')) throw new Error('提交草稿无法核对，请保留原话并检查浏览器存储。');
  if (value.context !== undefined) contextRef(value.context);
  if (value.background !== undefined && (!Array.isArray(value.background) || value.background.length > 40 || value.background.some((ref: any) => typeof ref?.id !== 'string' || typeof ref.version !== 'string'))) throw new Error('历史选择无法核对，请保留原话并重新选择。');
  return { sessionId: value.sessionId, projectId: value.projectId, clientRequestId: value.clientRequestId,
    statement: value.statement, basis: value.basis, ...(value.replyTo ? { replyTo: value.replyTo } : {}), ...(value.context ? { context: value.context } : {}), ...(value.background !== undefined ? { background: value.background } : {}) };
}
export function saveOutbox(storage: Storage, request: InputRequest) {
  const encoded = JSON.stringify(request); storage.setItem(key(request), encoded);
  if (storage.getItem(key(request)) !== encoded) throw new Error('提交标识未能保存，这次尚未发送。请保留原话后重试。');
}
export function clearOutbox(storage: Storage, request: InputRequest) {
  const saved = readOutbox(storage, request);
  if (saved?.clientRequestId === request.clientRequestId) storage.removeItem(key(request));
}
