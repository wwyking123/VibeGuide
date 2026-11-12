import assert from 'node:assert/strict';
import test from 'node:test';

const target = process.env.VIBEGUIDE_TEST_SOURCE === '1'
  ? '../src/guide/host/choices.ts'
  : '../dist/guide/host/choices.js';
const { pendingChoices } = await import(target);

const sessionId = 'session-choice-fixture';
const text = value => [{ type: 'text', text: value }];
const questions = [{
  id: 'storage', question: '回答保存在哪里？', options: [
    { label: '当前浏览器', description: '不用登录，换设备后看不到。' },
    { label: '跨设备保存', description: '需要识别用户并维护共享数据。' },
  ],
}, {
  id: 'visibility', question: '谁能看到回答？', options: [{ label: '仅本人' }, { label: '公开分享' }],
}];

function call(seq = 4, callId = 'call-choice-1', value = questions) {
  return { type: 'tool/call', seq, data: {
    callId, name: 'ask_user_question', arguments: JSON.stringify({ questions: value }),
  } };
}
function result(seq = 5, callId = 'call-choice-1', payload = { answers: [] }) {
  return { type: 'tool/result', seq, surfaceOp: 'append', sourceEventSeqs: [4], data: { message: {
    role: 'tool', toolCallId: callId, source: { kind: 'tool', callId }, content: text(JSON.stringify(payload)),
  } } };
}
function timedProjection(active = [], settled = []) {
  return { kind: 'sequenced', asOfSeq: 5, values: { userQuestions: { active, settled } } };
}

test('reconstructs unmatched legacy calls with stable derived identities and real seq only', () => {
  const first = pendingChoices(sessionId, [call()]);
  const reordered = pendingChoices(sessionId, [
    { type: 'assistant/message', seq: 7, data: {} }, call(),
  ].reverse());
  assert.equal(first.length, 2);
  assert.deepEqual(first, reordered);
  assert.deepEqual(first.map(item => item.question), ['回答保存在哪里？', '谁能看到回答？']);
  assert.deepEqual(first[0].source, { sessionId, seq: 4 });
  assert.equal(Object.hasOwn(first[0].source, 'eventId'), false);
  assert.match(first[0].id, /^choice-[a-f0-9]{32}$/);
  assert.match(first[0].version, /^[a-f0-9]{64}$/);
  assert.deepEqual(first[0].options.map(option => option.label), ['当前浏览器', '跨设备保存']);
  assert.notEqual(first[0].options[0].id, first[0].options[1].id);
});

test('a linked result or admitted late reply closes the legacy question', () => {
  assert.deepEqual(pendingChoices(sessionId, [call(), result()]), []);
  const reply = { type: 'user/message', seq: 8, data: {
    source: { kind: 'user-question-reply', callId: 'call-choice-1', outcome: 'answered' },
    content: text('{"kind":"answer_to_pending_question"}'),
  } };
  assert.deepEqual(pendingChoices(sessionId, [call(), reply]), []);
});

test('uses the exact timed userQuestions projection for pending and continued calls', () => {
  const pendingResult = result(5, 'call-choice-1', { pending: true, callId: 'call-choice-1' });
  const active = [{ callId: 'call-choice-1', questions, state: 'continued' }];
  const choices = pendingChoices(sessionId, [call(), pendingResult], timedProjection(active));
  assert.equal(choices.length, 2);
  assert.ok(choices.every(choice => choice.state === 'pending'));

  const settled = [{ callId: 'call-choice-1', answers: [{ id: 'storage', selected: ['当前浏览器'] }] }];
  assert.deepEqual(pendingChoices(sessionId, [call(), pendingResult], timedProjection([], settled)), []);
});

test('accepts a validated timed PTC pending source but never invents a source for projection-only data', () => {
  const ptc = { type: 'tool/ptc-dispatch', seq: 12, data: {
    name: 'ask_user_question', subCallId: 'ptc-choice-1', arguments: { questions },
    isError: false, content: text('{"pending":true}'),
  } };
  const active = [{ callId: 'ptc-choice-1', questions, state: 'continued' }];
  const choices = pendingChoices(sessionId, [ptc], timedProjection(active));
  assert.equal(choices.length, 2);
  assert.deepEqual(choices[0].source, { sessionId, seq: 12 });
  assert.deepEqual(pendingChoices(sessionId, [], timedProjection(active)), []);
});

test('fails closed on malformed, ambiguous, mismatched or weakly linked evidence', () => {
  const invalidQuestionSets = [
    [{ id: 'same', question: 'A?' }, { id: 'same', question: 'B?' }],
    [{ id: 'blank', question: '  ' }],
    [{ id: 'duplicate-options', question: '选哪个？', options: [{ label: '同名' }, { label: '同名' }] }],
    [{ id: 'bad-option', question: '选哪个？', options: [{ label: 7 }] }],
  ];
  for (const value of invalidQuestionSets) assert.deepEqual(pendingChoices(sessionId, [call(4, 'bad', value)]), []);
  const malformed = call(); malformed.data.arguments = '{not-json';
  assert.deepEqual(pendingChoices(sessionId, [malformed]), []);
  assert.deepEqual(pendingChoices(sessionId, [call(), call(9)]), [], 'duplicate call IDs are ambiguous');

  const unlinked = result(); delete unlinked.sourceEventSeqs;
  assert.deepEqual(pendingChoices(sessionId, [call(), unlinked]), []);
  const extraSource = result(); extraSource.sourceEventSeqs = [3, 4];
  assert.deepEqual(pendingChoices(sessionId, [call(), extraSource]), []);
  const changed = structuredClone(questions); changed[0].question = '另一个问题？';
  assert.deepEqual(pendingChoices(sessionId, [call()], timedProjection([
    { callId: 'call-choice-1', questions: changed, state: 'open' },
  ])), []);
  assert.deepEqual(pendingChoices(sessionId, [call()], timedProjection([
    { callId: 'call-choice-1', questions, state: 'open' },
    { callId: 'call-choice-1', questions, state: 'continued' },
  ])), [], 'duplicate projected call IDs are ambiguous');
});

test('pending result remains current without a projection, while unknown recovery requires projection proof', () => {
  const pendingResult = result(5, 'call-choice-1', { pending: true, callId: 'call-choice-1' });
  assert.equal(pendingChoices(sessionId, [call(), pendingResult]).length, 2);
  const unknown = result(); unknown.data.error = { code: 'TOOL_OUTCOME_UNKNOWN' };
  assert.deepEqual(pendingChoices(sessionId, [call(), unknown]), []);
  assert.equal(pendingChoices(sessionId, [call(), unknown], timedProjection([
    { callId: 'call-choice-1', questions, state: 'continued' },
  ])).length, 2);
});
