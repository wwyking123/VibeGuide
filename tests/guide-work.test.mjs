import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GuideStore } from '../dist/guide/store.js';
import { ProgressTracker } from '../dist/guide/progress.js';
import { GuideService } from '../dist/guide/service.js';
import { captureFiles, hash } from '../dist/guide/files.js';
import { executionOrigin } from '../dist/guide/host/lineage.js';
import { withBackground } from '../dist/guide/requirements.js';
import { readOutbox, saveOutbox } from '../dist/client/outbox.js';

const signal = () => new AbortController().signal;
const native = exitCode => ({ isError: false, value: { kind: 'foreground', exitCode }, content: [{ type: 'text', text: `exit ${exitCode}` }] });
async function fixture(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'vg-p4-'))), root = join(dir, 'project'); await mkdir(root);
  await writeFile(join(root, 'app.js'), 'const answer = "before";');
  const store = await GuideStore.open(join(dir, 'state')), tracker = new ProgressTracker(store), projectId = hash(root);
  const scope = sessionId => ({ sessionId, projectId: sessionId === 'foreign' ? 'foreign' : projectId });
  let calls = 0, source, sent = [], moved = false;
  const host = { tracker, projectFor: async id => ({ scope: moved ? { ...scope(id), projectId: 'moved' } : scope(id), enabled: true, root }),
    snapshot: async id => ({ scope: moved ? { ...scope(id), projectId: 'moved' } : scope(id), enabled: true,
      projectName: 'p4', basis: (await captureFiles(root)).digest, throughSeq: 1, choices: [], observations: [],
      model: { status: 'ready', route: { provider: 'fixture', model: 'fixture' } }, limitations: [], explanations: (await store.read(scope(id))).explanations }),
    structured: async (_snapshot, task, input) => {
      calls++; source = input;
      if (task === 'trial') return JSON.stringify({ steps: [{ action: '打开自己的回答', expected: '能看见' }, { action: '换其他账号查看', expected: '不能查看本人回答' }] });
      return JSON.stringify({ summary: task === 'goal' ? '需要考虑保存和身份' : '实际保存内容已变化', impacts: ['当前资料不证明权限已经正确'],
        nodes: [{ title: '回答保存', reason: '与换手机查看相关', files: ['app.js'] }], possibleAdditions: ['可能需要身份识别'], unknowns: ['跨设备未验证'], sources: ['app.js'] });
    },
    explain: async () => { calls++; return '只解释'; },
    saveExplanation: answer => store.update(answer.scope, record => record.explanations.push(answer)),
    queueModification: async (sessionId, content, id) => { sent.push({ sessionId, content, id }); },
    deliveryStatus: async () => ({ state: 'accepted', source: { sessionId: 's2', seq: 9 } }),
  };
  const service = new GuideService(host), project = service.project, requirements = project.work.requirements;
  const req = (id, extra = {}) => ({ sessionId: 's1', projectId, clientRequestId: id, ...extra });
  const base = { sessionId: 's1', projectId };
  const original = async (text = '把回答改为仅自己可见，不让其他用户查看，最多保存21天。', id = 'rq-original') => {
    await store.update(scope('s1'), record => record.requirements.push({ id, scope: scope('s1'), text, createdAt: '2026-10-28T00:00:00Z', source: { sessionId: 's1', seq: 1 } }));
    return (await requirements.list(scope('s1'))).items.find(row => row.id === id);
  };
  const operations = async () => {
    const origin = { turn: 1, startSeq: 0, callSeq: 2, userSeqs: [1] };
    const edit = await tracker.begin(scope('s1'), root, { callId: 'edit', name: 'write', arguments: { description: '更新回答显示范围' } }, origin);
    await writeFile(join(root, 'app.js'), 'const answer = "after";'); await tracker.finish(edit, { isError: false, content: [] });
    const check = await tracker.begin(scope('s1'), root, { callId: 'check', name: 'bash', arguments: { command: 'node --test', description: '检查自己的回答与其他账号的访问' } }, origin);
    await tracker.finish(check, native(0));
  };
  const prepare = async () => {
    const row = await original(); await operations();
    const card = await project.prepareReview(req('trial', { requirement: { id: row.id, version: row.version } }), signal());
    return { row, card };
  };
  const bind = async (row, card, extra = {}) => {
    const outcome = (await project.view(base, signal())).work.outcomes.find(item => item.requirement.id === row.id);
    return project.work.bind(req('bind', { requirement: { id: row.id, version: row.version }, trialId: card.id, evidenceVersion: outcome.evidenceVersion,
      coverage: card.steps.map(step => ({ stepId: step.id, changes: [{ sessionId: 's1', id: 'edit' }], checks: [{ sessionId: 's1', id: 'check' }] })), scopeConfirmed: true, ...extra }), signal());
  };
  t.after(async () => { service.dispose(); await service.communication.close(); await project.close(); await tracker.close(); await rm(dir, { recursive: true, force: true }); });
  return { root, scope, store, tracker, service, project, requirements, original, operations, prepare, bind, req, base, host,
    calls: () => calls, sent: () => sent, source: () => source, move: () => { moved = true; } };
}

test('native lineage uses persisted turn identity and refuses ambiguous, inherited or missing users', () => {
  const events = [{ seq: 0, type: 'turn/start', data: { turn: 2 } }, { seq: 1, type: 'user/message', surfaceOp: 'append', data: { source: { kind: 'user' } } },
    { seq: 3, type: 'tool/call', data: { turn: 2, callId: 'call' } }];
  assert.deepEqual(executionOrigin(events, 'child', 0, 'call').userSeqs, [1]);
  assert.equal(executionOrigin(events, 'call', 2), undefined);
  assert.equal(executionOrigin([...events, { ...events[1], seq: 2 }], 'call'), undefined);
  assert.equal(executionOrigin(events.map(e => e.seq === 1 ? { ...e, data: { source: { kind: 'assistant' } } } : e), 'call'), undefined);
});

test('only real explicit user requirements are captured; quotes and questions stay explanations', async t => {
  const f = await fixture(t), messages = ['把回答改为仅自己可见。', '为什么不用云端？', 'AI说“把回答公开”', '允许访问', '不要修改文件，只解释影响'];
  const events = messages.map((text, seq) => ({ seq, type: 'user/message', surfaceOp: 'append', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } }));
  await f.tracker.snapshot({ scope: f.scope('s1'), root: f.root, events, throughSeq: events.length - 1, segmentStart: 0, waiting: false });
  assert.deepEqual((await f.requirements.list(f.scope('s1'))).items.map(row => row.text), [messages[0]]);
  assert.equal(f.calls(), 0);
});

test('actual before/after capture is bounded and concurrent writes never grant exclusive ownership', async t => {
  const f = await fixture(t); await f.operations();
  const op = (await f.store.read(f.scope('s1'))).operations[0];
  assert.equal(op.changeOwnership, 'exclusive'); assert.match(op.sourceChanges[0].before, /before/); assert.match(op.sourceChanges[0].after, /after/);
  const a = await f.tracker.begin(f.scope('s1'), f.root, { callId: 'a', name: 'write' });
  const b = await f.tracker.begin(f.scope('s2'), f.root, { callId: 'b', name: 'write' });
  await writeFile(join(f.root, 'app.js'), 'overlap'); await f.tracker.finish(a, native(0)); await f.tracker.finish(b, native(0));
  assert.equal((await f.store.read(f.scope('s1'))).operations.find(row => row.id === 'a').changeOwnership, 'unknown');
});

test('completion requires full confirmed scope, real changes, current checks and feedback for every step', async t => {
  const f = await fixture(t), { row, card } = await f.prepare();
  let view = await f.project.view(f.base, signal()); assert.equal(view.work.outcomes[0].state, 'needs_scope');
  await f.bind(row, card); assert.equal((await f.project.view(f.base, signal())).work.outcomes[0].state, 'needs_feedback');
  const feedback = i => f.project.feedback(f.req(`feedback-${i}`, { cardId: card.id, stepId: card.steps[i].id, fileDigest: card.basis.digest, result: 'pass' }), signal());
  await feedback(0); assert.equal((await f.project.view(f.base, signal())).work.outcomes[0].state, 'needs_feedback');
  await feedback(1); view = await f.project.view(f.base, signal()); assert.equal(view.work.outcomes[0].state, 'complete');
  assert.match(view.work.outcomes[0].message, /确认的范围/); assert.equal(f.sent().length, 0);
  await f.project.feedback(f.req('negative', { cardId: card.id, stepId: card.steps[0].id, fileDigest: card.basis.digest, result: 'fail' }), signal());
  assert.equal((await f.project.view(f.base, signal())).work.outcomes[0].state, 'feedback_failed');
  await writeFile(join(f.root, 'app.js'), 'new version'); assert.equal((await f.project.view(f.base, signal())).work.outcomes[0].state, 'stale');
});

test('scope rejects wrong-project evidence, missing steps, unconfirmed mapping and stale evidence', async t => {
  const f = await fixture(t), { row, card } = await f.prepare();
  await assert.rejects(f.bind(row, card, { scopeConfirmed: false }), { code: 'invalid_input' });
  await assert.rejects(f.bind(row, card, { coverage: [{ stepId: card.steps[0].id, changes: [], checks: [] }] }), { code: 'invalid_input' });
  await assert.rejects(f.bind(row, card, { evidenceVersion: 'old' }), { code: 'basis_changed' });
  await assert.rejects(f.bind(row, card, { coverage: card.steps.map(step => ({ stepId: step.id, changes: [{ sessionId: 'foreign', id: 'edit' }], checks: [{ sessionId: 's1', id: 'check' }] })) }), { code: 'basis_changed' });
});

test('later related failing checks are not hidden by a selected older pass', async t => {
  const f = await fixture(t), { row, card } = await f.prepare(); await f.bind(row, card);
  const check = await f.tracker.begin(f.scope('s1'), f.root, { callId: 'failed', name: 'bash', arguments: { command: 'node --test', description: '新增权限检查' } }, { turn: 1, startSeq: 0, callSeq: 6, userSeqs: [1] });
  await f.tracker.finish(check, native(1));
  assert.equal((await f.project.view(f.base, signal())).work.outcomes[0].state, 'check_failed');
});

test('same-project history carries exact negatives, numbers and roles; no cross-project or model text', async t => {
  const f = await fixture(t), row = await f.original();
  const before = await f.project.view({ ...f.base, sessionId: 's2' }, signal()); assert.equal(before.work.requirements[0].forwarded, 'not_forwarded');
  const request = f.req('send', { sessionId: 's2', basis: (await f.host.snapshot('s2')).basis, statement: '把回答保存改成换手机也能看。' });
  const result = await f.service.submit(request, signal()); await f.service.communication.settled();
  assert.equal(result.delivery.background[0].text, row.text); assert.equal(f.sent()[0].content, withBackground(request.statement, result.delivery.background));
  assert.equal((await f.project.view({ ...f.base, sessionId: 's2' }, signal())).work.requirements.find(r => r.id === row.id).forwarded, 'accepted');
  assert.equal((await f.requirements.list(f.scope('foreign'))).items.length, 0); assert.equal(f.calls(), 0);
  await f.service.submit(request, signal()); await f.service.communication.settled(); assert.equal(f.sent().length, 1);
});

test('changed or retired requirements stop old transfer and invalidate old trial feedback', async t => {
  const f = await fixture(t), { row, card } = await f.prepare(), background = await f.requirements.background(f.scope('s2'), '回答保存');
  const revision = f.req('revise', { requirement: { id: row.id, version: row.version }, text: '回答只在本机保存，不跨设备。', state: 'active', applicability: 'project' });
  await f.project.work.revise(revision, signal()); assert.deepEqual(await f.project.work.revise(revision, signal()), (await f.store.readProject(f.base.projectId)).requirementRevisions[0]);
  await assert.rejects(f.requirements.validateBackground(f.scope('s2'), background), { code: 'requirement_changed' });
  await assert.rejects(f.project.feedback(f.req('old-feedback', { cardId: card.id, stepId: card.steps[0].id, fileDigest: card.basis.digest, result: 'pass' }), signal()), { code: 'requirement_changed' });
  const current = (await f.requirements.list(f.scope('s2'))).items[0]; assert.equal(current.originalText, row.text); assert.equal(current.forwarded, 'not_forwarded');
  assert.equal((await f.requirements.background(f.scope('s2'), '把标题换成开始。'))[0].text, revision.text);
});

test('selected history including empty selection survives outbox and never triggers a send for questions', async t => {
  const f = await fixture(t), row = await f.original(), values = new Map(), storage = { getItem: k => values.get(k), setItem: (k, v) => values.set(k, v), removeItem: k => values.delete(k) };
  for (const background of [[], [{ id: row.id, version: row.version }]]) {
    const req = f.req(`question-${background.length}`, { statement: '保存有什么影响？', basis: (await f.host.snapshot('s1')).basis, background });
    saveOutbox(storage, req); assert.deepEqual(readOutbox(storage, f.scope('s1')).background, background);
    await f.service.submit(req, signal()); assert.equal(f.sent().length, 0);
  }
});

test('a revision between background validation and dispatch commit fails without sending stale history', async t => {
  const f = await fixture(t), row = await f.original(), comm = f.service.communication, validate = comm.requirements.validateBackground.bind(comm.requirements);
  comm.requirements.validateBackground = async (...args) => {
    const revision = await validate(...args);
    await f.project.work.revise(f.req('race', { requirement: { id: row.id, version: row.version }, text: '回答只保存7天，不分享。', state: 'active', applicability: 'related' }), signal());
    return revision;
  };
  const request = f.req('send-race', { sessionId: 's2', basis: (await f.host.snapshot('s2')).basis, statement: '把回答保存改成换手机也能看。' });
  const result = await f.service.submit(request, signal()); await comm.settled();
  assert.equal(f.sent().length, 0);
  assert.equal((await f.store.read(f.scope('s2'))).deliveries.find(row => row.id === result.delivery.id).state, 'failed');
});

test('no before-after material produces an honest deterministic answer without a model call', async t => {
  const f = await fixture(t), answer = await f.project.analyze(f.req('no-diff', { kind: 'changes', question: '这次实际改动有什么影响？' }), signal());
  assert.equal(f.calls(), 0); assert.equal(answer.impacts.length, 0); assert.equal(answer.coveredChanges, 0); assert.match(answer.summary, /没有可核对/);
});

test('unknown corrupt history is visible and does not become complete through partial records', async t => {
  const f = await fixture(t); await f.original();
  await writeFile(join(f.store.directory, `${'a'.repeat(64)}.json`), '{broken');
  assert.equal((await f.project.view(f.base, signal())).work.historyIncomplete, true);
  await assert.rejects(f.requirements.background(f.scope('s2'), '回答保存'), { code: 'history_incomplete' });
  assert.deepEqual(await f.requirements.background(f.scope('s2'), '回答保存', []), []);
});

test('explicit change analysis uses actual before/after and goal locator grounds files without executing', async t => {
  const f = await fixture(t); await f.original(); await f.operations();
  await f.project.view(f.base, signal()); assert.equal(f.calls(), 0);
  const req = f.req('change-analysis', { kind: 'changes', question: '这次实际改动有什么影响？' });
  const changes = await f.project.analyze(req, signal()); assert.equal(changes.coveredChanges, 1); assert.match(f.source().changes[0].before, /before/);
  assert.equal((await f.project.analyze({ ...req, clientRequestId: 'cache' }, signal())).id, changes.id); assert.equal(f.calls(), 1);
  const snapshot = await f.host.snapshot('s1');
  const answer = await f.service.submit(f.req('goal', { statement: '如果换手机也能看回答，需要改哪些部分？', basis: snapshot.basis }), signal());
  assert.equal(answer.input.kind, 'explain'); assert.ok(answer.explanation.analysisId); assert.equal(f.sent().length, 0);
  const before = f.calls(); await f.project.view(f.base, signal()); await f.service.getSnapshot({ sessionId: 's1' }); assert.equal(f.calls(), before);
  await writeFile(join(f.root, 'app.js'), 'later'); assert.equal((await f.project.view(f.base, signal())).work.analyses.at(-1).historical, true);
});

test('invented analysis files or nodes are rejected and late project results cannot cross projects', async t => {
  const f = await fixture(t), original = f.host.structured;
  f.host.structured = async (...args) => { const v = JSON.parse(await original(...args)); v.nodes[0].files = ['secret.key']; return JSON.stringify(v); };
  await assert.rejects(f.project.analyze(f.req('bad', { kind: 'goal', question: '哪些部分？' }), signal()), { code: 'invalid_generation' });
  assert.equal((await f.store.readProject(f.base.projectId)).analyses.length, 0);
  f.host.structured = async (...args) => { const result = await original(...args); f.move(); return result; };
  await assert.rejects(f.project.analyze(f.req('late', { kind: 'goal', question: '哪些部分？' }), signal()), { code: 'scope_changed' });
});

test('correcting a goal explanation retires its analysis cache and follow-up uses only the correction', async t => {
  const f = await fixture(t), snapshot = await f.host.snapshot('s1');
  const request = { sessionId: 's1', clientRequestId: 'goal-original', basis: snapshot.basis, question: '换手机需要改哪些部分？' };
  const answer = await f.service.ask(request, signal()), history = (await f.project.history(f.base, signal())).items[0];
  const analysis = (await f.store.readProject(f.base.projectId)).analyses.find(row => row.id === answer.analysisId);
  await f.project.annotate(f.req('correct-analysis', { explanationId: answer.id, version: history.contextVersion, action: 'correct', text: '只保存本机，不需要跨设备。' }), signal());
  const follow = await f.project.resolve(snapshot, { kind: 'analysis', id: analysis.id, version: analysis.cacheKey });
  assert.match(follow.text, /只保存本机/); assert.ok(!follow.text.includes(analysis.summary));
  await f.service.ask({ ...request, clientRequestId: 'goal-new' }, signal()); assert.equal(f.calls(), 2);
  assert.equal((await f.project.view(f.base, signal())).work.analyses.find(row => row.id === analysis.id).historical, true);
});

test('old records remain byte-identical on read while absent work arrays get in-memory defaults', async t => {
  const f = await fixture(t), scope = f.scope('s1'); await f.original();
  const sessionPath = join(f.store.directory, `${hash(scope)}.json`), old = JSON.parse(await readFile(sessionPath)); delete old.requirements;
  await writeFile(sessionPath, JSON.stringify(old)); const before = await readFile(sessionPath);
  await f.project.view(f.base, signal()); assert.deepEqual(await readFile(sessionPath), before); assert.deepEqual((await f.store.read(scope)).requirements, []);
});
