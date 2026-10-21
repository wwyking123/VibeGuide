import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_APP, desktopHost } from './desktop.mjs';

const { values } = parseArgs({ options: {
  app: { type: 'string', default: DEFAULT_APP },
  installed: { type: 'string' },
} });
if (!process.versions.electron) {
  const result = spawnSync(join(values.app, 'Contents', 'MacOS', 'DeepSeek Harness'), [
    '--expose-internals', fileURLToPath(import.meta.url), ...process.argv.slice(2),
  ], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit' });
  if (result.error) console.error(result.error.message);
  process.exitCode = result.status ?? 1;
} else {
  const host = await desktopHost(values.app);
  const temporary = await mkdtemp(join(tmpdir(), 'vibeguide-desktop-'));
  const previousHome = process.env.DSH_HOME;
  const previousCwd = process.cwd();
  process.env.DSH_HOME = temporary;
  process.chdir(temporary);
  let root;
  const webRuntime = await host.load('@deepseek-ai/dsh-web-app');
  const originalBrowserOpener = webRuntime.internals.openBrowser;
  let browserOpenAttempts = 0;
  webRuntime.internals.openBrowser = async () => { browserOpenAttempts++; throw new Error('Browser opening is forbidden during this smoke test'); };
  try {
    const profileDirectory = join(temporary, 'profiles', 'desktop');
    await mkdir(profileDirectory, { recursive: true });
    await writeFile(join(profileDirectory, 'package.json'), JSON.stringify({
      name: 'vibeguide-desktop-smoke', private: true,
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
    }));
    const originalPatch = '# Existing configuration must survive installation.\n- id: hmr\n  disabled: true\n';
    await writeFile(join(profileDirectory, 'cordis.patch.yml'), originalPatch);
    if (values.installed) {
      const declaration = host.parse(await readFile(join(values.installed, 'preset.cordis.yml'), 'utf8'));
      assert.equal(declaration[0]?.config?.id, 'vibeguide');
      await writeFile(join(profileDirectory, 'cordis.patch.yml'), originalPatch + host.dump([{ insert: [{
        id: 'vibeguide-presets', name: 'cordis:include',
        config: { path: join(values.installed, 'preset.cordis.yml') },
      }] }]));
    } else {
      const install = spawnSync(process.execPath, [
        '--expose-internals', fileURLToPath(new URL('./install-desktop.mjs', import.meta.url)),
        '--app', values.app, '--home', temporary,
      ], { env: process.env, encoding: 'utf8', timeout: 30000 });
      assert.equal(install.status, 0, install.stderr);
      const result = JSON.parse(install.stdout);
      assert.equal(await readFile(result.backup, 'utf8'), originalPatch);
    }
    const installedPatch = await readFile(join(profileDirectory, 'cordis.patch.yml'), 'utf8');
    assert.ok(installedPatch.startsWith(originalPatch));
    const { loadProfileDirectory, loadLayeredEnv } = await host.load('@deepseek-ai/dsh-app-boot');
    const { runProfile } = await host.load('@deepseek-ai/dsh/profile-boot');
    const telemetryPatch = join(temporary, 'smoke.patch.yml');
    await writeFile(telemetryPatch, host.dump([
      { id: 'session-telemetry-otel', config: { mode: 'DISABLED' } },
      { id: 'session-title-llm', disabled: true },
      { id: 'desktop-product-telemetry', disabled: true },
      { id: 'product-analytics', disabled: true },
      { id: 'web-runtime', config: { printUrl: false, openBrowser: false } },
    ]));
    const profile = loadProfileDirectory('vibeguide-smoke', profileDirectory, host.anchor);
    const application = await runProfile({
      environment: loadLayeredEnv('vibeguide-smoke'), profile: 'desktop',
      resolvedProfile: { profile, installAnchor: host.anchor },
      patchFiles: [telemetryPatch],
      args: ['--no-open', '--host', '127.0.0.1', '--port', '0'],
    });
    root = application.ctx;
    const roster = await root.agentPresets.list();
    const vibeguide = roster.find(row => row.id === 'vibeguide');
    assert.ok(vibeguide, 'desktop preset must be discoverable');
    assert.equal(vibeguide.broken, undefined);
    const { scopeOf } = await host.load('@deepseek-ai/dsh-scope');
    const handles = [];
    const assemblies = [];
    for (const id of ['standard', 'vibeguide']) {
      const handle = await root.agents.create({
        sessionId: `vibeguide-smoke-${id}`, meta: { cwd: temporary, agentPreset: id },
        setup: async ctx => { await root.agentPresets.mount(ctx, id); },
      });
      handles.push(handle);
      assemblies.push(await root.systemPrompt.assemble({ scope: scopeOf(handle.agent.ctx), agent: handle.agent }));
    }
    assert.deepEqual(assemblies[1].tools.filter(tool => !tool.name.startsWith('vibeguide_')), assemblies[0].tools);
    assert.equal(assemblies[1].tools.length, assemblies[0].tools.length + 3);
    assert.ok(assemblies[1].sections.some(section => section.name === 'vibeguide:continuity'));
    assert.equal(roster.some(row => row.id === 'vibeguide-p0'), false);
    assert.ok(assemblies[1].tools.some(tool => tool.name === 'ask_user_question'));
    assert.ok(assemblies[1].sections.some(section => section.name === 'vibeguide:communication'));
    assert.equal(assemblies[0].sections.some(section => section.name === 'vibeguide:communication'), false);
    for (const handle of handles) await handle.dispose();
    assert.equal(browserOpenAttempts, 0);
    console.log(JSON.stringify({
      desktopVersion: host.version, installation: 'passed', originalConfigurationPreserved: true,
      presetDiscovered: true, standardToolsPreserved: assemblies[0].tools.length,
      projectRecordTools: 3, singleVibeGuideMode: true,
      ordinarySessionIsolated: true, nativeQuestionsPreserved: true, modelCalled: false,
      browserOpenAttempts, userProfileModified: false,
    }, null, 2));
  } finally {
    try { if (root) await root.fiber.dispose(); }
    finally {
      webRuntime.internals.openBrowser = originalBrowserOpener;
      process.chdir(previousCwd);
      if (previousHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previousHome;
      await rm(temporary, { recursive: true, force: true });
    }
  }
}
