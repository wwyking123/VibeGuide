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
  guide: { type: 'boolean', default: false },
  upgrade: { type: 'boolean', default: false },
} });
if (values.help) {
  console.log('node scripts/install-desktop.mjs --home <DSH_HOME> [--app <DeepSeek Harness.app>] [--upgrade] [--guide]\n--guide 安装真实进展、持久记录与按需讲解侧栏，不挂载旧记账工具；不带此参数仍安装原项目续接版。两者均使用唯一 VibeGuide 模式。--upgrade 更新已有安装并保留旧记录与插件副本。');
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
  const previousStorage = async declaration => {
    const rows = host.parse(await readFile(declaration.config.path, 'utf8'));
    const preset = rows.find(row => ['vibeguide', 'vibeguide-p0'].includes(row.config?.id))?.config;
    return preset?.plugins?.find(row => row.id === 'vibeguide-continuity')?.config?.storageRoot
      ?? rows.find(row => row.id === 'vibeguide-guide')?.config?.storageRoot;
  };
  const formerP0 = previous.flatMap(row => [row, ...(row.insert ?? [])]).find(row => row.id === 'vibeguide-p0-presets');
  if (formerP0) {
    const oldStorage = await previousStorage(formerP0);
    if (oldStorage) storageRoot = oldStorage;
  }
  const formerVibeGuide = previous.flatMap(row => [row, ...(row.insert ?? [])]).find(row => row.id === 'vibeguide-presets');
  if (!formerP0 && formerVibeGuide) {
    const oldStorage = await previousStorage(formerVibeGuide);
    if (oldStorage) storageRoot = oldStorage;
  }
  const packageDirectory = join(home, 'plugins', `vibeguide-desktop-${randomUUID()}`);
  let published = false;
  let temporaryPatch;
  try {
    const prepared = await prepareDesktopPlugin(host, packageDirectory, { storageRoot, guide: values.guide });
    const edition = values.guide ? 'sidebar-p5' : 'continuity';
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
      version: prepared.version, edition, desktopVersion: host.version, preset: presetId, profile, backup, storageRoot,
      previousPatchSha256: createHash('sha256').update(before).digest('hex'),
      installedAt: new Date().toISOString(),
    }, null, 2) + '\n', { mode: 0o600 });
    // Abort if another process changed settings while the plugin was prepared.
    assert.deepEqual(await readFile(patchPath), before, 'Harness 设置刚刚发生变化，请重新安装；尚未覆盖');
    temporaryPatch = join(profile, `.vibeguide-${randomUUID()}.tmp`);
    await writeFile(temporaryPatch, candidate, { flag: 'wx', mode: 0o600 });
    await rename(temporaryPatch, patchPath);
    published = true;
    console.log(JSON.stringify({ installed: true, version: prepared.version, edition, desktopVersion: host.version, preset: presetId, packageDirectory, profile, backup, storageRoot, upgraded: values.upgrade, retiredP0: Boolean(formerP0), restartRequired: true }, null, 2));
  } finally {
    if (temporaryPatch) await rm(temporaryPatch, { force: true });
    if (!published) await rm(packageDirectory, { recursive: true, force: true });
  }
}
