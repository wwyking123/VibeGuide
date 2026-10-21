import assert from 'node:assert/strict';
import test from 'node:test';
import * as sources from '../dist/continuity/sources.js';

const { assertUserSource, userSources } = sources;
const clone = value => structuredClone(value);
const content = text => [{ type: 'text', text }];
const callId = 'call-ask-registration-capacity';
const userId = 'cd2747a5-214d-4713-8bf1-11b97f559a9c';
const toolMessageId = '6eeb7db5-50cd-49a1-8ded-46fb5c158173';
const lateMessageId = '7b424970-1ba1-45d1-b4dd-d1d30317182e';

function userEvent() {
  return {
    type: 'user/message', seq: 3,
    data: { id: userId, role: 'user', source: { kind: 'user' },
      content: [...content('参加者最多20人。'), { type: 'image', url: 'fixture://image' }, ...content('名单不要放在参加者页面。')] },
  };
}

function questionCall() {
  return {
    type: 'tool/call', seq: 4,
    data: { callId, name: 'ask_user_question', arguments: JSON.stringify({ questions: [
      { id: 'capacity', question: '满员后怎样处理？', options: [
        { label: '进入候补', description: '留下信息，但没有参加名额。' },
        { label: '拒绝报名', description: '提示满员，不保存新的报名。' },
      ] },
      { id: 'theme', question: '页面风格？', options: [{ label: '温暖' }, { label: '简洁' }] },
    ] }) },
  };
}

function timelyEvent(answers = [{ id: 'capacity', selected: ['进入候补'] }]) {
  return {
    type: 'tool/result', seq: 5, sourceEventSeqs: [4],
    data: { message: { id: toolMessageId, role: 'tool', toolCallId: callId,
      source: { kind: 'tool', callId }, content: content(JSON.stringify({ answers })) } },
  };
}

function lateEvent(answers = [{ id: 'capacity', selected: ['进入候补'], custom: '请明确告诉候补者还没有名额。' }]) {
  return {
    type: 'user/message', seq: 8,
    data: { id: lateMessageId, role: 'user', source: { kind: 'user-question-reply', callId, outcome: 'answered' },
      content: content(JSON.stringify({ kind: 'answer_to_pending_question', tool: 'ask_user_question', callId, answers })) },
  };
}

function replacePayload(event, payload) {
  const next = clone(event);
  (next.type === 'tool/result' ? next.data.message : next.data).content = content(JSON.stringify(payload));
  return next;
}

function reject(event, events = [questionCall(), event], reference = { seq: event.seq, questionId: 'capacity', quote: '进入候补' }) {
  assert.deepEqual(userSources(event, events), []);
  assert.throws(() => assertUserSource(reference, event, events));
}

test('real user text is quotable, preserving text order while excluding non-text content', () => {
  const event = userEvent();
  assert.deepEqual(userSources(event, [event]), [{ seq: 3, quote: '参加者最多20人。\n名单不要放在参加者页面。' }]);
  assert.doesNotThrow(() => assertUserSource({ seq: 3, quote: '参加者最多20人' }, event, [event]));
  assert.throws(() => assertUserSource({ seq: 3, quote: '我同意公开名单' }, event, [event]));
  assert.throws(() => assertUserSource({ seq: 3, quote: '参加者最多20人', questionId: 'capacity' }, event, [event]));
});

test('assistant, ordinary tool, API and spoofed event sources are not user decisions', () => {
  const cases = [
    event => { event.type = 'assistant/message'; event.data.role = 'assistant'; },
    event => { event.data.role = 'assistant'; },
    event => { event.data.source = { kind: 'api' }; },
    event => { event.data.source = { kind: 'assistant' }; },
    event => { event.data.source = { kind: 'tool', callId: 'ordinary-call' }; },
    event => { delete event.data.source; },
    event => { event.type = 'tool/result'; },
  ];
  for (const mutate of cases) {
    const event = userEvent(); mutate(event);
    reject(event, [event], { seq: event.seq, quote: '参加者最多20人' });
  }
  const call = questionCall();
  call.data.name = 'fetch_api';
  reject(timelyEvent(), [call, timelyEvent()]);
});

test('empty or malformed user text and invalid event sequence cannot become a source', () => {
  for (const value of [[], content(' \n '), [{ type: 'text', text: 123 }], [{ type: 'image', url: 'fixture://only-image' }], undefined]) {
    const event = userEvent(); event.data.content = value;
    reject(event, [event], { seq: event.seq, quote: '参加者最多20人' });
  }
  for (const seq of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '3', undefined]) {
    const event = userEvent(); event.seq = seq;
    reject(event, [event], { seq, quote: '参加者最多20人' });
  }
});

test('timely ask_user_question replies expose only actual selected answers and custom text', () => {
  const event = timelyEvent([
    { id: 'capacity', selected: ['进入候补'], custom: '请明确告诉候补者还没有名额。' },
    { id: 'theme', selected: ['温暖'] },
  ]);
  const events = [questionCall(), event];
  assert.deepEqual(userSources(event, events), [
    { seq: 5, questionId: 'capacity', quote: '进入候补' },
    { seq: 5, questionId: 'capacity', quote: '请明确告诉候补者还没有名额。' },
    { seq: 5, questionId: 'theme', quote: '温暖' },
  ]);
  assert.doesNotThrow(() => assertUserSource({ seq: 5, questionId: 'capacity', quote: '候补者还没有名额' }, event, events));
  assert.doesNotThrow(() => assertUserSource({ seq: 5, questionId: 'theme', quote: '温暖' }, event, events));
  for (const quote of ['拒绝报名', '简洁', '满员后怎样处理？', '留下信息，但没有参加名额。']) {
    assert.throws(() => assertUserSource({ seq: 5, questionId: 'capacity', quote }, event, events));
  }
});

test('late user-question-reply links an answered native message to its original call', () => {
  const pending = replacePayload(timelyEvent(), { status: 'pending' });
  const event = lateEvent();
  const events = [questionCall(), pending, event];
  assert.deepEqual(userSources(event, events), [
    { seq: 8, questionId: 'capacity', quote: '进入候补' },
    { seq: 8, questionId: 'capacity', quote: '请明确告诉候补者还没有名额。' },
  ]);
  assert.doesNotThrow(() => assertUserSource({ seq: 8, questionId: 'capacity', quote: '进入候补' }, event, events));
  assert.throws(() => assertUserSource({ seq: 8, questionId: 'capacity', quote: '拒绝报名' }, event, events));
});

test('timely reply rejects missing, mismatched, ambiguous or future call associations', () => {
  const cases = [
    event => { event.data.message.toolCallId = 'different-call'; },
    event => { event.data.message.source.callId = 'different-call'; },
    event => { delete event.data.message.toolCallId; },
    event => { delete event.sourceEventSeqs; },
    event => { event.sourceEventSeqs = [2, 99]; },
    event => { event.data.message.role = 'assistant'; },
    event => { event.data.message.source.kind = 'api'; },
  ];
  for (const mutate of cases) { const event = timelyEvent(); mutate(event); reject(event); }
  reject(timelyEvent(), [timelyEvent()]);
  const duplicateCall = questionCall(); duplicateCall.seq = 2;
  reject(timelyEvent(), [duplicateCall, questionCall(), timelyEvent()]);
  const futureCall = questionCall(); futureCall.seq = 6;
  reject(timelyEvent(), [futureCall, timelyEvent()]);
  const sameSequenceCall = questionCall(); sameSequenceCall.seq = 5;
  reject(timelyEvent(), [sameSequenceCall, timelyEvent()]);
});

test('late replies reject mismatched tool, payload kind, call ID and unanswered outcomes', () => {
  for (const outcome of ['pending', 'cancelled', 'dismissed', undefined]) {
    const event = lateEvent(); event.data.source.outcome = outcome; reject(event);
  }
  for (const changed of [
    { kind: 'not_an_answer' }, { tool: 'fetch_api' }, { callId: 'different-call' }, { answers: null },
  ]) {
    reject(replacePayload(lateEvent(), {
      kind: 'answer_to_pending_question', tool: 'ask_user_question', callId,
      answers: [{ id: 'capacity', selected: ['进入候补'] }], ...changed,
    }));
  }
  const differentSource = lateEvent(); differentSource.data.source.callId = 'different-call'; reject(differentSource);
  reject(lateEvent(), [lateEvent()]);
});

test('pending, errored and malformed tool responses cannot authorize a user decision', () => {
  const pendingWithAnswers = replacePayload(timelyEvent(), {
    status: 'pending', answers: [{ id: 'capacity', selected: ['进入候补'] }],
  });
  reject(pendingWithAnswers);
  reject(replacePayload(timelyEvent(), { pending: true, callId, answers: [{ id: 'capacity', selected: ['进入候补'] }] }));
  const error = timelyEvent(); error.data.error = 'User question failed'; reject(error);
  const isError = timelyEvent(); isError.data.message.isError = true; reject(isError);
  const invalid = timelyEvent(); invalid.data.message.content = content('{not-json'); reject(invalid);
  for (const payload of [{}, { answers: '进入候补' }, { answers: null }]) reject(replacePayload(timelyEvent(), payload));
  const badCall = questionCall(); badCall.data.arguments = '{not-json';
  reject(timelyEvent(), [badCall, timelyEvent()]);
  const noQuestions = questionCall(); noQuestions.data.arguments = JSON.stringify({ questions: 'not-an-array' });
  reject(timelyEvent(), [noQuestions, timelyEvent()]);
});

test('forged labels and malformed answer IDs fail for both timely and late replies', () => {
  const invalidAnswers = [
    [{ id: 'capacity', selected: ['直接公开名单'] }],
    [{ id: 'capacity', selected: ['进入候补', '伪造选项'] }],
    [{ id: 'capacity', selected: [123] }],
    [{ id: 'capacity', selected: '进入候补' }],
    [{ id: 'capacity' }],
    [{ id: 'capacity', selected: ['进入候补'], custom: { text: '伪造' } }],
    [{ id: 'not-the-question', selected: ['进入候补'] }],
    [{ id: 123, selected: ['进入候补'] }],
    [{ selected: ['进入候补'] }],
    [{ id: 'capacity', selected: ['进入候补'] }, { id: 'capacity', selected: ['拒绝报名'] }],
  ];
  for (const answers of invalidAnswers) {
    reject(timelyEvent(answers));
    reject(lateEvent(answers));
  }
  const call = questionCall();
  const args = JSON.parse(call.data.arguments);
  args.questions.push(clone(args.questions[0]));
  call.data.arguments = JSON.stringify(args);
  reject(timelyEvent(), [call, timelyEvent()]);
  reject(lateEvent(), [call, lateEvent()]);
});

test('empty selections provide no decision, but an actual custom reply remains usable', () => {
  reject(timelyEvent([{ id: 'capacity', selected: [], custom: ' \n ' }]));
  reject(lateEvent([{ id: 'capacity', selected: [] }]));
  const event = timelyEvent([{ id: 'capacity', selected: [], custom: '这次先不设上限。' }]);
  const events = [questionCall(), event];
  assert.deepEqual(userSources(event, events), [{ seq: 5, questionId: 'capacity', quote: '这次先不设上限。' }]);
  assert.doesNotThrow(() => assertUserSource({ seq: 5, questionId: 'capacity', quote: '先不设上限' }, event, events));
});

test('source references require the exact sequence and question ID, a real quote and bounded length', () => {
  for (const event of [timelyEvent(), lateEvent()]) {
    const events = [questionCall(), event];
    for (const questionId of [undefined, '', 'theme', 'unknown', 123]) {
      assert.throws(() => assertUserSource({ seq: event.seq, questionId, quote: '进入候补' }, event, events));
    }
    for (const seq of [event.seq - 1, String(event.seq), undefined]) {
      assert.throws(() => assertUserSource({ seq, questionId: 'capacity', quote: '进入候补' }, event, events));
    }
    for (const quote of ['', '  ', '拒绝报名']) {
      assert.throws(() => assertUserSource({ seq: event.seq, questionId: 'capacity', quote }, event, events));
    }
  }
  const event = userEvent(); event.data.content = content('字'.repeat(4001));
  assert.throws(() => assertUserSource({ seq: event.seq, quote: '字'.repeat(4001) }, event, [event]));
  assert.doesNotThrow(() => assertUserSource({ seq: event.seq, quote: '字'.repeat(4000) }, event, [event]));
});

test('sourceMessageId uses the original native message ID for ordinary, timely and late events', () => {
  assert.equal(typeof sources.sourceMessageId, 'function');
  const ordinary = userEvent(); ordinary.id = 'outer-event-id';
  assert.equal(sources.sourceMessageId(ordinary), userId);
  const timely = timelyEvent(); timely.id = 'outer-event-id'; timely.data.id = 'tool-envelope-id';
  assert.equal(sources.sourceMessageId(timely), toolMessageId);
  const late = lateEvent(); late.id = 'outer-event-id';
  assert.equal(sources.sourceMessageId(late), lateMessageId);
});

test('sourceMessageId rejects absent, empty or non-string IDs without falling back to envelope IDs', () => {
  assert.equal(typeof sources.sourceMessageId, 'function');
  for (const factory of [userEvent, timelyEvent, lateEvent]) {
    for (const id of [undefined, null, '', ' \n ', 7, {}, []]) {
      const event = factory();
      event.id = 'outer-event-id';
      if (event.type === 'tool/result') { event.data.id = 'tool-envelope-id'; event.data.message.id = id; }
      else event.data.id = id;
      assert.throws(() => sources.sourceMessageId(event));
    }
  }
});
