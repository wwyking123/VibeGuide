import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_APP, desktopHost, prepareDesktopPlugin } from './desktop.mjs';

const { values } = parseArgs({ options: {
  app: { type: 'string', default: DEFAULT_APP },
  phase: { type: 'string' }, home: { type: 'string' },
} });
const marker = 'VIBEGUIDE_CONTINUITY_SMOKE=';
if (!process.versions.electron) {
  const temporary = await mkdtemp(join(tmpdir(), 'vibeguide-p0-smoke-'));
  try {
    const reports = [];
    for (const phase of ['write', 'reopen']) {
      const child = spawnSync(join(values.app, 'Contents', 'MacOS', 'DeepSeek Harness'), [
        '--expose-internals', fileURLToPath(import.meta.url), '--app', values.app, '--phase', phase, '--home', temporary,
      ], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: temporary }, encoding: 'utf8', timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
      assert.equal(child.status, 0, child.error?.message || child.stderr || child.stdout);
      const line = child.stdout.split('\n').find(s => s.startsWith(marker));
      assert.ok(line, child.stdout);
      reports.push(JSON.parse(line.slice(marker.length)));
    }
    console.log(JSON.stringify({ reports, freshProcessReopen: true, modelCalled: false, userProfileModified: false }, null, 2));
  } finally { await rm(temporary, { recursive: true, force: true }); }
} else {
  assert.ok(values.home && ['write', 'reopen'].includes(values.phase), 'Internal smoke phase required.');
  const temporary = values.home;
  process.env.DSH_HOME = temporary;
  process.chdir(temporary);
  const host = await desktopHost(values.app);
  const project = join(temporary, 'signup');
  const otherProject = join(temporary, 'another-project');
  const profileDirectory = join(temporary, 'profiles', 'desktop');
  if (values.phase === 'write') {
    await mkdir(profileDirectory, { recursive: true });
    await mkdir(otherProject);
    await cp(fileURLToPath(new URL('../evals/continuity/fixture', import.meta.url)), project, { recursive: true });
    await writeFile(join(profileDirectory, 'package.json'), JSON.stringify({
      name: 'vibeguide-p0-smoke', private: true,
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
    }));
    // Reproduce an older installation with two modes, then exercise real upgrade.
    const original = await prepareDesktopPlugin(host, join(temporary, 'plugins', 'old-white'));
    const formerP0 = await prepareDesktopPlugin(host, join(temporary, 'plugins', 'old-p0'), { storageRoot: join(temporary, 'vibeguide-p0-state') });
    formerP0.preset.id = 'preset-vibeguide-p0'; formerP0.preset.config.id = 'vibeguide-p0'; formerP0.preset.config.name = 'VibeGuide P0 · 项目续接';
    await writeFile(formerP0.patch.insert[0].config.path, host.dump([formerP0.preset]));
    formerP0.patch.insert[0].id = 'vibeguide-p0-presets';
    const historicalProject = join(temporary, 'historical-project'); await mkdir(historicalProject);
    const { ProjectStore } = await import('../dist/continuity/store.js');
    const historicalStore = await ProjectStore.forProject(join(temporary, 'vibeguide-p0-state'), historicalProject);
    const saved = await historicalStore.write({ expectedRevision: 0, operationId: 'historical-op', sessionId: 'old-p0', changes: [
      { type: 'requirement', id: 'preserved', text: '合并模式前保存的要求', kind: 'requirement', source: { sessionId: 'old-p0', messageId: 'historical-message', seq: 1, quote: '合并模式前保存的要求' } },
    ] });
    assert.equal(saved.status, 'saved');
    const historicalBytes = await readFile(historicalStore.recordPath);
    await writeFile(join(profileDirectory, 'cordis.patch.yml'), host.dump([{ id: 'hmr', disabled: true }, original.patch, formerP0.patch]));
    const child = spawnSync(process.execPath, ['--expose-internals', fileURLToPath(new URL('./install-desktop.mjs', import.meta.url)),
      '--app', values.app, '--home', temporary, '--upgrade'], { env: process.env, encoding: 'utf8', timeout: 30000 });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(JSON.parse(child.stdout).preset, 'vibeguide');
    assert.equal(JSON.parse(child.stdout).retiredP0, true);
    assert.deepEqual(await readFile(historicalStore.recordPath), historicalBytes);
    const patch = await readFile(join(profileDirectory, 'cordis.patch.yml'), 'utf8');
    const duplicate = spawnSync(process.execPath, ['--expose-internals', fileURLToPath(new URL('./install-desktop.mjs', import.meta.url)),
      '--app', values.app, '--home', temporary, '--continuity'], { env: process.env, encoding: 'utf8', timeout: 30000 });
    assert.notEqual(duplicate.status, 0);
    assert.equal(await readFile(join(profileDirectory, 'cordis.patch.yml'), 'utf8'), patch);
  }
  let root;
  const handles = [];
  const webRuntime = await host.load('@deepseek-ai/dsh-web-app');
  const originalBrowserOpener = webRuntime.internals.openBrowser;
  let browserOpenAttempts = 0;
  webRuntime.internals.openBrowser = async () => { browserOpenAttempts++; throw new Error('Browser forbidden in smoke.'); };
  try {
    const { loadProfileDirectory, loadLayeredEnv } = await host.load('@deepseek-ai/dsh-app-boot');
    const { runProfile } = await host.load('@deepseek-ai/dsh/profile-boot');
    const smokePatch = join(temporary, 'smoke.patch.yml');
    await writeFile(smokePatch, host.dump([
      { id: 'session-telemetry-otel', config: { mode: 'DISABLED' } },
      { id: 'session-title-llm', disabled: true },
      { id: 'desktop-product-telemetry', disabled: true },
      { id: 'product-analytics', disabled: true },
      { id: 'web-runtime', config: { printUrl: false, openBrowser: false } },
    ]));
    const profile = loadProfileDirectory('vibeguide-p0-smoke', profileDirectory, host.anchor);
    const application = await runProfile({
      environment: loadLayeredEnv('vibeguide-p0-smoke'), profile: 'desktop',
      resolvedProfile: { profile, installAnchor: host.anchor }, patchFiles: [smokePatch],
      args: ['--no-open', '--host', '127.0.0.1', '--port', '0'],
    });
    root = application.ctx;
    const roster = await root.agentPresets.list();
    for (const id of ['standard', 'vibeguide']) assert.ok(roster.some(p => p.id === id && !p.broken));
    assert.equal(roster.some(p => p.id === 'vibeguide-p0'), false);
    const create = async (preset, cwd = project) => {
      const handle = await root.agents.create({
        sessionId: `p0-smoke-${values.phase}-${handles.length}`, meta: { cwd, agentPreset: preset },
        setup: async ctx => { await root.agentPresets.mount(ctx, preset); },
      });
      handles.push(handle); return handle.agent;
    };
    const assemble = agent => root.systemPrompt.assemble({ scope: agent, agent });
    const contextText = assembly => assembly.contexts.find(c => c.name === 'vibeguide:project-record')?.text;
    let call = 0;
    const execute = (agent, args) => root.tools.execute({
      name: 'vibeguide_project', arguments: args, callId: `p0-call-${++call}`, agent, signal: AbortSignal.timeout(10000),
    });
    const tool = async (agent, args) => {
      const result = await execute(agent, args);
      assert.equal(result.isError, false, JSON.stringify(result));
      return result.value;
    };
    const user = (agent, text, id) => agent.session.append('user/message', {
      id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' },
    }, { surfaceOp: 'append' });
    const source = (event, quote, questionId) => ({ seq: event.seq, quote, ...(questionId ? { questionId } : {}) });
    const p0 = await create('vibeguide');
    const standard = await create('standard');
    const historical = await create('vibeguide', join(temporary, 'historical-project'));
    assert.equal((await tool(historical, { action: 'read' })).record.requirements[0].text, '合并模式前保存的要求');
    const [p0Assembly, standardAssembly] = await Promise.all([assemble(p0), assemble(standard)]);
    assert.deepEqual(p0Assembly.tools.filter(t => !t.name.startsWith('vibeguide_')), standardAssembly.tools);
    assert.equal(p0Assembly.tools.length, standardAssembly.tools.length + 3);
    assert.equal(contextText(standardAssembly), undefined);
    assert.ok(contextText(p0Assembly));
    assert.equal(contextText(root.systemPrompt.refreshContext(p0Assembly, { scope: p0, agent: p0 })), contextText(p0Assembly));
    const schema = await host.load('@deepseek-ai/dsh-tools');
    const recordTool = root.tools.get('vibeguide_project', p0);
    schema.assertObjectJsonSchema(recordTool.parameters);
    schema.assertSupportedJsonSchema(recordTool.output.schema);
    assert.deepEqual(schema.validateJsonSchemaValue(recordTool.parameters, { action: 'read' }), []);
    assert.notDeepEqual(schema.validateJsonSchemaValue(recordTool.parameters, { action: 'write', changes: [{ type: 'unknown' }] }), []);
    assert.notEqual(schema.jsonSchemaToTs(recordTool.parameters), 'unknown');
    assert.notEqual(schema.jsonSchemaToPy(recordTool.parameters), 'Any');
    const sdk = root.tools.sdkSchemas(p0).filter(t => t.name === 'vibeguide_project');
    assert.match(schema.renderToolsSdk(sdk), /vibeguide_project/);
    assert.match(schema.renderToolsSdkPy(sdk), /vibeguide_project/);
    assert.equal((await execute(standard, { action: 'read' })).isError, true);
    for (const name of ['vibeguide_workspace', 'vibeguide_preferences']) {
      const registered = root.tools.get(name, p0);
      schema.assertObjectJsonSchema(registered.parameters);
      assert.notEqual(schema.jsonSchemaToTs(registered.parameters), 'unknown');
      assert.notEqual(schema.jsonSchemaToPy(registered.parameters), 'Any');
      assert.equal((await root.tools.execute({ name, arguments: { action: name === 'vibeguide_workspace' ? 'overview' : 'read' }, callId: `isolation-${name}`, agent: standard, signal: AbortSignal.timeout(10000) })).isError, true);
    }
    const initial = await tool(p0, { action: 'read' });
    if (values.phase === 'write') {
      assert.equal(initial.record.revision, 0);
      const event = user(p0, '做一个活动报名页。名单只有组织者可见。', 'p0-user-initial');
      assert.ok((await tool(p0, { action: 'read' })).userSources.some(s => s.seq === event.seq));
      const first = await tool(p0, { action: 'write', expectedRevision: 0, changes: [
        { type: 'start_task', id: 'signup', title: '调整报名页面' },
        { type: 'requirement', id: 'privacy', kind: 'requirement', text: '名单只有组织者可见', source: source(event, '名单只有组织者可见') },
      ] });
      assert.equal(first.status, 'saved');
      assert.equal((await execute(p0, { action: 'write', expectedRevision: 1, changes: [
        { type: 'requirement', id: 'forged', kind: 'requirement', text: '伪造', source: { ...source(event, '名单'), messageId: 'invented' } },
      ] })).isError, true);
      const limit = user(p0, '最多 20 人，满员后不再接受报名。', 'p0-user-limit');
      // Synthetic changes test persistence; this script does not claim model implementation or business validation.
      await writeFile(join(project, 'smoke-change.txt'), 'capacity=20; full=reject\n');
      assert.equal((await tool(p0, { action: 'write', expectedRevision: 1, changes: [
        { type: 'requirement', id: 'capacity', kind: 'requirement', text: '最多 20 人，满员拒绝报名', source: source(limit, '最多 20 人，满员后不再接受报名') },
        { type: 'task', id: 'signup', status: 'in_progress', progress: '第一次合成文件修改已写；没有运行模型或业务检查。', nextStep: '调整样式。', files: ['smoke-change.txt'] },
      ] })).status, 'saved');
      user(p0, '按钮改成蓝色，其他要求不变。', 'p0-user-style');
      await writeFile(join(project, 'smoke-change.txt'), 'capacity=20; full=reject; button=blue\n');
      assert.equal((await tool(p0, { action: 'write', expectedRevision: 2, changes: [
        { type: 'task', id: 'signup', status: 'needs_check', progress: '两次合成文件修改已写；尚未验证真实界面。', nextStep: '核对实际页面与名单访问范围。', files: ['smoke-change.txt'] },
      ] })).status, 'saved');
      assert.equal((await tool(p0, { action: 'read' })).record.requirements.length, 2);
    } else {
      assert.equal(initial.record.revision, 3);
      assert.deepEqual(initial.record.requirements.map(r => r.id), ['privacy', 'capacity']);
      assert.equal(initial.record.tasks[0].status, 'needs_check');
      assert.match(contextText(p0Assembly), /名单只有组织者可见/);
      await writeFile(join(project, 'smoke-change.txt'), 'external modification\n');
      assert.equal((await tool(p0, { action: 'read' })).files[0].status, 'changed');
      const correction = user(p0, '更正一下：最多 30 人。只更新记录，暂时不要修改功能。', 'p0-user-correction');
      assert.equal((await tool(p0, { action: 'write', expectedRevision: 3, changes: [
        { type: 'requirement', id: 'capacity30', kind: 'requirement', text: '最多 30 人，满员仍拒绝报名', replaces: 'capacity', source: source(correction, '最多 30 人') },
      ] })).status, 'saved');
      assert.equal(await readFile(join(project, 'smoke-change.txt'), 'utf8'), 'external modification\n');
      const corrected = await tool(p0, { action: 'read' });
      assert.deepEqual(corrected.record.requirements.filter(r => r.status === 'active').map(r => r.id), ['privacy', 'capacity30']);
      const other = await create('vibeguide', otherProject);
      assert.equal((await tool(other, { action: 'read' })).record.revision, 0);
      assert.equal(contextText(await assemble(other)).includes('名单只有组织者可见'), false);
      assert.equal(contextText(await assemble(p0)).includes('capacity30'), true);
      // Native question result shape, with the actual event relationship.
      const questions = [{ id: 'q1', question: '满员后怎样处理？', options: [{ label: '拒绝报名', description: '不再登记。' }, { label: '进入候补', description: '留下候补记录。' }] }];
      const question = p0.session.append('tool/call', { turn: 0, step: 0, callId: 'native-question', name: 'ask_user_question', arguments: JSON.stringify({ questions }) });
      const answer = p0.session.append('tool/result', { turn: 0, step: 0, message: {
        id: 'p0-card-answer', role: 'tool', source: { kind: 'tool', callId: 'native-question' }, toolCallId: 'native-question',
        content: [{ type: 'text', text: JSON.stringify({ answers: [{ id: 'q1', selected: ['进入候补'], custom: '' }] }) }], isError: false,
      } }, { sourceEventSeqs: [question.seq], surfaceOp: 'append' });
      assert.ok((await tool(p0, { action: 'read' })).userSources.some(s => s.seq === answer.seq && s.quote === '进入候补'));
      assert.equal((await execute(p0, { action: 'write', expectedRevision: 4, changes: [
        { type: 'requirement', id: 'unselected', kind: 'requirement', text: '拒绝报名', source: source(answer, '拒绝报名', 'q1') },
      ] })).isError, true);
      assert.equal((await tool(p0, { action: 'write', expectedRevision: 4, changes: [
        { type: 'requirement', id: 'waitlist', kind: 'requirement', text: '最多 30 人，满员后进入候补', source: source(answer, '进入候补', 'q1'), replaces: 'capacity30' },
      ] })).status, 'saved');
      const cardRecord = await tool(p0, { action: 'read' });
      assert.equal(cardRecord.record.requirements.find(r => r.id === 'waitlist').source.messageId, 'p0-card-answer');
      // A corrupt saved record must degrade the context, not prevent opening the conversation.
      const { ProjectStore } = await import('../dist/continuity/store.js');
      const backing = await ProjectStore.forProject(join(temporary, 'vibeguide-p0-state'), project);
      const bytes = await readFile(backing.recordPath);
      try {
        await writeFile(backing.recordPath, '{broken');
        assert.match(contextText(await assemble(p0)), /读取失败/);
        assert.equal((await execute(p0, { action: 'read' })).isError, true);
        assert.equal((await tool(other, { action: 'read' })).record.revision, 0);
      } finally { await writeFile(backing.recordPath, bytes); }
    }
    const internal = async (name, args, agent = p0) => {
      const result = await root.tools.execute({ name, arguments: args, callId: `workbench-${++call}`, agent, signal: AbortSignal.timeout(10000) });
      assert.equal(result.isError, false, JSON.stringify(result)); return result.value;
    };
    const ws = async (args, agent = p0) => {
      if (!['overview', 'read', 'impact', 'guide'].includes(args.action)) args = { ...args, expectedRevision: (await internal('vibeguide_workspace', { action: 'overview' }, agent)).revision };
      return internal('vibeguide_workspace', args, agent);
    };
    if (values.phase === 'write') {
      const consent = user(p0, '组织者负责查看报名名单。以后默认先说下一步，再解释原因。', 'workbench-user');
      assert.equal((await ws({ action: 'fact', id: 'organizer', kind: 'role', text: '组织者查看报名名单', status: 'confirmed', source: source(consent, '组织者负责查看报名名单'), requirementIds: ['privacy'], files: ['app.mjs'], relatedIds: [] })).status, 'saved');
      const prefRead = await internal('vibeguide_preferences', { action: 'read' });
      assert.equal((await internal('vibeguide_preferences', { action: 'set', id: 'action-first', dimension: 'explanation', value: 'action_first', scope: 'personal', source: source(consent, '以后默认先说下一步，再解释原因'), expectedRevision: prefRead.revision })).status, 'saved');
      await writeFile(join(project, 'receipt-check.mjs'), 'console.log("VIBEGUIDE_RECEIPT_OK");\n');
      assert.equal((await ws({ action: 'check', id: 'receipt-check', title: '验收来源接入检查', expected: '记录真实命令退出结果，仅验证宿主接入', requirementIds: ['privacy'], files: ['receipt-check.mjs'], external: false })).status, 'saved');
      assert.equal((await ws({ action: 'prepare', checkId: 'receipt-check' })).status, 'saved');
      const scriptPath = join(project, 'receipt-check.mjs');
      const command = { command: `node '${scriptPath.replaceAll("'", "'\\''")}'`, description: '运行临时目录内的验收来源检查脚本' };
      const callId = 'real-receipt-bash';
      const nativeCall = p0.session.append('tool/call', { turn: 0, step: 0, callId, name: 'bash', arguments: JSON.stringify(command) });
      const nativeResult = await root.tools.execute({ name: 'bash', arguments: command, callId, agent: p0, signal: AbortSignal.timeout(10000) });
      assert.equal(nativeResult.isError, false, JSON.stringify(nativeResult));
      assert.equal(nativeResult.value.exitCode, 0, JSON.stringify(nativeResult.value));
      const nativeEvent = p0.session.append('tool/result', { turn: 0, step: 0, message: { id: 'real-receipt-message', role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId, content: nativeResult.content, isError: nativeResult.isError }, meta: nativeResult.meta }, { sourceEventSeqs: [nativeCall.seq], surfaceOp: 'append' });
      assert.equal((await ws({ action: 'evidence', id: 'real-receipt', checkId: 'receipt-check', seq: nativeEvent.seq, quote: 'VIBEGUIDE_RECEIPT_OK', interpretation: '真实 bash 进程成功退出；这不是报名业务验收。' })).status, 'saved');
      const evidence = (await ws({ action: 'read', collection: 'evidence' })).items[0];
      assert.equal(evidence.outcome, 'passed'); assert.equal(evidence.applicability, 'unchanged_scope');
      const guide = await ws({ action: 'guide' }); assert.equal(guide.steps.length, 5); assert.equal(guide.stages.every(s => s.status === 'not_checked'), true);
    } else {
      const facts = await ws({ action: 'read', collection: 'facts' }); assert.equal(facts.items[0].id, 'organizer');
      const evidence = (await ws({ action: 'read', collection: 'evidence' })).items[0]; assert.equal(evidence.outcome, 'passed');
      assert.equal((await internal('vibeguide_preferences', { action: 'read' })).effective[0].value, 'action_first');
      const crossProject = await create('vibeguide', otherProject);
      assert.equal((await ws({ action: 'read', collection: 'facts' }, crossProject)).items.length, 0);
      const crossPrefs = await internal('vibeguide_preferences', { action: 'read' }, crossProject);
      assert.equal(crossPrefs.effective[0].value, 'action_first'); assert.equal(JSON.stringify(crossPrefs).includes('报名名单'), false);
      await writeFile(join(project, 'receipt-check.mjs'), 'console.log("changed");\n');
      assert.equal((await ws({ action: 'read', collection: 'evidence' })).items[0].applicability, 'stale');
    }
    assert.equal(browserOpenAttempts, 0);
    console.log(marker + JSON.stringify({ phase: values.phase, desktopVersion: host.version,
      nativeToolsPreserved: standardAssembly.tools.length, extraRecordTools: 3, standardIsolated: true, singleVibeGuideMode: true, previousProjectRecordsPreserved: true,
      contextRefreshPreserved: true, nativeSchemaAndSdkValidated: true, revision: (await tool(p0, { action: 'read' })).record.revision,
      workbenchLoaded: true, nativeBashReceiptPersisted: true, preferencesIsolated: true,
      ...(values.phase === 'reopen' ? { correctionPreservedOtherRequirements: true, externalChangeDetected: true, otherProjectIsolated: true, nativeSelectedAnswerValidated: true, corruptRecordDegradesExplicitly: true } : {}),
    }));
  } finally {
    try { for (const handle of handles) await handle.dispose(); if (root) await root.fiber.dispose(); }
    finally { webRuntime.internals.openBrowser = originalBrowserOpener; }
  }
}
