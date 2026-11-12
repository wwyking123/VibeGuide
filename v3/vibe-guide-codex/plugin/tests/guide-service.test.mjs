import assert from 'node:assert/strict';
import test from 'node:test';
import { GuideService } from '../dist/guide/service.js';
import { HarnessAdapter } from '../dist/guide/host/adapter.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function fixture() {
  let basis = 'version-1', calls = 0;
  const host = {
    snapshot: async sessionId => ({ scope: { projectId: `project-${sessionId}`, sessionId }, projectName: sessionId,
      enabled: sessionId !== 'ordinary', throughSeq: 1, basis, observations: [], choices: [],
      model: { status: 'ready', route: { provider: 'fixture', model: 'fixture' } }, limitations: [] }),
    explain: async () => { calls++; return '换手机后，原来的回答不会自动出现。'; },
  };
  return { host, service: new GuideService(host), change: value => { basis = value; }, calls: () => calls };
}
const request = (clientRequestId = 'ask-1', sessionId = 'one') => ({ sessionId, clientRequestId, basis: 'version-1', question: '保存到本机有什么影响？' });
const signal = () => new AbortController().signal;

test('snapshot is deterministic, mode-gated and never calls model', async () => {
  const f = fixture();
  await f.service.getSnapshot({ sessionId: 'one' });
  await assert.rejects(f.service.getSnapshot({ sessionId: 'ordinary' }), { code: 'mode_required' });
  await assert.rejects(f.service.getSnapshot({ sessionId: 'one', projectId: 'forged' }), { code: 'invalid_input' });
  assert.equal(f.calls(), 0);
});

test('double-submit shares one call; changed content cannot reuse an id', async () => {
  const f = fixture();
  const [a, b] = await Promise.all([f.service.ask(request(), signal()), f.service.ask(request(), signal())]);
  assert.deepEqual(a, b); assert.equal(f.calls(), 1);
  await assert.rejects(f.service.ask({ ...request(), question: '改成云端' }, signal()), { code: 'request_conflict' });
});

test('effective cache is scoped to project, session, question and basis', async () => {
  const f = fixture();
  await f.service.ask(request(), signal());
  assert.equal((await f.service.ask(request('ask-2'), signal())).cached, true);
  assert.equal((await f.service.ask(request('ask-3', 'two'), signal())).cached, false);
  f.change('version-2');
  await assert.rejects(f.service.ask(request('ask-4'), signal()), { code: 'basis_changed' });
  assert.equal(f.calls(), 2);
});

test('new progress during generation makes the answer historical', async () => {
  const f = fixture();
  f.host.explain = async () => { f.change('version-2'); return '当时的讲解'; };
  assert.equal((await f.service.ask(request(), signal())).state, 'historical');
});

test('choice explanation receives only the selected question and rejects incomplete references', async () => {
  const f = fixture(), base = f.host.snapshot;
  f.host.snapshot = async id => ({ ...await base(id), choices: [
    { id: 'storage', version: 'v1', question: '保存在哪里？' },
    { id: 'privacy', version: 'v2', question: '谁能看到？' },
  ] });
  f.host.explain = async snapshot => {
    assert.deepEqual(snapshot.choices.map(item => item.id), ['privacy']); return '仅本人可见';
  };
  await assert.rejects(f.service.ask({ ...request(), choiceVersion: 'v1' }, signal()), { code: 'invalid_input' });
  const answer = await f.service.ask({ ...request(), choiceId: 'privacy', choiceVersion: 'v2' }, signal());
  assert.equal(answer.text, '仅本人可见');
});

test('failed read-only explanation can retry its id; replayed answer loses current status after progress', async () => {
  const f = fixture(); let first = true;
  f.host.explain = async () => { if (first) { first = false; throw new Error('temporary fixture failure'); } return 'retry worked'; };
  await assert.rejects(f.service.ask(request(), signal()), /temporary fixture failure/);
  assert.equal((await f.service.ask(request(), signal())).text, 'retry worked');
  f.change('new-basis');
  assert.equal((await f.service.ask(request(), signal())).state, 'historical');
});

test('cancelling explanation never invokes the main agent; dispose prevents new work', async () => {
  const f = fixture(), controller = new AbortController();
  f.host.explain = async (_snapshot, _question, abort) => new Promise((resolve, reject) => {
    abort.addEventListener('abort', () => reject(abort.reason), { once: true });
    controller.abort();
  });
  await assert.rejects(f.service.ask(request(), controller.signal), { name: 'AbortError' });
  f.service.dispose();
  await assert.rejects(f.service.getSnapshot({ sessionId: 'one' }), { code: 'unavailable' });
});

test('too many simultaneous explanations fail before dispatch; current choice requires its version', async () => {
  const f = fixture();
  f.host.explain = (_snapshot, _question, abort) => new Promise((_resolve, reject) => {
    abort.throwIfAborted();
    abort.addEventListener('abort', () => reject(abort.reason), { once: true });
  });
  const a = f.service.ask(request('a'), signal());
  const b = f.service.ask(request('b', 'two'), signal());
  await assert.rejects(f.service.ask(request('c'), signal()), { code: 'explanation_busy' });
  f.service.dispose();
  const settled = await Promise.allSettled([a, b]);
  assert.ok(settled.every(result => result.status === 'rejected'));
  const next = fixture();
  await assert.rejects(next.service.ask({ ...request(), choiceId: 'old', choiceVersion: 'old-version' }, signal()), { code: 'choice_changed' });
});

test('adapter uses one immutable cut, current directory/preset and real user message shape', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vibeguide-adapter-'));
  let releases = 0;
  const adapter = new HarnessAdapter({ sessionQuery: { observeSession: async () => ({
    header: { cwd: directory, agentPreset: 'standard' }, cursor: 2,
    projections: { values: { agentPreset: 'vibeguide', workingDirectory: directory,
      modelSelection: { next: { provider: 'fixture', model: 'next' }, lastUsed: null } } },
    events: [{ seq: 2, type: 'user/message', surfaceOp: 'append', data: { id: 'real-user-id', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '不要公开名单' }] } }],
    [Symbol.dispose]: () => { releases++; },
  }) } }, {});
  try {
    const view = await adapter.snapshot('session-1');
    assert.equal(view.enabled, true); assert.equal(view.observations[0].text, '不要公开名单');
    assert.equal(view.model.route.model, 'next'); assert.equal(releases, 1);
    assert.ok(!JSON.stringify(view).includes(directory), 'wire never leaks absolute project path');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('forked history is neither fresh progress, a pending child question nor delivery to that child', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vibeguide-fork-'));
  const adapter = new HarnessAdapter({ sessionQuery: { observeSession: async () => ({
    header: { cwd: directory, agentPreset: 'vibeguide' }, cursor: 2, inheritedEventCount: 3,
    events: [
      { seq: 0, type: 'user/message', surfaceOp: 'append', data: { id: 'parent-user', role: 'user',
        source: { kind: 'user', rpcId: 'parent-delivery' }, content: [{ type: 'text', text: '父会话要求' }] } },
      { seq: 1, type: 'assistant/message', surfaceOp: 'append', data: { message: { role: 'assistant', id: 'parent-assistant', content: [{ type: 'text', text: '父会话已完成' }] } } },
      { seq: 2, type: 'tool/call', data: { callId: 'parent-question', name: 'ask_user_question', arguments: '{"questions":[{"id":"q","question":"父会话的问题？"}]}' } },
    ], [Symbol.dispose]: () => {},
  }) } }, {});
  try {
    const view = await adapter.snapshot('child');
    assert.deepEqual(view.observations, []); assert.deepEqual(view.choices, []);
    assert.equal((await adapter.deliveryStatus('child', 'parent-delivery')).state, 'unknown');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
