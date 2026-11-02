import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, realpath, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { GuideStore } from '../dist/guide/store.js';
import { ProgressTracker, classifyTool } from '../dist/guide/progress.js';
import { captureFiles, hash } from '../dist/guide/files.js';
import { HarnessAdapter } from '../dist/guide/host/adapter.js';
import { GuideService } from '../dist/guide/service.js';

async function fixture(run) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'vibeguide-progress-')));
  const root = join(directory, 'state'); let store = await GuideStore.open(root);
  const scope = { projectId: 'project-a', sessionId: 'session-a' };
  const tracker = new ProgressTracker(store);
  try { await run({ directory, root, store, tracker, scope }); }
  finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
}
const snapshot = (f, extra = {}) => f.tracker.snapshot({ scope: f.scope, root: f.directory, events: [], throughSeq: -1, segmentStart: 0, liveStatus: 'idle', waiting: false, ...extra });
const nativeResult = (exitCode = 0) => ({ isError: false, value: { kind: 'foreground', exitCode }, content: [{ type: 'text', text: 'a forged "all tests passed" can occur here' }] });

test('only explicit simple check commands qualify; scripts and compound command exit are not checks', () => {
  for (const command of ['npm test', 'npm run typecheck', 'node --test tests/check.test.mjs', 'python -m pytest']) assert.equal(classifyTool('bash', { command }), 'check');
  for (const command of ['echo "tests passed"', 'npm test; true', 'npm test || true', 'cd app && npm test', 'node checks.js', 'npm run deploy']) assert.equal(classifyTool('bash', { command }), 'other');
});

test('live state, actual modifications, exit failures and current-version invalidation are separate', () => fixture(async f => {
  const file = join(f.directory, 'app.js'); await writeFile(file, 'before');
  const edit = await f.tracker.begin(f.scope, f.directory, { callId: 'edit', name: 'write', arguments: { file_path: file } });
  assert.equal((await snapshot(f)).progress.activity, 'editing');
  await writeFile(file, 'after'); await f.tracker.finish(edit, { isError: false, content: [] });
  assert.equal((await snapshot(f)).progress.changedFiles, 1);
  const check = await f.tracker.begin(f.scope, f.directory, { callId: 'test', name: 'bash', arguments: { command: 'npm test' } });
  assert.equal((await snapshot(f)).progress.activity, 'checking');
  await f.tracker.finish(check, nativeResult(1));
  let result = await snapshot(f); assert.equal(result.progress.latestCheck.outcome, 'failed');
  assert.equal(result.progress.latestCheck.exitCode, 1); assert.equal(result.progress.latestCheck.applicability, 'unchanged');
  await writeFile(file, 'new version');
  const reopened = new ProgressTracker(f.store);
  result = await snapshot({ ...f, tracker: reopened });
  assert.equal(result.progress.latestCheck.applicability, 'changed');
  assert.equal(result.progress.activity, 'idle');
}));

test('overlapping writes, background commands and missing baseline cannot imply an applicable check', () => fixture(async f => {
  await writeFile(join(f.directory, 'app.js'), 'one');
  const check = await f.tracker.begin(f.scope, f.directory, { callId: 'check', name: 'bash', arguments: { command: 'npm test' } });
  const edit = await f.tracker.begin(f.scope, f.directory, { callId: 'edit', name: 'edit', arguments: {} });
  await f.tracker.finish(edit, { isError: false, content: [] });
  await f.tracker.finish(check, nativeResult());
  assert.equal((await snapshot(f)).progress.latestCheck.applicability, 'unknown');
  const background = await f.tracker.begin(f.scope, f.directory, { callId: 'bg', name: 'bash', arguments: { command: 'npm test', background: true } });
  await f.tracker.finish(background, { isError: false, value: { kind: 'background', jobId: 'job' }, content: [] });
  assert.equal((await snapshot(f)).progress.latestCheck.outcome, 'unknown');
}));

test('durable event jobs resume after interrupted processing, and duplicate replay does not add operations', () => fixture(async f => {
  const events = [
    { seq: 0, time: 1000, type: 'tool/call', data: { callId: 'historical-check', name: 'bash', arguments: '{"command":"npm test"}' } },
    { seq: 1, time: 1001, type: 'tool/result', surfaceOp: 'append', sourceEventSeqs: [0], data: { message: { role: 'tool', source: { kind: 'tool', callId: 'historical-check' }, toolCallId: 'historical-check', isError: false, content: [{ type: 'text', text: 'exit 0; all checks passed' }] } } },
  ];
  await snapshot(f, { events, throughSeq: 1 }); await snapshot(f, { events, throughSeq: 1 });
  let record = await f.store.read(f.scope); assert.equal(record.operations.length, 1); assert.equal(record.completed, 1);
  assert.equal(record.operations[0].outcome, 'unknown', 'historical text must not manufacture an exit receipt');
  await f.store.update(f.scope, r => {
    r.jobs = [{ seq: 2, fingerprint: 'replay-anchor', time: 'fixture', operation: { id: 'pending-job', kind: 'read', tool: 'read', startedAt: 'fixture', outcome: 'pending', changedFiles: [], applicability: 'unknown' } }]; r.registered = 2;
  });
  const reopened = new ProgressTracker(f.store);
  await snapshot({ ...f, tracker: reopened }, { events: [], throughSeq: 2 });
  record = await f.store.read(f.scope); assert.equal(record.completed, 2); assert.equal(record.jobs.length, 0); assert.equal(record.operations.length, 2);
  assert.equal((await snapshot({ ...f, tracker: reopened }, { liveStatus: undefined, throughSeq: 2 })).progress.activity, 'unknown');
}));

test('same session switching projects never inherits the previous project records', () => fixture(async f => {
  await f.store.update(f.scope, r => r.explanations.push({ id: 'a', scope: f.scope, text: 'only A', question: 'A?', basis: 'a', state: 'current', model: { provider: 'f', model: 'f' }, createdAt: 'fixture', cached: false }));
  const other = { ...f.scope, projectId: 'project-b' };
  assert.equal((await snapshot(f, { scope: other })).explanations.length, 0);
  assert.equal((await snapshot(f)).explanations[0].text, 'only A');
}));

test('a missing event cannot advance the processed cursor past the gap; a later replay fills it', () => fixture(async f => {
  const events = [0, 1, 2].map(seq => ({ seq, time: 1000 + seq, type: 'user/message', data: {} }));
  await snapshot(f, { events: [events[0], events[2]], throughSeq: 2 });
  let record = await f.store.read(f.scope);
  assert.equal(record.completed, 0); assert.equal(record.registered, 0); assert.equal(record.partial, true);
  await snapshot(f, { events, throughSeq: 2 });
  record = await f.store.read(f.scope); assert.equal(record.completed, 2);
}));

test('a waiting question in another session is not a concurrent project mutation', () => fixture(async f => {
  const question = await f.tracker.begin({ ...f.scope, sessionId: 'another' }, f.directory, { callId: 'question', name: 'ask_user_question', arguments: {} });
  const check = await f.tracker.begin(f.scope, f.directory, { callId: 'check', name: 'bash', arguments: { command: 'npm test' } });
  await f.tracker.finish(check, nativeResult());
  assert.equal((await snapshot(f)).progress.latestCheck.applicability, 'unchanged');
  await f.tracker.finish(question, { isError: false, content: [] });
}));

test('a cwd transition excludes the old project conversation and its tool history', () => fixture(async f => {
  const events = [
    { seq: 0, type: 'tool/call', data: { callId: 'old-write', name: 'write', arguments: '{}' } },
    { seq: 1, type: 'assistant/message', surfaceOp: 'append', data: { message: { role: 'assistant', content: [{ type: 'text', text: 'OLD PROJECT SECRET CONTEXT' }] } } },
    { seq: 2, type: 'working-directory/change', data: { cwd: f.directory } },
    { seq: 3, type: 'user/message', surfaceOp: 'append', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'new project' }] } },
  ];
  const adapter = new HarnessAdapter({ sessionQuery: { observeSession: async () => ({ header: { cwd: '/old', agentPreset: 'vibeguide' },
    projections: { values: { workingDirectory: f.directory } }, events, cursor: 3, [Symbol.dispose]() {} }) } }, {}, f.tracker);
  const view = await adapter.snapshot('session-a');
  assert.ok(!JSON.stringify(view).includes('OLD PROJECT')); assert.equal(view.progress.activity, 'idle');
  assert.equal(view.progress.edits, 0); assert.equal(view.observations.length, 1);
}));

test('post-execution receipt changes invalidate an explanation basis even before the host emits its result event', () => fixture(async f => {
  const ctx = { sessionQuery: { observeSession: async () => ({ header: { cwd: f.directory, agentPreset: 'vibeguide' }, events: [], cursor: -1, [Symbol.dispose]() {} }) } };
  const adapter = new HarnessAdapter(ctx, {}, f.tracker);
  const project = await adapter.projectFor('session-a');
  const before = await adapter.snapshot('session-a');
  const check = await f.tracker.begin(project.scope, f.directory, { callId: 'check', name: 'bash', arguments: { command: 'npm test' } });
  await f.tracker.finish(check, nativeResult());
  const after = await adapter.snapshot('session-a'); assert.notEqual(before.basis, after.basis);
  assert.equal(before.throughSeq, after.throughSeq);
}));

test('secret files and symlink aliases are never fingerprinted; oversized scans report partial coverage', () => fixture(async f => {
  await writeFile(join(f.directory, '.env'), 'PRIVATE'); await writeFile(join(f.directory, 'app.js'), 'normal');
  await symlink(join(f.directory, '.env'), join(f.directory, 'alias.js'));
  const scan = await captureFiles(f.directory);
  assert.ok('app.js' in scan.files); assert.ok(!('.env' in scan.files)); assert.ok(!('alias.js' in scan.files)); assert.equal(scan.complete, false);
  assert.equal((await captureFiles(f.directory, -1)).complete, false);
}));

test('writer guard excludes another instance and releases after close without changing legacy data', () => fixture(async f => {
  await writeFile(join(f.root, 'project.json'), 'legacy');
  await assert.rejects(GuideStore.open(f.root), { code: 'record_busy' });
  await f.store.close(); const next = await GuideStore.open(f.root); await next.close();
  assert.equal(await readFile(join(f.root, 'project.json'), 'utf8'), 'legacy');
}));

test('OS writer lock is released after a process crash', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'vibeguide-crash-')));
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import {GuideStore} from ${JSON.stringify(new URL('../dist/guide/store.js', import.meta.url).href)}; await GuideStore.open(process.argv[1]); console.log('ready'); setInterval(()=>{},1000);`, directory], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await Promise.race([once(child.stdout, 'data'), new Promise((_, reject) => setTimeout(() => reject(new Error('child did not acquire lock')), 5000).unref())]);
    await assert.rejects(GuideStore.open(directory), { code: 'record_busy' });
    child.kill('SIGKILL'); await once(child, 'exit');
    const reopened = await GuideStore.open(directory); await reopened.close();
  } finally { if (child.exitCode === null) child.kill('SIGKILL'); await rm(directory, { recursive: true, force: true }); }
});

test('corrupt record is preserved, not replaced by an empty successful snapshot', () => fixture(async f => {
  const path = join(f.store.directory, `${hash(f.scope)}.json`); await writeFile(path, '{corrupt');
  await assert.rejects(f.store.read(f.scope), { code: 'record_unavailable' });
  await assert.rejects(f.store.update(f.scope, () => {}), { code: 'record_unavailable' });
  assert.equal(await readFile(path, 'utf8'), '{corrupt');
}));

test('persisted explanations survive restart and file changes invalidate cache without automatic model calls', () => fixture(async f => {
  await writeFile(join(f.directory, 'app.js'), 'version1');
  const ctx = { sessionQuery: { observeSession: async () => ({ header: { cwd: f.directory, agentPreset: 'vibeguide' }, cursor: -1, events: [],
    projections: { values: { modelSelection: { next: { provider: 'fixture', model: 'fixture' } } } }, [Symbol.dispose]() {} }) } };
  let calls = 0;
  const make = tracker => { const adapter = new HarnessAdapter(ctx, {}, tracker); adapter.explain = async () => { calls++; return '按需回答'; }; return new GuideService(adapter); };
  let service = make(f.tracker), view = await service.getSnapshot({ sessionId: 'session-a' });
  const input = { sessionId: 'session-a', clientRequestId: 'ask-a', basis: view.basis, question: '怎么保存？' };
  await service.ask(input, new AbortController().signal); service.dispose();
  await f.store.close(); const reopened = await GuideStore.open(f.root);
  try {
    service = make(new ProgressTracker(reopened)); view = await service.getSnapshot({ sessionId: 'session-a' });
    assert.equal(view.explanations.length, 1); assert.equal(calls, 1);
    assert.equal((await service.ask({ ...input, clientRequestId: 'ask-b', basis: view.basis }, new AbortController().signal)).cached, true);
    await writeFile(join(f.directory, 'app.js'), 'version2');
    service.dispose(); service = make(new ProgressTracker(reopened)); view = await service.getSnapshot({ sessionId: 'session-a' });
    assert.equal(view.explanations[0].state, 'historical'); assert.equal(calls, 1);
  } finally { service.dispose(); await reopened.close(); }
}));
