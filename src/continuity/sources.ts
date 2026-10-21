/** Host event data stays untrusted until its type, sender and question linkage agree. */
export type Event = { type: string; seq: number; data: any; sourceEventSeqs?: number[] };
export type UserSource = { seq: number; quote: string; questionId?: string };
const messageText = (message: any): string => Array.isArray(message?.content)
  ? message.content.filter((c: any) => c?.type === 'text' && typeof c.text === 'string').map((c: any) => c.text).join('\n') : '';
function parse(value: unknown) { try { return typeof value === 'string' ? JSON.parse(value) : undefined; } catch { return undefined; } }

/** Native message IDs survive session forks; model-supplied identities are never used. */
export function sourceMessageId(event: Event): string {
  const id = event.type === 'tool/result' ? event.data?.message?.id : event.data?.id;
  if (typeof id !== 'string' || !id.trim() || id.length > 300 || id.includes('\0')) throw new Error('User source has no stable native message ID.');
  return id;
}

export function userSources(event: Event, events: Event[]): UserSource[] {
  if (!Number.isSafeInteger(event.seq) || event.seq < 0) return [];
  if (event.type === 'user/message' && event.data?.role === 'user' && event.data?.source?.kind === 'user') {
    const quote = messageText(event.data);
    return quote.trim() ? [{ seq: event.seq, quote }] : [];
  }
  let callId: string;
  let answers: any;
  if (event.type === 'tool/result') {
    const message = event.data?.message;
    if (event.data?.error || message?.isError || message?.role !== 'tool' || message?.source?.kind !== 'tool') return [];
    callId = message.toolCallId;
    if (typeof callId !== 'string' || message.source.callId !== callId) return [];
    const payload = parse(messageText(message));
    if (payload?.pending === true || payload?.status === 'pending') return [];
    answers = payload?.answers;
  } else if (event.type === 'user/message' && event.data?.role === 'user'
    && event.data?.source?.kind === 'user-question-reply' && event.data?.source?.outcome === 'answered') {
    callId = event.data.source.callId;
    const payload = parse(messageText(event.data));
    if (payload?.kind !== 'answer_to_pending_question' || payload.tool !== 'ask_user_question' || payload.callId !== callId) return [];
    answers = payload.answers;
  } else return [];
  if (!Array.isArray(answers)) return [];
  const calls = events.filter(e => e.seq < event.seq && e.type === 'tool/call' && e.data?.callId === callId && e.data?.name === 'ask_user_question');
  if (calls.length !== 1) return [];
  const call = calls[0]!;
  if (event.type === 'tool/result' && !event.sourceEventSeqs?.includes(call.seq)) return [];
  const questions = parse(call.data.arguments)?.questions;
  if (!Array.isArray(questions)) return [];
  const output: UserSource[] = [];
  const answered = new Set<string>();
  for (const answer of answers) {
    if (typeof answer?.id !== 'string' || answered.has(answer.id)) return [];
    answered.add(answer.id);
    const matching = questions.filter((q: any) => q?.id === answer.id);
    if (matching.length !== 1) return [];
    const q = matching[0];
    if (!Array.isArray(answer.selected)) return [];
    if (answer.selected.some((label: unknown) => typeof label !== 'string' || !q.options?.some((o: any) => o?.label === label))) return [];
    if (answer.custom !== undefined && typeof answer.custom !== 'string') return [];
    const values = [...answer.selected, ...(answer.custom?.trim() ? [answer.custom] : [])];
    for (const quote of values) if (quote.trim()) output.push({ seq: event.seq, questionId: answer.id, quote });
  }
  return output;
}

export function assertUserSource(reference: UserSource, event: Event, events: Event[]) {
  if (!reference.quote?.trim() || reference.quote.length > 4000 || reference.seq !== event.seq) throw new Error('Invalid source reference.');
  const possible = userSources(event, events);
  if (!possible.some(s => s.questionId === reference.questionId && s.quote.includes(reference.quote))) {
    throw new Error('来源不是本会话用户原话或已选择答案；不能把助手、工具输出或未选项记成用户决定。');
  }
}
