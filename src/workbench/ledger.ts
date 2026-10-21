import { constants } from 'node:fs';
import { mkdir, open, lstat, rename, rm } from 'node:fs/promises';
import { join, isAbsolute, relative, sep } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

export const digest = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export function ensure(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
export function bounded(value: unknown, max = 2000): asserts value is string { ensure(typeof value === 'string' && !!value.trim() && value.length <= max && !value.includes('\0'), 'Invalid or oversized text.'); }
export function identifier(value: unknown): asserts value is string { ensure(typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value), 'Invalid ID.'); }
export function exact(value: unknown, allowed: string[]): asserts value is Record<string, any> { ensure(value && typeof value === 'object' && !Array.isArray(value), 'Expected an object.'); ensure(Object.keys(value).every(k => allowed.includes(k)), 'Unsupported field.'); }
export type Envelope<T> = { schemaVersion: 1; identity: string; revision: number; data: T; operations: { id: string; digest: string }[] };
/** Independent private ledger: never rewrites legacy project records or application files. */
export class Ledger<T> {
  constructor(readonly directory: string, readonly filename: string, readonly identity: string, readonly empty: () => T, readonly validate: (data: T) => void, readonly guardRoot = directory) { ensure(isAbsolute(directory) && /^[a-z-]+\.json$/.test(filename), 'Invalid ledger path.'); }
  get path() { return join(this.directory, this.filename); }
  private async directoryReady(create: boolean) {
    const rel = relative(this.guardRoot, this.directory);
    ensure(!rel.startsWith('..') && !isAbsolute(rel), 'Ledger escaped its storage root.');
    let path = this.guardRoot;
    for (const part of ['', ...rel.split(sep).filter(Boolean)]) {
      if (part) path = join(path, part);
      try { const info = await lstat(path); ensure(info.isDirectory() && !info.isSymbolicLink(), 'Storage ancestry must not contain symlinks.'); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    }
    if (create) await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try { const info = await lstat(this.directory); ensure(info.isDirectory() && !info.isSymbolicLink(), 'Ledger directory must be a real directory.'); return true; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT' && !create) return false; throw e; }
  }
  async read(): Promise<Envelope<T>> {
    const fresh = () => ({ schemaVersion: 1 as const, identity: this.identity, revision: 0, data: this.empty(), operations: [] });
    if (!await this.directoryReady(false)) return fresh();
    let handle;
    try {
      handle = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat(); ensure(stat.isFile() && stat.size <= 8 * 1024 * 1024, 'Ledger too large or not a file.');
      const value = JSON.parse(await handle.readFile('utf8'));
      exact(value, ['schemaVersion', 'identity', 'revision', 'data', 'operations']);
      ensure(value.schemaVersion === 1 && value.identity === this.identity && Number.isSafeInteger(value.revision) && value.revision >= 0, 'Unsupported/corrupt ledger identity.');
      ensure(Array.isArray(value.operations) && value.operations.length <= 128 && value.operations.every((o: any) => typeof o.id === 'string' && /^[a-f0-9]{64}$/.test(o.digest)), 'Corrupt operation history.');
      this.validate(value.data); return value as Envelope<T>;
    } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return fresh(); throw e; }
    finally { await handle?.close(); }
  }
  async update(revision: number, operationId: string, input: unknown, mutate: (data: T) => void | Promise<void>, signal?: AbortSignal) {
    ensure(Number.isSafeInteger(revision) && revision >= 0, 'Invalid revision.'); identifier(operationId);
    const lockPath = join(this.directory, `${this.filename}.lock`), tempPath = join(this.directory, `.${randomUUID()}.tmp`);
    let locked = false, replaced = false;
    try {
      signal?.throwIfAborted(); await this.directoryReady(true);
      let lock;
      try { lock = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); locked = true; await lock.writeFile(JSON.stringify({ pid: process.pid })); await lock.sync(); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') return { status: 'busy', message: '记录正被使用；先读取，不覆盖。' }; throw e; }
      finally { await lock?.close(); }
      const before = await this.read(), checksum = digest(input), prior = before.operations.find(o => o.id === operationId);
      if (prior) { ensure(prior.digest === checksum, 'Operation ID reused with different content.'); return { status: 'unchanged', revision: before.revision }; }
      if (revision !== before.revision) return { status: 'conflict', revision: before.revision };
      const next = structuredClone(before); await mutate(next.data); this.validate(next.data);
      next.revision++; next.operations = [...next.operations, { id: operationId, digest: checksum }].slice(-128);
      const bytes = JSON.stringify(next, null, 2) + '\n'; ensure(Buffer.byteLength(bytes) <= 8 * 1024 * 1024, 'Ledger capacity reached; no records dropped.');
      signal?.throwIfAborted();
      const temp = await open(tempPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      try { await temp.writeFile(bytes); await temp.sync(); } finally { await temp.close(); }
      signal?.throwIfAborted(); await rename(tempPath, this.path); replaced = true;
      const directory = await open(this.directory, constants.O_RDONLY); try { await directory.sync(); } finally { await directory.close(); }
      const saved = await this.read(); ensure(saved.revision === next.revision && saved.operations.at(-1)?.id === operationId, 'Saved revision could not be confirmed.');
      return { status: 'saved', revision: next.revision };
    } catch (e) { return { status: replaced ? 'unknown' : 'failed', message: e instanceof Error ? e.message : String(e) }; }
    finally { await rm(tempPath, { force: true }).catch(() => {}); if (locked) await rm(lockPath, { force: true }).catch(() => {}); }
  }
}
