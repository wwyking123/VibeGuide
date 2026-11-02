import { createHash } from 'node:crypto';
import type { Choice } from '../contracts.js';

const MAX_QUESTIONS = 20;
const MAX_OPTIONS = 20;

type NativeOption = { label: string; description?: string };
type NativeQuestion = { id: string; question: string; options: NativeOption[] };
type NativeCall = { callId: string; seq: number; questions: NativeQuestion[] };

type ProjectionView = {
  active: Map<string, NativeQuestion[]>;
  settled: Set<string>;
  invalid: Set<string>;
};

const record = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const bounded = (value: unknown, max: number, nonblank = true): value is string =>
  typeof value === 'string' && value.length <= max && !value.includes('\0') && (!nonblank || !!value.trim());
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function questionsFrom(value: unknown): NativeQuestion[] | undefined {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return; }
  }
  if (!record(value) || !Array.isArray(value.questions)
    || value.questions.length < 1 || value.questions.length > MAX_QUESTIONS) return;

  const ids = new Set<string>();
  const questions: NativeQuestion[] = [];
  for (const item of value.questions) {
    if (!record(item) || !bounded(item.id, 300) || ids.has(item.id)
      || !bounded(item.question, 4000)) return;
    ids.add(item.id);
    if (item.options !== undefined && (!Array.isArray(item.options)
      || item.options.length > MAX_OPTIONS)) return;
    const labels = new Set<string>();
    const options: NativeOption[] = [];
    for (const option of item.options ?? []) {
      if (!record(option) || !bounded(option.label, 500) || labels.has(option.label)
        || option.description !== undefined && !bounded(option.description, 2000, false)) return;
      labels.add(option.label);
      options.push({ label: option.label,
        ...(option.description === undefined ? {} : { description: option.description }) });
    }
    questions.push({ id: item.id, question: item.question, options });
  }
  return questions;
}

function pendingPayload(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  const text = content.find(part => record(part) && part.type === 'text' && typeof part.text === 'string');
  if (!text) return false;
  try { return JSON.parse(text.text).pending === true; } catch { return false; }
}

function nativeCall(event: any): NativeCall | undefined {
  if (!Number.isSafeInteger(event?.seq) || event.seq < 0 || !record(event.data)) return;
  if (event.type === 'tool/call' && event.data.name === 'ask_user_question'
    && bounded(event.data.callId, 300)) {
    const questions = questionsFrom(event.data.arguments);
    if (questions) return { callId: event.data.callId, seq: event.seq, questions };
  }
  if (event.type === 'tool/ptc-dispatch' && event.data.name === 'ask_user_question'
    && event.data.isError !== true && bounded(event.data.subCallId, 300)
    && pendingPayload(event.data.content)) {
    const questions = questionsFrom({ questions: event.data.arguments?.questions });
    if (questions) return { callId: event.data.subCallId, seq: event.seq, questions };
  }
}

function projectionView(value: any): ProjectionView | undefined {
  if (value?.kind !== undefined && value.kind !== 'sequenced') return;
  const candidate = value?.values?.userQuestions ?? value?.userQuestions ?? value;
  if (!record(candidate) || !Array.isArray(candidate.active) || !Array.isArray(candidate.settled)) return;

  const settled = new Set<string>();
  for (const item of candidate.settled) {
    if (record(item) && bounded(item.callId, 300)) settled.add(item.callId);
  }
  const active = new Map<string, NativeQuestion[]>();
  const invalid = new Set<string>();
  for (const item of candidate.active) {
    if (!record(item) || !bounded(item.callId, 300)) continue;
    const questions = questionsFrom({ questions: item.questions });
    if (!['open', 'continued'].includes(item.state) || !questions || active.has(item.callId)) {
      invalid.add(item.callId);
      active.delete(item.callId);
      continue;
    }
    active.set(item.callId, questions);
  }
  for (const callId of invalid) active.delete(callId);
  return { active, settled, invalid };
}

function sameQuestions(left: NativeQuestion[], right: NativeQuestion[]): boolean {
  return digest(left) === digest(right);
}

/**
 * Reconstruct current rc.2 questions without inventing a native event id.
 * Projection-only entries are omitted because Choice requires a real source seq.
 * Malformed or contradictory evidence fails closed instead of reviving an old question.
 */
export function pendingChoices(sessionId: string, events: readonly any[], projection?: any): Choice[] {
  if (!bounded(sessionId, 200) || !Array.isArray(events)) return [];
  const ordered = events.filter(event => Number.isSafeInteger(event?.seq) && event.seq >= 0)
    .sort((left, right) => left.seq - right.seq);

  const calls = new Map<string, NativeCall>();
  const ambiguousCalls = new Set<string>();
  for (const event of ordered) {
    const call = nativeCall(event);
    if (!call) continue;
    if (calls.has(call.callId)) ambiguousCalls.add(call.callId);
    else calls.set(call.callId, call);
  }

  const view = projectionView(projection);
  const resultEvents = new Map<string, any[]>();
  const replies = new Set<string>();
  for (const event of ordered) {
    const message = event?.type === 'tool/result' ? event.data?.message : undefined;
    if (bounded(message?.toolCallId, 300)) {
      const list = resultEvents.get(message.toolCallId) ?? [];
      list.push(event);
      resultEvents.set(message.toolCallId, list);
    }
    const source = event?.type === 'user/message' ? event.data?.source : undefined;
    if (source?.kind === 'user-question-reply' && bounded(source.callId, 300)) replies.add(source.callId);
  }

  const output: Array<{ seq: number; index: number; choice: Choice }> = [];
  for (const [callId, call] of calls) {
    if (ambiguousCalls.has(callId) || replies.has(callId)
      || view?.settled.has(callId) || view?.invalid.has(callId)) continue;
    const projected = view?.active.get(callId);
    if (projected && !sameQuestions(projected, call.questions)) continue;

    const matchingResults = resultEvents.get(callId) ?? [];
    if (matchingResults.length > 1) continue;
    let closed = false;
    let explicitlyPending = false;
    for (const event of matchingResults) {
      if (event.seq <= call.seq) { closed = true; break; }
      const message = event.data?.message;
      const linked = event.surfaceOp === 'append'
        && Array.isArray(event.sourceEventSeqs) && event.sourceEventSeqs.length === 1
        && event.sourceEventSeqs[0] === call.seq
        && message?.role === 'tool' && message?.source?.kind === 'tool'
        && message.source.callId === callId;
      if (!linked) { closed = true; break; }
      if (event.data?.error?.code === 'TOOL_OUTCOME_UNKNOWN') {
        if (!projected) closed = true;
      } else if (event.data?.error === undefined && message.isError !== true
        && pendingPayload(message.content)) explicitlyPending = true;
      else closed = true;
      if (closed) break;
    }
    if (closed) continue;
    if (matchingResults.length > 0 && !explicitlyPending && !projected) continue;

    const questions = projected ?? call.questions;
    questions.forEach((question, index) => {
      const id = `choice-${digest({ sessionId, callId, questionId: question.id }).slice(0, 32)}`;
      const version = digest({ callId, sourceSeq: call.seq, question });
      output.push({ seq: call.seq, index, choice: {
        id, version, question: question.question,
        options: question.options.map((option, optionIndex) => ({
          id: `option-${digest({ id, optionIndex, option }).slice(0, 32)}`,
          label: option.label,
          ...(option.description === undefined ? {} : { description: option.description }),
        })),
        source: { sessionId, seq: call.seq },
        state: 'pending',
      } });
    });
  }
  return output.sort((left, right) => left.seq - right.seq || left.index - right.index)
    .map(item => item.choice);
}
