import { DatabaseSync } from 'node:sqlite';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, readdir, rm, realpath } from 'node:fs/promises';
import { join, resolve, parse, dirname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { GuideError } from './contracts.js';
import type { Delivery, Explanation, GuideInput, Operation, Scope } from './contracts.js';
import { hash } from './files.js';
import { freshProject, validProject } from './project-types.js';
import type { ProjectRecord } from './project-types.js';
import type { OriginalRequirement } from './work-types.js';

export type EventJob = { seq: number; fingerprint: string; operation?: Operation; requirement?: OriginalRequirement; result?: { id: string; failed: boolean; contentHash: string }; time: string };
export type GuideRecord = {
  version: 1; scope: Scope; revision: number; registered: number; completed: number;
  anchor?: string; partial: boolean; jobs: EventJob[]; operations: Operation[]; explanations: Explanation[];
  inputs: GuideInput[]; deliveries: Delivery[];
  requirements: OriginalRequirement[];
};
const fresh = (scope: Scope): GuideRecord => ({ version: 1, scope, revision: 0, registered: -1, completed: -1, partial: false, jobs: [], operations: [], explanations: [], inputs: [], deliveries: [], requirements: [] });

async function safeDirectory(path: string) {
  let current = parse(path).root;
  for (const part of path.slice(current.length).split('/').filter(Boolean)) {
    current = join(current, part);
    try { await mkdir(current, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Guide storage must not contain symlinks.');
  }
}

/** JSON state, protected by a process-lifetime OS-backed SQLite lock. A crash releases the lock. */
export class GuideStore {
  readonly directory: string;
  private guard?: DatabaseSync;
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private constructor(root: string) { this.directory = join(resolve(root), 'guide-v1'); }
  static async open(root: string): Promise<GuideStore> {
    // Canonicalize existing system ancestors (macOS /var), while rejecting a symlink at the configured root itself.
    const absolute = resolve(root);
    await mkdir(dirname(absolute), { recursive: true, mode: 0o700 });
    const store = new GuideStore(join(await realpath(dirname(absolute)), basename(absolute)));
    await safeDirectory(store.directory);
    const lock = join(store.directory, 'writer.sqlite');
    try { const info = await lstat(lock); if (!info.isFile() || info.isSymbolicLink()) throw new Error('Invalid writer guard.'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    const handle = await open(lock, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600); await handle.close();
    const guard = new DatabaseSync(lock);
    try {
      guard.exec('PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS writer (id INTEGER PRIMARY KEY); INSERT OR REPLACE INTO writer VALUES (1); COMMIT;');
      store.guard = guard;
    } catch (error) {
      guard.close();
      if (error instanceof Error && /locked|busy/i.test(error.message)) throw new GuideError('record_busy', '另一处 VibeGuide 正在使用项目记录，请先关闭另一处后重试。');
      throw new GuideError('record_unavailable', '记录保护文件无法读取，原文件已保留，请检查本地存储。');
    }
    return store;
  }
  private path(scope: Scope) { return join(this.directory, `${hash(scope)}.json`); }
  private async load(scope: Scope): Promise<GuideRecord> {
    let handle;
    try {
      handle = await open(this.path(scope), constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error('Invalid guide record size.');
      const value = JSON.parse(await handle.readFile('utf8')) as GuideRecord;
      // Additive compatibility: old P1 files stay byte-for-byte intact until the next actual write.
      value.inputs ??= []; value.deliveries ??= []; value.requirements ??= [];
      if (!Array.isArray(value.requirements) || value.requirements.length > 1000 || value.requirements.some(row => row.scope?.projectId !== scope.projectId || row.scope?.sessionId !== scope.sessionId || typeof row.text !== 'string' || !(row.source && 'seq' in row.source && Number.isSafeInteger(row.source.seq)))) throw new Error('Invalid original requirements');
      if (value.version !== 1 || hash(value.scope) !== hash(scope) || !Number.isSafeInteger(value.revision)
        || !Number.isSafeInteger(value.registered) || !Number.isSafeInteger(value.completed) || value.completed > value.registered
        || !Array.isArray(value.operations) || !Array.isArray(value.jobs) || !Array.isArray(value.explanations)
        || value.operations.length > 3000 || value.jobs.length > 1000 || value.explanations.length > 200
        || value.operations.some(op => typeof op.id !== 'string' || !Array.isArray(op.changedFiles) || !['pending', 'succeeded', 'failed', 'unknown'].includes(op.outcome))
        || value.explanations.some(answer => hash(answer.scope) !== hash(scope) || typeof answer.text !== 'string' || typeof answer.basis !== 'string')) {
        throw new Error('Invalid guide record.');
      }
      if (!Array.isArray(value.inputs) || !Array.isArray(value.deliveries) || value.inputs.length > 500 || value.deliveries.length > 500
        || new Set(value.inputs.map(row => row.id)).size !== value.inputs.length
        || new Set(value.deliveries.map(row => row.requestId)).size !== value.deliveries.length
        || value.inputs.some(row => typeof row.id !== 'string' || typeof row.digest !== 'string' || typeof row.statement !== 'string'
          || !Array.isArray(row.statements) || !row.statements.every(s => typeof s === 'string')
          || !['explain', 'modify', 'clarify', 'redirect', 'cancel'].includes(row.kind) || !['pending', 'done', 'failed'].includes(row.state))
        || value.deliveries.some(row => hash(row.scope) !== hash(scope) || typeof row.content !== 'string' || hash(row.content) !== row.contentDigest
          || typeof row.id !== 'string' || typeof row.requestId !== 'string' || typeof row.userStatement !== 'string'
          || !Array.isArray(row.clarificationStatements) || !row.clarificationStatements.every(s => typeof s === 'string')
          || !['pending', 'dispatching', 'queued', 'accepted', 'unknown', 'failed'].includes(row.state))) throw new Error('Invalid communication record.');
      return value;
    } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return fresh(scope); throw new GuideError('record_unavailable', '项目记录暂时无法读取，原记录已保留，请勿把当前内容当成完整进展。'); }
    finally { await handle?.close(); }
  }
  private serial<T>(run: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new GuideError('unavailable', '侧栏记录服务已关闭。'));
    const job = this.tail.then(run);
    this.tail = job.catch(() => {}); return job;
  }
  read(scope: Scope) { return this.serial(() => this.load(scope)); }
  private projectPath(projectId: string) { return join(this.directory, `project-${hash(projectId)}.json`); }
  private async loadProject(projectId: string): Promise<ProjectRecord> {
    let file;
    try {
      file = await open(this.projectPath(projectId), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error('Invalid project record size');
      const value = JSON.parse(await file.readFile('utf8')) as ProjectRecord;
      value.requirementRevisions ??= []; value.bindings ??= []; value.analyses ??= [];
      if (!validProject(value, projectId)) throw new Error('Invalid project record');
      return value;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return freshProject(projectId);
      throw new GuideError('record_unavailable', '项目的结构或学习记录暂时无法读取，原记录已保留。');
    } finally { await file?.close(); }
  }
  readProject(projectId: string) { return this.serial(() => this.loadProject(projectId)); }
  updateProject(projectId: string, mutate: (value: ProjectRecord) => void) {
    return this.serial(async () => {
      const before = await this.loadProject(projectId), value = structuredClone(before);
      mutate(value);
      if (hash(before) === hash(value)) return before;
      value.revision++;
      const data = JSON.stringify(value);
      if (!validProject(value, projectId) || Buffer.byteLength(data) > 8 * 1024 * 1024) throw new GuideError('record_full', '项目记录已达到容量上限，旧记录已保留，本次新内容尚未保存。');
      const temp = join(this.directory, `.${randomUUID()}.tmp`);
      let replaced = false;
      try {
        const file = await open(temp, 'wx', 0o600);
        try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
        await rename(temp, this.projectPath(projectId)); replaced = true;
        const directory = await open(this.directory, 'r'); try { await directory.sync(); } finally { await directory.close(); }
        const saved = await this.loadProject(projectId);
        if (saved.revision !== value.revision) throw new Error('Project revision mismatch');
        return saved;
      } catch {
        throw new GuideError(replaced ? 'record_unknown' : 'record_failed', replaced ? '保存结果尚未确认，请刷新核对。' : '本次记录未能保存，主对话开发不受影响。');
      } finally { await rm(temp, { force: true }).catch(() => {}); }
    });
  }
  update(scope: Scope, mutate: (value: GuideRecord) => void, projectRevision?: number | string) {
    return this.serial(async () => {
      const project = projectRevision === undefined ? undefined : await this.loadProject(scope.projectId);
      if (project && (typeof projectRevision === 'string' ? hash(project.requirementRevisions) : project.revision) !== projectRevision) throw new GuideError('requirement_changed', '发送前历史约定发生了变化，这次没有发送；请刷新后重新提出修改。');
      const before = await this.load(scope), value = structuredClone(before);
      mutate(value);
      if (hash(before) === hash(value)) return before;
      value.revision++;
      const data = JSON.stringify(value);
      if (Buffer.byteLength(data) > 8 * 1024 * 1024 || value.operations.length > 3000 || value.jobs.length > 1000 || value.explanations.length > 200 || value.inputs.length > 500 || value.deliveries.length > 500 || value.requirements.length > 1000) {
        throw new GuideError('record_full', '本会话的记录空间已满，旧记录已保留；新进展暂未保存。');
      }
      const temp = join(this.directory, `.${randomUUID()}.tmp`);
      let replaced = false;
      try {
        const handle = await open(temp, 'wx', 0o600);
        try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
        await rename(temp, this.path(scope)); replaced = true;
        const directory = await open(this.directory, 'r'); try { await directory.sync(); } finally { await directory.close(); }
        const saved = await this.load(scope);
        if (saved.revision !== value.revision) throw new Error('Guide revision mismatch.');
        return saved;
      } catch (e) {
        throw new GuideError(replaced ? 'record_unknown' : 'record_failed', replaced ? '记录保存结果尚未确认，请刷新核对。' : '本次记录未能保存，主对话开发不受影响。');
      } finally { await rm(temp, { force: true }).catch(() => {}); }
    });
  }
  async scopeInventory(): Promise<{ scopes: Scope[]; incomplete: boolean }> {
    const result: Scope[] = [];
    let incomplete = false;
    for (const name of await readdir(this.directory)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      let file;
      try {
        file = await open(join(this.directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
        if ((await file.stat()).size > 8 * 1024 * 1024) { incomplete = true; continue; }
        const data = JSON.parse(await file.readFile('utf8'));
        if (typeof data.scope?.sessionId === 'string' && data.scope.sessionId.length <= 200
          && typeof data.scope?.projectId === 'string' && name === `${hash(data.scope)}.json`) result.push(data.scope);
        else incomplete = true;
      } catch { incomplete = true; /* Individual reads report corrupt records without destroying them. */ }
      finally { await file?.close(); }
    }
    return { scopes: result, incomplete };
  }
  async scopes(): Promise<Scope[]> { return (await this.scopeInventory()).scopes; }
  async sessions(): Promise<string[]> { return [...new Set((await this.scopes()).map(scope => scope.sessionId))]; }
  /** v3 documents share the existing single-writer guard and atomic persistence. */
  readDocument<T>(id: string): Promise<T | undefined> {
    return this.serial(async () => {
      let file;
      try {
        file = await open(join(this.directory, `v3-${hash(id)}.json`), constants.O_RDONLY | constants.O_NOFOLLOW);
        if ((await file.stat()).size > 8 * 1024 * 1024) throw new Error('Document too large');
        return JSON.parse(await file.readFile('utf8')) as T;
      } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; }
      finally { await file?.close(); }
    });
  }
  writeDocument(id: string, value: unknown) {
    return this.serial(async () => {
      const data = JSON.stringify(value);
      if (Buffer.byteLength(data) > 8 * 1024 * 1024) throw new GuideError('record_full', '任务记录空间已满，请先导出并清理历史。');
      const temp = join(this.directory, `.${randomUUID()}.tmp`);
      try {
        const file = await open(temp, 'wx', 0o600);
        try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
        await rename(temp, join(this.directory, `v3-${hash(id)}.json`));
        const directory = await open(this.directory, 'r'); try { await directory.sync(); } finally { await directory.close(); }
      } finally { await rm(temp, { force: true }).catch(() => {}); }
    });
  }
  deleteDocument(id: string) { return this.serial(() => rm(join(this.directory, `v3-${hash(id)}.json`), { force: true })); }
  async close() { this.closed = true; await this.tail; this.guard?.close(); this.guard = undefined; }
}
