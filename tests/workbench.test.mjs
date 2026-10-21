import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../dist/continuity/plugin.js';
import { ProjectStore } from '../dist/continuity/store.js';
import { workbenchFor } from '../dist/workbench/state.js';
import { preferencesFor } from '../dist/workbench/preferences.js';
import { probeSupabase, supabaseGuide } from '../dist/workbench/services.js';
import { executionOutcome } from '../dist/workbench/evidence.js';
import { Ledger } from '../dist/workbench/ledger.js';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'vibeguide-workbench-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const project = join(dir, 'project'), other = join(dir, 'other'), storage = join(dir, 'memory'); await mkdir(project); await mkdir(other);
  const registered = new Map(), hooks = new Map(), histories = new Map(), sections = []; let call = 0;
  const agent = { session: { id: 'session-1', header: { cwd: project } } };
  const ctx = { tools: { register(tool) { registered.set(tool.name, tool); }, get(name) { return registered.get(name); } },
    systemPrompt: { section(s) { sections.push(s); } }, on(event, hook) { hooks.set(event, hook); },
    sessionQuery: { async readSession(id) { return { events: histories.get(id) ?? [] }; }, async readEvent({ sessionId, seq }) { return { target: (histories.get(sessionId) ?? []).find(e => e.seq === seq) }; } } };
  apply(ctx, { storageRoot: storage });
  const events = (a = agent) => { if (!histories.has(a.session.id)) histories.set(a.session.id, []); return histories.get(a.session.id); };
  const user = (quote, a = agent, messageId) => { const history = events(a), seq = history.length + 1; history.push({ type: 'user/message', seq, data: { id: messageId ?? `${a.session.id}-u${seq}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: quote }] } }); return { seq, quote }; };
  const invoke = (name, args, a = agent) => registered.get(name).execute(args, { agent: a, callId: `call-${++call}`, signal: AbortSignal.timeout(10000) });
  const workspace = async (args, a = agent) => {
    if (!['overview', 'read', 'impact'].includes(args.action) && !(args.action === 'guide' && !args.goal) && args.expectedRevision === undefined) args = { ...args, expectedRevision: (await invoke('vibeguide_workspace', { action: 'overview' }, a)).revision };
    return invoke('vibeguide_workspace', args, a);
  };
  const prefs = async (args, a = agent) => {
    if (!['read', 'session'].includes(args.action) && args.expectedRevision === undefined) args = { ...args, expectedRevision: (await invoke('vibeguide_preferences', { action: 'read' }, a)).revision };
    return invoke('vibeguide_preferences', args, a);
  };
  const projectWrite = async (changes, a = agent) => { const revision = (await invoke('vibeguide_project', { action: 'read' }, a)).record.revision; return invoke('vibeguide_project', { action: 'write', expectedRevision: revision, changes }, a); };
  const requirement = async (id = 'privacy', text = '名单仅组织者能看', a = agent, extra = {}) => { const source = user(text, a); assert.equal((await projectWrite([{ type: 'requirement', id, text, kind: 'requirement', source, ...extra }], a)).status, 'saved'); return source; };
  const check = async (extra = {}) => { await writeFile(join(project, 'check.mjs'), 'console.log("checked")'); assert.equal((await workspace({ action: 'check', id: 'privacy-check', title: '名单权限', expected: '其他用户看不到名单', requirementIds: ['privacy'], files: ['check.mjs'], external: false, ...extra })).status, 'saved'); };
  const executeNative = async (value, { name = 'bash', a = agent, text = 'permission check passed', isError = false } = {}) => {
    const history = events(a), callId = `native-${++call}`, seq = history.length + 1;
    history.push({ type: 'tool/call', seq, data: { callId, name, arguments: '{"command":"node check.mjs"}' } });
    const result = { isError, value, content: [{ type: 'text', text }] };
    hooks.get('tools/result')({ agent: a, name, callId }, result);
    history.push({ type: 'tool/result', seq: seq + 1, surfaceOp: 'append', sourceEventSeqs: [seq], data: { message: { id: `result-${callId}`, role: 'tool', toolCallId: callId, source: { kind: 'tool', callId }, isError, content: result.content } } });
    return { seq: seq + 1, quote: text };
  };
  const context = async (a = agent) => (await hooks.get('system-prompt/assemble')({}, { agent: a }, async () => ({ sections, contexts: [] }))).contexts[0].text;
  return { dir, project, other, storage, agent, registered, events, user, invoke, workspace, prefs, projectWrite, requirement, check, executeNative, context, restart: () => apply(ctx, { storageRoot: storage }) };
}
const foreground = (exitCode = 0) => ({ kind: 'foreground', exitCode, timedOut: false, aborted: false, signal: null });

test('project consensus distinguishes proposals, user decisions and observations; forget clears predecessors', async t => {
  const f = await fixture(t), source = await f.requirement();
  const fact = { action: 'fact', id: 'role', kind: 'role', text: '组织者看名单', status: 'confirmed', requirementIds: ['privacy'], files: [], relatedIds: [], source };
  assert.equal((await f.workspace(fact)).status, 'saved');
  await assert.rejects(f.workspace({ ...fact, id: 'forged', source: { seq: source.seq, quote: '所有人都能看' } }));
  assert.equal((await f.workspace({ ...fact, id: 'guess', status: 'proposed', replaces: 'role' })).status, 'failed');
  const correction = f.user('只有活动组织者看名单');
  assert.equal((await f.workspace({ ...fact, id: 'role-v2', replaces: 'role', text: correction.quote, source: correction })).status, 'saved');
  assert.equal((await f.workspace({ action: 'forget_fact', id: 'role-v2', source: f.user('忘记这条角色记录，不改代码') })).status, 'saved');
  assert.equal((await f.workspace({ action: 'read', collection: 'facts' })).items.length, 0);
  assert.equal((await f.workspace({ ...fact, id: 'resurrection' })).status, 'failed');
});

test('evidence requires an actual captured native result and preserves historical outcomes when files/requirements change', async t => {
  const f = await fixture(t); await f.requirement(); await f.check();
  assert.equal((await f.workspace({ action: 'prepare', checkId: 'privacy-check' })).status, 'saved');
  const native = await f.executeNative(foreground());
  assert.equal((await f.workspace({ action: 'evidence', id: 'proof', checkId: 'privacy-check', ...native, interpretation: '输出表明名单权限用例通过，未检查其他业务。' })).status, 'saved');
  let evidence = (await f.workspace({ action: 'read', collection: 'evidence' })).items[0];
  assert.equal(evidence.outcome, 'passed'); assert.equal(evidence.applicability, 'unchanged_scope');
  await writeFile(join(f.project, 'check.mjs'), 'changed');
  evidence = (await f.workspace({ action: 'read', collection: 'evidence' })).items[0];
  assert.equal(evidence.outcome, 'passed'); assert.equal(evidence.applicability, 'stale');
  await f.requirement('privacy-v2', '更正：名单也允许工作人员看', f.agent, { replaces: 'privacy' });
  assert.match((await f.workspace({ action: 'read', collection: 'evidence' })).items[0].reasons.join(' '), /要求已改变/);
  await assert.rejects(f.workspace({ action: 'evidence', id: 'lie', checkId: 'privacy-check', seq: 1, quote: '名单', interpretation: '测试通过' }));
});

test('nonzero bash exits, pending jobs, outer run_code and failed baseline cannot masquerade as success', async t => {
  const f = await fixture(t); await f.requirement(); await f.check();
  await f.workspace({ action: 'prepare', checkId: 'privacy-check' });
  const native = await f.executeNative(foreground(1), { text: 'test failed' });
  assert.equal((await f.workspace({ action: 'evidence', id: 'failure', checkId: 'privacy-check', ...native, interpretation: '没有通过' })).status, 'saved');
  assert.equal((await f.workspace({ action: 'read', collection: 'evidence' })).items[0].outcome, 'failed');
  assert.equal(executionOutcome('run_code', { isError: false, value: foreground() }), 'unknown');
  assert.equal(executionOutcome('bash', { isError: false, value: { kind: 'background' } }), 'unknown');
  assert.equal(executionOutcome('bash', { isError: false, value: { ...foreground(), timedOut: true } }), 'failed');
  assert.equal(executionOutcome('bash', { isError: true, error: { info: { code: 'TOOL_OUTCOME_UNKNOWN' } } }), 'unknown');
  await writeFile(join(f.project, 'check.mjs'), 'changed after preparation');
  const changed = await f.executeNative(foreground());
  assert.equal((await f.workspace({ action: 'evidence', id: 'uncertain', checkId: 'privacy-check', ...changed, interpretation: '待重新检查' })).status, 'saved');
  assert.equal((await f.workspace({ action: 'read', collection: 'evidence' })).items[1].applicability, 'stale');
});

test('preferences are explicit, project overrides personal, temporary disabling is session-only, forgetting prevents resurrection', async t => {
  const f = await fixture(t), a2 = { session: { id: 'second', header: { cwd: f.project } } }, b = { session: { id: 'other', header: { cwd: f.other } } };
  await f.requirement();
  assert.equal((await f.prefs({ action: 'set', id: 'once', dimension: 'workflow', value: 'plan_first', scope: 'personal', source: f.user('这次先给方案') })).status, 'failed');
  assert.equal((await f.prefs({ action: 'set', id: 'restricted', dimension: 'detail', value: 'concise', scope: 'personal', source: f.user('以后只在这个项目回答简短一点，其他项目照常。') })).status, 'failed');
  const source = f.user('以后默认简短回答');
  assert.equal((await f.prefs({ action: 'set', id: 'short', dimension: 'detail', value: 'concise', scope: 'personal', source })).status, 'saved');
  assert.equal((await f.prefs({ action: 'set', id: 'project-detailed', dimension: 'detail', value: 'detailed', scope: 'project', source: f.user('本项目详细解释') })).status, 'saved');
  assert.equal((await f.prefs({ action: 'read' }, a2)).effective[0].value, 'detailed');
  assert.equal((await f.prefs({ action: 'read' }, b)).effective[0].value, 'concise');
  assert.equal(JSON.stringify(await f.prefs({ action: 'read' }, b)).includes('本项目详细解释'), false);
  assert.equal((await f.prefs({ action: 'session', enabled: false, source: f.user('这次别用以前的偏好') })).status, 'session_only');
  assert.match(await f.context(), /名单仅组织者能看/);
  assert.deepEqual((await f.prefs({ action: 'read' })).effective, []);
  f.restart(); assert.deepEqual((await f.prefs({ action: 'read' })).effective, []);
  assert.equal((await f.prefs({ action: 'read' }, a2)).effective.length, 1);
  assert.equal((await f.prefs({ action: 'forget', id: 'short', source: f.user('忘掉简短回答的偏好') })).status, 'saved');
  assert.deepEqual((await f.prefs({ action: 'read' }, b)).effective, []);
  assert.equal((await f.prefs({ action: 'set', id: 'return-old', dimension: 'detail', value: 'concise', scope: 'personal', source })).status, 'failed');
});

test('task paging has revision-bound cursors and archive never hides global requirements', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 16; i++) await f.requirement(`rule-${i}`, `必须保留要求 ${i}`);
  const first = await f.workspace({ action: 'read', collection: 'requirements', limit: 10 });
  assert.equal(first.complete, false); assert.equal(first.items.length, 10);
  const changedCursor = JSON.parse(Buffer.from(first.nextCursor, 'base64url').toString('utf8')); changedCursor.offset = 15;
  await assert.rejects(f.workspace({ action: 'read', collection: 'requirements', limit: 10, cursor: Buffer.from(JSON.stringify(changedCursor)).toString('base64url') }), /modified/);
  const second = await f.workspace({ action: 'read', collection: 'requirements', limit: 10, cursor: first.nextCursor }); assert.equal(second.items.length, 6); assert.equal(second.complete, true);
  await f.requirement('new-rule', '新增要求');
  await assert.rejects(f.workspace({ action: 'read', collection: 'requirements', limit: 10, cursor: first.nextCursor }), /stale/);
  await f.projectWrite([{ type: 'start_task', id: 'done', title: '已完成的小修改' }, { type: 'task', id: 'done', status: 'completed', progress: '修改完成', nextStep: '无', files: [] }]);
  assert.equal((await f.workspace({ action: 'archive_task', taskId: 'done', archive: true })).status, 'saved');
  assert.equal((await f.workspace({ action: 'read', collection: 'tasks' })).total, 0);
  assert.equal((await f.workspace({ action: 'read', collection: 'tasks', includeArchived: true })).total, 1);
  assert.equal((await f.workspace({ action: 'read', collection: 'requirements' })).total, 17);
  await assert.rejects(f.workspace({ action: 'select_task', taskId: 'done' }), /active task/);
  assert.match(await f.context(), /必须保留要求/);
});

test('static impact follows transitive references, links requirements and checks, and never changes application files', async t => {
  const f = await fixture(t); await f.requirement();
  await mkdir(join(f.project, 'src')); await mkdir(join(f.project, 'tests'));
  await writeFile(join(f.project, 'src/rules.ts'), 'export const allowed = true;');
  await writeFile(join(f.project, 'src/page.ts'), "import { allowed } from './rules'; export { allowed };");
  await writeFile(join(f.project, 'tests/page.test.ts'), "import { allowed } from '../src/page';");
  await f.workspace({ action: 'check', id: 'regression', title: '权限回归', expected: '其他人不可见', files: ['src/rules.ts', 'tests/page.test.ts'], requirementIds: ['privacy'], external: false });
  const before = await readFile(join(f.project, 'src/rules.ts'));
  const result = await f.workspace({ action: 'impact', files: ['src/rules.ts'] });
  assert.ok(result.affectedFiles.includes('src/page.ts')); assert.ok(result.relatedTestFiles.includes('tests/page.test.ts'));
  assert.equal(result.regressionChecks[0].id, 'regression'); assert.equal(result.requirementsToPreserve[0].id, 'privacy');
  assert.deepEqual(await readFile(join(f.project, 'src/rules.ts')), before);
});

test('Supabase guide is staged and probe rejects wrong keys, redirects/unsafe URLs, empty rows and server errors without echoing secrets', async t => {
  const f = await fixture(t); await f.requirement();
  const guide = await f.workspace({ action: 'guide' }); assert.equal(guide.steps.length, 5); assert.ok(guide.stages.every(s => s.status === 'not_checked'));
  assert.match(guide.artifacts.permissionTestSql, /rollback;/); assert.match(guide.artifacts.clientModule, /未确认保存成功/);
  await f.workspace({ action: 'guide', goal: '让登录用户保存自己的回答', requirementIds: ['privacy'] });
  assert.equal((await f.workspace({ action: 'overview' })).guide.goal, '让登录用户保存自己的回答');
  let calls = 0; const env = { VITE_SUPABASE_URL: 'https://sample.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fake_secret_value' };
  const fetcher = async (url, init) => { calls++; assert.equal(init.redirect, 'error'); assert.equal(init.headers.apikey, env.VITE_SUPABASE_PUBLISHABLE_KEY); assert.equal(init.headers.Authorization, undefined); return { ok: true, status: 200, json: async () => [{ id: 'connection-check', label: 'connected' }] }; };
  assert.equal((await probeSupabase({ ...env, VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_bad' }, fetcher)).ok, false);
  assert.equal((await probeSupabase({ ...env, VITE_SUPABASE_URL: 'http://localhost:9999' }, fetcher)).ok, false); assert.equal(calls, 0);
  const success = await probeSupabase(env, fetcher); assert.equal(success.ok, true); assert.equal(JSON.stringify(success).includes(env.VITE_SUPABASE_PUBLISHABLE_KEY), false);
  assert.equal((await probeSupabase(env, async () => ({ ok: true, status: 200, json: async () => [] }))).ok, false);
  assert.equal((await probeSupabase(env, async () => ({ ok: false, status: 401 }))).code, 'REQUEST_REJECTED');
  await assert.rejects(f.workspace({ action: 'guide', goal: 'store sb_secret_do_not_store', requirementIds: ['privacy'] }), /Credentials/);
});

test('legacy records are read without migration and forgetting scrubs associated consensus/evidence without changing code', async t => {
  const f = await fixture(t), source = await f.requirement(), store = await ProjectStore.forProject(f.storage, f.project);
  const before = await readFile(store.recordPath);
  await f.workspace({ action: 'overview' }); await f.context(); assert.deepEqual(await readFile(store.recordPath), before);
  await f.workspace({ action: 'fact', id: 'private', kind: 'role', text: '名单仅组织者能看', status: 'confirmed', requirementIds: ['privacy'], files: [], relatedIds: [], source });
  await f.check();
  const codeBefore = await readFile(join(f.project, 'check.mjs'));
  const forgotten = await f.projectWrite([{ type: 'forget', id: 'privacy', source: f.user('只忘掉这项要求，不改代码') }]);
  assert.equal(forgotten.status, 'saved'); assert.equal(forgotten.linkedRecordsCleanup.status, 'saved');
  assert.equal((await f.workspace({ action: 'read', collection: 'facts' })).items.length, 0);
  assert.equal((await f.workspace({ action: 'read', collection: 'checks' })).items.length, 0);
  assert.equal((await readFile(workbenchFor(store).path, 'utf8')).includes('名单仅组织者能看'), false);
  assert.deepEqual(await readFile(join(f.project, 'check.mjs')), codeBefore);
});

test('new ledgers distinguish conflicts, failed and unknown saves, reject corruption and keep existing data intact', async t => {
  const f = await fixture(t); const ledger = new Ledger(join(f.storage, 'ledger-test'), 'test.json', 'fixture', () => ({ value: 0 }), d => assert.equal(typeof d.value, 'number'));
  assert.equal((await ledger.update(0, 'one', { value: 1 }, d => { d.value = 1; })).status, 'saved');
  assert.equal((await ledger.update(0, 'two', {}, d => { d.value = 2; })).status, 'conflict');
  assert.equal((await ledger.update(1, 'bad', {}, d => { d.value = 'invalid'; })).status, 'failed');
  const read = ledger.read.bind(ledger); let reads = 0; ledger.read = async () => { if (++reads === 2) throw new Error('readback lost'); return read(); };
  assert.equal((await ledger.update(1, 'three', {}, d => { d.value = 3; })).status, 'unknown'); ledger.read = read;
  assert.equal((await ledger.read()).data.value, 3);
  assert.equal((await ledger.update(1, 'three', {}, d => { d.value = 3; })).status, 'unchanged');
  await writeFile(ledger.path, '{broken'); await assert.rejects(ledger.read());
  assert.equal((await ledger.update(0, 'four', {}, d => { d.value = 4; })).status, 'failed');
});

test('forgetting cascades through related summaries and corrected requirements remove stale consensus from current context', async t => {
  const f = await fixture(t), source = await f.requirement();
  const fact = { action: 'fact', id: 'root', kind: 'role', text: '保密规则的根摘要', status: 'confirmed', requirementIds: ['privacy'], files: [], relatedIds: [], source };
  await f.workspace(fact);
  await f.workspace({ ...fact, id: 'derived', text: '依赖根摘要的旧理解', requirementIds: [], relatedIds: ['root'] });
  await f.requirement('public', '更正：现在公开这份名单', f.agent, { replaces: 'privacy' });
  assert.equal((await f.workspace({ action: 'read', collection: 'facts' })).total, 0);
  const history = await f.workspace({ action: 'read', collection: 'facts', includeArchived: true });
  assert.equal(history.total, 2); assert.ok(history.items.every(f => f.applicability === 'needs_review'));
  assert.equal((await f.context()).includes('依赖根摘要的旧理解'), false);
  await f.projectWrite([{ type: 'forget', id: 'public', source: f.user('只忘掉这条名单要求，不修改代码') }]);
  const store = await ProjectStore.forProject(f.storage, f.project), bytes = await readFile(workbenchFor(store).path, 'utf8');
  assert.equal(bytes.includes('依赖根摘要的旧理解'), false); assert.equal(bytes.includes('保密规则的根摘要'), false);
  await assert.rejects(f.workspace({ ...fact, id: 'resurrected' }), /active requirements|forgotten/);
});

test('storage and file aliases cannot expose protected environment files or write through a storage symlink', async t => {
  const f = await fixture(t), external = join(f.dir, 'external'); await mkdir(external);
  await symlink(external, join(f.dir, 'unsafe'));
  const ledger = new Ledger(join(f.dir, 'unsafe', 'child'), 'test.json', 'fixture', () => ({}), () => {}, join(f.dir, 'unsafe'));
  assert.equal((await ledger.update(0, 'write', {}, () => {})).status, 'failed');
  await writeFile(join(f.project, '.env.local'), 'TOKEN=not-real'); await symlink('.env.local', join(f.project, 'innocent.txt'));
  const store = await ProjectStore.forProject(f.storage, f.project); await assert.rejects(store.stamp('innocent.txt'));
});

test('completed selections cannot hide the sole remaining active task or its requirements', async t => {
  const f = await fixture(t);
  await f.projectWrite([{ type: 'start_task', id: 'a', title: '旧任务' }, { type: 'start_task', id: 'b', title: '当前任务' }]);
  await f.requirement('b-rule', '当前任务必须保留的要求', f.agent, { taskId: 'b' });
  await f.workspace({ action: 'select_task', taskId: 'a' });
  await f.projectWrite([{ type: 'task', id: 'a', status: 'completed', progress: '已完成', nextStep: '无', files: [] }]);
  const context = await f.context(); assert.match(context, /当前任务必须保留的要求/);
  const overview = await f.workspace({ action: 'overview' }); assert.equal(overview.selectedTask.id, 'b'); assert.equal(overview.requirementsComplete, true);
});
