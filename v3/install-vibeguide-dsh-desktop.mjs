// VibeGuide installer adapter for "DSH Desktop.app" (io.dsh.desktop).
//
// Upstream scripts/install-desktop.mjs targets "/Applications/DeepSeek Harness.app" with
// runtime at app.asar/dsh, executable "DeepSeek Harness", and profile "profiles/desktop".
// DSH Desktop bundles the same Harness (@deepseek-ai/dsh 0.2.1-rc.2) but at app.asar root,
// with executable "DSH Desktop", data home ~/Library/Application Support/dsh-desktop/harness
// and profile "profiles/web". Everything else reuses the repo's own helpers unchanged.
//
// Usage (after `npm ci && npm run build` in the repo):
//   node install-vibeguide-dsh-desktop.mjs [--repo ./VibeGuide] [--app "/Applications/DSH Desktop.app"]
//                                          [--home <harness home>] [--profile web]
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({ options: {
  repo: { type: 'string', default: join(here, 'VibeGuide') },
  app: { type: 'string', default: '/Applications/DSH Desktop.app' },
  home: { type: 'string', default: join(homedir(), 'Library', 'Application Support', 'dsh-desktop', 'harness') },
  profile: { type: 'string', default: 'web' },
} });

if (!process.versions.electron) {
  // Run under the app's own Electron-as-Node so app.asar paths resolve, like upstream does.
  const result = spawnSync(join(values.app, 'Contents', 'MacOS', 'DSH Desktop'), [
    '--expose-internals', fileURLToPath(import.meta.url), ...process.argv.slice(2),
  ], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit' });
  if (result.error) console.error(result.error.message);
  process.exitCode = result.status ?? 1;
} else {
  const repo = resolve(values.repo);
  const { composeDesktopPatch, prepareDesktopPlugin } = await import(pathToFileURL(join(repo, 'scripts', 'desktop.mjs')).href);
  const { assertDesktopVersion } = await import(pathToFileURL(join(repo, 'dist', 'guide', 'host', 'compatibility.js')).href);

  const runtime = join(values.app, 'Contents', 'Resources', 'app.asar');
  const require = createRequire(join(runtime, 'package.json'));
  const anchor = require.resolve('@deepseek-ai/dsh/package.json');
  const dshVersion = JSON.parse(await readFile(anchor, 'utf8')).version;
  assertDesktopVersion(dshVersion);
  const { entryListSchema } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis-plugin-include')).href);
  const yaml = require('js-yaml');
  const host = {
    runtime, anchor, version: dshVersion, resolve: require.resolve,
    load: name => import(pathToFileURL(require.resolve(name)).href),
    parse: text => yaml.load(text, { schema: entryListSchema }),
    dump: value => yaml.dump(value, { schema: entryListSchema, lineWidth: -1, noRefs: true }),
  };

  const presetId = 'vibeguide';
  const home = resolve(values.home);
  const profile = join(home, 'profiles', values.profile);
  const profileManifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'));
  if (!profileManifest.dsh?.profile?.bundles?.includes('@deepseek-ai/dsh-web-app')) {
    throw new Error('目标 profile 不包含 Web 会话能力。');
  }
  const patchPath = join(profile, 'cordis.patch.yml');
  const before = await readFile(patchPath);
  const previous = host.parse(before.toString('utf8'));
  if (!Array.isArray(previous)) throw new Error('现有 profile patch 不是有效的数组，未修改。');
  composeDesktopPatch(previous, { insert: [] }, true);

  // Keep the storage of an earlier install of this same plugin, as upstream --upgrade does.
  let storageRoot = join(home, 'vibeguide-p0-state');
  const rows = previous.flatMap(row => [row, ...(row.insert ?? [])]);
  const former = rows.find(row => row.id === 'vibeguide-p0-presets') ?? rows.find(row => row.id === 'vibeguide-presets');
  if (former) {
    const included = host.parse(await readFile(former.config.path, 'utf8'));
    const preset = included.find(row => ['vibeguide', 'vibeguide-p0'].includes(row.config?.id))?.config;
    const old = preset?.plugins?.find(row => row.id === 'vibeguide-continuity')?.config?.storageRoot
      ?? included.find(row => row.id === 'vibeguide-guide')?.config?.storageRoot;
    if (old) storageRoot = old;
  }

  const packageDirectory = join(home, 'plugins', `vibeguide-desktop-${randomUUID()}`);
  let published = false;
  let temporaryPatch;
  try {
    const prepared = await prepareDesktopPlugin(host, packageDirectory, { storageRoot });
    const expected = composeDesktopPatch(previous, prepared.patch, true);
    let candidate = before.toString('utf8') + '\n\n# VibeGuide desktop preset\n' + host.dump([prepared.patch]);
    try { assert.deepEqual(host.parse(candidate), expected); }
    catch { candidate = host.dump(expected); }
    assert.deepEqual(host.parse(candidate), expected, '现有配置必须完整保留');
    const backupDirectory = join(home, '.vibeguide-backups');
    await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
    const backup = join(backupDirectory, `${values.profile}-cordis-${Date.now()}.patch.yml`);
    await writeFile(backup, before, { flag: 'wx', mode: 0o600 });
    await writeFile(join(packageDirectory, 'installation.json'), JSON.stringify({
      version: prepared.version, edition: 'sidebar', desktopVersion: host.version, preset: presetId, profile, backup, storageRoot,
      app: values.app, installer: 'install-vibeguide-dsh-desktop.mjs',
      previousPatchSha256: createHash('sha256').update(before).digest('hex'),
      installedAt: new Date().toISOString(),
    }, null, 2) + '\n', { mode: 0o600 });
    assert.deepEqual(await readFile(patchPath), before, 'Harness 设置刚刚发生变化，请重新安装；尚未覆盖');
    temporaryPatch = join(profile, `.vibeguide-${randomUUID()}.tmp`);
    await writeFile(temporaryPatch, candidate, { flag: 'wx', mode: 0o600 });
    await rename(temporaryPatch, patchPath);
    published = true;
    console.log(JSON.stringify({ installed: true, version: prepared.version, desktopVersion: host.version, preset: presetId, packageDirectory, profile, backup, storageRoot, restartRequired: true }, null, 2));
  } finally {
    if (temporaryPatch) await rm(temporaryPatch, { force: true });
    if (!published) await rm(packageDirectory, { recursive: true, force: true });
  }
}
