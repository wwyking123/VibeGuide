import { createRequire } from 'node:module';
import { readFile, cp, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DESKTOP_VERSION = '0.2.1-rc.2';
export const DEFAULT_APP = '/Applications/DeepSeek Harness.app';
export const sourceRoot = fileURLToPath(new URL('..', import.meta.url));

export async function desktopHost(app = DEFAULT_APP) {
  if (!process.versions.electron) throw new Error('桌面版适配必须通过 Electron 的 Node 模式运行。');
  const runtime = join(app, 'Contents', 'Resources', 'app.asar', 'dsh');
  const require = createRequire(join(runtime, 'package.json'));
  const anchor = require.resolve('@deepseek-ai/dsh/package.json');
  const pkg = JSON.parse(await readFile(anchor, 'utf8'));
  if (pkg.version !== DESKTOP_VERSION) throw new Error(`桌面版适配仅验证 ${DESKTOP_VERSION}，实际为 ${pkg.version}。`);
  const load = name => import(pathToFileURL(require.resolve(name)).href);
  const { entryListSchema } = await load('@deepseek-ai/cordis-plugin-include');
  const yaml = require('js-yaml');
  return {
    runtime, anchor, version: pkg.version, load, resolve: require.resolve,
    parse: text => yaml.load(text, { schema: entryListSchema }),
    dump: value => yaml.dump(value, { schema: entryListSchema, lineWidth: -1, noRefs: true }),
  };
}

export async function prepareDesktopPlugin(host, directory) {
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
    id: 'preset-vibeguide',
    name: pathToFileURL(host.resolve('@deepseek-ai/dsh-agent-preset')).href,
    config: {
      ...standard.config,
      id: 'vibeguide', name: 'VibeGuide', order: 2,
      description: '直接用易懂的语言说明方案、业务选择与实际结果，保留标准开发能力。',
      plugins: [...hostRows(standard.config.plugins), {
        id: 'vibeguide-communication',
        name: pathToFileURL(join(directory, 'dist', 'index.js')).href,
      }],
    },
  };
  const composition = host.dump([preset]);
  await writeFile(join(directory, 'preset.cordis.yml'), composition, { mode: 0o600 });
  return {
    version: packageJson.version,
    preset,
    patch: { insert: [{
      id: 'vibeguide-presets', name: 'cordis:include',
      config: { path: join(directory, 'preset.cordis.yml') },
    }] },
  };
}
