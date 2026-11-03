import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, rm, writeFile, readFile, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_APP, desktopHost, prepareDesktopPlugin, sourceRoot } from './desktop.mjs';

const { values } = parseArgs({ options: { installed: { type: 'string' }, serve: { type: 'boolean' } } });
const installedDirectory = values.installed ? resolve(values.installed) : undefined;
if (!process.versions.electron) {
  const result = spawnSync(join(DEFAULT_APP, 'Contents', 'MacOS', 'DeepSeek Harness'), [
    '--expose-internals', fileURLToPath(import.meta.url), ...process.argv.slice(2),
  ], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit' });
  if (result.error) console.error(result.error.message);
  process.exitCode = result.status ?? 1;
} else {
  const originalSignalListeners = new Map(['SIGINT', 'SIGTERM'].map(name => [name, new Set(process.rawListeners(name))]));
  const host = await desktopHost();
  const temporary = await mkdtemp(join(tmpdir(), 'vibeguide-guide-smoke-'));
  const projectDirectory = join(temporary, 'project');
  await mkdir(projectDirectory);
  const previousHome = process.env.DSH_HOME;
  const previousCwd = process.cwd();
  process.env.DSH_HOME = temporary; process.chdir(temporary);
  const web = await host.load('@deepseek-ai/dsh-web-app');
  const originalOpener = web.internals.openBrowser;
  web.internals.openBrowser = async () => { throw new Error('No browser opening in host smoke test'); };
  let root;
  let installedPresetBefore;
  try {
    const profileDirectory = join(temporary, 'profiles', 'desktop');
    await mkdir(profileDirectory, { recursive: true });
    await writeFile(join(profileDirectory, 'package.json'), JSON.stringify({ name: 'vibeguide-guide-smoke', private: true,
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }));
    const originalRows = [
      { id: 'hmr', disabled: true },
      { id: 'session-telemetry-otel', config: { mode: 'DISABLED' } },
      { id: 'session-title-llm', disabled: true },
      { id: 'desktop-product-telemetry', disabled: true },
      { id: 'product-analytics', disabled: true },
      { id: 'web-runtime', config: { printUrl: false, openBrowser: false } },
    ];
    const patchPath = join(profileDirectory, 'cordis.patch.yml');
    let pluginDirectory;
    if (installedDirectory) {
      // Cordis persists fiber.dispose() as disabled in the owning include. Never
      // give the smoke test's Loader ownership of a daily installation's file.
      installedPresetBefore = await readFile(join(installedDirectory, 'preset.cordis.yml'), 'utf8');
      pluginDirectory = join(temporary, 'installed-copy');
      await cp(installedDirectory, pluginDirectory, { recursive: true });
      const sourcePrefix = pathToFileURL(installedDirectory + '/').href;
      const targetPrefix = pathToFileURL(pluginDirectory + '/').href;
      const rebase = value => typeof value === 'string'
        ? value.startsWith(sourcePrefix) ? targetPrefix + value.slice(sourcePrefix.length) : value
        : Array.isArray(value) ? value.map(rebase)
        : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, field]) =>
          [key, key === 'storageRoot' ? join(temporary, 'isolated-state') : rebase(field)])) : value;
      await writeFile(join(pluginDirectory, 'preset.cordis.yml'), host.dump(rebase(host.parse(installedPresetBefore))));
      await writeFile(patchPath, host.dump([...originalRows, { insert: [{
        id: 'vibeguide-presets', name: 'cordis:include', config: { path: join(pluginDirectory, 'preset.cordis.yml') },
      }] }]));
    } else {
      // Exercise the actual CLI upgrade, including custom legacy storage and backups.
      const storageRoot = join(temporary, 'existing-records');
      await mkdir(storageRoot);
      const recordFile = join(storageRoot, 'retained.json');
      await writeFile(recordFile, '{"retained":true}\n');
      const legacy = await prepareDesktopPlugin(host, join(temporary, 'legacy-plugin'), { storageRoot });
      let before = host.dump([...originalRows, legacy.patch]);
      await writeFile(patchPath, before);
      for (let pass = 0; pass < 2; pass++) {
        const install = spawnSync(process.execPath, [
          '--expose-internals', fileURLToPath(new URL('./install-desktop.mjs', import.meta.url)),
          '--home', temporary, '--upgrade',
        ], { env: process.env, encoding: 'utf8', timeout: 30000 });
        assert.equal(install.status, 0, install.stderr);
        const result = JSON.parse(install.stdout);
        assert.equal(result.edition, 'sidebar');
        assert.equal(result.storageRoot, storageRoot, 'legacy storage location must survive repeated sidebar upgrades');
        assert.equal(await readFile(result.backup, 'utf8'), before);
        assert.equal(await readFile(recordFile, 'utf8'), '{"retained":true}\n');
        before = await readFile(patchPath, 'utf8');
        const rows = host.parse(before);
        assert.deepEqual(rows.slice(0, -1), originalRows, 'unrelated settings must survive');
        assert.equal(rows.flatMap(row => row.insert ?? []).filter(row => row.id === 'vibeguide-presets').length, 1);
        pluginDirectory = result.packageDirectory;
      }
    }
    const manifest = JSON.parse(await readFile(join(pluginDirectory, 'package.json'), 'utf8'));
    assert.equal(manifest.dsh.client.immediately, true);
    assert.equal(manifest.exports['.'], './dist/guide/plugin.js');
    assert.ok((await readFile(join(pluginDirectory, 'dist', 'client.js'), 'utf8')).includes('__ModuleLoader__'));
    const declaration = host.parse(await readFile(join(pluginDirectory, 'preset.cordis.yml'), 'utf8'));
    assert.equal(declaration.filter(row => row.id === 'vibeguide-guide').length, 1);
    assert.equal(declaration.filter(row => row.config?.id === 'vibeguide').length, 1);
    const { loadProfileDirectory, loadLayeredEnv } = await host.load('@deepseek-ai/dsh-app-boot');
    const { runProfile } = await host.load('@deepseek-ai/dsh/profile-boot');
    const profile = loadProfileDirectory('vibeguide-guide-smoke', profileDirectory, host.anchor);
    const app = await runProfile({ environment: loadLayeredEnv('vibeguide-guide-smoke'), profile: 'desktop',
      resolvedProfile: { profile, installAnchor: host.anchor }, patchFiles: [], args: ['--no-open', '--host', '127.0.0.1', '--port', '0'] });
    root = app.ctx;
    assert.ok(root.clientModules.graph().entries.some(entry => entry.id === 'vibeguide'),
      'VibeGuide client must be present in the boot graph before Desktop captures its injections');
    // This isolated harness owns shutdown. Let our finally block complete instead of
    // the CLI's process-exit signal handler racing temporary-profile cleanup.
    for (const [name, original] of originalSignalListeners) {
      for (const listener of process.rawListeners(name)) if (!original.has(listener)) process.removeListener(name, listener);
    }
    assert.ok(root.vibeGuide, 'host service must be mounted once');
    await assert.rejects(root.vibeGuide.getSnapshot({ sessionId: 'untrusted-direct-call' }, new AbortController().signal),
      { code: 'vibeguide/access-denied' }, 'service requires the authenticated Gateway invocation');
    let modelCalls = 0;
    let mainCalls = 0;
    let p4MainPhase = 0, p5MainPhase = 0;
    let enterMain, releaseMain;
    const mainEntered = new Promise(resolve => { enterMain = resolve; });
    const mainGate = new Promise(resolve => { releaseMain = resolve; });
    let composeCalls = 0;
    const fixtureSuggestions = { P2_SUGGEST: '请把标题改成每日思考，保留 21 天规则，不要公开回答。', P2_IDLE_SUGGEST: '请把标题改成每天一个问题。',
      P4_SUGGEST: '请把页面标题改成每天一个问题，保留回答保存。P4_NATIVE_TITLE' };
    let enterCancelledCall;
    const cancelledCallEntered = new Promise(resolve => { enterCancelledCall = resolve; });
    root.llm.registerAdapter(['vibeguide-fixture'], {
      providerInfo: provider => ({ id: provider, name: 'VibeGuide deterministic fixture' }),
      providerRetryPolicy: () => undefined,
      listModels: async provider => [{ provider, id: 'fixture', name: 'Fixture (no network)' }],
      resolveModel: async (provider, model) => ({ provider, id: model, name: 'Fixture' }),
      prepareCall: async (provider, model) => ({
        model: { provider, id: model, name: 'Fixture' },
        async *stream(options) {
          const isExplanation = typeof options.system === 'string' && options.system.includes('只读理解助手');
          if (typeof options.system === 'string' && options.system.includes('替用户给主开发 AI 写一条修改要求')) {
            modelCalls++; composeCalls++;
            assert.equal(options.tools?.length ?? 0, 0, 'composing must not carry execution tools');
            const source = JSON.parse(options.messages.at(-1).content.find(part => part.type === 'text').text);
            yield { type: 'text-delta', index: 0, text: source.suggestion };
            yield { type: 'finish', reason: { kind: 'stop' } }; return;
          }
          if (isExplanation) {
            modelCalls++;
            yield { type: 'usage', usage: { inputTokens: 120, outputTokens: 40, cacheReadTokens: 30 } };
            assert.equal(options.tools?.length ?? 0, 0, 'explanation must not carry execution tools');
            if (options.system.includes('任务类型：overview')) {
              const source = JSON.parse(options.messages.at(-1).content.find(part => part.type === 'text').text);
              const files = source.files.filter(row => ['index.html', 'app.js'].includes(row.file));
              yield { type: 'text-delta', index: 0, text: JSON.stringify({ summary: '一个帮助用户每天回答问题的页面，这是测试模型的固定概览。',
                name: '每天一个问题', missing: [{ title: '账号登录', layer: 'external', purpose: '换手机继续看需要识别同一个人' }], nodes: files.map(row => ({ layer: row.file === 'index.html' ? 'page' : 'data', maturity: row.file === 'index.html' ? 'works' : 'mock', maturityReason: '固定测试推测', title: row.file === 'index.html' ? '每日问题页面' : '回答保存', purpose: '推测承担页面展示或回答保存职责。', impact: '本机保存可能无法跨设备，需要实际验证。', files: [row.file] })), unknowns: ['尚未验证跨设备和权限行为。'] }) };
              yield { type: 'finish', reason: { kind: 'stop' } }; return;
            }
            if (options.system.includes('任务类型：goal') || options.system.includes('任务类型：changes')) {
              const source = JSON.parse(options.messages.at(-1).content.find(part => part.type === 'text').text);
              const title = source.overview?.nodes.find(node => node.files.includes('index.html'));
              yield { type: 'text-delta', index: 0, text: JSON.stringify({ summary: '实际标题内容发生变化；这是隔离测试固定讲解。', impacts: ['标题变化不会自动增加跨设备保存能力。'],
                nodes: [{ ...(title ? { id: title.id } : {}), title: '每日问题页面', reason: '展示用户看到的标题', files: ['index.html'] }],
                possibleAdditions: ['跨设备可能还需要身份和网络保存'], unknowns: ['没有验证跨设备体验'], sources: ['index.html'] }) };
              yield { type: 'finish', reason: { kind: 'stop' } }; return;
            }
            if (options.system.includes('任务类型：trouble')) {
              yield { type: 'text-delta', index: 0, text: JSON.stringify({ summary: '同一检查反复失败；这是固定测试讲解。', impacts: ['当前不能确认符合预期'], nodes: [], possibleAdditions: [], unknowns: ['没有确定根因'], sources: [], nextSteps: [{ label: '先检查失败条件', reason: '缩小需要修改的范围', request: '请定位并修复失败的检查，保留已有要求及数据。' }] }) };
              yield { type: 'finish', reason: { kind: 'stop' } }; return;
            }
            if (options.system.includes('任务类型：trial')) {
              yield { type: 'text-delta', index: 0, text: JSON.stringify({ steps: [{ action: '打开修改后的页面，查看顶部标题', expected: '显示“每天一个问题”' }] }) };
              yield { type: 'finish', reason: { kind: 'stop' } }; return;
            }

            if (JSON.stringify(options.messages).includes('fixture-unload-cancel')) {
              enterCancelledCall();
              await new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
            }
          } else {
            mainCalls++;
            if (JSON.stringify(options.messages).includes('P5_NATIVE_FAIL') && p5MainPhase < 2) {
              const check = { command: 'node --test verify.test.mjs', description: '检查实际回答是否符合预期' };
              if (options.tools?.some(tool => tool.name === 'bash')) {
                yield { type: 'tool-call-delta', index: 0, id: `p5-native-${p5MainPhase++}`, name: 'bash', argumentsDelta: JSON.stringify(check) };
              } else {
                p5MainPhase = 2;
                yield { type: 'tool-call-delta', index: 0, id: 'p5-native-run', name: 'run_code', argumentsDelta: JSON.stringify({ code: `await tools.bash(${JSON.stringify(check)}); await tools.bash(${JSON.stringify(check)});`, description: '核对重复检查失败' }) };
              }
              yield { type: 'finish', reason: { kind: 'tool-calls' } }; return;
            }
            if (JSON.stringify(options.messages).includes('P4_NATIVE_TITLE') && p4MainPhase < 2) {
              const write = { command: "printf '<h1>每天一个问题</h1><script src=\"./app.js\"></script>' > index.html", description: '把页面标题改为每天一个问题，保留回答保存入口' };
              const check = { command: 'node --test p4.test.mjs', description: '确认标题内容和回答保存入口' };
              if (options.tools?.some(tool => tool.name === 'bash')) {
                yield { type: 'tool-call-delta', index: 0, id: `p4-native-${p4MainPhase}`, name: 'bash', argumentsDelta: JSON.stringify(p4MainPhase++ === 0 ? write : check) };
              } else {
                assert.ok(options.tools?.some(tool => tool.name === 'run_code'), 'native fixture needs bash or run_code'); p4MainPhase = 2;
                yield { type: 'tool-call-delta', index: 0, id: 'p4-native-run', name: 'run_code', argumentsDelta: JSON.stringify({ code: `await tools.bash(${JSON.stringify(write)}); await tools.bash(${JSON.stringify(check)});`, description: '修改标题并检查这条要求' }) };
              }
              yield { type: 'finish', reason: { kind: 'stop' } }; return;
            }
            if (mainCalls === 1) { enterMain(); await mainGate; }
            if (mainCalls === 3) {
              yield { type: 'tool-call-delta', index: 0, id: 'fixture-live-question', name: 'ask_user_question', argumentsDelta: JSON.stringify({ questions: [{
                id: 'device', question: '换一部手机后，需要继续看到之前的回答吗？', options: [
                  { label: '需要跨设备', description: '需要登录；回答保存在网络上，换设备可继续。' },
                  { label: '先只在本机', description: '不用登录；换设备后不会带上之前的回答。' },
                ],
              }] }) };
              yield { type: 'finish', reason: { kind: 'stop' } }; return;
            }
          }
          options.signal.throwIfAborted();
          const suggest = isExplanation && Object.entries(fixtureSuggestions).find(([token]) => JSON.stringify(options.messages).includes(token));
          yield { type: 'text-delta', index: 0, text: '这是隔离验证使用的固定回答：保存在本机意味着换手机后不能自动看到之前的回答。需要跨设备时，再考虑账号与云端保存。' + (suggest ? `\n\n【可发送的改法】${suggest[1]}` : '') };
          yield { type: 'finish', reason: { kind: 'stop' } };
        },
      }),
    });
    const { scopeOf } = await host.load('@deepseek-ai/dsh-scope');
    const handles = [];
    const assemblies = [];
    for (const id of ['standard', 'vibeguide']) {
      const handle = await root.agents.create({ sessionId: `guide-smoke-${id}`, meta: { cwd: projectDirectory, agentPreset: id },
        setup: async ctx => { await root.agentPresets.mount(ctx, id); } });
      handles.push(handle);
      assemblies.push(await root.systemPrompt.assemble({ scope: scopeOf(handle.agent.ctx), agent: handle.agent }));
    }
    const guideAgent = handles[1].agent;
    guideAgent.session.append('model/selection', { provider: 'vibeguide-fixture', model: 'fixture' });
    guideAgent.session.append('user/message', { id: 'fixture-user', role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text: '我要做一个 21 天打卡思考小游戏。先讨论怎么保存回答，暂时不要写代码。' }] }, { surfaceOp: 'append' });
    assert.deepEqual(assemblies[1].tools, assemblies[0].tools, 'no VibeGuide record tools in main AI');
    assert.equal(assemblies[1].sections.some(section => section.name === 'vibeguide:continuity'), false);
    assert.equal(assemblies[1].sections.some(section => section.name === 'vibeguide:communication'), true);
    const peer = { id: 'vibeguide-owner-test', principal: { kind: 'owner' }, signal: new AbortController().signal };
    const invoke = (method, request, identity = peer) => root.typertGateway.invoke({
      namespace: 'vibeGuide', method, args: { request }, signal: new AbortController().signal, peer: identity,
    });
    const snapshot = await invoke('getSnapshot', { sessionId: 'guide-smoke-vibeguide' });
    assert.equal(snapshot.scope.sessionId, 'guide-smoke-vibeguide');
    assert.equal(snapshot.enabled, true);
    await assert.rejects(invoke('getSnapshot', { sessionId: 'guide-smoke-standard' }), /VibeGuide/);
    assert.equal(snapshot.choices.length, 0);
    assert.match(snapshot.observations.at(-1).text, /暂时不要写代码/);
    assert.equal(modelCalls, 0, 'snapshot must not call a model');
    const beforeAsk = guideAgent.session.seq;
    const answer = await invoke('ask', { sessionId: guideAgent.session.id, clientRequestId: 'fixture-explain',
      basis: snapshot.basis, question: '本机保存对用户有什么影响？' });
    assert.match(answer.text, /换手机/);
    assert.equal(modelCalls, 1);
    assert.equal(guideAgent.session.seq, beforeAsk, 'explanation must not append main chat events');
    const reused = await invoke('ask', { sessionId: guideAgent.session.id, clientRequestId: 'fixture-explain-again',
      basis: snapshot.basis, question: '本机保存对用户有什么影响？' });
    assert.equal(reused.cached, true); assert.equal(modelCalls, 1);
    const questionCall = guideAgent.session.append('tool/call', { turn: 0, step: 0, callId: 'pending-choice', name: 'ask_user_question',
      arguments: JSON.stringify({ questions: [{ id: 'save', question: '换一部手机后，需要继续看到之前的回答吗？', options: [
        { label: '需要跨设备', description: '需要识别同一个用户，并在网络上保存回答。' },
        { label: '先只在本机', description: '不用登录，换设备后不会自动带上之前的回答。' },
      ] }] }) });
    assert.equal((await invoke('getSnapshot', { sessionId: guideAgent.session.id })).choices.length, 1,
      'pending legacy question is available before its result');
    guideAgent.session.append('tool/result', { turn: 0, step: 0, message: { id: 'fixture-answer', role: 'tool',
      source: { kind: 'tool', callId: 'pending-choice' }, toolCallId: 'pending-choice', isError: false,
      content: [{ type: 'text', text: '{"answers":[{"id":"save","selected":["先只在本机"],"custom":""}]}' }] } },
      { sourceEventSeqs: [questionCall.seq], surfaceOp: 'append' });
    assert.equal((await invoke('getSnapshot', { sessionId: guideAgent.session.id })).choices.length, 0);

    // Use the real API-created Agent for queue admission; all model responses remain local fixtures.
    const workspace = await root.workspaceRegistry.create(projectDirectory, 'VibeGuide 隔离验证');
    const created = await root.sessionController.create({ workspaceId: workspace.id, agentPreset: 'vibeguide' });
    const deliverySessionId = created.sessionId;
    await root.sessionController.selectModel({ sessionId: deliverySessionId, provider: 'vibeguide-fixture', model: 'fixture' });
    const { HarnessAdapter } = await import('../dist/guide/host/adapter.js');
    const adapter = new HarnessAdapter(root, await host.load('@deepseek-ai/dsh-llm'));
    await adapter.queueModification(deliverySessionId, '这是隔离测试：先讨论保存方式，不要修改文件。', 'fixture-busy', new AbortController().signal);
    await Promise.race([mainEntered, new Promise((_, reject) => setTimeout(() => reject(new Error('main fixture did not start')), 5000))]);
    const original = '那就改成换手机也能看；不要公开回答，只允许本人查看。';
    await adapter.queueModification(deliverySessionId, original, 'fixture-delivery', new AbortController().signal);
    assert.equal((await adapter.deliveryStatus(deliverySessionId, 'fixture-delivery')).state, 'queued');
    await adapter.queueModification(deliverySessionId, original, 'fixture-delivery', new AbortController().signal);
    releaseMain();
    let receipt;
    for (let attempt = 0; attempt < 100; attempt++) {
      receipt = await adapter.deliveryStatus(deliverySessionId, 'fixture-delivery');
      if (receipt.state === 'accepted') break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(receipt.state, 'accepted');
    const sent = (await root.sessionQuery.readSession(deliverySessionId)).events.filter(event => event.type === 'user/message'
      && event.data.source?.rpcId === 'fixture-delivery');
    assert.equal(sent.length, 1); assert.equal(sent[0].data.content[0].text, original);
    assert.equal((await adapter.deliveryStatus(deliverySessionId, 'never-sent')).state, 'unknown');

    // A bounded pre-execution probe persists its baseline before next(), never via tools/result.
    const baselinePath = join(projectDirectory, 'native-check-baseline.json');
    const checkInput = join(projectDirectory, 'check-input.txt');
    await writeFile(checkInput, 'before');
    let captured = false, baselineMs = 0;
    const unhook = root.on('tools/execute', async (exec, next) => {
      if (exec.callId !== 'guide-native-baseline') return next();
      const started = performance.now();
      const file = await open(baselinePath, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify({ callId: exec.callId, before: await readFile(checkInput, 'utf8') })); await file.sync(); }
      finally { await file.close(); }
      captured = true;
      baselineMs = performance.now() - started;
      return next();
    }, { global: true });
    try {
      const result = await root.tools.execute({ name: 'bash',
        arguments: { command: 'test -f native-check-baseline.json && test "$(cat check-input.txt)" = before', description: 'Verify isolated pre-execution baseline' },
        callId: 'guide-native-baseline', agent: guideAgent,
        signal: AbortSignal.timeout(5000) });
      assert.equal(captured, true);
      assert.equal(result.isError, false, JSON.stringify(result));
      assert.equal(result.value.exitCode, 0, JSON.stringify(result.value));
    } finally { unhook(); }
    await adapter.queueModification(deliverySessionId, '请先问我换手机后的体验。', 'fixture-live-question-request', new AbortController().signal);
    let pending;
    for (let attempt = 0; attempt < 100; attempt++) {
      pending = await invoke('getSnapshot', { sessionId: deliverySessionId });
      if (pending.choices.length) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(pending.choices.length, 1, 'native question remains readable while main Agent awaits an answer');
    const explainedChoice = await invoke('ask', { sessionId: deliverySessionId, clientRequestId: 'fixture-live-choice-explanation',
      basis: pending.basis, question: '这两个选项会影响什么？', choiceId: pending.choices[0].id, choiceVersion: pending.choices[0].version });
    assert.ok(explainedChoice.text);
    assert.equal(root.agents.get(deliverySessionId).status, 'running', 'explaining must not answer or cancel the main question');

    // P2 public input endpoint: the input box only explains; one click sends a written change.
    const p2Snapshot = await invoke('getSnapshot', { sessionId: deliverySessionId });
    const p2Request = (id, statement, extra = {}) => ({ sessionId: deliverySessionId, projectId: p2Snapshot.scope.projectId,
      clientRequestId: id, statement, basis: p2Snapshot.basis, ...extra });
    const mainEventsBeforeP2 = (await root.sessionQuery.readSession(deliverySessionId)).events;
    const p2Answer = await invoke('submit', p2Request('p2-question', '为什么不用云端？'));
    assert.equal(p2Answer.input.kind, 'explain'); assert.ok(p2Answer.explanation.text);
    assert.equal((await invoke('submit', p2Request('p2-original-answer', '选第二个'))).input.kind, 'redirect');
    assert.equal((await invoke('submit', p2Request('p2-typed-change', '把标题改成每日思考，保留 21 天规则，不要公开回答。'))).input.kind, 'explain', 'typed changes are only explained');
    assert.deepEqual((await root.sessionQuery.readSession(deliverySessionId)).events, mainEventsBeforeP2);
    assert.equal((await invoke('getSnapshot', { sessionId: deliverySessionId })).choices.length, 1);
    const p2Suggested = await invoke('ask', { sessionId: deliverySessionId, clientRequestId: 'p2-suggest', basis: (await invoke('getSnapshot', { sessionId: deliverySessionId })).basis, question: '标题怎么改更好？P2_SUGGEST' });
    assert.equal(p2Suggested.suggestion, fixtureSuggestions.P2_SUGGEST); assert.doesNotMatch(p2Suggested.text, /可发送的改法/);
    assert.deepEqual((await root.sessionQuery.readSession(deliverySessionId)).events, mainEventsBeforeP2, 'a suggestion alone sends nothing');
    const p2Modify = { sessionId: deliverySessionId, projectId: p2Snapshot.scope.projectId, clientRequestId: 'p2-queued-change', source: { kind: 'explanation', id: p2Suggested.id } };
    const p2Pair = await Promise.all([invoke('handoff', p2Modify), invoke('handoff', p2Modify)]);
    assert.equal(p2Pair[0].delivery.id, p2Pair[1].delivery.id); assert.equal(composeCalls, 1);
    let p2Queued;
    for (let i = 0; i < 100; i++) {
      p2Queued = (await invoke('getSnapshot', { sessionId: deliverySessionId })).deliveries.find(row => row.id === p2Pair[0].delivery.id);
      if (p2Queued.state === 'queued') break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(p2Queued.state, 'queued'); assert.equal(p2Queued.content, fixtureSuggestions.P2_SUGGEST);
    assert.equal((await invoke('getSnapshot', { sessionId: deliverySessionId })).choices.length, 1, 'queued change does not answer or interrupt original question');
    const p2IdleSession = (await root.sessionController.create({ workspaceId: workspace.id, agentPreset: 'vibeguide' })).sessionId;
    await root.sessionController.selectModel({ sessionId: p2IdleSession, provider: 'vibeguide-fixture', model: 'fixture' });
    const p2IdleView = await invoke('getSnapshot', { sessionId: p2IdleSession });
    const p2IdleAnswer = await invoke('ask', { sessionId: p2IdleSession, clientRequestId: 'p2-idle-suggest', basis: p2IdleView.basis, question: '标题要不要改？P2_IDLE_SUGGEST' });
    const p2IdleStatement = fixtureSuggestions.P2_IDLE_SUGGEST;
    const p2IdleRequest = { sessionId: p2IdleSession, projectId: p2IdleView.scope.projectId, clientRequestId: 'p2-idle-change', source: { kind: 'explanation', id: p2IdleAnswer.id } };
    const p2IdleResult = await invoke('handoff', p2IdleRequest);
    let p2Accepted;
    for (let i = 0; i < 100; i++) {
      p2Accepted = (await invoke('getSnapshot', { sessionId: p2IdleSession })).deliveries.find(row => row.id === p2IdleResult.delivery.id);
      if (p2Accepted.state === 'accepted') break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(p2Accepted.state, 'accepted'); assert.ok(Number.isInteger(p2Accepted.source.seq));
    const p2NativeMessages = () => root.sessionQuery.readSession(p2IdleSession).then(read => read.events.filter(event => event.type === 'user/message'
      && event.data.source?.rpcId === p2Accepted.requestId));
    assert.equal((await p2NativeMessages()).length, 1);

    // P3: explicit project knowledge, cross-session history and scoped experience feedback.
    await writeFile(join(projectDirectory, 'index.html'), '<script src="./app.js"></script>');
    await writeFile(join(projectDirectory, 'app.js'), 'localStorage.setItem("answer", "fixture");');
    const p3Scope = { sessionId: p2IdleSession, projectId: p2IdleView.scope.projectId };
    const p3BeforeCalls = modelCalls;
    const p3Empty = await invoke('projectView', p3Scope);
    assert.equal(p3Empty.overview, undefined);
    const p3History = await invoke('history', p3Scope);
    assert.ok(p3History.items.some(row => row.id === answer.id && !row.fromCurrentSession));
    assert.equal(modelCalls, p3BeforeCalls, 'opening project and history must not generate');
    const p3Graph = await invoke('overview', { ...p3Scope, clientRequestId: 'p3-overview' });
    assert.equal(p3Graph.nodes.length, 2); assert.equal(p3Graph.edges.length, 1);
    assert.equal((await invoke('overview', { ...p3Scope, clientRequestId: 'p3-cached-overview' })).id, p3Graph.id);
    assert.equal(modelCalls, p3BeforeCalls + 1);
    const p3OldAnswer = p3History.items.find(row => row.id === answer.id);
    await invoke('annotate', { ...p3Scope, clientRequestId: 'p3-correction', explanationId: answer.id,
      version: p3OldAnswer.contextVersion, action: 'correct', text: '目前仅本机保存，尚未确认云端能力。' });
    assert.ok(!(await invoke('getSnapshot', { sessionId: guideAgent.session.id })).explanations.some(row => row.id === answer.id));
    const p3Corrected = (await invoke('history', p3Scope)).items.find(row => row.id === answer.id);
    const p3FollowView = await invoke('getSnapshot', { sessionId: p2IdleSession });
    const p3Follow = await invoke('submit', { ...p3Scope, clientRequestId: 'p3-follow', basis: p3FollowView.basis,
      statement: '换手机有什么影响？', context: { kind: 'explanation', id: answer.id, version: p3Corrected.contextVersion } });
    assert.equal(p3Follow.input.kind, 'explain'); assert.equal(p3Follow.explanation.context.id, answer.id);
    await writeFile(join(projectDirectory, 'app.js'), 'localStorage.setItem("answer", "later fixture");');
    const p3Changed = await invoke('projectView', p3Scope);
    assert.equal(p3Changed.overview.historical, true); assert.equal(p3Changed.overview.changedNodes.length, 1);
    assert.equal((await p2NativeMessages()).length, 1, 'project explanations never dispatch development');
    console.log(JSON.stringify({ explicitOverview: true, overviewCached: true, importEdges: true, crossSessionHistory: true,
      correctionPersists: true, contextualFollowup: true,
      openingProjectModelCalls: 0, realModelQualityEvaluated: false }));

    // P4: a real host turn performs tools; fixed model output does not substitute for native receipts.
    for (const method of ['reviseRequirement', 'confirmRequirement', 'handoff', 'analyze']) await assert.rejects(root.vibeGuide[method]({}, new AbortController().signal), { code: 'vibeguide/access-denied' });
    await writeFile(join(projectDirectory, 'p4.test.mjs'), 'import {readFileSync} from "node:fs"; import assert from "node:assert/strict"; const page=readFileSync("index.html","utf8"); assert.ok(page.includes("<h1>每天一个问题</h1>")); assert.ok(page.includes("app.js"));');
    const p4Session = (await root.sessionController.create({ workspaceId: workspace.id, agentPreset: 'vibeguide' })).sessionId;
    await root.sessionController.selectModel({ sessionId: p4Session, provider: 'vibeguide-fixture', model: 'fixture' });
    const p4Snapshot = await invoke('getSnapshot', { sessionId: p4Session }), p4Scope = { sessionId: p4Session, projectId: p4Snapshot.scope.projectId };
    const p4Suggested = await invoke('ask', { sessionId: p4Session, clientRequestId: 'p4-suggest', basis: p4Snapshot.basis, question: '标题要怎么改？P4_SUGGEST' });
    const p4Delivery = await invoke('handoff', { ...p4Scope, clientRequestId: 'p4-native-requirement', source: { kind: 'explanation', id: p4Suggested.id } });
    assert.ok(p4Delivery.delivery.background.some(row => row.text === p2IdleStatement), 'related history must be visibly attached');
    let p4View, p4Outcome;
    for (let i = 0; i < 150; i++) {
      await invoke('getSnapshot', { sessionId: p4Session });
      p4View = await invoke('projectView', p4Scope);
      p4Outcome = p4View.work.outcomes.find(row => row.requirement.deliveryId === p4Delivery.delivery.id);
      if (p4Outcome?.candidates.some(row => row.linked && row.kind === 'check' && row.current)) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(p4Outcome?.candidates.some(row => row.linked && row.kind === 'check' && row.current), JSON.stringify(p4Outcome));
    const p4Ref = { id: p4Outcome.requirement.id, version: p4Outcome.requirement.version };
    assert.equal(p4Outcome.state, 'needs_feedback', 'a linked native change makes the requirement ready to try');
    await invoke('confirmRequirement', { ...p4Scope, clientRequestId: 'p4-confirm', requirement: p4Ref });
    assert.equal((await invoke('projectView', p4Scope)).work.outcomes.find(row => row.requirement.id === p4Ref.id).state, 'complete');
    const p4Analysis = await invoke('analyze', { ...p4Scope, clientRequestId: 'p4-changes', kind: 'changes', question: '这次实际改动有什么影响？' });
    assert.ok(p4Analysis.coveredChanges > 0);
    const p4Calls = modelCalls;
    assert.equal((await invoke('analyze', { ...p4Scope, clientRequestId: 'p4-changes-cache', kind: 'changes', question: '这次实际改动有什么影响？' })).id, p4Analysis.id);
    const p4Latest = await invoke('getSnapshot', { sessionId: p4Session });
    const p4Goal = await invoke('submit', { ...p4Scope, clientRequestId: 'p4-goal', basis: p4Latest.basis, statement: '如果换手机也能看回答，需要改哪些部分？' });
    assert.equal(p4Goal.input.kind, 'explain'); assert.ok(p4Goal.explanation.analysisId);
    const p4ReadCalls = modelCalls;
    await invoke('projectView', p4Scope); await invoke('history', p4Scope); await invoke('getSnapshot', { sessionId: p4Session });
    assert.equal(modelCalls, p4ReadCalls); assert.equal(modelCalls, p4Calls + 1);
    const oldRequirement = p4View.work.requirements.find(row => row.deliveryId === p2Accepted.id);
    await invoke('reviseRequirement', { ...p4Scope, clientRequestId: 'p4-revise', requirement: { id: oldRequirement.id, version: oldRequirement.version }, text: '整个项目保留标题每天一个问题，不公开用户回答。', state: 'active', applicability: 'project' });
    assert.equal((await invoke('projectView', p4Scope)).work.requirements.find(row => row.id === oldRequirement.id).forwarded, 'not_forwarded');
    console.log(JSON.stringify({ ownerConfirmedRequirement: true, actualNativeLineage: true, visibleHistoryAttached: true, requirementRevisionNotSilentlyForwarded: true,
      actualBeforeAfterExplained: true, goalLocatorReadOnly: true, analysisCached: true, passiveModelCalls: 0, actualModelQualityEvaluated: false }));

    // P1: native execution hooks, not fabricated event text, establish the receipts.
    const p1ModelCalls = modelCalls;
    const pollProgress = async predicate => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const value = await invoke('getSnapshot', { sessionId: guideAgent.session.id });
        if (predicate(value)) return value;
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      throw new Error('P1 progress did not reach the expected state');
    };
    await root.tools.execute({ name: 'bash', arguments: { command: 'printf after > app.txt', description: 'Write an isolated test fixture' },
      callId: 'p1-write', agent: guideAgent, signal: AbortSignal.timeout(5000) });
    const changed = await pollProgress(value => value.progress.changedFiles > 0);
    assert.equal(changed.progress.activity, 'idle');
    await writeFile(join(projectDirectory, 'verify.test.mjs'), 'import {readFileSync} from "node:fs"; import assert from "node:assert/strict"; await new Promise(r=>setTimeout(r,800)); assert.equal(readFileSync("app.txt","utf8"),"after");');
    const runningCheck = root.tools.execute({ name: 'bash', arguments: { command: 'node --test verify.test.mjs', description: 'Check the isolated fixture' },
      callId: 'p1-check', agent: guideAgent, signal: AbortSignal.timeout(10000) });
    await pollProgress(value => value.progress.activity === 'checking');
    const successfulCheck = await runningCheck;
    assert.equal(successfulCheck.value.exitCode, 0);
    const checked = await pollProgress(value => value.progress.latestCheck?.id === 'p1-check' && value.progress.latestCheck.outcome === 'succeeded');
    assert.equal(checked.progress.latestCheck.applicability, 'unchanged');
    await writeFile(join(projectDirectory, 'app.txt'), 'later edit');
    await pollProgress(value => value.progress.latestCheck?.applicability === 'changed');
    await root.tools.execute({ name: 'bash', arguments: { command: 'node --test verify.test.mjs', description: 'Check a changed fixture' },
      callId: 'p1-failed-check', agent: guideAgent, signal: AbortSignal.timeout(10000) });
    await pollProgress(value => value.progress.latestCheck?.id === 'p1-failed-check' && value.progress.latestCheck.outcome === 'failed');
    const restorePresentation = guideAgent.ctx.tools.presentAs('ptc');
    const nested = await root.tools.execute({ name: 'run_code', arguments: {
      code: 'await tools.bash({ command: "node --test verify.test.mjs", description: "Run the failing fixture inside PTC" }); console.log("outer program completed");',
      description: 'Verify nested check receipts' }, callId: 'p1-nested-check', agent: guideAgent, signal: AbortSignal.timeout(10000) });
    assert.equal(nested.isError, false, `outer program completes even though the child command exits nonzero: ${JSON.stringify(nested.error)}`);
    await pollProgress(value => value.progress.latestCheck?.id === 'p1-nested-check:ptc:1' && value.progress.latestCheck.outcome === 'failed');
    await restorePresentation();
    assert.equal(modelCalls, p1ModelCalls, 'progress, checks and invalidation must not call the model');
    // P5: actual native failed receipts, owner-gated settings, local lookup, budgets and history.
    const p5Session = (await root.sessionController.create({ workspaceId: workspace.id, agentPreset: 'vibeguide' })).sessionId;
    await root.sessionController.selectModel({ sessionId: p5Session, provider: 'vibeguide-fixture', model: 'fixture' });
    await root.sessionController.prompt({ sessionId: p5Session, requestId: 'p5-fault-native', content: [{ type: 'text', text: '请检查回答保存为什么失败，保留原回答。P5_NATIVE_FAIL' }] }, new AbortController().signal);
    const p5UiScope = { sessionId: p5Session, projectId: snapshot.scope.projectId };
    for (let i = 0; i < 120; i++) {
      const view = await invoke('projectView', p5UiScope);
      if (view.work.trouble.failures.some(row => row.count >= 2)) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok((await invoke('projectView', p5UiScope)).work.trouble.failures.some(row => row.count >= 2));
    const p5UiSnapshot = await invoke('getSnapshot', { sessionId: p5Session });
    await invoke('ask', { sessionId: p5Session, clientRequestId: 'p5-ui-trouble', basis: p5UiSnapshot.basis, question: '为什么反复失败？' });
    assert.ok(!(await invoke('projectView', p4Scope)).work.analyses.some(row => row.kind === 'trouble'), 'another conversation must not show this fault analysis as its own');
    const p5Scope = { sessionId: guideAgent.session.id, projectId: snapshot.scope.projectId };
    const p5View = await invoke('projectView', p5Scope);
    assert.ok(p5View.work.trouble.failures.some(row => row.count >= 2));
    const p5Latest = await invoke('getSnapshot', { sessionId: guideAgent.session.id });
    const p5Trouble = await invoke('ask', { sessionId: guideAgent.session.id, clientRequestId: 'p5-trouble', basis: p5Latest.basis, question: '为什么反复失败？' });
    assert.match(p5Trouble.text, /反复失败/);
    const p5Analysis = (await invoke('projectView', p5Scope)).work.analyses.find(row => row.id === p5Trouble.analysisId);
    assert.equal(p5Analysis.nextSteps.length, 1);
    let p5Settings = await invoke('supportView', p5Scope);
    assert.ok(p5Settings.calls > 0); assert.ok(p5Settings.inputTokens > 0); assert.ok(p5Settings.cacheHits > 0);
    const p5NoCalls = modelCalls, p5MainSeq = guideAgent.session.seq;
    await assert.rejects(invoke('supportView', p5Scope, { id: 'not-owner', principal: { kind: 'guest' }, signal: new AbortController().signal }));
    p5Settings = await invoke('saveSupport', { ...p5Scope, clientRequestId: 'p5-preferences', version: p5Settings.version, target: 'project', preferences: { language: 'zh-CN', detail: 'brief', style: 'example', order: 'impact' } });
    assert.equal(p5Settings.preferences.detail, 'brief');
    p5Settings = await invoke('saveSupport', { ...p5Scope, clientRequestId: 'p5-budget-zero', version: p5Settings.version, target: 'budget', budget: { dailyCalls: 0, turnCalls: 0 } });
    const p5BudgetBasis = await invoke('getSnapshot', { sessionId: guideAgent.session.id });
    await assert.rejects(invoke('ask', { sessionId: guideAgent.session.id, clientRequestId: 'p5-blocked', basis: p5BudgetBasis.basis, question: '这个项目如何支持更多用户同时访问？' }), /次数已用完/);
    const localAnswer = await invoke('ask', { sessionId: guideAgent.session.id, clientRequestId: 'p5-local-answer', basis: p5BudgetBasis.basis, question: 'API是什么？' }); assert.equal(localAnswer.sourceKind, 'glossary');
    assert.equal(modelCalls, p5NoCalls); assert.equal(guideAgent.session.seq, p5MainSeq);
    p5Settings = await invoke('saveSupport', { ...p5Scope, clientRequestId: 'p5-budget-restore', version: p5Settings.version, target: 'budget', budget: { dailyCalls: 100, turnCalls: 20 } });
    const p5Graph = await invoke('overview', { ...p3Scope, clientRequestId: 'p5-new-overview' }); assert.notEqual(p5Graph.id, p3Graph.id);
    assert.equal((await invoke('projectView', { ...p3Scope, overviewId: p3Graph.id })).overview.id, p3Graph.id);
    console.log(JSON.stringify({ nativeTroubleReceipts: true, onDemandTroubleChoices: true, localConceptNoModel: true, preferenceSaved: true, budgetBlocksBeforeProvider: true, projectUsageReported: true, structureHistoryNoModel: true, sidebarSettingsMainHistoryUnchanged: true }));
    const savedAnswers = (await invoke('getSnapshot', { sessionId: deliverySessionId })).explanations;
    assert.ok(savedAnswers.some(value => value.id === explainedChoice.id), 'requested explanations are persisted');
    console.log(JSON.stringify({ hostVersion: host.version, installation: installedDirectory ? 'installed-copy' : 'cli-upgrade', hostMounted: true, gateway: true,
      staticPromptOnly: true, noVibeGuideTools: true, standardIsolated: true, realProviderCalled: false,
      independentExplanation: true, sameBasisCache: true, mainHistoryUnchanged: true,
      pendingChoiceReadable: true, answeredChoiceRemoved: true, busyQueue: true,
      requestIdReconciled: true, originalModificationPreserved: true, nativePreExecutionBaseline: true,
      baselineMs: Math.round(baselineMs * 100) / 100,
      independentExplanationWhileMainWaits: true,
      nativeProgress: true, changesCaptured: true, realCheckFailurePreserved: true, nestedCheckFailurePreserved: true, fileChangeInvalidatesCheck: true,
      progressModelCalls: 0, explanationsPersisted: true,
      publicInputRouting: true, originalAnswerRedirectOnly: true, publicBusyDelivery: true, publicIdleDelivery: true,
      duplicateSubmissionOneMessage: true,
      userProfileModified: false }, null, 2));
    if (values.serve) {
      const readyFile = join(sourceRoot, 'output', 'playwright', 'guide-ready.json');
      await mkdir(join(sourceRoot, 'output', 'playwright'), { recursive: true });
      await writeFile(readyFile, JSON.stringify({ url: root.connection.authenticatedUrl(`${root.webServer.protocol}//127.0.0.1:${root.webServer.port}`),
        sessionId: deliverySessionId, workSessionId: p4Session, troubleSessionId: p5Session, pid: process.pid }), { mode: 0o600 });
      console.log('Isolated UI fixture is ready; local URL stored in output/playwright/guide-ready.json.');
      await new Promise(resolve => { process.once('SIGTERM', resolve); process.once('SIGINT', resolve); });
      await rm(readyFile, { force: true });
    }
    const finalSnapshot = await invoke('getSnapshot', { sessionId: deliverySessionId });
    const pendingExplanation = invoke('ask', { sessionId: deliverySessionId, clientRequestId: 'fixture-unload',
      basis: finalSnapshot.basis, question: 'fixture-unload-cancel' });
    const rejectedOnUnload = assert.rejects(pendingExplanation);
    await cancelledCallEntered;
    const guideEntry = [...root.loader.entries()].find(entry => entry.options.name.endsWith('/dist/guide/plugin.js'));
    assert.ok(guideEntry?.fiber); assert.notEqual(guideEntry.fiber, root.fiber);
    await guideEntry.fiber.dispose();
    await rejectedOnUnload;
    assert.equal(root.vibeGuide, undefined);
    await assert.rejects(invoke('getSnapshot', { sessionId: deliverySessionId }));
    console.log(JSON.stringify({ hostPluginUnload: true, explanationCancelledOnUnload: true, gatewayRemovedOnUnload: true }));
    // Re-mount the same installed plugin to exercise guard release and JSON recovery.
    const guideConfig = declaration.find(row => row.id === 'vibeguide-guide').config;
    const reloaded = root.plugin(await import(pathToFileURL(join(pluginDirectory, 'dist/guide/plugin.js')).href), guideConfig);
    let recovered;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { recovered = await invoke('getSnapshot', { sessionId: deliverySessionId }); break; } catch { await new Promise(resolve => setTimeout(resolve, 30)); }
    }
    assert.ok(recovered?.explanations.some(value => value.id === explainedChoice.id), 'reload must restore the same explanation');
    const recoveredProgress = await invoke('getSnapshot', { sessionId: guideAgent.session.id });
    assert.equal(recoveredProgress.progress.latestCheck.outcome, 'failed');
    assert.equal(recoveredProgress.progress.activity, 'idle', 'old runtime operations must not remain running');
    const p2Restored = await invoke('getSnapshot', { sessionId: p2IdleSession });
    assert.equal(p2Restored.deliveries[0].state, 'accepted');
    await invoke('handoff', p2IdleRequest);
    assert.equal((await p2NativeMessages()).length, 1, 'reloaded delivery must not resend');
    assert.equal((await invoke('getSnapshot', { sessionId: deliverySessionId })).deliveries.find(row => row.id === p2Queued.id).state, 'queued');
    const p3Recovered = await invoke('projectView', p3Scope);
    assert.equal(p3Recovered.overview.id, p5Graph.id);
    assert.equal((await invoke('projectView', { ...p3Scope, overviewId: p3Graph.id })).overview.id, p3Graph.id);
    assert.equal((await invoke('supportView', p5Scope)).preferences.detail, 'brief');
    assert.equal((await invoke('history', p3Scope)).items.find(row => row.id === answer.id).annotation.text, p3Corrected.annotation.text);
    console.log(JSON.stringify({ projectKnowledgeRecovered: true, correctionRecovered: true }));
    console.log(JSON.stringify({ deliveriesRecoveredOnReload: true, noRepeatAfterReload: true }));
    console.log(JSON.stringify({ hotReloadRestoresRecords: true, writerGuardReleased: true, noPhantomRunningState: true }));
    await reloaded.dispose();
    for (const handle of handles) await handle.dispose();
  } finally {
    try { if (root) await root.fiber.dispose(); }
    finally {
      web.internals.openBrowser = originalOpener;
      process.chdir(previousCwd);
      if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
      await rm(temporary, { recursive: true, force: true });
      if (installedPresetBefore !== undefined) assert.equal(
        await readFile(join(installedDirectory, 'preset.cordis.yml'), 'utf8'), installedPresetBefore,
        'installed plugin configuration must remain byte-for-byte unchanged, including after unload');
    }
  }
}
