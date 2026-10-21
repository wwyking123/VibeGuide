import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, cp, open, realpath, symlink, unlink, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_APP, desktopHost, prepareDesktopPlugin, sourceRoot } from './desktop.mjs';
import { isolationPolicy, isolatedEnvironment, probeFileIsolation } from './manual-isolation.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  app: { type: 'string', default: DEFAULT_APP },
  'source-home': { type: 'string', default: join(homedir(), '.dsh') },
  directory: { type: 'string' },
  'standard-workspace': { type: 'string' },
  'vibeguide-workspace': { type: 'string' },
} });
const action = positionals[0];
assert.ok(['prepare', 'start', 'status', 'stop'].includes(action), 'Use prepare | start | status | stop [--directory <run>]');
assert.equal(process.platform, 'darwin', 'This manual comparison launcher requires macOS.');
const executable = join(values.app, 'Contents', 'MacOS', 'DeepSeek Harness');
let incompleteDirectory;

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function prepare() {
  const host = await desktopHost(values.app);
  const sourceHome = resolve(values['source-home']);
  const rows = host.parse(await readFile(join(sourceHome, 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8'));
  const selectedModel = rows.find(row => row.id === 'agent-default-model');
  assert.equal(selectedModel?.config?.provider, 'deepseek-account', 'This launcher currently supports the signed-in DeepSeek account route only.');
  const store = host.parse(await readFile(join(sourceHome, '.credentials.yaml'), 'utf8'));
  const keys = ['deepseek-account-platform/default', 'deepseek-account-platform/device'];
  assert.ok(store.records?.[keys[0]], 'Sign in to DeepSeek Harness before preparing the comparison.');
  // Copy only the inference account/device, never browser tokens, sessions,
  // workspaces, memories, or the user's complete profile.
  const credentials = { version: store.version, records: Object.fromEntries(keys.filter(key => store.records[key]).map(key => [key, store.records[key]])) };
  const requested = [values['standard-workspace'], values['vibeguide-workspace']];
  assert.ok(requested.every(Boolean) || requested.every(value => !value), 'Provide both workspace paths, or neither.');
  const workspaces = requested[0] ? await Promise.all(requested.map(path => realpath(path))) : [];
  const within = (path, parent) => path === parent || path.startsWith(parent + '/');
  if (workspaces.length) {
    assert.ok(!within(workspaces[0], workspaces[1]) && !within(workspaces[1], workspaces[0]), 'The two workspaces must be separate, non-nested directories.');
    for (const path of workspaces) {
      assert.ok((await stat(path)).isDirectory(), 'Each workspace must be a directory.');
      // Never grant the other group's data through a shared public runtime root.
      for (const reserved of [sourceRoot, sourceHome, values.app, '/System', '/usr', '/bin', '/sbin', '/Library', '/opt/homebrew', '/private/etc', '/dev']) {
        assert.ok(!within(path, reserved) && !within(reserved, path), `Unsupported workspace boundary: ${path}`);
      }
    }
  }
  const target = resolve(values.directory ?? join(homedir(), 'VibeGuide-Compare', `${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`));
  assert.ok(target !== sourceRoot && !target.startsWith(sourceRoot + '/'), 'Keep comparison data outside the VibeGuide source repository.');
  for (const workspace of workspaces) assert.ok(!within(target, workspace) && !within(workspace, target), 'Keep session data outside the test workspaces.');
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await mkdir(target, { mode: 0o700 }); // refuse to overwrite any previous run
  incompleteDirectory = target;
  const directory = await realpath(target);
  const ports = [await availablePort()];
  do { ports[1] = await availablePort(); } while (ports[0] === ports[1]);
  const groups = [
    { label: 'A', preset: 'standard', port: ports[0], workspace: workspaces[0] ?? join(directory, 'A', 'workspace') },
    { label: 'B', preset: 'vibeguide', port: ports[1], workspace: workspaces[1] ?? join(directory, 'B', 'workspace') },
  ];
  for (const group of groups) {
    const dir = join(directory, group.label);
    for (const folder of ['workspace', 'runtime', 'tmp', 'cache', 'home/profiles/desktop']) {
      await mkdir(join(dir, folder), { recursive: true, mode: 0o700 });
    }
    for (const file of ['manual-eval-host.mjs', 'desktop.mjs']) {
      await cp(join(sourceRoot, 'scripts', file), join(dir, 'runtime', file));
    }
    await writeFile(join(dir, 'home', '.credentials.yaml'), host.dump(credentials), { mode: 0o600 });
    const profile = join(dir, 'home', 'profiles', 'desktop');
    await writeFile(join(profile, 'package.json'), JSON.stringify({
      name: 'vibeguide-manual-comparison', private: true,
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
    }), { mode: 0o600 });
    const patch = [
      { id: 'hmr', disabled: true },
      selectedModel,
      { id: 'agent-preset-registry', config: { default: group.preset } },
      { id: 'session-telemetry-otel', config: { mode: 'DISABLED' } },
      { id: 'session-title-llm', disabled: true },
      { id: 'desktop-product-telemetry', disabled: true },
      { id: 'product-analytics', disabled: true },
      { id: 'web-runtime', config: { printUrl: false, openBrowser: false } },
    ];
    if (group.preset === 'vibeguide') patch.push((await prepareDesktopPlugin(host, join(dir, 'home', 'plugins', 'vibeguide'))).patch);
    await writeFile(join(profile, 'cordis.patch.yml'), host.dump(patch), { mode: 0o600 });
    await writeFile(join(dir, 'run.json'), JSON.stringify({ ...group, workspaceTitle: workspaces.length ? basename(group.workspace) : '公司官网', app: values.app, model: selectedModel.config }), { mode: 0o600 });
    await writeFile(join(dir, 'probe.txt'), 'local isolation probe\n', { mode: 0o600 });
    await writeFile(join(dir, 'isolation.sb'), await isolationPolicy(dir, values.app, ports.find(port => port !== group.port), group.workspace), { mode: 0o600 });
  }
  for (const group of groups) {
    const dir = join(directory, group.label);
    const other = join(directory, group.label === 'A' ? 'B' : 'A');
    await symlink(other, join(dir, 'other-link'));
    try { await probeFileIsolation({ directory: dir, other, policy: join(dir, 'isolation.sb'), executable }); }
    finally { await unlink(join(dir, 'other-link')); }
  }
  const metadata = { version: 1, directory, app: values.app, groups, model: selectedModel.config, createdAt: new Date().toISOString() };
  await writeFile(join(directory, 'comparison.json'), JSON.stringify(metadata, null, 2), { mode: 0o600 });
  await cp(join(sourceRoot, 'evals', 'MANUAL_COMPARISON.md'), join(directory, '开始评测.md'));
  const controller = join(directory, 'controller');
  await mkdir(controller, { mode: 0o700 });
  for (const file of ['manual-compare.mjs', 'manual-isolation.mjs', 'desktop.mjs']) {
    await cp(join(sourceRoot, 'scripts', file), join(controller, file));
  }
  const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
  for (const [filename, command] of [['恢复评测.command', 'start'], ['结束评测.command', 'stop']]) {
    const args = [executable, '--expose-internals', join(controller, 'manual-compare.mjs'), command, '--directory', directory];
    await writeFile(join(directory, filename), `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${args.map(shellQuote).join(' ')}\n`, { mode: 0o700 });
  }
  incompleteDirectory = undefined;
  console.log(JSON.stringify({ prepared: true, directory, model: metadata.model, isolationProbes: 'passed', modelCalled: false }, null, 2));
}

async function control() {
  assert.ok(values.directory, '--directory is required');
  const directory = await realpath(values.directory);
  const metadata = JSON.parse(await readFile(join(directory, 'comparison.json'), 'utf8'));
  assert.equal(metadata.directory, directory);
  const records = [];
  const launched = [];
  try {
    for (const group of metadata.groups) {
      const dir = join(directory, group.label);
      const config = JSON.parse(await readFile(join(dir, 'run.json'), 'utf8'));
      assert.equal(config.port, group.port);
      const runExecutable = join(metadata.app, 'Contents', 'MacOS', 'DeepSeek Harness');
      const readyFile = join(dir, 'ready.json');
      let ready;
      try { ready = JSON.parse(await readFile(readyFile, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      let alive = false;
      if (ready?.pid) {
        try {
          process.kill(ready.pid, 0);
          const command = spawnSync('/bin/ps', ['-p', String(ready.pid), '-o', 'command='], { encoding: 'utf8' }).stdout;
          alive = command.includes(join(dir, 'runtime', 'manual-eval-host.mjs'));
        } catch { /* No running host with this identity. */ }
      }
      if (action === 'stop') {
        if (alive) process.kill(ready.pid, 'SIGTERM');
        records.push({ label: group.label, stopRequested: alive });
        continue;
      }
      if (action === 'start' && !alive) {
        await unlink(readyFile).catch(error => { if (error.code !== 'ENOENT') throw error; });
        const log = await open(join(dir, 'host.log'), 'a', 0o600);
        const child = spawn('/usr/bin/sandbox-exec', ['-f', join(dir, 'isolation.sb'), runExecutable, '--expose-internals', join(dir, 'runtime', 'manual-eval-host.mjs')], {
          cwd: config.workspace ?? join(dir, 'workspace'), env: isolatedEnvironment(dir, runExecutable),
          detached: true, stdio: ['ignore', log.fd, log.fd],
        });
        child.on('error', () => {});
        launched.push(child);
        await log.close();
        for (let attempt = 0; attempt < 100; attempt++) {
          try { ready = JSON.parse(await readFile(readyFile, 'utf8')); break; }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
          if (child.exitCode !== null || child.signalCode !== null) throw new Error(`${group.label} failed to start; inspect ${join(dir, 'host.log')}`);
          await new Promise(resolve => setTimeout(resolve, 200));
        }
        assert.ok(ready, `${group.label} did not become ready within 20 seconds.`);
        alive = true;
      }
      records.push({ label: group.label, running: alive, ...(alive ? ready : {}) });
    }
    if (action === 'start') {
      assert.equal(records.length, 2);
      assert.deepEqual(records[0].tools, records[1].tools.filter(tool => !tool.name.startsWith('vibeguide_')), 'VibeGuide must preserve standard tool schemas.');
      assert.equal(records[1].tools.length, records[0].tools.length + 3, 'The unified VibeGuide adds three internal project/preference tools.');
      assert.equal(records[0].hasPolicy, false);
      assert.equal(records[1].hasPolicy, true);
      for (const child of launched) child.unref();
    }
    console.log(JSON.stringify(records.map(({ tools, ...record }) => ({ ...record, ...(tools ? { presetToolCount: tools.length } : {}) })), null, 2));
  } catch (error) {
    for (const child of launched) child.kill('SIGTERM');
    throw error;
  }
}

if (action === 'prepare' && !process.versions.electron) {
  const result = spawnSync(executable, ['--expose-internals', fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit',
  });
  if (result.error) console.error(result.error.message);
  process.exitCode = result.status ?? 1;
} else if (action === 'prepare') {
  try { await prepare(); }
  catch (error) {
    if (incompleteDirectory) await rm(incompleteDirectory, { recursive: true, force: true });
    throw error;
  }
}
else await control();
