import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { createRequire } from 'node:module';
import { readFile, cp, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertDesktopVersion, SUPPORTED_DESKTOP_VERSIONS } from '../dist/guide/host/compatibility.js';

export const DESKTOP_VERSION = SUPPORTED_DESKTOP_VERSIONS.at(-1);
export const DEFAULT_APP = process.env.VIBEGUIDE_DSH_APP ?? (existsSync('/Applications/DeepSeek Harness.app') ? '/Applications/DeepSeek Harness.app' : '/Applications/DSH Desktop.app');
export const desktopExecutable = (app = DEFAULT_APP) => join(app, 'Contents', 'MacOS', basename(app, '.app'));
export const sourceRoot = fileURLToPath(new URL('..', import.meta.url));

export async function desktopHost(app = DEFAULT_APP) {
  if (!process.versions.electron) throw new Error('桌面版适配必须通过 Electron 的 Node 模式运行。');
  const archive = join(app, 'Contents', 'Resources', 'app.asar');
  const runtime = existsSync(join(archive, 'dsh')) ? join(archive, 'dsh') : archive;
  const require = createRequire(join(runtime, 'package.json'));
  const anchor = require.resolve('@deepseek-ai/dsh/package.json');
  const pkg = JSON.parse(await readFile(anchor, 'utf8'));
  assertDesktopVersion(pkg.version);
  const load = name => import(pathToFileURL(require.resolve(name)).href);
  const { entryListSchema } = await load('@deepseek-ai/cordis-plugin-include');
  const yaml = require('js-yaml');
  return {
    runtime, anchor, version: pkg.version, load, resolve: require.resolve,
    parse: text => yaml.load(text, { schema: entryListSchema }),
    dump: value => yaml.dump(value, { schema: entryListSchema, lineWidth: -1, noRefs: true }),
  };
}

export async function prepareDesktopPlugin(host, directory, options = {}) {
  const presetId = 'vibeguide';
  const packageJson = JSON.parse(await readFile(join(sourceRoot, 'package.json'), 'utf8'));
  const webRoot = dirname(host.resolve('@deepseek-ai/dsh-web-app/package.json'));
  const standardText = await readFile(join(webRoot, 'presets', 'standard.patch.yml'), 'utf8');
  const standard = host.parse(standardText)[0]?.insert?.find(row => row.config?.id === 'standard');
  if (!standard || !Array.isArray(standard.config.plugins)) throw new Error('桌面版标准预设结构不符合预期，未安装。');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const folder of ['dist', 'prompts']) {
    await cp(join(sourceRoot, folder), join(directory, folder), { recursive: true });
  }
  await writeFile(join(directory, 'package.json'), JSON.stringify({
    name: 'vibeguide', version: packageJson.version, private: true, type: 'module',
    exports: { '.': './dist/guide/plugin.js', './client': './dist/client.js', './package.json': './package.json' },
    dsh: { client: { platform: 'web', immediately: true, inject: [
      '@deepseek-ai/dsh-client-ui-sidebar-right', '@deepseek-ai/dsh-client-ui-conversation',
      '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-connection',
    ] } },
  }, null, 2) + '\n', { mode: 0o600 });
  // Includes outside the profile do not inherit its package lookup fallback.
  // Use this desktop's exact modules, including every nested preset row.
  const hostRows = rows => rows.map(row => ({
    ...row,
    name: row.name.startsWith('@deepseek-ai/') ? pathToFileURL(host.resolve(row.name)).href : row.name,
    ...(row.group === true ? { config: hostRows(row.config) } : {}),
  }));
  const preset = {
    ...standard,
    id: `preset-${presetId}`,
    name: pathToFileURL(host.resolve('@deepseek-ai/dsh-agent-preset')).href,
    config: {
      ...standard.config,
      id: presetId, name: 'VibeGuide', order: 2,
      description: '用易懂的话沟通开发；在 VibeGuide 侧栏按需看懂进展与选择。',
      plugins: [...hostRows(standard.config.plugins), {
        id: 'vibeguide-communication',
        name: pathToFileURL(join(directory, 'dist', 'index.js')).href,
      }],
    },
  };
  const composition = host.dump([{
    id: 'vibeguide-guide', name: pathToFileURL(join(directory, 'dist', 'guide', 'plugin.js')).href,
    config: { runtimeAnchor: host.anchor, storageRoot: options.storageRoot ?? join(dirname(directory), 'vibeguide-v2-state') },
  }, preset]);
  await writeFile(join(directory, 'preset.cordis.yml'), composition, { mode: 0o600 });
  return {
    version: packageJson.version,
    preset,
    patch: { insert: [{
      id: `${presetId}-presets`, name: 'cordis:include',
      config: { path: join(directory, 'preset.cordis.yml') },
    }] },
  };
}

/** Upgrade only our two installer-owned includes, preserving all other rows. */
export function composeDesktopPatch(previous, addition, upgrade = false) {
  const ids = new Set(['vibeguide-presets', 'vibeguide-p0-presets']);
  const found = previous.flatMap(row => [row, ...(row.insert ?? [])]).filter(row => ids.has(row.id));
  if (found.length && !upgrade) throw new Error('VibeGuide 已安装；请使用 --upgrade 更新并合并旧模式。');
  if (new Set(found.map(row => row.id)).size !== found.length) throw new Error('存在重复的 VibeGuide 声明，未修改。');
  for (const row of found) if (row.name !== 'cordis:include' || typeof row.config?.path !== 'string') throw new Error('VibeGuide 声明有自定义结构，未修改。');
  const otherDeclaration = previous.flatMap(row => [row, ...(row.insert ?? [])]).some(row => ['vibeguide', 'vibeguide-p0'].includes(row.config?.id));
  if (otherDeclaration) throw new Error('存在手动声明的 VibeGuide 预设，未修改。');
  const next = [];
  for (const original of previous) {
    if (ids.has(original.id)) continue;
    // Preserve custom YAML tag instances (including !!js) in untouched values.
    const row = { ...original };
    if (Array.isArray(row.insert)) {
      row.insert = row.insert.filter(item => !ids.has(item.id));
      if (!row.insert.length) delete row.insert;
    }
    if (row.id === 'agent-preset-registry' && row.config?.default === 'vibeguide-p0') row.config = { ...row.config, default: 'vibeguide' };
    if (Object.keys(row).length) next.push(row);
  }
  return [...next, addition];
}
