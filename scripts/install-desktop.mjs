import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_APP, desktopHost, prepareDesktopPlugin } from './desktop.mjs';

const { values } = parseArgs({ options: {
  app: { type: 'string', default: DEFAULT_APP },
  home: { type: 'string' },
  help: { type: 'boolean' },
} });
if (values.help) {
  console.log('node scripts/install-desktop.mjs --home <DSH_HOME> [--app <DeepSeek Harness.app>]');
} else if (!values.home) {
  console.error('请用 --home 明确指定桌面版数据目录。');
  process.exitCode = 1;
} else if (!process.versions.electron) {
  const result = spawnSync(join(values.app, 'Contents', 'MacOS', 'DeepSeek Harness'), [
    '--expose-internals', fileURLToPath(import.meta.url), ...process.argv.slice(2),
  ], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit' });
  if (result.error) console.error(result.error.message);
  process.exitCode = result.status ?? 1;
} else {
  const host = await desktopHost(values.app);
  const home = resolve(values.home);
  const profile = join(home, 'profiles', 'desktop');
  const profileManifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'));
  if (!profileManifest.dsh?.profile?.bundles?.includes('@deepseek-ai/dsh-web-app')) {
    throw new Error('目标目录不是包含 Web 会话能力的桌面版 profile。');
  }
  const patchPath = join(profile, 'cordis.patch.yml');
  const before = await readFile(patchPath);
  const previous = host.parse(before.toString('utf8'));
  if (!Array.isArray(previous)) throw new Error('现有 profile patch 不是有效的数组，未修改。');
  if (previous.some(row => row.id === 'vibeguide-presets' || row.insert?.some(item => item.id === 'vibeguide-presets' || item.config?.id === 'vibeguide'))) {
    throw new Error('该 profile 已声明 VibeGuide；本安装器不会覆盖现有安装。');
  }
  const packageDirectory = join(home, 'plugins', `vibeguide-desktop-${randomUUID()}`);
  let published = false;
  let temporaryPatch;
  try {
    const prepared = await prepareDesktopPlugin(host, packageDirectory);
    const expected = [...previous, prepared.patch];
    let candidate = before.toString('utf8') + '\n\n# VibeGuide desktop preset\n' + host.dump([prepared.patch]);
    try { assert.deepEqual(host.parse(candidate), expected); }
    catch { candidate = host.dump(expected); }
    assert.deepEqual(host.parse(candidate), expected, '现有配置必须完整保留');
    const backupDirectory = join(home, '.vibeguide-backups');
    await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
    const backup = join(backupDirectory, `desktop-cordis-${Date.now()}.patch.yml`);
    await writeFile(backup, before, { flag: 'wx', mode: 0o600 });
    await writeFile(join(packageDirectory, 'installation.json'), JSON.stringify({
      version: prepared.version, desktopVersion: host.version, profile, backup,
      previousPatchSha256: createHash('sha256').update(before).digest('hex'),
      installedAt: new Date().toISOString(),
    }, null, 2) + '\n', { mode: 0o600 });
    // Abort if another process changed settings while the plugin was prepared.
    assert.deepEqual(await readFile(patchPath), before, 'Harness 设置刚刚发生变化，请重新安装；尚未覆盖');
    temporaryPatch = join(profile, `.vibeguide-${randomUUID()}.tmp`);
    await writeFile(temporaryPatch, candidate, { flag: 'wx', mode: 0o600 });
    await rename(temporaryPatch, patchPath);
    published = true;
    console.log(JSON.stringify({ installed: true, desktopVersion: host.version, preset: 'vibeguide', packageDirectory, profile, backup, restartRequired: true }, null, 2));
  } finally {
    if (temporaryPatch) await rm(temporaryPatch, { force: true });
    if (!published) await rm(packageDirectory, { recursive: true, force: true });
  }
}
