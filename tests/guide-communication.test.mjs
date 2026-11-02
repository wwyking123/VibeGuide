import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommunicationService } from '../dist/guide/communication.js';
import { GuideStore } from '../dist/guide/store.js';
import { GuideError } from '../dist/guide/contracts.js';
import { classifyInput, isRequirement, routeQuestion } from '../dist/guide/intent.js';
import { splitSuggestion } from '../dist/guide/host/adapter.js';
import { hash } from '../dist/guide/files.js';
import { HarnessAdapter } from '../dist/guide/host/adapter.js';
import { readOutbox, saveOutbox, clearOutbox } from '../dist/client/outbox.js';

const scope = { projectId: 'project-one', sessionId: 'session-one' };
const signal = () => new AbortController().signal;
const choice = { id: 'storage', version: 'choice-v1', question: '回答保存在哪里？', state: 'pending',
  source: { sessionId: scope.sessionId, seq: 1 }, options: [{ id: 'local', label: '只在本机' }, { id: 'cloud', label: '换手机也能看' }] };
const view = (extra = {}) => ({ scope, projectName: 'fixture', enabled: true, throughSeq: 1, basis: 'basis-1', observations: [], choices: [],
  model: { status: 'ready', route: { provider: 'fixture', model: 'fixture' } }, limitations: [], ...extra });
const req = (id, statement, extra = {}) => ({ ...scope, clientRequestId: id, statement, basis: 'basis-1', ...extra });

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'vibeguide-communication-'));
  let store = await GuideStore.open(directory), current = view(), explains = 0;
  const sends = [], receipts = new Map(), composed = [];
  const host = {
    snapshot: async () => current,
    queueModification: async (sessionId, content, id, _signal, expected) => {
      assert.equal(hash(expected), hash(current.scope));
      const record = await store.read(expected);
      assert.equal(record.deliveries.find(row => row.requestId === id).state, 'dispatching', 'durable boundary must precede host admission');
      sends.push({ sessionId, content, id }); receipts.set(id, { state: 'accepted', source: { sessionId, seq: 2 } });
    },
    deliveryStatus: async (_session, id) => receipts.get(id) ?? { state: 'unknown' },
    compose: async (_snapshot, source) => { composed.push(source); return source.suggestion; },
  };
  const explain = async request => {
    explains++;
    const answer = { id: `answer-${explains}`, scope, basis: request.basis, question: request.question, text: '换手机以后原回答不会出现。',
      state: 'current', model: { provider: 'fixture', model: 'fixture' }, createdAt: 'fixture', cached: false };
    await store.update(scope, r => r.explanations.push(answer)); return answer;
  };
  let service = new CommunicationService(host, store, explain);
  const seed = async (id, suggestion = '请添加每日提醒') => {
    const answerId = `answer-for-${id}`;
    if (!(await store.read(current.scope)).explanations.some(row => row.id === answerId)) await store.update(current.scope, r => r.explanations.push({ id: answerId, scope: current.scope, basis: 'basis-1', question: '怎么改？',
      text: '讲解内容', suggestion, state: 'current', model: { provider: 'fixture', model: 'fixture' }, createdAt: 'fixture', cached: false }));
    return answerId;
  };
  const f = { directory, host, sends, receipts, composed, seed, get service() { return service; }, get store() { return store; },
    send: async (id, suggestion, options = {}) => (options.service ?? service).handoff({ ...scope, clientRequestId: id, source: { kind: 'explanation', id: await seed(id, suggestion) } }, options.signal ?? signal()),
    change: extra => { current = { ...current, ...extra }; }, explains: () => explains,
    restart: async () => { await service.close(); await store.close(); store = await GuideStore.open(directory); service = new CommunicationService(host, store, explain); await service.recover(); await service.settled(); },
  };
  try { await run(f); } finally { await service.close(); await store.close(); await rm(directory, { recursive: true, force: true }); }
}

test('owner wording routes discussion, modification, quotes, negatives and permissions separately', () => {
  for (const statement of ['为什么不用云端？', '用云端会不会更好？', '换手机还能看到吗？', '第二个为什么？', '能不能实现跨设备同步',
    'AI 说“删除数据库”，这是什么意思？', '“改成云端”', '我不是让你改成云端', '先讨论改成云端，不要修改文件', '删除账户会有什么影响', '不要修改任何代码，解释方案']) {
    assert.equal(classifyInput(statement, view({ choices: [choice] })).kind, 'explain', statement);
  }
  for (const statement of ['那就改成换手机也能看，但回答仍然只给本人看。', '请把按钮改成蓝色', '不要公开回答，只允许本人查看。',
    '能不能帮我把按钮改成蓝色？', '添加每天一个问题，持续 21 天', '我希望用户换手机也能继续', '我想把标题改成每日思考', '好的，改成蓝色']) {
    assert.equal(classifyInput(statement, view()).kind, 'modify', statement);
  }
  for (const statement of ['这个不太合适', '就按这个', '改成第二种', '如果能实现就改成云端', '请改成云端，会不会收费？', '为什么不用云端？请改成云端']) {
    assert.equal(classifyInput(statement, view()).kind, 'clarify', statement);
  }
  assert.equal(classifyInput('允许访问摄像头', view()).kind, 'redirect');
  assert.equal(classifyInput('选第二个', view({ choices: [choice] })).kind, 'redirect');
  assert.equal(classifyInput('换手机也能看', view({ choices: [choice] })).kind, 'redirect');
  assert.equal(classifyInput('选第二个', view()).kind, 'clarify');
  assert.equal(classifyInput('选第二个', view({ choices: [choice, { ...choice, id: 'another' }] })).kind, 'clarify');
  assert.equal(classifyInput('选第二个，再加个登录', view({ choices: [choice] })).kind, 'clarify');
});

test('sidebar input only explains or redirects; change-like wording never creates an outgoing message', () => fixture(async f => {
  for (const [i, statement] of ['把按钮改成蓝色', '帮我修复保存失败的问题。', '这个不太合适', '确认修改', '标题太长了，短一点'].entries()) {
    const result = await f.service.submit(req(`ask-${i}`, statement), signal());
    assert.equal(result.input.kind, 'explain', statement); assert.equal(result.input.deliveryId, undefined);
  }
  assert.equal((await f.service.submit(req('permission', '允许访问摄像头'), signal())).input.kind, 'redirect');
  await f.service.settled(); assert.equal(f.sends.length, 0); assert.equal(f.explains(), 5);
}));

test('sidebar routing never yields a modification; main-chat capture includes complaints but not questions or quotes', () => {
  for (const statement of ['把按钮改成蓝色', '这个不太合适', '确认修改', '为什么不用云端？']) assert.equal(routeQuestion(statement, view()).kind, 'explain', statement);
  assert.equal(routeQuestion('选第二个', view({ choices: [choice] })).kind, 'redirect');
  assert.equal(routeQuestion('选第二个', view()).kind, 'redirect');
  assert.equal(routeQuestion('批准', view()).kind, 'redirect');
  for (const statement of ['把按钮改成蓝色', '标题太长了，短一点', '登录老是失败', '保存失败了，帮我修一下', '发布后找不到自己的好消息'])
    assert.equal(isRequirement(statement, view()), true, statement);
  for (const statement of ['为什么保存失败？', 'AI 说“登录失败”', '先不要修复，只解释登录失败', '能不能实现跨设备同步', '选第二个'])
    assert.equal(isRequirement(statement, view({ choices: [choice] })), false, statement);
});

test('a sendable change is split from the explanation only when marked', () => {
  assert.deepEqual(splitSuggestion('只是解释。'), { text: '只是解释。' });
  assert.deepEqual(splitSuggestion('影响是这样。\n\n【可发送的改法】：请把回答改成仅自己可见。'), { text: '影响是这样。', suggestion: '请把回答改成仅自己可见。' });
  assert.deepEqual(splitSuggestion('影响。\n【可发送的改法】'), { text: '影响。' });
});

test('questions explain without creating any outgoing message; exact replay does not regenerate', () => fixture(async f => {
  const input = req('question', '换手机还能看到吗？');
  const a = await f.service.submit(input, signal()), b = await f.service.submit(input, signal());
  assert.equal(a.input.kind, 'explain'); assert.equal(a.explanation.id, b.explanation.id);
  assert.equal(f.explains(), 1); assert.equal(f.sends.length, 0);
  await f.restart(); await f.service.submit(input, signal()); assert.equal(f.explains(), 1);
  f.change({ basis: 'basis-2' }); assert.equal((await f.service.submit(input, signal())).explanation.state, 'historical');
}));

test('one click sends the written request once and records it as the owner requirement', () => fixture(async f => {
  const suggestion = '请把回答改成换手机也能看，但仍然只给本人看，21 天后也不删除。';
  const first = await f.send('click', suggestion); await f.service.settled();
  assert.equal(first.input.kind, 'modify'); assert.equal(f.sends.length, 1); assert.equal(f.sends[0].content, suggestion);
  assert.equal(f.composed.length, 1); assert.equal(f.composed[0].suggestion, suggestion);
  assert.equal((await f.send('click', suggestion)).delivery.id, first.delivery.id); await f.service.settled();
  assert.equal(f.sends.length, 1); assert.equal(f.composed.length, 1);
  const { items } = await f.service.requirements.list(scope);
  assert.equal(items.length, 1); assert.equal(items[0].text, suggestion);
}));

test('concurrent duplicate clicks and restarts deliver once; a request id cannot change its source', () => fixture(async f => {
  await f.seed('dup');
  const [a, b] = await Promise.all([f.send('dup'), f.send('dup')]);
  assert.equal(a.input.deliveryId, b.input.deliveryId); await f.service.settled();
  assert.equal(f.sends.length, 1); assert.equal(f.composed.length, 1);
  await f.restart(); await f.send('dup'); await f.service.settled(); assert.equal(f.sends.length, 1);
  await f.seed('other', '请删除全部回答');
  await assert.rejects(f.service.handoff({ ...scope, clientRequestId: 'dup', source: { kind: 'explanation', id: 'answer-for-other' } }, signal()), { code: 'request_conflict' });
}));

test('trouble next steps send by index; missing suggestions or steps send nothing', () => fixture(async f => {
  const analysis = { id: 'trouble-1', projectId: scope.projectId, scope, requestId: 'r', requestDigest: 'd', cacheKey: 'c', kind: 'trouble', question: '卡在哪？', createdAt: 'fixture',
    basis: { digest: 'b', files: {}, complete: true, capturedAt: 'fixture' }, requirementBasis: 'w', summary: '保存检查一直失败', impacts: [], unknowns: [], nodes: [], possibleAdditions: [], sources: [],
    observedChanges: 0, coveredChanges: 0, nextSteps: [{ label: '先查失败条件', reason: '能确认原因', request: '请先找出保存检查失败的条件，保留已有回答。' }] };
  await f.store.updateProject(scope.projectId, p => { p.analyses.push(analysis); });
  await f.service.handoff({ ...scope, clientRequestId: 'step', source: { kind: 'step', id: 'trouble-1', index: 0 } }, signal()); await f.service.settled();
  assert.equal(f.sends[0].content, '请先找出保存检查失败的条件，保留已有回答。');
  await assert.rejects(f.service.handoff({ ...scope, clientRequestId: 'no-step', source: { kind: 'step', id: 'trouble-1', index: 2 } }, signal()), { code: 'context_changed' });
  await f.store.update(scope, r => r.explanations.push({ id: 'plain', scope, basis: 'basis-1', question: '为什么？', text: '只是解释', state: 'current', model: { provider: 'fixture', model: 'fixture' }, createdAt: 'fixture', cached: false }));
  await assert.rejects(f.service.handoff({ ...scope, clientRequestId: 'plain-click', source: { kind: 'explanation', id: 'plain' } }, signal()), { code: 'context_changed' });
  await f.service.settled(); assert.equal(f.sends.length, 1);
}));

test('no model or a failed write sends nothing; a new click can try again', () => fixture(async f => {
  await f.seed('no-model'); f.change({ model: { status: 'not_configured' } });
  await assert.rejects(f.send('no-model'), { code: 'model_unavailable' }); f.change({ model: { status: 'ready', route: { provider: 'fixture', model: 'fixture' } } });
  const compose = f.host.compose; f.host.compose = async () => { throw new GuideError('explanation_failed', 'fixture failure'); };
  await assert.rejects(f.send('broken'), { code: 'explanation_failed' });
  assert.equal((await f.store.read(scope)).inputs.find(row => row.id === 'broken').state, 'failed');
  f.host.compose = async () => '   '; await assert.rejects(f.send('empty'), { code: 'invalid_handoff' });
  f.host.compose = compose; await f.send('retry'); await f.service.settled(); assert.equal(f.sends.length, 1);
}));

test('an interrupted write is not resumed or sent after restart', () => fixture(async f => {
  await f.store.update(scope, record => record.inputs.push({ id: 'interrupted-click', digest: 'fixture', statement: '请添加提醒', statements: ['请添加提醒'], basis: 'basis-1', createdAt: 'fixture', kind: 'modify', state: 'pending', handoff: { kind: 'explanation', id: 'x' } }));
  await f.restart(); assert.equal((await f.store.read(scope)).inputs[0].state, 'failed'); assert.equal(f.sends.length, 0);
}));

test('original-question answers redirect; stale choices never apply to new questions', () => fixture(async f => {
  f.change({ choices: [choice] });
  const result = await f.service.submit(req('answer', '选第二个'), signal());
  assert.equal(result.input.kind, 'redirect'); assert.equal(result.input.choiceId, 'storage');
  f.change({ basis: 'basis-2', choices: [{ ...choice, version: 'v2' }] });
  const late = await f.service.submit(req('late-answer', '选第二个'), signal());
  assert.equal(late.input.kind, 'redirect'); assert.equal(late.input.choiceId, undefined);
  assert.equal(f.sends.length, 0); assert.equal(f.explains(), 0);
}));

test('a pending question does not block a separate click', () => fixture(async f => {
  f.change({ choices: [choice] });
  await f.send('new-change', '请把标题改成每日思考'); await f.service.settled(); assert.equal(f.sends.length, 1);
}));

test('saving admission failure cannot call host; failed claims remain unsent', () => fixture(async f => {
  await f.seed('no-save');
  const update = f.store.update.bind(f.store); let reject = true;
  f.store.update = (...args) => { if (reject) throw new GuideError('record_failed', 'fixture disk failure'); return update(...args); };
  await assert.rejects(f.send('no-save'), { code: 'record_failed' });
  assert.equal(f.sends.length, 0); reject = false;
  await f.send('no-save'); await f.service.settled(); assert.equal(f.sends.length, 1);
}));

test('lost host response is reconciled without resend, including after restart', () => fixture(async f => {
  const queue = f.host.queueModification;
  f.host.queueModification = async (...args) => { await queue(...args); throw new Error('response lost after admission'); };
  await f.send('lost'); await f.service.settled();
  assert.equal((await f.store.read(scope)).deliveries[0].state, 'accepted');
  await f.restart(); assert.equal(f.sends.length, 1);
}));

test('uncertain durable dispatch claim cannot call host or become a retry after restart', () => fixture(async f => {
  await f.seed('uncertain-claim'); await f.seed('unrelated-change', '请把标题改成每日思考');
  const update = f.store.update.bind(f.store); let fail = true;
  f.store.update = async (...args) => {
    const result = await update(...args);
    if (fail && result.deliveries.some(row => row.state === 'dispatching')) { fail = false; throw new GuideError('record_unknown', 'read-back failed'); }
    return result;
  };
  await f.send('uncertain-claim'); await f.service.settled();
  assert.equal(f.sends.length, 0); assert.equal((await f.store.read(scope)).deliveries[0].state, 'dispatching');
  await f.restart(); assert.equal((await f.store.read(scope)).deliveries[0].state, 'unknown'); assert.equal(f.sends.length, 0);
  await f.send('unrelated-change'); await f.service.settled();
  assert.equal(f.sends.length, 1, 'an unknown request does not block an independent click');
}));

test('closing after admission preserves the outgoing request; abort before admission saves nothing', () => fixture(async f => {
  await f.seed('cancelled-before');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.send('cancelled-before', undefined, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal((await f.store.read(scope)).inputs.length, 0);
  f.service.kick = () => {};
  const after = new AbortController(); await f.send('accepted-before-close', undefined, { signal: after.signal }); after.abort();
  await f.restart(); assert.equal(f.sends.length, 1, 'a UI disconnect cannot cancel a durably admitted request');
}));

test('unknown transport result never retries, later real evidence updates receipt', () => fixture(async f => {
  let attempts = 0; f.host.queueModification = async () => { attempts++; throw new Error('transport broke'); };
  await f.send('unknown'); await f.service.settled();
  let delivery = (await f.store.read(scope)).deliveries[0]; assert.equal(delivery.state, 'unknown');
  await f.restart(); await f.send('unknown'); await f.service.settled(); assert.equal(attempts, 1);
  f.receipts.set(delivery.requestId, { state: 'queued' }); await f.service.records(scope); await f.service.settled();
  assert.equal((await f.store.read(scope)).deliveries[0].state, 'queued');
  f.receipts.set(delivery.requestId, { state: 'accepted', source: { sessionId: scope.sessionId, seq: 99 } });
  await f.service.records(scope); await f.service.settled(); delivery = (await f.store.read(scope)).deliveries[0];
  assert.equal(delivery.state, 'accepted'); assert.equal(delivery.source.seq, 99); assert.equal(attempts, 1);
}));

test('native admission timeout stays unknown and a late successful admission is reconciled once', () => fixture(async f => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  f.host.queueModification = async (sessionId, content, id) => {
    calls++; assert.equal((await f.store.read(scope)).deliveries[0].state, 'dispatching');
    await gate; f.sends.push({ sessionId, content, id }); f.receipts.set(id, { state: 'accepted', source: { sessionId, seq: 2 } });
  };
  const service = new CommunicationService(f.host, f.store, async () => { throw new Error('must not explain'); }, 10);
  const keepAlive = setTimeout(() => release(), 500);
  try {
    await f.send('native-timeout', undefined, { service }); await service.settled();
    assert.equal((await f.store.read(scope)).deliveries[0].state, 'unknown'); assert.equal(calls, 1);
    release(); await gate; await new Promise(resolve => setTimeout(resolve, 20));
    await service.records(scope); await service.settled();
    assert.equal((await f.store.read(scope)).deliveries[0].state, 'accepted'); assert.equal(calls, 1);
  } finally { release(); clearTimeout(keepAlive); await service.close(); }
}));

test('crash boundary resumes pending only; dispatching without evidence becomes unknown', () => fixture(async f => {
  // Pause worker scheduling after durable admission to emulate each crash boundary.
  f.service.kick = () => {};
  await f.send('before-dispatch', '请添加每日提醒');
  await f.send('during-dispatch', '请把标题改成思考');
  await f.store.update(scope, record => { record.deliveries[1].state = 'dispatching'; });
  await f.restart();
  const record = await f.store.read(scope); assert.equal(record.deliveries[0].state, 'accepted'); assert.equal(record.deliveries[1].state, 'unknown');
  assert.equal(f.sends.length, 1); assert.equal(f.sends[0].content, '请添加每日提醒');
}));

test('project switch, mode changes and forged scope fail without sending elsewhere', () => fixture(async f => {
  await f.seed('changed-before-send');
  f.change({ scope: { ...scope, projectId: 'project-two' } });
  await assert.rejects(f.service.handoff({ ...scope, clientRequestId: 'wrong-project', source: { kind: 'explanation', id: 'answer-for-changed-before-send' } }, signal()), { code: 'scope_changed' });
  f.change({ scope, enabled: false });
  await assert.rejects(f.send('wrong-mode'), { code: 'mode_required' });
  f.change({ enabled: true });
  f.host.queueModification = async () => { throw new GuideError('scope_changed', '项目在实际发送前改变'); };
  await f.send('changed-before-send'); await f.service.settled();
  assert.equal((await f.store.read(scope)).deliveries[0].state, 'failed'); assert.equal(f.sends.length, 0);
}));

test('reload does not regenerate a pending explanation or send its words as a task', () => fixture(async f => {
  await f.store.update(scope, record => record.inputs.push({ id: 'interrupted', digest: 'fixture', statement: '为什么？', statements: ['为什么？'], basis: 'basis-1', createdAt: 'fixture', kind: 'explain', state: 'pending' }));
  await f.restart(); assert.equal((await f.store.read(scope)).inputs[0].state, 'failed');
  assert.equal(f.explains(), 0); assert.equal(f.sends.length, 0);
}));

test('P1 records load without rewrite; malformed delivery payload is preserved and rejected', () => fixture(async f => {
  const file = join(f.store.directory, `${hash(scope)}.json`);
  const old = { ...(await f.store.read(scope)) }; delete old.inputs; delete old.deliveries;
  const bytes = JSON.stringify(old); await writeFile(file, bytes);
  assert.deepEqual((await f.store.read(scope)).deliveries, []); assert.equal(await readFile(file, 'utf8'), bytes);
  await f.send('recorded'); await f.service.settled();
  const data = JSON.parse(await readFile(file, 'utf8')); data.deliveries[0].content = 'changed silently'; await writeFile(file, JSON.stringify(data));
  await assert.rejects(f.store.read(scope), { code: 'record_unavailable' }); assert.match(await readFile(file, 'utf8'), /changed silently/);
}));

test('native receipt reconciliation detects duplicate RPC IDs, mismatched content and inherited evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vibeguide-receipt-')); let events = [], inheritedEventCount = 0;
  const adapter = new HarnessAdapter({ sessionQuery: { observeSession: async () => ({ header: { cwd: directory }, events, inheritedEventCount, projections: {}, [Symbol.dispose]() {} }) } }, {});
  const event = seq => ({ type: 'user/message', seq, data: { id: `message-${seq}`, role: 'user', source: { kind: 'user', rpcId: 'request' }, content: [{ type: 'text', text: 'original' }] } });
  try {
    events = [event(1), event(2)]; assert.equal((await adapter.deliveryStatus('s', 'request')).state, 'conflict');
    events = [event(1)]; assert.equal((await adapter.deliveryStatus('s', 'request', { scope, contentDigest: hash('different') })).state, 'conflict');
    inheritedEventCount = 2; assert.equal((await adapter.deliveryStatus('s', 'request')).state, 'unknown');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('browser outbox survives reopen, isolates projects and reuses IDs without automatic sending', () => {
  const map = new Map(), storage = { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key) };
  const request = req('browser-id', '不要公开回答'); saveOutbox(storage, request);
  assert.deepEqual(readOutbox(storage, scope), request); assert.equal(readOutbox(storage, { ...scope, projectId: 'other' }), undefined);
  clearOutbox(storage, { ...request, clientRequestId: 'different' }); assert.deepEqual(readOutbox(storage, scope), request);
  clearOutbox(storage, request); assert.equal(readOutbox(storage, scope), undefined);
  assert.throws(() => saveOutbox({ ...storage, setItem() {} }, request), /尚未发送/);
});
