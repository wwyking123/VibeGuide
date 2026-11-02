import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Harness owns React and the module registry. See the rc.2 sidebar-files client.
const root = fileURLToPath(new URL('..', import.meta.url));
const external = ['react', 'react/jsx-runtime'];
await build({
  absWorkingDir: root,
  entryPoints: ['src/client/index.tsx'],
  outfile: 'dist/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external,
  banner: { js: 'window.__ModuleLoader__.load({id:"vibeguide",factory:(require)=>{const module={exports:{}};const exports=module.exports;' },
  footer: { js: 'return module.exports;}});' },
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
});
const output = await readFile(new URL('../dist/client.js', import.meta.url), 'utf8');
if (/\bimport\.meta\b|(^|\n)\s*(?:import|export)\s/m.test(output)) throw new Error('Client contains unsupported ESM syntax.');
for (const [, name] of output.matchAll(/require\(["']([^"']+)["']\)/g)) {
  if (!external.includes(name)) throw new Error(`Unsupported client runtime dependency: ${name}`);
}
