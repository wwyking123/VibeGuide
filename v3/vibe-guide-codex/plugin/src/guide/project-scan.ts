import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { captureFiles } from './files.js';
import { redact } from './privacy.js';
import type { FileBasis } from './contracts.js';

export type ProjectEvidence = {
  basis: FileBasis; snippets: { file: string; excerpt: string; clipped: boolean }[];
  links: { from: string; to: string }[];
};
const sensitive = /(^\.env($|\.)|(^|[._-])(secret|credentials?|tokens?|private[-_]?key)([._-]|$)|\.(pem|key|p12|pfx|keystore)$|^id_(rsa|ed25519)$)/i;

/** Bounded excerpts are hash-matched to the scan. The tracker may retain redacted before/after excerpts with native receipts; never follow source aliases. */
export async function projectEvidence(root: string, excludedRoots: string[], signal: AbortSignal, options: { basis?: FileBasis; only?: string[]; priority?: string[] } = {}): Promise<ProjectEvidence> {
  const basis = options.basis ?? await captureFiles(root, 250, excludedRoots);
  const snippets: ProjectEvidence['snippets'] = [], links: ProjectEvidence['links'] = [];
  const priority = (path: string) => options.priority?.includes(path) ? -1 : /(^|\/)(package\.json|readme\.md|index\.[^.]+|app\.[^.]+|main\.[^.]+)$/i.test(path) ? 0 : 1;
  let budget = 24000;
  for (const path of Object.keys(basis.files).sort((a, b) => priority(a) - priority(b) || a.localeCompare(b))) {
    if (options.only && !options.only.includes(path)) continue;
    signal.throwIfAborted();
    if (snippets.length >= 24 || budget <= 0) break;
    if (/\.(lock|json)$/i.test(path) && !/(^|\/)package\.json$/i.test(path)) continue;
    const absolute = resolve(root, path), rel = relative(root, absolute);
    if (rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).some(part => sensitive.test(part))) continue;
    if (excludedRoots.some(excluded => absolute === excluded || absolute.startsWith(excluded + sep))) continue;
    let file;
    try {
      if (await realpath(absolute) !== absolute) continue;
      file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const before = await file.stat();
      if (!before.isFile() || before.nlink !== 1 || before.size > 1024 * 1024) continue;
      const content = await file.readFile(), after = await file.stat(), named = await stat(absolute);
      if (await realpath(absolute) !== absolute || before.dev !== named.dev || before.ino !== named.ino
        || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
        || createHash('sha256').update(content).digest('hex') !== basis.files[path]) continue;
      const raw = content.toString('utf8');
      // Only literal local Web references. Dynamic imports/aliases/server flows remain unknown.
      if (/\.(?:[cm]?[jt]sx?|html?|vue|svelte|css|scss)$/i.test(path)) {
        const imports = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*|(?:src|href)\s*=\s*|@import\s*)["'](\.[^"']+)["']/g;
        for (const match of raw.matchAll(imports)) {
          const target = relative(root, resolve(root, dirname(path), match[1].split(/[?#]/)[0]));
          if (target.startsWith('..') || isAbsolute(target)) continue;
          const found = [target, ...['.ts', '.tsx', '.js', '.jsx', '.vue', '.svelte', '/index.ts', '/index.js'].map(ext => target + ext)].find(p => p in basis.files);
          if (found && links.length < 500 && !links.some(link => link.from === path && link.to === found)) links.push({ from: path, to: found });
        }
      }
      const add = (target: string, suffixes: string[]) => {
        if (target.startsWith('..') || isAbsolute(target)) return;
        const found = [target, ...suffixes.map(ext => target + ext)].find(p => p in basis.files);
        if (found && links.length < 500 && !links.some(link => link.from === path && link.to === found)) links.push({ from: path, to: found });
      };
      // Conservative literal local references only. No aliases, external modules or dynamic paths.
      if (/\.py$/i.test(path)) for (const match of raw.matchAll(/^\s*(?:from\s+([.\w]+)\s+import\b|import\s+([\w.]+)(?:\s|$))/gm)) {
        const module = match[1] ?? match[2], dots = module.match(/^\.+/)?.[0].length ?? 0;
        if (!module.replace(/^\.+/, '')) continue;
        const base = dots ? resolve(root, dirname(path), ...Array(dots - 1).fill('..')) : root;
        add(relative(root, resolve(base, module.replace(/^\.+/, '').replaceAll('.', '/'))), ['.py', '/__init__.py']);
      }
      if (/\.(?:c|cc|cpp|h|hpp)$/i.test(path)) for (const match of raw.matchAll(/^\s*#\s*include\s*"([^"\n]+)"/gm)) add(relative(root, resolve(root, dirname(path), match[1])), []);
      if (/\.rb$/i.test(path)) for (const match of raw.matchAll(/\brequire_relative\s*["']([^"']+)["']/g)) add(relative(root, resolve(root, dirname(path), match[1])), ['.rb']);
      if (/\.php$/i.test(path)) for (const match of raw.matchAll(/\b(?:require|include)(?:_once)?\s*(?:\(\s*)?["'](\.[^"']+)["']/g)) add(relative(root, resolve(root, dirname(path), match[1])), ['.php']);
      const safe = redact(raw), excerpt = safe.slice(0, Math.min(1800, budget));
      snippets.push({ file: path, excerpt, clipped: safe.length > excerpt.length }); budget -= excerpt.length;
    } catch { /* Coverage is reported as sampled files; a failed read is never fabricated evidence. */ }
    finally { await file?.close(); }
  }
  return { basis, snippets, links };
}
