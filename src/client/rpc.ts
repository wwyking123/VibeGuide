type RemoteResult = { ok: true; value: unknown } | { ok: false; error?: { code?: string; message?: string } };
type Connection = { rpc: { call: (base: string, method: string, data: unknown, signal: AbortSignal) => Promise<RemoteResult> } };
const unavailable = 'VibeGuide 暂时无法连接，主对话仍可使用。请稍后点击「刷新进展」。';
export class GuideCallError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

/** Keep transport diagnostics out of the non-technical conversation surface. */
export async function guideCall<T>(connection: Connection, method: string, request: unknown, signal: AbortSignal): Promise<T> {
  let result: RemoteResult;
  try {
    result = await connection.rpc.call('/api', `vibeGuide/${method}`, { args: { request } }, signal);
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof Error && /\bHTTP 404\b/.test(error.message)) {
      throw new Error('VibeGuide 后台尚未连接。如果刚更新过 Harness，请更新 VibeGuide 并重新打开应用。主对话仍可使用。');
    }
    throw new Error(unavailable);
  }
  if (!result?.ok) {
    if (result?.error?.code?.startsWith('vibeguide/') && result.error.message) throw new GuideCallError(result.error.code, result.error.message);
    throw new Error(unavailable);
  }
  return result.value as T;
}
