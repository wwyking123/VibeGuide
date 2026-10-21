// Opt-in, bounded model regression. Only isolated records and allowlisted reads execute; project mutations stop the run.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_APP, desktopHost, prepareDesktopPlugin, sourceRoot } from './desktop.mjs';

const { values } = parseArgs({ options: {
  app: { type: 'string', default: DEFAULT_APP },
  'source-home': { type: 'string', default: join(homedir(), '.dsh') },
  output: { type: 'string', default: join(sourceRoot, 'evals/runs', `kickoff-${Date.now()}`) },
  live: { type: 'boolean', default: false },
} });
if (!values.live) {
  console.log('Use --live to run 4 bounded kickoff cases with the configured DeepSeek account. This consumes model quota. Only isolated records and explicitly allowlisted read-only tools execute; project mutation intent stops the evaluation.');
} else if (!process.versions.electron) {
  const result = spawnSync(join(values.app, 'Contents/MacOS/DeepSeek Harness'), [
    '--expose-internals', fileURLToPath(import.meta.url), ...process.argv.slice(2),
  ], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit', timeout: 600000 });
  process.exitCode = result.status ?? 1;
} else {
  const output = resolve(values.output);
  await mkdir(output, { recursive: false, mode: 0o700 });
  const host = await desktopHost(values.app);
  const rows = host.parse(await readFile(join(values['source-home'], 'profiles/desktop/cordis.patch.yml'), 'utf8'));
  const selected = rows.find(row => row.id === 'agent-default-model');
  assert.equal(selected?.config?.provider, 'deepseek-account', 'This evaluation supports the existing DeepSeek account route only.');
  const sourceCredentials = host.parse(await readFile(join(values['source-home'], '.credentials.yaml'), 'utf8'));
  const keys = ['deepseek-account-platform/default', 'deepseek-account-platform/device'];
  assert.ok(sourceCredentials.records?.[keys[0]], 'Sign in to Harness first.');
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'vibeguide-kickoff-')));
  const previousCwd = process.cwd(); const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = temporary; process.chdir(temporary);
  const profileDirectory = join(temporary, 'profiles/desktop');
  let root;
  const handles = [];
  const report = { version: '0.1.0-alpha.4', policy: '2026-10-21.2', model: selected.config, kind: 'bounded-model-responses', maxCallsPerCase: 3, projectMutationToolsExecuted: false, humanUnderstandingTested: false, results: [] };
  try {
    await mkdir(profileDirectory, { recursive: true });
    await writeFile(join(temporary, '.credentials.yaml'), host.dump({ version: sourceCredentials.version, records: Object.fromEntries(keys.filter(k => sourceCredentials.records[k]).map(k => [k, sourceCredentials.records[k]])) }), { mode: 0o600 });
    await writeFile(join(profileDirectory, 'package.json'), JSON.stringify({ name: 'vibeguide-kickoff-eval', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }));
    const plugin = await prepareDesktopPlugin(host, join(temporary, 'plugins/vibeguide'), { storageRoot: join(temporary, 'state') });
    await writeFile(join(profileDirectory, 'cordis.patch.yml'), host.dump([
      { id: 'hmr', disabled: true }, selected,
      { id: 'session-telemetry-otel', config: { mode: 'DISABLED' } }, { id: 'session-title-llm', disabled: true },
      { id: 'desktop-product-telemetry', disabled: true }, { id: 'product-analytics', disabled: true },
      { id: 'web-runtime', config: { printUrl: false, openBrowser: false } }, plugin.patch,
    ]));
    const web = await host.load('@deepseek-ai/dsh-web-app');
    web.internals.openBrowser = async () => { throw new Error('No browser during bounded evaluation.'); };
    const { loadProfileDirectory, loadLayeredEnv } = await host.load('@deepseek-ai/dsh-app-boot');
    const { runProfile } = await host.load('@deepseek-ai/dsh/profile-boot');
    const profile = loadProfileDirectory('kickoff-eval', profileDirectory, host.anchor);
    const application = await runProfile({ environment: loadLayeredEnv('kickoff-eval'), profile: 'desktop', resolvedProfile: { profile, installAnchor: host.anchor }, patchFiles: [], args: ['--no-open', '--host', '127.0.0.1', '--port', '0'] });
    root = application.ctx;
    const { renderPrompt, renderContextSnapshot } = await host.load('@deepseek-ai/dsh-system-prompt');
    const { BlockAssembler, createSystemMessage, createUserMessage, createAssistantMessage, createToolResultMessage } = await host.load('@deepseek-ai/dsh-llm');
    const cases = [
      { id: 'vague-game', prompt: '我要做一个21天打卡思考的网页版小游戏，目的是让用户从每日一个问题开始，养成主动思考的习惯。', expected: 'clarify-and-wait' },
      { id: 'specified-game', prompt: '做一个只供我自己在本机体验的21天思考小游戏：你先拟21个生活思考问题，每天按顺序展示一题；我写下文字后点完成，能回看答案。进度保存在这台浏览器，不做登录、分享、排行榜或AI评分。漏一天可以补做，不重置。请直接开始做可运行原型。', expected: 'proceed' },
      { id: 'delegated-game', prompt: '我要做一个21天打卡思考的网页版小游戏，目的是养成主动思考的习惯。玩法你来定，先做一个只给我自己体验的本机原型，问题也请你先拟，不接外部服务。', expected: 'proceed' },
      { id: 'small-edit', prompt: '把当前页面“开始思考”按钮背景改成蓝色，其他文字、功能和布局不动。', expected: 'proceed', fixture: '<button style="background:green">开始思考</button>' },
    ];
    for (const c of cases) {
      const project = join(temporary, c.id); await mkdir(project);
      if (c.fixture) await writeFile(join(project, 'index.html'), c.fixture);
      const handle = await root.agents.create({ sessionId: `kickoff-${c.id}`, agentOptions: selected.config, meta: { cwd: project, agentPreset: 'vibeguide' }, setup: async ctx => { await root.agentPresets.mount(ctx, 'vibeguide'); } });
      handles.push(handle);
      const user = createUserMessage({ content: [{ type: 'text', text: c.prompt }], source: { kind: 'user' } });
      handle.agent.session.append('user/message', user, { surfaceOp: 'append' });
      const assembly = await root.systemPrompt.assemble({ agent: handle.agent, scope: handle.agent, provider: selected.config.provider, model: selected.config.model });
      const messages = [createSystemMessage(renderPrompt(assembly)), user];
      const runtimeContext = renderContextSnapshot(assembly);
      if (runtimeContext) messages.push(createUserMessage({ content: [{ type: 'text', text: runtimeContext }], source: { kind: 'runtime-context' } }));
      const row = { id: c.id, expected: c.expected, input: c.prompt, attempts: [], review: 'not_reviewed' };
      const safeCommands = new Set([
        'pwd', 'ls', 'ls -la', 'pwd && ls -la', 'cat index.html',
        'ls -la; echo "---"; git status 2>/dev/null | head -5',
        'pwd && ls -la && printf \'\\n--- parent ---\\n\' && ls -la ..',
        'pwd && ls -la && echo "---" && node --version 2>/dev/null; python3 --version 2>/dev/null',
        'pwd && ls -la && echo "---" && node -v 2>&1 && python3 -V 2>&1',
        'pwd && ls -la && echo "---" && node -v 2>/dev/null; python3 -V 2>/dev/null',
      ]);
      const mayExecute = call => {
        let args; try { args = JSON.parse(call.arguments); } catch { return false; }
        if (call.name === 'vibeguide_project') return true;
        if (call.name === 'ask_user_question' && c.expected === 'clarify-and-wait') return true;
        if (call.name === 'bash') return safeCommands.has(args.command);
        if (!['grep', 'glob', 'read_file', 'read'].includes(call.name)) return false;
        for (const field of ['path', 'file_path', 'directory', 'root']) {
          if (args[field] !== undefined && typeof args[field] !== 'string') return false;
          if (args[field]) { const path = resolve(project, args[field]); if (path !== project && !path.startsWith(project + '/')) return false; }
        }
        return true;
      };
      report.results.push(row);
      console.log(`Model regression: ${c.id}`);
      for (let attempt = 0; attempt < 3; attempt++) {
        const request = { ...selected.config, maxTokens: 4096, messages: structuredClone(messages), tools: assembly.tools };
        await writeFile(join(output, `${c.id}-${attempt}-request.json`), JSON.stringify(request, null, 2), { mode: 0o600 });
        const assembler = new BlockAssembler();
        for await (const chunk of root.llm.stream({ ...request, signal: AbortSignal.timeout(90000) })) assembler.push(chunk);
        // Keep public output and tool intent; do not export internal reasoning blocks.
        const blocks = assembler.blocks();
        const visible = blocks.filter(b => b.type !== 'reasoning');
        row.attempts.push({ finish: assembler.finish, usage: assembler.usage, blocks: visible });
        await writeFile(join(output, 'results.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
        if (['error', 'aborted', 'max-tokens'].includes(assembler.finish.kind)) break;
        const calls = blocks.filter(b => b.type === 'tool-call');
        // A fixed read-only allowlist permits workspace inspection before questions.
        // All unknown commands, mutations and UI questions stop before dispatch.
        if (!calls.length || calls.some(b => !mayExecute(b))) break;
        messages.push(createAssistantMessage({ content: blocks, source: { provider: selected.config.provider, model: selected.config.model } }));
        for (const call of calls) {
          if (call.name === 'ask_user_question') {
            row.simulatedPendingQuestion = true;
            messages.push(createToolResultMessage({ callId: call.id, content: [{ type: 'text', text: JSON.stringify({ pending: true, callId: call.id }) }], isError: false }));
            continue;
          }
          const result = await root.tools.execute({ name: call.name, arguments: JSON.parse(call.arguments), callId: call.id, agent: handle.agent, signal: AbortSignal.timeout(10000) });
          row.attempts.at(-1).executedTools ??= [];
          row.attempts.at(-1).executedTools.push({ name: call.name, isError: result.isError });
          messages.push(createToolResultMessage({ callId: call.id, content: result.content, isError: result.isError }));
        }
      }
      console.log(JSON.stringify({ id: row.id, expected: row.expected, output: row.attempts.at(-1) }));
      assert.deepEqual(await readdir(project), c.fixture ? ['index.html'] : [], 'No project scaffolding may be executed by this evaluator.');
      if (c.fixture) assert.equal(await readFile(join(project, 'index.html'), 'utf8'), c.fixture);
      await writeFile(join(output, 'results.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
    }
    console.log(JSON.stringify({ output, cases: report.results.length, model: selected.config, projectMutationToolsExecuted: false, humanUnderstandingTested: false }));
    if (report.results.some(row => row.attempts.some(a => ['error', 'aborted', 'max-tokens'].includes(a.finish.kind)))) process.exitCode = 1;
  } finally {
    for (const handle of handles) await handle.dispose();
    if (root) await root.fiber.dispose();
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
    await rm(temporary, { recursive: true, force: true });
  }
}
