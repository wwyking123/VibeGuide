import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { findHarness } from './harness.mjs';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
export const PLUGIN_ROW = '\n# VibeGuide: communication rules in this preset scope only.\n- id: vibeguide\n  name: ./.vibeguide-plugin/dist/index.js\n';

async function restrictAccess(directory) {
  await chmod(directory, 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = join(directory, entry.name);
    if (entry.isDirectory()) await restrictAccess(target);
    else await chmod(target, 0o600 | ((await stat(target)).mode & 0o100));
  }
}

/** Create a new preset only. Existing presets and host configuration are untouched. */
export async function installPreset({ home, harness, id = 'vibeguide', source = packageRoot }) {
  if (!['darwin', 'linux'].includes(process.platform)) {
    throw new Error('此开发版安装器仅支持 macOS/Linux。');
  }
  if (!home) throw new Error('必须通过 --home 明确指定 Harness 数据目录。');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id) || id === 'standard') {
    throw new Error('preset id 必须由小写字母、数字或短横线组成，且不能是 standard。');
  }
  const shipped = await readdir(dirname(harness.standard), { withFileTypes: true });
  if (shipped.some(entry => entry.name === id && entry.isDirectory())) {
    throw new Error(`preset id ${id} 与宿主自带预设重名，会被宿主遮蔽；请换一个 --id。`);
  }
  const destination = join(resolve(home), '.agent-presets', id);
  const composition = await readFile(join(harness.standard, 'agent.cordis.yml'), 'utf8');
  const policy = await readFile(join(source, 'prompts', 'core.md'), 'utf8');
  await readFile(join(source, 'dist', 'index.js')); // Fail before creating anything if not built.
  const pkg = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  // Leading dot keeps incomplete builds out of Harness preset discovery.
  const stage = await mkdtemp(join(dirname(destination), '.vibeguide-install-'));
  let claimed = false;
  try {
    // Preserve the complete shipped composition and assets, including !!js YAML.
    // Write the composition last so no mount can see missing plugin assets.
    await cp(harness.standard, stage, {
      recursive: true,
      dereference: true,
      filter: entry => entry !== join(harness.standard, 'agent.cordis.yml'),
    });
    await chmod(stage, 0o700); // Local presets contain executable code.
    const pluginDirectory = join(stage, '.vibeguide-plugin');
    await mkdir(pluginDirectory);
    for (const directory of ['dist', 'prompts']) {
      await cp(join(source, directory), join(pluginDirectory, directory), { recursive: true });
    }
    await writeFile(join(pluginDirectory, 'package.json'), JSON.stringify({
      name: pkg.name, version: pkg.version, private: true, type: 'module',
    }, null, 2) + '\n');
    await writeFile(join(stage, 'preset.yml'), JSON.stringify({
      name: 'VibeGuide',
      description: '直接用易懂的语言说明开发方案、业务选择和实际结果。保留标准开发能力。',
      order: 2,
    }, null, 2) + '\n');
    await writeFile(join(stage, '.vibeguide.json'), JSON.stringify({
      package: pkg.name,
      version: pkg.version,
      harnessVersion: harness.version,
      basePreset: 'standard',
      baseCompositionSha256: createHash('sha256').update(composition).digest('hex'),
      policySha256: createHash('sha256').update(policy).digest('hex'),
      installedAt: new Date().toISOString(),
    }, null, 2) + '\n');
    await writeFile(join(stage, 'agent.cordis.yml'), composition + PLUGIN_ROW);
    await restrictAccess(stage);
    // Claim immediately before publishing. rename alone would overwrite an
    // existing empty directory on POSIX; mkdir must first prove ownership.
    try {
      await mkdir(destination, { mode: 0o700 });
      claimed = true;
    } catch (error) {
      if (error.code === 'EEXIST') throw new Error(`已存在 ${destination}；请使用另一个 --id，或先移走旧版本。不会覆盖。`);
      throw error;
    }
    await rename(stage, destination);
    return { destination, id, harnessVersion: harness.version, version: pkg.version };
  } catch (error) {
    if (claimed) await rm(destination, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: {
      home: { type: 'string' },
      id: { type: 'string', default: 'vibeguide' },
      'harness-root': { type: 'string' },
      help: { type: 'boolean' },
    } });
    if (values.help) {
      console.log('node scripts/install-preset.mjs --home <DSH_HOME> [--id vibeguide] [--harness-root <dsh package>]');
    } else {
      if (!values.home) throw new Error('请指定 --home；不会默认修改你的日常 Harness 配置。');
      const harness = await findHarness(values['harness-root']);
      console.log(JSON.stringify(await installPreset({ home: values.home, id: values.id, harness }), null, 2));
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
