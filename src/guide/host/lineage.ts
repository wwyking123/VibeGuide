import type { Operation } from '../contracts.js';
import type { NativeEvent } from '../progress.js';

/** Uses the host's persisted turn/call identity, never wall-clock adjacency or file overlap. */
export function executionOrigin(events: NativeEvent[], callId: string, boundary = 0, rootCallId?: string): Operation['origin'] {
  const calls = events.filter(event => event.seq >= boundary && event.type === 'tool/call' && event.data?.callId === (rootCallId ?? callId));
  if (calls.length !== 1) return;
  const call = calls[0], turn = call.data.turn;
  if (!Number.isSafeInteger(turn)) return;
  const start = events.filter(event => event.seq >= boundary && event.seq < call.seq && event.type === 'turn/start' && event.data?.turn === turn).at(-1);
  if (!start || events.some(event => event.seq > start.seq && event.seq < call.seq && event.type === 'turn/end')) return;
  const users = events.filter(event => event.seq > start.seq && event.seq < call.seq && event.type === 'user/message'
    && event.surfaceOp === 'append' && event.data?.source?.kind === 'user');
  // Mid-turn additional user input makes attribution ambiguous, and remains explicitly unresolved.
  if (users.length !== 1) return;
  return { turn, startSeq: start.seq, callSeq: call.seq, userSeqs: users.map(event => event.seq) };
}
