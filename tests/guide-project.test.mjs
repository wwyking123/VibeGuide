import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, symlink, link, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GuideStore } from '../dist/guide/store.js';
import { GuideService } from '../dist/guide/service.js';
import { captureFiles, hash } from '../dist/guide/files.js';
import { projectEvidence } from '../dist/guide/project-scan.js';
import { readOutbox, saveOutbox } from '../dist/client/outbox.js';

const signal = () => new AbortController().signal;
async function fixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'vg-p3-'))), root = join(directory, 'project');
  await mkdir(root); await writeFile(join(root, 'index.html'), '<script src="./app.js"></script>');
  await writeFile(join(root, 'app.js'), 'localStorage.setItem("answer", "private answer");');
  const store = await GuideStore.open(join(directory, 'private'));
  let calls = 0, sends = 0, context, enabled = true, moved = false;
  const projectId = hash(root), scopeFor = sessionId => ({ sessionId, projectId: sessionId === 'other' || moved ? 'other-project' : projectId });
  const host = {
    tracker: { store },
    projectFor: async sessionId => ({ root, scope: scopeFor(sessionId), enabled }),
    snapshot: async sessionId => {
      const scope = scopeFor(sessionId), record = await store.read(scope);
      return { scope, projectName: 'fixture', enabled, basis: (await captureFiles(root, 1000)).digest,
        throughSeq: 1, choices: [], observations: [], explanations: record.explanations,
        model: { status: 'ready', route: { provider: 'fixture', model: 'fixture' } }, limitations: [] };
    },
    structured: async (_snapshot, task, source) => {
      calls++;
      if (task === 'trial') return JSON.stringify({ steps: [{ action: '用另一个账号打开回答页面', expected: '看不到本人的回答' }] });
      return JSON.stringify({ summary: '一个保存个人回答的页面', nodes: source.files.filter(row => ['index.html', 'app.js'].includes(row.file)).map(row => ({ title: row.file === 'index.html' ? '回答页面' : '回答保存', purpose: '推测承担回答相关功能', impact: '换设备可能看不到原回答', files: [row.file] })), unknowns: ['权限和跨设备体验尚未验证'] });
    },
    explain: async (snapshot) => { calls++; context = snapshot.context; return '这是需要实际验证的讲解'; },
    saveExplanation: async answer => { await store.update(answer.scope, state => state.explanations.push(answer)); },
    queueModification: async () => { sends++; }, deliveryStatus: async () => ({ state: 'queued' }),
  };
  const service = new GuideService(host), project = service.project;
  const req = (id, extra = {}) => ({ sessionId: 's1', projectId, clientRequestId: id, ...extra });
  const base = { sessionId: 's1', projectId };
  t.after(async () => { service.dispose(); await service.communication.close(); await project.close(); await store.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, root, store, host, service, project, projectId, req, base,
    calls: () => calls, sends: () => sends, context: () => context, disable: () => { enabled = false; }, move: () => { moved = true; } };
}

test('opening project/history is read-only; explicit overview is cached with literal import edges', async t => {
  const f = await fixture(t), original = await readFile(join(f.root, 'app.js'));
  assert.equal((await f.project.view(f.base, signal())).fileCount, 2);
  assert.equal((await f.project.history(f.base, signal())).items.length, 0); assert.equal(f.calls(), 0);
  const overview = await f.project.overview(f.req('overview-1'), signal());
  assert.equal(overview.nodes.length, 2); assert.equal(overview.edges.length, 1);
  assert.equal((await f.project.overview(f.req('overview-2'), signal())).id, overview.id);
  await f.project.view(f.base, signal()); assert.equal(f.calls(), 1); assert.equal(f.sends(), 0);
  assert.deepEqual(await readFile(join(f.root, 'app.js')), original);
});

test('scan contents exclude secrets, storage, symbolic and hard links; clipped evidence stays bounded', async t => {
  const f = await fixture(t), secret = 'never-send-this-value';
  await writeFile(join(f.root, '.env'), secret); await writeFile(join(f.root, 'credentials.json'), secret);
  await symlink(join(f.root, '.env'), join(f.root, 'alias.js'));
  await link(join(f.root, '.env'), join(f.root, 'hard.js'));
  await mkdir(join(f.root, 'state')); await writeFile(join(f.root, 'state', 'personal.md'), secret);
  await writeFile(join(f.root, 'big.js'), 'const password="plain-password";'.repeat(500));
  const evidence = await projectEvidence(f.root, [join(f.root, 'state')], signal());
  assert.equal(JSON.stringify(evidence.snippets).includes(secret), false);
  assert.equal(JSON.stringify(evidence.snippets).includes('plain-password'), false);
  assert.ok(!evidence.snippets.some(row => /hard|alias|credentials|personal/.test(row.file)));
  assert.ok(evidence.snippets.find(row => row.file === 'big.js').clipped);
  assert.ok(evidence.snippets.reduce((n, row) => n + row.excerpt.length, 0) <= 24000);
  assert.equal(evidence.basis.complete, false);
});

test('model invented sources are rejected, no graph or actions persisted', async t => {
  const f = await fixture(t);
  f.host.structured = async () => JSON.stringify({ summary: 'claim', nodes: [{ title: 'Cloud', purpose: 'claim', impact: 'claim', files: ['../../private.key'] }], unknowns: [] });
  await assert.rejects(f.project.overview(f.req('bad'), signal()), { code: 'invalid_generation' });
  assert.equal((await f.store.readProject(f.projectId)).overviews.length, 0); assert.equal(f.sends(), 0);
});

test('file changes highlight mapped nodes and retain historical graph without automatic calls', async t => {
  const f = await fixture(t), graph = await f.project.overview(f.req('graph'), signal());
  await writeFile(join(f.root, 'app.js'), 'changed'); await writeFile(join(f.root, 'new.js'), 'new');
  const view = await f.project.view(f.base, signal());
  assert.equal(view.overview.id, graph.id); assert.equal(view.overview.historical, true);
  assert.equal(view.overview.changedNodes.length, 1); assert.equal(view.overview.unmappedChanges, 1); assert.equal(f.calls(), 1);
  const ref = { kind: 'node', id: `${graph.id}:${graph.nodes[0].id}`, version: graph.id };
  assert.equal(JSON.parse((await f.project.resolve(await f.host.snapshot('s1'), ref)).text).historical, true);
  await assert.rejects(f.project.resolve(await f.host.snapshot('other'), ref), { code: 'context_changed' });
});

test('same-project cross-session history is historical and cannot leak across projects', async t => {
  const f = await fixture(t), snapshot = await f.service.getSnapshot({ sessionId: 's1' });
  const answer = await f.service.ask({ sessionId: 's1', clientRequestId: 'ask', basis: snapshot.basis, question: '能跨设备吗？' }, signal());
  const same = await f.project.history({ ...f.base, sessionId: 's2' }, signal());
  assert.equal(same.items[0].id, answer.id); assert.equal(same.items[0].fromCurrentSession, false); assert.equal(same.items[0].state, 'historical');
  assert.equal((await f.project.history({ sessionId: 'other', projectId: 'other-project' }, signal())).items.length, 0);
  await assert.rejects(f.project.history({ ...f.base, sessionId: 'other' }, signal()), { code: 'scope_changed' });
});

test('correction excludes stale memory/persistent cache and follows only user correction', async t => {
  const f = await fixture(t), snapshot = await f.service.getSnapshot({ sessionId: 's1' });
  const request = { sessionId: 's1', clientRequestId: 'ask', basis: snapshot.basis, question: '保存有什么影响？' };
  const answer = await f.service.ask(request, signal()), item = (await f.project.history(f.base, signal())).items[0];
  await f.project.annotate(f.req('correction', { explanationId: answer.id, version: item.contextVersion, action: 'correct', text: '只保存在本机，不同步其他设备。' }), signal());
  assert.equal((await f.service.getSnapshot({ sessionId: 's1' })).explanations.length, 0);
  await assert.rejects(f.service.ask(request, signal()), { code: 'context_changed' });
  assert.equal((await f.service.ask({ ...request, clientRequestId: 'new' }, signal())).cached, false);
  const corrected = (await f.project.history(f.base, signal())).items.find(row => row.id === answer.id);
  const ref = { kind: 'explanation', id: answer.id, version: corrected.contextVersion };
  await f.service.ask({ ...request, clientRequestId: 'follow', question: '那换手机怎么办？', context: ref }, signal());
  assert.ok(f.context().text.includes('只保存在本机')); assert.ok(!f.context().text.includes(answer.text));
  assert.equal(f.sends(), 0);
});

test('retired explanations cannot be resolved and concurrent stale corrections cannot replace latest', async t => {
  const f = await fixture(t), snapshot = await f.host.snapshot('s1');
  const answer = await f.service.ask({ sessionId: 's1', clientRequestId: 'ask', basis: snapshot.basis, question: '为什么？' }, signal());
  const item = (await f.project.history(f.base, signal())).items[0];
  const result = await Promise.allSettled([
    f.project.annotate(f.req('one', { explanationId: answer.id, version: item.contextVersion, action: 'retire' }), signal()),
    f.project.annotate(f.req('two', { explanationId: answer.id, version: item.contextVersion, action: 'correct', text: '新理解' }), signal()),
  ]);
  assert.equal(result.filter(row => row.status === 'fulfilled').length, 1);
  await assert.rejects(f.project.resolve(snapshot, { kind: 'explanation', id: answer.id, version: item.contextVersion }), { code: 'context_changed' });
});

test('late project overview cannot enter switched project; modes gate all reads', async t => {
  const f = await fixture(t), original = f.host.structured;
  f.host.structured = async (...args) => { const result = await original(...args); f.move(); return result; };
  await assert.rejects(f.project.overview(f.req('late'), signal()), { code: 'scope_changed' });
  assert.equal((await f.store.readProject(f.projectId)).overviews.length, 0);
  f.disable(); await assert.rejects(f.project.view(f.base, signal()), { code: 'mode_required' });
});

test('project records persist separately without entering session recovery or mutating old files', async t => {
  const f = await fixture(t), scope = (await f.host.snapshot('s1')).scope;
  await f.store.update(scope, record => { record.partial = true; });
  const before = await readFile(join(f.store.directory, `${hash(scope)}.json`));
  const overview = await f.project.overview(f.req('persist'), signal());
  assert.deepEqual(await f.store.sessions(), ['s1']);
  assert.deepEqual(await readFile(join(f.store.directory, `${hash(scope)}.json`)), before);
  assert.equal((await f.store.readProject(f.projectId)).overviews[0].id, overview.id);
  await writeFile(join(f.store.directory, `project-${hash(f.projectId)}.json`), '{broken');
  await assert.rejects(f.project.view(f.base, signal()), { code: 'record_unavailable' });
  assert.equal(await readFile(join(f.store.directory, `project-${hash(f.projectId)}.json`), 'utf8'), '{broken');
});

test('concurrent overview requests deduplicate; unload aborts unfinished generation', async t => {
  const f = await fixture(t), original = f.host.structured;
  const pair = await Promise.all([f.project.overview(f.req('same'), signal()), f.project.overview(f.req('same'), signal())]);
  assert.equal(pair[0].id, pair[1].id); assert.equal(f.calls(), 1);
  await writeFile(join(f.root, 'app.js'), 'new version');
  let entered; const gate = new Promise(resolve => { entered = resolve; });
  f.host.structured = async (_snapshot, _task, _source, abort) => new Promise((_resolve, reject) => {
    entered(); abort.addEventListener('abort', () => reject(abort.reason), { once: true });
  });
  const pending = f.project.overview(f.req('cancel'), signal()), rejection = assert.rejects(pending, { name: 'AbortError' });
  await gate; await f.project.close(); await rejection;
  assert.equal((await f.store.readProject(f.projectId)).overviews.length, 1); f.host.structured = original;
});

test('context survives outbox reload and does not become an implicit modification', async t => {
  const f = await fixture(t), graph = await f.project.overview(f.req('graph'), signal()), snapshot = await f.host.snapshot('s1');
  const context = { kind: 'node', id: `${graph.id}:${graph.nodes[0].id}`, version: graph.id };
  const request = { ...f.req('question'), statement: '这个部分有什么影响？', basis: snapshot.basis, context };
  const values = new Map(), storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  saveOutbox(storage, request); assert.deepEqual(readOutbox(storage, snapshot.scope).context, context);
  const result = await f.service.submit(readOutbox(storage, snapshot.scope), signal());
  assert.equal(result.input.kind, 'explain'); assert.equal(result.explanation.context.id, context.id); assert.ok(f.context()); assert.equal(f.sends(), 0);
});
