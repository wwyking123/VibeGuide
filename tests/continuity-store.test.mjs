import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectStore } from '../dist/continuity/store.js';

async function fixture(t) {
  const temporary = await mkdtemp(join(tmpdir(), 'vibeguide-store-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const project = join(temporary, 'project');
  const storage = join(temporary, 'state');
  await mkdir(project);
  return { temporary, project, storage, store: await ProjectStore.forProject(storage, project) };
}
const source = (seq = 1, extra = {}) => ({ sessionId: 's1', messageId: `m${seq}`, seq, quote: '名单只有组织者可见', ...extra });
const requirement = (id, extra = {}) => ({ type: 'requirement', id, text: '名单只有组织者可见', kind: 'requirement', source: source(), ...extra });
const write = (store, expectedRevision, operationId, changes, sessionId = 's1') => store.write({ expectedRevision, operationId, changes, sessionId });
const task = (id, extra = {}) => ({ type: 'task', id, status: 'in_progress', progress: '页面已修改；尚未检查运行效果。', nextStep: '检查页面效果。', files: [], ...extra });

test('requirements survive reopening, corrections preserve other decisions, project paths stay isolated', async t => {
  const { project, storage, store, temporary } = await fixture(t);
  assert.equal((await write(store, 0, 'op1', [
    { type: 'start_task', id: 'signup', title: '修改报名页面' },
    requirement('privacy', { taskId: 'signup' }),
    requirement('limit', { text: '最多 20 人', source: source(2) }),
  ])).status, 'saved');
  const reopened = await ProjectStore.forProject(storage, project);
  assert.equal((await reopened.read()).requirements.length, 2);
  assert.equal((await write(reopened, 1, 'op2', [requirement('limit30', { text: '改成最多 30 人', source: source(3), replaces: 'limit' })])).status, 'saved');
  const record = await reopened.read();
  assert.equal(record.requirements.find(r => r.id === 'limit').status, 'superseded');
  assert.deepEqual(record.requirements.filter(r => r.status === 'active').map(r => r.id), ['privacy', 'limit30']);
  const alias = join(temporary, 'alias'); await symlink(project, alias);
  assert.equal((await ProjectStore.forProject(storage, alias)).projectId, store.projectId);
  const other = join(temporary, 'other'); await mkdir(other);
  assert.equal((await (await ProjectStore.forProject(storage, other)).read()).revision, 0);
});

test('forget removes content and blocks re-extraction across quotes and forked sessions', async t => {
  const { store, project } = await fixture(t);
  const code = join(project, 'app.js'); await writeFile(code, '// code must remain');
  assert.equal((await write(store, 0, 'op1', [requirement('privacy')])).status, 'saved');
  assert.equal((await write(store, 1, 'op2', [{ type: 'forget', id: 'privacy', source: source(2, { quote: '不要再记住这一条' }) }])).status, 'saved');
  assert.equal(await readFile(code, 'utf8'), '// code must remain');
  const raw = await readFile(store.recordPath, 'utf8');
  assert.equal(raw.includes('名单只有组织者可见'), false);
  assert.equal((await write(store, 2, 'op3', [requirement('new-id', { source: source(1, { quote: '组织者可见' }) })])).status, 'failed');
  assert.equal((await write(store, 2, 'op4', [requirement('fork-id', { source: source(99, { sessionId: 'fork', messageId: 'm1' }) })], 'fork')).status, 'failed');
  assert.equal((await store.read()).revision, 2);
  assert.equal((await write(store, 2, 'op5', [requirement('reconfirmed', { source: source(3) })])).status, 'saved');
});

test('pause/cancel cannot be bypassed through an intermediate task status', async t => {
  const { store } = await fixture(t);
  await write(store, 0, 'op1', [{ type: 'start_task', id: 'a', title: 'A' }, { type: 'start_task', id: 'b', title: 'B' }]);
  await write(store, 1, 'op2', [task('a', { status: 'cancelled', source: source(2, { quote: '取消 A' }) })]);
  const bypass = await write(store, 2, 'op3', [task('a', { status: 'needs_check' }), task('a')]);
  assert.equal(bypass.status, 'failed');
  assert.equal((await store.read()).tasks[0].status, 'cancelled');
  assert.equal((await store.read()).tasks[1].status, 'in_progress');
  assert.equal((await write(store, 2, 'op4', [task('a', { source: source(3, { quote: '恢复 A' }) })])).status, 'saved');
});

test('forgetting a corrected rule also clears superseded versions without touching unrelated rules', async t => {
  const { store } = await fixture(t);
  await write(store, 0, 'op1', [requirement('old'), requirement('unrelated', { text: '按钮蓝色', source: source(2) })]);
  await write(store, 1, 'op2', [requirement('corrected', { text: '更正后的要求', replaces: 'old', source: source(3) })]);
  await write(store, 2, 'op3', [{ type: 'forget', id: 'corrected', source: source(4, { quote: '忘记这一条及以前的版本' }) }]);
  const record = await store.read();
  assert.deepEqual(record.requirements.map(r => [r.id, r.status]), [['old', 'deleted'], ['unrelated', 'active'], ['corrected', 'deleted']]);
  assert.equal((await write(store, 3, 'op4', [requirement('resurrected', { source: source(1) })])).status, 'failed');
  assert.equal(record.requirements.find(r => r.id === 'old').text, undefined);
});

test('stale and concurrent writers cannot overwrite the newest record; retries are idempotent', async t => {
  const { store, storage, project } = await fixture(t);
  const peer = await ProjectStore.forProject(storage, project);
  const results = await Promise.all([
    write(store, 0, 'op1', [requirement('one')]),
    write(peer, 0, 'op2', [requirement('two', { source: source(2) })]),
  ]);
  assert.equal(results.filter(r => r.status === 'saved').length, 1);
  assert.ok(results.some(r => ['busy', 'conflict'].includes(r.status)));
  assert.equal((await store.read()).revision, 1);
  assert.equal((await write(peer, 0, 'stale', [requirement('stale')])).status, 'conflict');
  const winner = results.findIndex(r => r.status === 'saved');
  assert.equal((await write(store, 0, winner === 0 ? 'op1' : 'op2', [winner === 0 ? requirement('one') : requirement('two', { source: source(2) })])).status, 'unchanged');
  assert.equal((await write(store, 1, winner === 0 ? 'op1' : 'op2', [requirement('different')])).status, 'failed');
  assert.equal((await store.read()).requirements.length, 1);
});

test('failed and unknown saves have distinct outcomes and never execute project changes', async t => {
  const { store, project } = await fixture(t);
  await writeFile(join(project, 'app.js'), '// original');
  const abort = new AbortController(); abort.abort();
  assert.equal((await store.write({ expectedRevision: 0, operationId: 'abort', sessionId: 's1', changes: [requirement('a')] }, abort.signal)).status, 'failed');
  const originalRead = store.read.bind(store); let reads = 0;
  store.read = async () => { if (++reads === 2) throw new Error('Injected readback failure'); return originalRead(); };
  assert.equal((await write(store, 0, 'unknown', [requirement('a')])).status, 'unknown');
  store.read = originalRead;
  assert.equal((await store.read()).revision, 1);
  assert.equal((await write(store, 0, 'unknown', [requirement('a')])).status, 'unchanged');
  assert.equal(await readFile(join(project, 'app.js'), 'utf8'), '// original');
  await writeFile(join(store.directory, 'write.lock'), '{}');
  assert.equal((await write(store, 1, 'locked', [requirement('b')])).status, 'busy');
});

test('corrupt records and unsafe storage are never replaced with empty successful records', async t => {
  const { store, temporary, project } = await fixture(t);
  await write(store, 0, 'op1', [requirement('a')]);
  await writeFile(store.recordPath, '{broken');
  await assert.rejects(store.read());
  assert.equal((await write(store, 0, 'op2', [requirement('b')])).status, 'failed');
  assert.equal(await readFile(store.recordPath, 'utf8'), '{broken');
  const unsafe = join(temporary, 'unsafe'); await symlink(store.storageRoot, unsafe);
  const unsafeStore = await ProjectStore.forProject(unsafe, project);
  assert.equal((await write(unsafeStore, 0, 'op3', [requirement('c')])).status, 'failed');
  const unwritable = join(temporary, 'file'); await writeFile(unwritable, 'file');
  const failedStore = await ProjectStore.forProject(unwritable, project);
  assert.equal((await write(failedStore, 0, 'op4', [requirement('d')])).status, 'failed');
});

test('file observations compare each task baseline and reject escaping paths', async t => {
  const { store, project, temporary } = await fixture(t);
  const file = join(project, 'page.txt'); await writeFile(file, 'v1');
  await write(store, 0, 'op1', [{ type: 'start_task', id: 'a', title: 'A' }, { type: 'start_task', id: 'b', title: 'B' }, task('a', { files: ['page.txt'] })]);
  await writeFile(file, 'v2');
  await write(store, 1, 'op2', [task('b', { files: ['page.txt'] })]);
  assert.deepEqual((await store.inspect()).files, [
    { taskId: 'a', path: 'page.txt', status: 'changed' },
    { taskId: 'b', path: 'page.txt', status: 'unchanged' },
  ]);
  for (const path of ['../outside', '/etc/hosts', '.env', '.env.local', '.git/config']) await assert.rejects(store.stamp(path));
  await symlink(temporary, join(project, 'outside'));
  await assert.rejects(store.stamp('outside/not-created'));
  await writeFile(join(temporary, 'external.txt'), 'external');
  await assert.rejects(store.stamp('outside/external.txt'));
  assert.deepEqual(await store.stamp('not-created'), { path: 'not-created', sha256: null });
});

test('invalid input is rejected before storage and batch failures leave all prior data intact', async t => {
  const { store } = await fixture(t);
  await assert.rejects(write(store, 0, 'op1', [requirement('a', { source: source(1, { sessionId: 'foreign' }) })]));
  await assert.rejects(write(store, 0, 'op1', [requirement('a', { extra: 'unsupported' })]));
  const batch = await write(store, 0, 'op2', [requirement('valid'), requirement('invalid', { replaces: 'missing' })]);
  assert.equal(batch.status, 'failed');
  assert.equal((await store.read()).revision, 0);
});

test('an AI assumption cannot supersede a confirmed requirement', async t => {
  const { store } = await fixture(t);
  await write(store, 0, 'op1', [requirement('privacy')]);
  assert.equal((await write(store, 1, 'op2', [requirement('guess', { kind: 'assumption', text: '推测可以公开', replaces: 'privacy', source: source(2) })])).status, 'failed');
  assert.equal((await store.read()).requirements[0].status, 'active');
  assert.equal((await write(store, 1, 'op3', [requirement('guess', { kind: 'assumption', text: '待确认的猜测', source: source(2) })])).status, 'saved');
  assert.deepEqual((await store.read()).requirements.map(r => r.kind), ['requirement', 'assumption']);
});
