import { constants } from 'node:fs';
import { lstat, readdir, open, realpath } from 'node:fs/promises';
import { join, relative, isAbsolute, sep } from 'node:path';
import { createHash } from 'node:crypto';
import type { FileBasis } from './contracts.js';

export const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ignored = new Set(['.git', '.dsh', '.ssh', '.codex', 'node_modules', 'dist', 'build', 'coverage', '.next', '.cache', '.venv', 'vendor', 'output', 'artifacts']);
const secret = /(^\.env($|\.)|(^|[._-])(secret|credentials?|tokens?|private[-_]?key)([._-]|$)|\.(pem|key|p12|pfx|keystore)$|^id_(rsa|ed25519)$)/i;
const source = /\.(?:[cm]?[jt]sx?|json|html?|css|scss|md|txt|ya?ml|toml|lock|py|rs|go|java|kt|swift|rb|php|cs|c|cc|cpp|h|hpp|sh|sql|vue|svelte)$/i;

export type FingerprintCache = Map<string, { stamp: string; digest: string }>;
/** Bounded, read-only source fingerprints. No content, symlinks or secret files are retained. */
export async function captureFiles(root: string, budgetMs = 120, excludedRoots: string[] = [], options: { cache?: FingerprintCache; maxFiles?: number; maxBytes?: number } = {}): Promise<FileBasis> {
  const maxFiles = options.maxFiles ?? 500, maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
  const seen = new Set<string>();
  const files: Record<string, string> = Object.create(null);
  const deadline = performance.now() + budgetMs;
  let bytes = 0, count = 0, complete = true;
  const visit = async (directory: string): Promise<void> => {
    if (excludedRoots.some(excluded => directory === excluded || directory.startsWith(excluded + sep))) return;
    if (performance.now() > deadline || count >= maxFiles || bytes > maxBytes) { complete = false; return; }
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch { complete = false; return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (ignored.has(entry.name) || secret.test(entry.name)) continue;
      if (performance.now() > deadline || count >= maxFiles || bytes > maxBytes) { complete = false; return; }
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) { complete = false; continue; }
      if (entry.isDirectory()) { await visit(path); continue; }
      if (!entry.isFile() || !source.test(entry.name)) continue;
      let file;
      try {
        // Recheck the resolved ancestry, including secret aliases, before reading.
        const actual = await realpath(path), rel = relative(root, actual);
        if (actual !== path || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).some(part => secret.test(part))) { complete = false; continue; }
        file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const before = await file.stat();
        if (!before.isFile() || before.nlink !== 1 || before.size > 1024 * 1024 || bytes + before.size > maxBytes) { complete = false; continue; }
        const stamp = hash([before.dev, before.ino, before.size, before.mtimeMs, before.ctimeMs, before.nlink]);
        seen.add(rel);
        const prior = options.cache?.get(rel);
        if (prior?.stamp === stamp) {
          const after = await file.stat(), named = await lstat(path);
          if (await realpath(path) !== path || named.ino !== before.ino || named.dev !== before.dev || after.nlink !== 1 || after.ctimeMs !== before.ctimeMs || after.mtimeMs !== before.mtimeMs || after.size !== before.size) { complete = false; continue; }
          files[rel] = prior.digest; count++; bytes += before.size; continue;
        }
        const value = await file.readFile();
        const after = await file.stat();
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) { complete = false; continue; }
        const named = await lstat(path);
        if (await realpath(path) !== path || named.ino !== before.ino || named.dev !== before.dev || after.nlink !== 1) { complete = false; continue; }
        files[rel] = createHash('sha256').update(value).digest('hex');
        options.cache?.set(rel, { stamp, digest: files[rel] });
        count++; bytes += value.length;
      } catch { complete = false; }
      finally { await file?.close(); }
    }
  };
  try { const info = await lstat(root); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(); await visit(root); }
  catch { complete = false; }
  if (complete && options.cache) for (const path of options.cache.keys()) if (!seen.has(path)) options.cache.delete(path);
  return { files, complete, digest: hash({ version: 1, files, complete }), capturedAt: new Date().toISOString() };
}

export function changedFiles(before: FileBasis, after: FileBasis): string[] {
  // Missing entries in an incomplete scan are not proof of deletion.
  return [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].filter(path =>
    before.files[path] !== after.files[path] && ((path in before.files && path in after.files) || (before.complete && after.complete)));
}
