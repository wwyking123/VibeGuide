import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_APP, composeDesktopPatch, desktopHost, prepareDesktopPlugin } from './desktop.mjs';

const { values } = parseArgs({ options: {
  app: { type: 'string', default: DEFAULT_APP },
  home: { type: 'string' },
  help: { type: 'boolean' },
  continuity: { type: 'boolean', default: false },
  upgrade: { type: 'boolean', default: false },
} });
if (values.help) {
  console.log('node scripts/install-desktop.mjs --home <DSH_HOME> [--app <DeepSeek Harness.app>] [--upgrade]\n统一安装 VibeGuide（含项目续接）。--upgrade 合并旧 VibeGuide/P0 声明并保留记录。旧 --continuity 参数仍接受，但不再创建第二模式。');
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
  const presetId = 'vibeguide';
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
  // Validate the update shape before preparing files. The existing package copies stay intact.
  composeDesktopPatch(previous, { insert: [] }, values.upgrade);
  let storageRoot = join(home, 'vibeguide-p0-state');
  const formerP0 = previous.flatMap(row => [row, ...(row.insert ?? [])]).find(row => row.id === 'vibeguide-p0-presets');
  if (formerP0) {
    const oldPreset = host.parse(await readFile(formerP0.config.path, 'utf8'))[0]?.config;
    const oldStorage = oldPreset?.plugins?.find(row => row.id === 'vibeguide-continuity')?.config?.storageRoot;
    if (oldStorage) storageRoot = oldStorage;
  }
  const formerVibeGuide = previous.flatMap(row => [row, ...(row.insert ?? [])]).find(row => row.id === 'vibeguide-presets');
  if (!formerP0 && formerVibeGuide) {
    const oldPreset = host.parse(await readFile(formerVibeGuide.config.path, 'utf8'))[0]?.config;
    const oldStorage = oldPreset?.plugins?.find(row => row.id === 'vibeguide-continuity')?.config?.storageRoot;
    if (oldStorage) storageRoot = oldStorage;
  }
  const packageDirectory = join(home, 'plugins', `vibeguide-desktop-${randomUUID()}`);
  let published = false;
  let temporaryPatch;
  try {
    const prepared = await prepareDesktopPlugin(host, packageDirectory, { storageRoot });
    const expected = composeDesktopPatch(previous, prepared.patch, values.upgrade);
    let candidate = before.toString('utf8') + '\n\n# VibeGuide desktop preset\n' + host.dump([prepared.patch]);
    try { assert.deepEqual(host.parse(candidate), expected); }
    catch { candidate = host.dump(expected); }
    assert.deepEqual(host.parse(candidate), expected, '现有配置必须完整保留');
    const backupDirectory = join(home, '.vibeguide-backups');
    await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
    const backup = join(backupDirectory, `desktop-cordis-${Date.now()}.patch.yml`);
    await writeFile(backup, before, { flag: 'wx', mode: 0o600 });
    await writeFile(join(packageDirectory, 'installation.json'), JSON.stringify({
      version: prepared.version, desktopVersion: host.version, preset: presetId, profile, backup, storageRoot,
      previousPatchSha256: createHash('sha256').update(before).digest('hex'),
      installedAt: new Date().toISOString(),
    }, null, 2) + '\n', { mode: 0o600 });
    // Abort if another process changed settings while the plugin was prepared.
    assert.deepEqual(await readFile(patchPath), before, 'Harness 设置刚刚发生变化，请重新安装；尚未覆盖');
    temporaryPatch = join(profile, `.vibeguide-${randomUUID()}.tmp`);
    await writeFile(temporaryPatch, candidate, { flag: 'wx', mode: 0o600 });
    await rename(temporaryPatch, patchPath);
    published = true;
    console.log(JSON.stringify({ installed: true, version: prepared.version, desktopVersion: host.version, preset: presetId, packageDirectory, profile, backup, storageRoot, upgraded: values.upgrade, retiredP0: Boolean(formerP0), restartRequired: true }, null, 2));
  } finally {
    if (temporaryPatch) await rm(temporaryPatch, { force: true });
    if (!published) await rm(packageDirectory, { recursive: true, force: true });
  }
}
