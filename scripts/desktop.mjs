import { createRequire } from 'node:module';
import { readFile, cp, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertDesktopVersion, SUPPORTED_DESKTOP_VERSIONS } from '../dist/guide/host/compatibility.js';

export const DESKTOP_VERSION = SUPPORTED_DESKTOP_VERSIONS.at(-1);
const WINDOWS = process.platform === 'win32';
export const DEFAULT_APP = WINDOWS ? join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness') : '/Applications/DeepSeek Harness.app';
/** Where the app keeps its executable and bundled resources: a .app bundle on macOS, a plain folder on Windows. */
export const appLayout = (app, windows = WINDOWS) => windows
  ? { executable: join(app, 'DeepSeek Harness.exe'), resources: join(app, 'resources') }
  : { executable: join(app, 'Contents', 'MacOS', 'DeepSeek Harness'), resources: join(app, 'Contents', 'Resources') };
export const sourceRoot = fileURLToPath(new URL('..', import.meta.url));

export async function desktopHost(app = DEFAULT_APP) {
  if (!process.versions.electron) throw new Error('桌面版适配必须通过 Electron 的 Node 模式运行。');
  const runtime = join(appLayout(app).resources, 'app.asar', 'dsh');
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
  // Nothing from the Harness's standard mode is copied here. The preset plugin reads it from the
  // running Harness on every start, so a Harness update cannot leave a stale copy behind.
  const composition = host.dump([{
    id: 'vibeguide-guide', name: pathToFileURL(join(directory, 'dist', 'guide', 'plugin.js')).href,
    config: { runtimeAnchor: host.anchor, storageRoot: options.storageRoot ?? join(dirname(directory), 'vibeguide-v2-state') },
  }, {
    id: 'vibeguide-preset', name: pathToFileURL(join(directory, 'dist', 'guide', 'host', 'preset.js')).href,
    config: { runtimeAnchor: host.anchor, communication: pathToFileURL(join(directory, 'dist', 'index.js')).href },
  }]);
  await writeFile(join(directory, 'preset.cordis.yml'), composition, { mode: 0o600 });
  return {
    version: packageJson.version,
    patch: { insert: [{
      id: `${presetId}-presets`, name: 'cordis:include',
      // A file URL, not a plain path: the Harness resolves this as a URL, and a Windows path such as
      // C:\\Users\\... would be read as a URL with the scheme "c:" and fail to load.
      config: { path: pathToFileURL(join(directory, 'preset.cordis.yml')).href },
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
