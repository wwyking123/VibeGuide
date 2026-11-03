// Real-model checks for the three sidebar outputs that depend on the model:
// sendable-change marking, owner-request writing, and overview layers/maturity.
// Copies only the signed-in inference account into a private temporary home; never
// the user's sessions, workspaces or profile. Results never contain credentials.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_APP, desktopHost, sourceRoot } from './desktop.mjs';

const { values } = parseArgs({ options: {
  'source-home': { type: 'string', default: join(homedir(), '.dsh') },
  only: { type: 'string' }, out: { type: 'string' },
} });
if (!process.versions.electron) {
  const result = spawnSync(join(DEFAULT_APP, 'Contents', 'MacOS', 'DeepSeek Harness'), [fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit' });
  if (result.error) console.error(result.error.message);
  process.exitCode = result.status ?? 1;
} else {
  const host = await desktopHost();
  const sourceHome = resolve(values['source-home']);
  const rows = host.parse(await readFile(join(sourceHome, 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8'));
  const selectedModel = rows.find(row => row.id === 'agent-default-model');
  assert.equal(selectedModel?.config?.provider, 'deepseek-account', 'Only the signed-in DeepSeek account route is supported.');
  const store = host.parse(await readFile(join(sourceHome, '.credentials.yaml'), 'utf8'));
  const keys = ['deepseek-account-platform/default', 'deepseek-account-platform/device'];
  assert.ok(store.records?.[keys[0]], 'Sign in to DeepSeek Harness first.');
  const cases = JSON.parse(await readFile(join(sourceRoot, 'evals', 'sidebar', 'cases.json'), 'utf8'));

  const temporary = await mkdtemp(join(tmpdir(), 'vibeguide-eval-')); await chmod(temporary, 0o700);
  const profileDirectory = join(temporary, 'profiles', 'desktop');
  await mkdir(profileDirectory, { recursive: true, mode: 0o700 });
  await writeFile(join(temporary, '.credentials.yaml'), host.dump({ version: store.version, records: Object.fromEntries(keys.filter(key => store.records[key]).map(key => [key, store.records[key]])) }), { mode: 0o600 });
  await writeFile(join(profileDirectory, 'package.json'), JSON.stringify({ name: 'vibeguide-sidebar-eval', private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }), { mode: 0o600 });
  await writeFile(join(profileDirectory, 'cordis.patch.yml'), host.dump([
    { id: 'hmr', disabled: true }, selectedModel,
    { id: 'session-telemetry-otel', config: { mode: 'DISABLED' } }, { id: 'session-title-llm', disabled: true },
    { id: 'desktop-product-telemetry', disabled: true }, { id: 'product-analytics', disabled: true },
    { id: 'web-runtime', config: { printUrl: false, openBrowser: false } },
  ]), { mode: 0o600 });

  const previousCwd = process.cwd(); process.env.DSH_HOME = temporary; process.chdir(temporary);
  const web = await host.load('@deepseek-ai/dsh-web-app');
  web.internals.openBrowser = async () => { throw new Error('No browser in evals'); };
  let root;
  const results = { version: 1, startedAt: new Date().toISOString(), model: { provider: selectedModel.config.provider, model: selectedModel.config.model }, explain: [], compose: [], overview: [] };
  try {
    const { loadProfileDirectory, loadLayeredEnv } = await host.load('@deepseek-ai/dsh-app-boot');
    const { runProfile } = await host.load('@deepseek-ai/dsh/profile-boot');
    const profile = loadProfileDirectory('vibeguide-sidebar-eval', profileDirectory, host.anchor);
    root = (await runProfile({ environment: loadLayeredEnv('vibeguide-sidebar-eval'), profile: 'desktop',
      resolvedProfile: { profile, installAnchor: host.anchor }, patchFiles: [], args: ['--no-open', '--host', '127.0.0.1', '--port', '0'] })).ctx;
    const { HarnessAdapter, splitSuggestion } = await import('../dist/guide/host/adapter.js');
    const adapter = new HarnessAdapter(root, await host.load('@deepseek-ai/dsh-llm'));
    const snapshot = { scope: { projectId: 'eval', sessionId: 'eval' }, projectName: cases.context.projectName, enabled: true, throughSeq: 2, basis: 'eval',
      observations: cases.context.observations, choices: [], limitations: [],
      model: { status: 'ready', route: { provider: selectedModel.config.provider, model: selectedModel.config.model } } };
    const run = async (kind, row, call) => {
      const started = Date.now();
      try { const output = await call(); return { id: row.id, ms: Date.now() - started, output }; }
      catch (error) { return { id: row.id, ms: Date.now() - started, error: error?.code ?? String(error?.message ?? error) }; }
    };
    const want = kind => !values.only || values.only === kind;

    if (want('explain')) for (const row of cases.explain) {
      const r = await run('explain', row, () => adapter.explain(snapshot, row.question, AbortSignal.timeout(90000)));
      const { text, suggestion } = r.output ? splitSuggestion(r.output) : {};
      const problems = [];
      if (r.error) problems.push(`error:${r.error}`);
      else {
        if (row.suggestion === 'yes' && !suggestion) problems.push('应标出改法但没有');
        if (row.suggestion === 'no' && suggestion) problems.push('不该有改法却标了');
        if (suggestion && !suggestion.startsWith('请')) problems.push('改法不是以“请”开头');
        if (suggestion) for (const word of row.mustInclude ?? []) if (!suggestion.includes(word)) problems.push(`改法缺少“${word}”`);
        if (text.includes('可发送的改法')) problems.push('标记残留在讲解正文');
      }
      results.explain.push({ ...r, question: row.question, expected: row.suggestion, suggestion, pass: !problems.length, problems });
      console.log(`explain ${row.id} ${problems.length ? 'FAIL ' + problems.join('；') : 'ok'}`);
    }

    if (want('compose')) for (const row of cases.compose) {
      const r = await run('compose', row, () => adapter.compose(snapshot, { constraints: [], ...row.source }, AbortSignal.timeout(90000)));
      const text = r.output?.trim(), problems = [];
      if (r.error) problems.push(`error:${r.error}`);
      else {
        if (!text.startsWith('请')) problems.push('不是以“请”开头');
        if (text.length > 300) problems.push(`过长 ${text.length} 字`);
        for (const word of row.mustInclude) if (!text.includes(word)) problems.push(`缺少“${word}”`);
        for (const word of row.mustNotInclude) if (text.includes(word)) problems.push(`多出“${word}”`);
      }
      results.compose.push({ ...r, suggestion: row.source.suggestion, written: text, pass: !problems.length, problems });
      console.log(`compose ${row.id} ${problems.length ? 'FAIL ' + problems.join('；') : 'ok'}`);
    }

    if (want('overview')) for (const row of cases.overview) {
      const source = { project: row.project ?? cases.context.projectName, requirements: row.requirements,
        coverage: { scanned: row.files.length, complete: true, sampled: row.files.length }, files: row.files.map(file => ({ ...file, clipped: false })) };
      const r = await run('overview', row, () => adapter.structured(snapshot, 'overview', source, AbortSignal.timeout(180000)));
      const problems = [], checks = [];
      let parsed, notes = [];
      if (r.error) problems.push(`error:${r.error}`);
      else {
        try { parsed = JSON.parse(r.output.replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { problems.push('不是合法 JSON'); }
        if (parsed) {
          if (!parsed.name) problems.push('没有产品名');
          if (row.expect.nameNot?.includes(parsed.name)) problems.push(`产品名照搬了“${parsed.name}”`);
          const devRated = (parsed.nodes ?? []).filter(item => item.layer === 'dev' && item.maturity);
          if (devRated.length) notes.push(`${devRated.length} 个开发资料带了完成程度，保存时已去掉`);
          const duplicated = (parsed.missing ?? []).filter(item => (parsed.nodes ?? []).some(node => node.maturity === 'mock' && (item.title.includes(node.title) || node.title.includes(item.title))));
          if (duplicated.length) problems.push(`“还没做”与已有的模拟部分重复：${duplicated.map(item => item.title).join('、')}`);
          for (const [file, expected] of Object.entries(row.expect.byFile)) {
            const node = parsed.nodes?.find(item => item.files?.includes(file));
            if (!node) { checks.push({ file, ok: false, note: '没有分配到任何部分' }); continue; }
            const layerOk = expected.layer.includes(node.layer), maturityOk = !expected.maturity || expected.maturity.includes(node.maturity);
            checks.push({ file, ok: layerOk && maturityOk, title: node.title, layer: node.layer, maturity: node.maturity, expected });
          }
          const missing = parsed.missing ?? [];
          if (missing.length > row.expect.missingMax) problems.push(`“还没做”超过 ${row.expect.missingMax} 项`);
          if (!missing.some(item => row.expect.missingAny.some(word => `${item.title}${item.purpose}`.includes(word)))) problems.push('没有指出应列为“还没做”的部分');
          const hedged = (parsed.nodes ?? []).filter(item => /^(可能|或许|大概|推测)/.test(item.purpose ?? ''));
          if (hedged.length) problems.push(`${hedged.length} 个描述以“可能”开头`);
        }
      }
      const wrong = checks.filter(item => !item.ok);
      results.overview.push({ ...r, parsed, checks, pass: !problems.length && !wrong.length, problems, notes,
        fileAccuracy: checks.length ? `${checks.length - wrong.length}/${checks.length}` : '0/0' });
      console.log(`overview ${row.id} ${problems.length || wrong.length ? 'FAIL ' + [...problems, ...wrong.map(item => `${item.file}: ${item.note ?? `${item.layer}/${item.maturity}`}`)].join('；') : 'ok'} (${checks.length - wrong.length}/${checks.length})`);
    }
  } finally {
    try { if (root) await root.fiber.dispose(); }
    finally {
      process.chdir(previousCwd);
      await rm(temporary, { recursive: true, force: true });
    }
  }
  results.finishedAt = new Date().toISOString();
  const summary = Object.fromEntries(['explain', 'compose', 'overview'].map(kind => [kind, `${results[kind].filter(row => row.pass).length}/${results[kind].length}`]));
  results.summary = summary;
  const out = resolve(values.out ?? join(sourceRoot, 'evals', 'runs', `sidebar-${results.startedAt.replace(/[:.]/g, '-')}.json`));
  await mkdir(join(out, '..'), { recursive: true });
  await writeFile(out, JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ summary, out }));
  process.exit(0);
}
