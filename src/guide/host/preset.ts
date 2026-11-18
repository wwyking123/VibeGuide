import { createRequire } from 'node:module';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';

export const name = 'vibeguide-preset';
export const inject = ['agentPresets'];
type Config = { runtimeAnchor?: string; communication?: string };
type Row = { config?: { id?: string; plugins?: unknown }; insert?: Row[] };

/**
 * VibeGuide mode is whatever this Harness's standard mode is right now, plus the communication rules.
 * The standard rows are passed through untouched, so plugins and settings a Harness update adds or
 * changes are picked up on the next start instead of being frozen at install time.
 */
export function vibeGuidePreset(standardRows: unknown, communication: string) {
  const rows = Array.isArray(standardRows) ? standardRows as Row[] : [];
  const standard = rows.flatMap(row => [row, ...(row?.insert ?? [])]).find(row => row?.config?.id === 'standard')?.config;
  if (!standard || !Array.isArray(standard.plugins)) {
    throw new Error('这个版本的 Harness 里没有找到标准模式的定义，VibeGuide 模式没有加载。请更新 VibeGuide。');
  }
  return {
    ...standard,
    id: 'vibeguide', name: 'VibeGuide', order: 2,
    description: '用易懂的话沟通开发；在 VibeGuide 侧栏按需看懂进展与选择。',
    plugins: [...standard.plugins, { id: 'vibeguide-communication', name: communication }],
  };
}

/** Host-side. Kept apart from the sidebar service so that neither one failing takes the other down. */
export async function apply(ctx: any, config: Config = {}) {
  config ??= {};
  if (config.runtimeAnchor !== undefined && !isAbsolute(config.runtimeAnchor)) throw new Error('VibeGuide: runtimeAnchor must be an absolute path.');
  // The rules plugin sits two folders up in the same package, wherever that package was installed.
  const communication = config.communication ?? new URL('../../index.js', import.meta.url).href;
  if (!communication.startsWith('file:')) throw new Error('VibeGuide requires the location of its communication rules.');
  // As a Harness bundle this file is anchor enough; the one-line installer passes one. See plugin.ts.
  const require = createRequire(config.runtimeAnchor ?? fileURLToPath(import.meta.url));
  const file = join(dirname(require.resolve('@deepseek-ai/dsh-web-app/package.json')), 'presets', 'standard.patch.yml');
  const { entryListSchema } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis-plugin-include')).href);
  // js-yaml is the Harness's own dependency, not something every install location can see: ask from where the Harness uses it.
  const yaml = createRequire(require.resolve('@deepseek-ai/cordis-plugin-include'))('js-yaml');
  const rows = yaml.load(await readFile(file, 'utf8'), { schema: entryListSchema });
  // Registering from the standard file's own location lets its module names and path expressions
  // resolve exactly as they do for the standard mode itself.
  const unregister = await ctx.extend({ baseUrl: new URL('.', pathToFileURL(file)).href }).agentPresets
    .register(vibeGuidePreset(rows, communication));
  ctx.effect(() => unregister);
}
