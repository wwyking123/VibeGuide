import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, rename, link, symlink, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GuideStore } from '../dist/guide/store.js';
import { GuideSupport } from '../dist/guide/support.js';
import { defaultPreferences } from '../dist/guide/support-types.js';
import { GuideService } from '../dist/guide/service.js';
import { HarnessAdapter } from '../dist/guide/host/adapter.js';
import { ProjectIndex, compareStructure } from '../dist/guide/structure.js';
import { projectEvidence } from '../dist/guide/project-scan.js';
import { captureFiles, hash } from '../dist/guide/files.js';
import { freshProject } from '../dist/guide/project-types.js';
import { troubleView } from '../dist/guide/trouble.js';
import { lookupConcept } from '../dist/guide/glossary.js';
const signal = () => new AbortController().signal;
async function fixture(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'vg-p5-'))), root = join(dir, 'project'); await mkdir(root); await writeFile(join(root, 'app.py'), 'from .store import save\n'); await writeFile(join(root, 'store.py'), 'def save(): pass\n');
  const store = await GuideStore.open(join(dir, 'private')); let now = new Date('2026-10-29T12:00:00'); const support = new GuideSupport(store, () => now);
  const snapshot = { scope: { sessionId: 'one', projectId: hash(root) }, basis: 'basis', enabled: true, projectName: 'project', throughSeq: 1, turn: 1, choices: [], observations: [], limitations: [], model: { status: 'ready', route: { provider: 'fixture', model: 'fixture' } } };
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }); });
  const save = async (fields, snap = snapshot) => support.save(snap, { clientRequestId: crypto.randomUUID(), version: (await support.view(snap)).version, ...fields });
  return { dir, root, store, support, snapshot, save, tomorrow: () => { now = new Date(now.getTime() + 86400000); } };
}

test('preferences persist, inherit across projects and can be overridden/reset without model calls', async t => {
  const f = await fixture(t), other = { ...f.snapshot, scope: { sessionId: 'two', projectId: 'other' } };
  await f.save({ target: 'personal', preferences: { ...defaultPreferences, style: 'example', language: 'en' } });
  assert.equal((await f.support.view(other)).preferences.language, 'en');
  await f.save({ target: 'project', preferences: { ...defaultPreferences, detail: 'brief' } });
  assert.equal((await f.support.view(f.snapshot)).preferences.detail, 'brief'); assert.equal((await f.support.view(other)).preferences.detail, 'standard');
  const restarted = new GuideSupport(f.store); assert.equal((await restarted.view(f.snapshot)).preferences.detail, 'brief');
  await f.save({ target: 'inherit' }); assert.equal((await restarted.view(f.snapshot)).preferences.language, 'en'); assert.equal((await restarted.view(f.snapshot)).calls, 0);
});

test('settings reject stale versions and id reuse; limit edits never reset usage', async t => {
  const f = await fixture(t), original = await f.support.view(f.snapshot);
  const req = { clientRequestId: 'same', version: original.version, target: 'budget', budget: { dailyCalls: 2, turnCalls: 2 } };
  await f.support.save(f.snapshot, req); await f.support.save(f.snapshot, req);
  await assert.rejects(f.support.save(f.snapshot, { ...req, budget: { dailyCalls: 9, turnCalls: 2 } }), { code: 'request_conflict' });
  await assert.rejects(f.support.save(f.snapshot, { ...req, clientRequestId: 'stale' }), { code: 'context_changed' });
  await f.support.call(f.snapshot, async () => 'answer'); await f.save({ target: 'budget', budget: { dailyCalls: 1, turnCalls: 1 } });
  await assert.rejects(f.support.call(f.snapshot, async () => assert.fail('must not dispatch')), { code: 'budget_reached' });
});

test('atomic admission rejects concurrent same-project calls and enforces turn/project/day boundaries', async t => {
  const f = await fixture(t); await f.save({ target: 'budget', budget: { dailyCalls: 2, turnCalls: 1 } });
  let release; const pending = f.support.call(f.snapshot, async () => new Promise(resolve => release = resolve));
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(f.support.call(f.snapshot, async () => 'unexpected'), { code: 'explanation_busy' }); release('ok'); await pending;
  await assert.rejects(f.support.call(f.snapshot, async () => 'unexpected'), { code: 'budget_reached' });
  await f.support.call({ ...f.snapshot, turn: 2 }, async () => 'ok');
  await assert.rejects(f.support.call({ ...f.snapshot, scope: { ...f.snapshot.scope, sessionId: 'another' } }, async () => 'unexpected'), { code: 'budget_reached' });
  f.tomorrow(); await f.support.call({ ...f.snapshot, turn: 3 }, async () => 'ok');
  assert.equal((await f.support.view({ ...f.snapshot, turn: 3 })).calls, 1);
});

test('failure, cancellation and crash ambiguity consume attempts; missing usage is not zero usage', async t => {
  const f = await fixture(t);
  await assert.rejects(f.support.call(f.snapshot, async report => { report({ inputTokens: 11, outputTokens: 2, cacheReadTokens: 6, cacheWriteTokens: 3 }); throw new Error('provider failed'); }));
  await assert.rejects(f.support.call(f.snapshot, async () => { throw new DOMException('cancelled', 'AbortError'); }));
  await f.store.updateProject(f.snapshot.scope.projectId, record => record.support.usage.push({ id: 'crashed', kind: 'model', state: 'pending', day: '2026-10-29', turn: 'one:1', sessionId: 'one', createdAt: '2026-10-29T10:00:00.000Z' }));
  const restarted = new GuideSupport(f.store, f.support.clock); await restarted.call(f.snapshot, async report => { report({ inputTokens: -1, outputTokens: Infinity }); return 'ok'; });
  const view = await restarted.view(f.snapshot);
  assert.equal(view.calls, 4); assert.equal(view.failed, 2); assert.equal(view.unknown, 1); assert.equal(view.inputTokens, 20); assert.equal(view.outputTokens, 2); assert.equal(view.missingUsage, 3);
});

test('cache and glossary counters are idempotent and usable at zero budget', async t => {
  const f = await fixture(t); await f.save({ target: 'budget', budget: { dailyCalls: 0, turnCalls: 0 } });
  await f.support.hit(f.snapshot, 'cache-a', 'cache'); await f.support.hit(f.snapshot, 'cache-a', 'cache'); await f.support.hit(f.snapshot, 'term-a', 'glossary');
  const view = await f.support.view(f.snapshot); assert.equal(view.calls, 0); assert.equal(view.cacheHits, 1); assert.equal(view.glossaryHits, 1);
});

async function serviceFixture(t) {
  const f = await fixture(t); let calls = 0, sends = 0, ready = true;
  const host = { support: f.support, tracker: { store: f.store }, projectFor: async () => ({ root: f.root, enabled: true, scope: f.snapshot.scope }),
    snapshot: async () => ({ ...f.snapshot, model: ready ? f.snapshot.model : { status: 'not_configured' }, explanations: (await f.store.read(f.snapshot.scope)).explanations }),
    explain: async () => { calls++; return '独立讲解'; }, structured: async (_snapshot, task, source) => { calls++;
      if (task === 'overview') return JSON.stringify({ summary: '回答保存', nodes: [{ title: '保存', purpose: '保存回答', impact: '保存方式影响换设备访问', files: [source.files[0].file] }], unknowns: [] });
      return JSON.stringify({ summary: '检查失败，原因待核对', nodes: [], impacts: ['当前不能确认可用'], unknowns: ['未知根因'], possibleAdditions: [], sources: [], nextSteps: [{ label: '先定位失败条件', reason: '缩小范围', request: '请添加并运行保存失败场景的检查，保留原要求。' }] }); },
    saveExplanation: async answer => f.store.update(answer.scope, record => record.explanations.push(answer)), queueModification: async () => { sends++; }, deliveryStatus: async () => ({ state: 'unknown' }) };
  const service = new GuideService(host); t.after(async () => { service.dispose(); await service.project.close(); await service.communication.close(); });
  return { ...f, host, service, calls: () => calls, sends: () => sends, noModel: () => ready = false,
    ask: (id, question) => service.ask({ sessionId: 'one', clientRequestId: id, basis: 'basis', question }, signal()), req: (id, extra = {}) => ({ ...f.snapshot.scope, clientRequestId: id, ...extra }) };
}

test('known pure concepts answer without a configured model; project-specific questions never masquerade as local facts', async t => {
  const f = await serviceFixture(t); f.noModel(); const answer = await f.ask('local', 'API是什么？');
  assert.equal(answer.sourceKind, 'glossary'); assert.match(answer.text, /不代表你的项目/); assert.equal(f.calls(), 0); assert.equal(f.sends(), 0);
  assert.equal(lookupConcept('我们项目的API是否已实现'), undefined);
  await assert.rejects(f.ask('specific', '我们项目的API是否已实现？'), { code: 'model_unavailable' });
});

test('preferences invalidate ordinary explanation caches and persistent history without changing main conversation', async t => {
  const f = await serviceFixture(t); await f.ask('a', '为什么换手机找不到回答？'); const cached = await f.ask('b', '为什么换手机找不到回答？'); assert.equal(cached.cached, true); assert.equal(f.calls(), 1);
  await f.save({ target: 'project', preferences: { ...defaultPreferences, detail: 'detailed' } });
  await f.ask('c', '为什么换手机找不到回答？'); assert.equal(f.calls(), 2); assert.equal(f.sends(), 0);
  const history = await f.service.project.history(f.snapshot.scope, signal()); assert.equal(history.items.find(row => row.id === cached.id).state, 'historical');
});

test('troubleshooting distinguishes repeat failure, current applicability, later success and other sessions', async t => {
  const f = await fixture(t), basis = await captureFiles(f.root, 2000), project = freshProject(f.snapshot.scope.projectId);
  const op = (id, outcome, at) => ({ id, kind: 'check', tool: 'bash', startedAt: at, endedAt: at, outcome, checkKey: 'same-check', baseline: basis, afterDigest: basis.digest, applicability: 'unchanged', changedFiles: [] });
  const row = { scope: f.snapshot.scope, operations: [op('a', 'failed', '1'), op('b', 'failed', '2')] };
  assert.equal(troubleView(f.snapshot.scope, [row], project, basis).failures[0].count, 2);
  assert.equal(troubleView(f.snapshot.scope, [row], project, { ...basis, complete: false }).failures[0].current, false);
  row.operations.push(op('c', 'succeeded', '3')); assert.equal(troubleView(f.snapshot.scope, [row], project, basis).failures.length, 0);
  row.operations.push(op('d', 'failed', '4')); assert.equal(troubleView(f.snapshot.scope, [row], project, basis).failures[0].count, 1);
  assert.equal(troubleView({ ...f.snapshot.scope, sessionId: 'other' }, [row], project, basis).attempts.length, 0);
});

test('trouble explanations remain on demand; absent evidence costs no call; new receipts invalidate analysis cache', async t => {
  const f = await serviceFixture(t); const empty = await f.ask('none', '为什么一直失败？'); assert.match(empty.text, /没有可核对/); assert.equal(f.calls(), 0);
  const basis = await captureFiles(f.root, 2000), failed = { id: 'fail1', kind: 'check', tool: 'bash', startedAt: '1', endedAt: '1', outcome: 'failed', checkKey: 'check', baseline: basis, afterDigest: basis.digest, applicability: 'unchanged', changedFiles: [], diagnostic: 'failure in saved answer' };
  await f.store.update(f.snapshot.scope, record => record.operations.push(failed));
  await f.service.project.view(f.snapshot.scope, signal()); assert.equal(f.calls(), 0);
  await f.ask('why', '为什么一直失败？'); await f.ask('again', '为什么一直失败？'); assert.equal(f.calls(), 1);
  await f.store.update(f.snapshot.scope, record => record.operations.push({ ...failed, id: 'fail2', startedAt: '2', endedAt: '2' }));
  await f.ask('new', '为什么一直失败？'); assert.equal(f.calls(), 2); assert.equal(f.sends(), 0);
});

test('overview history selects stored versions and compares locally, including renamed responsibilities', async t => {
  const f = await serviceFixture(t), first = await f.service.project.overview(f.req('first'), signal());
  await writeFile(join(f.root, 'app.py'), 'from .store import save\nsave()\n');
  const second = await f.service.project.overview(f.req('second'), signal()); assert.notEqual(first.id, second.id);
  const calls = f.calls(); const view = await f.service.project.view({ ...f.snapshot.scope, overviewId: first.id }, signal()); assert.equal(view.overview.id, first.id); assert.equal(view.versions.length, 2);
  const diff = await f.service.project.compareStructure({ ...f.snapshot.scope, from: first.id, to: second.id }, signal()); assert.equal(diff.sourceChanges, 1); assert.equal(f.calls(), calls);
  const changed = { ...second, nodes: second.nodes.map(n => ({ ...n, title: '新保存职责' })) }; assert.equal(compareStructure(first, changed).responsibilities[0].descriptionChanged, true);
  await assert.rejects(f.service.project.view({ ...f.snapshot.scope, overviewId: 'foreign-version' }, signal()), { code: 'context_changed' });
});

test('later successful checks invalidate trouble cards, history and follow-up material consistently', async t => {
  const f = await serviceFixture(t), files = await captureFiles(f.root, 2000);
  const failed = { id: 'failed', kind: 'check', tool: 'bash', startedAt: '1', endedAt: '1', outcome: 'failed', checkKey: 'save-check', baseline: files, afterDigest: files.digest, applicability: 'unchanged', changedFiles: [] };
  await f.store.update(f.snapshot.scope, row => row.operations.push(failed));
  const originalRequest = f.req('trouble-original', { basis: 'basis', statement: '为什么一直失败？' });
  const answer = (await f.service.submit(originalRequest, signal())).explanation;
  const analysis = (await f.service.project.view(f.snapshot.scope, signal())).work.analyses.find(row => row.id === answer.analysisId);
  const ref = { kind: 'analysis', id: analysis.id, version: analysis.cacheKey };
  assert.equal(JSON.parse((await f.service.project.resolve(f.snapshot, ref)).text).historical, false);
  let contexts = [], calls = 0;
  f.host.explain = async snapshot => { calls++; contexts.push(JSON.parse(snapshot.context.text)); return '参考了当前检查记录'; };
  const follow = id => f.service.ask({ sessionId: 'one', clientRequestId: id, basis: 'basis', question: '这会影响我保存的回答吗？', context: ref }, signal());
  await follow('before-pass'); await follow('cached-before'); assert.equal(calls, 1);
  await f.store.update(f.snapshot.scope, row => row.operations.push({ ...failed, id: 'passed', startedAt: '2', endedAt: '2', outcome: 'succeeded' }));
  const view = await f.service.project.view(f.snapshot.scope, signal());
  assert.equal(view.work.trouble.failures.length, 0); assert.equal(view.work.analyses.find(row => row.id === analysis.id).historical, true);
  assert.equal((await f.service.getSnapshot({ sessionId: 'one' })).explanations.find(row => row.id === answer.id).state, 'historical');
  assert.equal((await f.service.project.history(f.snapshot.scope, signal())).items.find(row => row.id === answer.id).state, 'historical');
  assert.equal((await f.service.submit(originalRequest, signal())).explanation.state, 'historical', 'public submit replay cannot relabel an old analysis as current');
  const reused = await follow('before-pass'); assert.equal(reused.state, 'historical'); assert.equal(calls, 1);
  await follow('after-pass'); assert.equal(calls, 2); assert.equal(contexts.at(-1).historical, true);
  assert.equal(contexts.at(-1).currentTrouble.failures.length, 0); assert.equal(contexts.at(-1).currentTrouble.latestAttempts.at(-1).result, 'succeeded');
  assert.equal(f.sends(), 0);
});

test('a check changing during a follow-up makes the returned explanation historical', async t => {
  const f = await serviceFixture(t), files = await captureFiles(f.root, 2000);
  const op = { id: 'first', kind: 'check', tool: 'bash', startedAt: '1', endedAt: '1', outcome: 'failed', checkKey: 'save-check', baseline: files, afterDigest: files.digest, applicability: 'unchanged', changedFiles: [] };
  await f.store.update(f.snapshot.scope, row => row.operations.push(op));
  const answer = await f.ask('initial', '为什么一直失败？');
  const analysis = (await f.service.project.view(f.snapshot.scope, signal())).work.analyses.find(row => row.id === answer.analysisId);
  f.host.explain = async () => { await f.store.update(f.snapshot.scope, row => row.operations.push({ ...op, id: 'later', startedAt: '2', endedAt: '2', outcome: 'succeeded' })); return '生成中检查发生变化'; };
  const result = await f.service.ask({ sessionId: 'one', clientRequestId: 'race-followup', basis: 'basis', question: '会影响什么？', context: { kind: 'analysis', id: analysis.id, version: analysis.cacheKey } }, signal());
  assert.equal(result.state, 'historical');
});

test('large source index reuses safe fingerprints, notices edits/additions/deletions and excludes hardlinks/secrets', async t => {
  const f = await fixture(t); await Promise.all(Array.from({ length: 610 }, (_, i) => writeFile(join(f.root, `m${i}.py`), `value = ${i}\n`)));
  const index = new ProjectIndex(), a = await index.scan(f.root, []); assert.equal(a.complete, true); assert.equal(Object.keys(a.files).length, 612);
  const b = await index.scan(f.root, []); assert.equal(a.digest, b.digest);
  await writeFile(join(f.root, 'm0.py'), 'value = 999\n'); await rename(join(f.root, 'm1.py'), join(f.root, 'renamed.py'));
  const c = await index.scan(f.root, []); assert.notEqual(c.files['m0.py'], a.files['m0.py']); assert.equal(c.files['m1.py'], undefined); assert.equal(c.files['renamed.py'], a.files['m1.py']);
  await writeFile(join(f.root, '.env'), 'PRIVATE_VALUE=never-read'); await link(join(f.root, '.env'), join(f.root, 'alias.py')); await symlink(join(f.root, '.env'), join(f.root, 'shortcut.py'));
  const d = await index.scan(f.root, []); assert.equal(d.files['alias.py'], undefined); assert.equal(d.files['shortcut.py'], undefined); assert.equal(d.complete, false);
});

test('literal Python, C++, Ruby and PHP local references link only files in the bounded evidence set', async t => {
  const f = await fixture(t); await Promise.all([['main.cpp', '#include "types.hpp"'], ['types.hpp', 'struct Answer {};'], ['main.rb', 'require_relative "store"'], ['store.rb', 'def save; end'], ['main.php', '<?php require "./store.php";'], ['store.php', '<?php echo "ok";']].map(([name, content]) => writeFile(join(f.root, name), content)));
  const evidence = await projectEvidence(f.root, [], signal(), { basis: await captureFiles(f.root, 2000) });
  for (const [from, to] of [['app.py', 'store.py'], ['main.cpp', 'types.hpp'], ['main.rb', 'store.rb'], ['main.php', 'store.php']]) assert.ok(evidence.links.some(row => row.from === from && row.to === to), `${from} -> ${to}`);
});

test('real adapter gates every independent call, applies preferences and records disjoint provider usage', async t => {
  const f = await fixture(t); let calls = 0, system;
  class Assembler { push(chunk) { if (chunk.type === 'usage') this.usage = chunk.usage; if (chunk.type === 'finish') this.finish = { kind: 'stop' }; } blocks() { return [{ type: 'text', text: '回答' }]; } }
  const adapter = new HarnessAdapter({ llm: { prepareCall: async () => { calls++; return { config: {}, async *stream(options) { system = options.system; yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 4, cacheReadTokens: 8 } }; yield { type: 'finish' }; } }; } } }, { BlockAssembler: Assembler, createUserMessage: value => value }, { store: f.store });
  await f.save({ target: 'project', preferences: { ...defaultPreferences, language: 'en', style: 'example' } });
  await adapter.explain(f.snapshot, 'question', signal()); assert.match(system, /Answer in English/); assert.match(system, /使用场景/);
  const view = await adapter.support.view(f.snapshot); assert.equal(view.calls, 1); assert.equal(view.inputTokens, 20); assert.equal(view.outputTokens, 4);
  await f.save({ target: 'budget', budget: { dailyCalls: 0, turnCalls: 0 } });
  await assert.rejects(adapter.structured(f.snapshot, 'overview', {}, signal()), { code: 'budget_reached' }); assert.equal(calls, 1);
});

test('usage writes do not invalidate an unchanged requirement at dispatch, but actual requirement edits do', async t => {
  const f = await fixture(t), before = hash((await f.store.readProject(f.snapshot.scope.projectId)).requirementRevisions);
  await f.support.hit(f.snapshot, 'local-read', 'glossary');
  await f.store.update(f.snapshot.scope, row => { row.partial = true; }, before);
  await f.store.updateProject(f.snapshot.scope.projectId, row => row.requirementRevisions.push({ requestId: 'r', requestDigest: 'd', id: 'r', previous: 'v', version: 'next', text: '保留原回答', state: 'active', applicability: 'project', createdAt: '2026-10-29' }));
  await assert.rejects(f.store.update(f.snapshot.scope, () => assert.fail('must not dispatch'), before), { code: 'requirement_changed' });
});

test('another session in the same project does not inherit a current trouble analysis', async t => {
  const f = await serviceFixture(t); await f.ask('fault-none', '为什么卡住？');
  const basis = await captureFiles(f.root, 2000), project = await f.store.readProject(f.snapshot.scope.projectId);
  const view = await f.service.project.work.view({ ...f.snapshot, scope: { ...f.snapshot.scope, sessionId: 'different-session' } }, basis, project);
  assert.equal(view.analyses.filter(row => row.kind === 'trouble').length, 0);
});
