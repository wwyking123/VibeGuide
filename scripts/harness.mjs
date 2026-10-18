import { access, readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { delimiter, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SUPPORTED_HARNESS = '0.1.0-rc.6';

/** Resolve the installed CLI, without reading any user profiles or credentials. */
export async function findHarness(explicit = process.env.VIBEGUIDE_HARNESS_ROOT) {
  if (!['darwin', 'linux'].includes(process.platform)) {
    throw new Error('此开发版安装器仅支持 macOS/Linux；Windows 安装路径尚未实现。');
  }
  let root = explicit && resolve(explicit);
  if (!root) {
    for (const directory of (process.env.PATH ?? '').split(delimiter)) {
      const binary = join(directory, process.platform === 'win32' ? 'dsh.cmd' : 'dsh');
      try {
        await access(binary);
        let candidate = dirname(await realpath(binary));
        for (let depth = 0; depth < 5; depth++, candidate = dirname(candidate)) {
          try {
            const pkg = JSON.parse(await readFile(join(candidate, 'package.json'), 'utf8'));
            if (pkg.name === '@deepseek-ai/dsh') { root = candidate; break; }
          } catch { /* Not the CLI package directory. */ }
        }
        if (root) break;
      } catch { /* Try the next PATH entry. */ }
    }
  }
  if (!root) throw new Error('未找到 dsh。请安装 DeepSeek Harness，或用 --harness-root 指定 @deepseek-ai/dsh 包目录。');
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (pkg.name !== '@deepseek-ai/dsh' || pkg.version !== SUPPORTED_HARNESS) {
    throw new Error(`本版仅验证过 @deepseek-ai/dsh ${SUPPORTED_HARNESS}；检测到 ${pkg.name} ${pkg.version}。尚未安装。`);
  }
  const require = createRequire(join(root, 'package.json'));
  return {
    root,
    version: pkg.version,
    standard: join(root, 'config', 'agent-presets', 'standard'),
    resolve: name => require.resolve(name),
    import: name => import(pathToFileURL(require.resolve(name)).href),
  };
}
