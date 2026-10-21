import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export type Source = { sessionId: string; messageId: string; seq: number; quote: string; questionId?: string };
export type Requirement = {
  id: string; text?: string; kind: 'requirement' | 'assumption'; taskId?: string;
  status: 'active' | 'superseded' | 'deleted'; source?: Source;
  sourceHash: string; updatedAt: string; replacedBy?: string; deletedSource?: Source;
};
export type FileStamp = { path: string; sha256: string | null };
export type Task = {
  id: string; title: string;
  status: 'in_progress' | 'paused' | 'cancelled' | 'completed' | 'needs_check';
  progress: string; nextStep: string; updatedAt: string; sessionId: string;
  files: FileStamp[];
};
export type ProjectRecord = {
  schemaVersion: 1; projectId: string; projectRoot: string; revision: number; updatedAt: string;
  requirements: Requirement[]; tasks: Task[];
  operations: { id: string; digest: string; revision: number }[];
};
export type Change =
  | { type: 'start_task'; id: string; title: string }
  | { type: 'requirement'; id: string; text: string; kind: 'requirement' | 'assumption'; taskId?: string; source: Source; replaces?: string }
  | { type: 'forget'; id: string; source: Source }
  | { type: 'task'; id: string; status: Task['status']; progress: string; nextStep: string; files: string[]; source?: Source };
export type WriteRequest = { expectedRevision: number; operationId: string; sessionId: string; changes: Change[] };
export type SaveResult = {
  status: 'saved' | 'unchanged' | 'conflict' | 'busy' | 'failed' | 'unknown';
  revision?: number; operationId: string; message: string;
};

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_ITEMS = 1000;
const hash = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const has = (o: object, key: string) => Object.prototype.hasOwnProperty.call(o, key);
function object(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object.');
}
function keys(value: object, allowed: string[]) {
  if (Object.keys(value).some(k => !allowed.includes(k))) throw new Error('Unsupported field.');
}
function text(value: unknown, max = 2000): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new Error('Invalid or oversized text.');
}
function id(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value)) throw new Error('Invalid record ID.');
}
function integer(value: unknown) { if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error('Invalid revision or event sequence.'); }
function source(value: unknown): asserts value is Source {
  object(value); keys(value, ['sessionId', 'messageId', 'seq', 'quote', 'questionId']); text(value.sessionId, 200); text(value.messageId, 300); integer(value.seq); text(value.quote, 4000);
  if (value.questionId !== undefined) text(value.questionId, 300);
}
const taskStatuses = ['in_progress', 'paused', 'cancelled', 'completed', 'needs_check'];

/** All input is validated again here, independently of the model/tool schema. */
export function validateRequest(value: unknown): asserts value is WriteRequest {
  object(value); keys(value, ['expectedRevision', 'operationId', 'sessionId', 'changes']);
  integer(value.expectedRevision); id(value.operationId); text(value.sessionId, 200);
  if (!Array.isArray(value.changes) || !value.changes.length || value.changes.length > 12) throw new Error('Use 1–12 changes.');
  for (const c of value.changes) {
    object(c); id(c.id);
    switch (c.type) {
      case 'start_task': keys(c, ['type', 'id', 'title']); text(c.title, 300); break;
      case 'requirement':
        keys(c, ['type', 'id', 'text', 'kind', 'taskId', 'source', 'replaces']); text(c.text);
        if (!['requirement', 'assumption'].includes(c.kind as string)) throw new Error('Invalid requirement kind.');
        source(c.source); if (c.taskId !== undefined) id(c.taskId); if (c.replaces !== undefined) id(c.replaces); break;
      case 'forget': keys(c, ['type', 'id', 'source']); source(c.source); break;
      case 'task':
        keys(c, ['type', 'id', 'status', 'progress', 'nextStep', 'files', 'source']);
        if (!taskStatuses.includes(c.status as string)) throw new Error('Invalid task status.');
        text(c.progress); text(c.nextStep);
        if (!Array.isArray(c.files) || c.files.length > 20) throw new Error('Track at most 20 relevant files.');
        for (const f of c.files) text(f, 500);
        if (c.source !== undefined) source(c.source);
        if (['paused', 'cancelled'].includes(c.status as string) && !c.source) throw new Error('Pausing/cancelling needs a user source.');
        break;
      default: throw new Error('Unknown record change.');
    }
    if (has(c, 'source') && (c.source as Source).sessionId !== value.sessionId) throw new Error('Source must belong to this session.');
  }
}

/** Corrupt/unsupported files never silently turn into an empty project. */
function validateRecord(value: unknown, root: string, projectId: string): asserts value is ProjectRecord {
  object(value);
  keys(value, ['schemaVersion', 'projectId', 'projectRoot', 'revision', 'updatedAt', 'requirements', 'tasks', 'operations']);
  if (value.schemaVersion !== 1 || value.projectRoot !== root || value.projectId !== projectId) throw new Error('Project record identity or version mismatch.');
  integer(value.revision); text(value.updatedAt, 100);
  if (!Array.isArray(value.requirements) || !Array.isArray(value.tasks) || !Array.isArray(value.operations)
    || value.requirements.length > MAX_ITEMS || value.tasks.length > MAX_ITEMS || value.operations.length > 64) throw new Error('Invalid project record size.');
  const requirementIds = new Set();
  const taskIds = new Set();
  for (const t of value.tasks) {
    object(t); keys(t, ['id', 'title', 'status', 'progress', 'nextStep', 'updatedAt', 'sessionId', 'files']);
    id(t.id); if (taskIds.has(t.id)) throw new Error('Duplicate task.'); taskIds.add(t.id);
    text(t.title, 300); text(t.progress); text(t.nextStep); text(t.sessionId, 200); text(t.updatedAt, 100);
    if (!taskStatuses.includes(t.status as string) || !Array.isArray(t.files) || t.files.length > 20) throw new Error('Invalid task.');
    for (const f of t.files) {
      object(f); keys(f, ['path', 'sha256']); text(f.path, 500);
      if (f.sha256 !== null && (typeof f.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(f.sha256))) throw new Error('Invalid file fingerprint.');
    }
  }
  for (const r of value.requirements) {
    object(r); keys(r, ['id', 'text', 'kind', 'taskId', 'status', 'source', 'sourceHash', 'updatedAt', 'replacedBy', 'deletedSource']);
    id(r.id); if (requirementIds.has(r.id)) throw new Error('Duplicate requirement.'); requirementIds.add(r.id);
    text(r.updatedAt, 100);
    if (typeof r.sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(r.sourceHash)) throw new Error('Invalid source fingerprint.');
    if (!['active', 'superseded', 'deleted'].includes(r.status as string) || !['requirement', 'assumption'].includes(r.kind as string)) throw new Error('Invalid requirement.');
    if (r.status !== 'deleted') { text(r.text); source(r.source); }
    else if (r.text !== undefined || r.source !== undefined) throw new Error('Deleted record retains content.');
    if (r.taskId !== undefined && !taskIds.has(r.taskId)) throw new Error('Unknown requirement task.');
    if (r.replacedBy !== undefined) id(r.replacedBy);
    if (r.deletedSource !== undefined) source(r.deletedSource);
  }
  for (const r of value.requirements) if (r.replacedBy && !requirementIds.has(r.replacedBy)) throw new Error('Missing replacement.');
  for (const op of value.operations) {
    object(op); keys(op, ['id', 'digest', 'revision']); id(op.id); integer(op.revision);
    if (typeof op.digest !== 'string' || !/^[a-f0-9]{64}$/.test(op.digest)) throw new Error('Invalid operation digest.');
  }
}

export class ProjectStore {
  private constructor(readonly storageRoot: string, readonly projectRoot: string, readonly projectId: string) {}
  static async forProject(storageRoot: string, projectRoot: string) {
    if (!isAbsolute(storageRoot) || !isAbsolute(projectRoot)) throw new Error('Storage and project paths must be absolute.');
    const canonical = await realpath(projectRoot);
    if (!(await lstat(canonical)).isDirectory()) throw new Error('Project root is not a directory.');
    return new ProjectStore(resolve(storageRoot), canonical, hash(canonical));
  }
  get directory() { return join(this.storageRoot, this.projectId); }
  get recordPath() { return join(this.directory, 'project.json'); }
  private empty(): ProjectRecord {
    return { schemaVersion: 1, projectId: this.projectId, projectRoot: this.projectRoot, revision: 0,
      updatedAt: new Date(0).toISOString(), requirements: [], tasks: [], operations: [] };
  }
  private async checkDirectory(create: boolean) {
    if (create) await mkdir(this.storageRoot, { recursive: true, mode: 0o700 });
    for (const p of [this.storageRoot, this.directory]) {
      if (create && p === this.directory) await mkdir(p, { mode: 0o700 }).catch(e => { if (e.code !== 'EEXIST') throw e; });
      try { if (!(await lstat(p)).isDirectory() || (await lstat(p)).isSymbolicLink()) throw new Error('Record directory must not be a symlink.'); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT' && !create) return false; throw e; }
    }
    return true;
  }
  async read(): Promise<ProjectRecord> {
    if (!await this.checkDirectory(false)) return this.empty();
    let handle;
    try {
      handle = await open(this.recordPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      if (!(await handle.stat()).isFile() || (await handle.stat()).size > MAX_BYTES) throw new Error('Invalid record file.');
      const record: unknown = JSON.parse(await handle.readFile('utf8'));
      validateRecord(record, this.projectRoot, this.projectId);
      return record;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return this.empty();
      throw e;
    } finally { await handle?.close(); }
  }
  async stamp(path: string): Promise<FileStamp> {
    if (isAbsolute(path) || path.split(/[\\/]/).some(p => p === '..' || p === '.git' || p === '.env' || p.startsWith('.env.'))) throw new Error('Only relevant project files may be tracked.');
    const absolute = resolve(this.projectRoot, path);
    const within = (p: string) => { const rel = relative(this.projectRoot, p); return rel && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel); };
    if (!within(absolute)) throw new Error('File is outside the project.');
    let canonical;
    try { canonical = await realpath(absolute); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      // Missing files are an observation too, but never follow an escaping parent symlink.
      let parent = dirname(absolute);
      while (true) {
        try { const realParent = await realpath(parent); if (realParent !== this.projectRoot && !within(realParent)) throw new Error('File parent is outside the project.'); break; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; parent = dirname(parent); }
      }
      return { path, sha256: null };
    }
    if (!within(canonical) || relative(this.projectRoot, canonical).split(sep).some(p => p === '.git' || p === '.env' || p.startsWith('.env.'))) throw new Error('File symlink escapes the project or exposes a protected file.');
    const info = await lstat(canonical);
    if (!info.isFile() || info.size > 4 * 1024 * 1024) throw new Error('Track regular files up to 4 MB.');
    return { path, sha256: hash(await readFile(canonical)) };
  }
  async inspect(taskIds?: string[]) {
    const record = await this.read();
    const current = new Map<string, FileStamp | null>();
    const changes: { taskId: string; path: string; status: 'changed' | 'unchanged' | 'unavailable' }[] = [];
    for (const t of record.tasks.filter(t => taskIds === undefined || taskIds.includes(t.id))) for (const f of t.files) {
      if (!current.has(f.path)) {
        try { current.set(f.path, await this.stamp(f.path)); } catch { current.set(f.path, null); }
      }
      const stamp = current.get(f.path);
      changes.push({ taskId: t.id, path: f.path, status: stamp ? stamp.sha256 === f.sha256 ? 'unchanged' : 'changed' : 'unavailable' });
    }
    return { record, files: changes, coverage: 'Only explicitly tracked files; unchanged hashes do not prove current runtime availability.' };
  }
  async write(request: WriteRequest, signal?: AbortSignal): Promise<SaveResult> {
    validateRequest(request);
    const base = { operationId: request.operationId };
    let locked = false;
    let renamed = false;
    const lockPath = join(this.directory, 'write.lock');
    const temporaryPath = join(this.directory, `.project-${randomUUID()}.tmp`);
    try {
      signal?.throwIfAborted();
      await this.checkDirectory(true);
      try {
        const lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
        locked = true;
        try { await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })); await lock.sync(); }
        finally { await lock.close(); }
      } catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') return { ...base, status: 'busy', message: '另一写入正在进行或遗留锁尚待核实；没有覆盖记录。请读取现状，确认写入者状态后再试。' }; throw e; }
      const before = await this.read();
      const digest = hash(JSON.stringify({ sessionId: request.sessionId, changes: request.changes }));
      const previous = before.operations.find(op => op.id === request.operationId);
      if (previous) {
        if (previous.digest !== digest) throw new Error('Operation ID was reused for different content.');
        return { ...base, status: 'unchanged', revision: before.revision, message: '这次操作已经保存；没有重复写入或执行项目操作。' };
      }
      if (before.revision !== request.expectedRevision) return { ...base, status: 'conflict', revision: before.revision, message: '记录已变化；先重新读取并核对差异，没有覆盖较新记录。' };
      const next = structuredClone(before);
      const now = new Date().toISOString();
      for (const c of request.changes) {
        if (c.type === 'start_task') {
          if (next.tasks.some(t => t.id === c.id)) throw new Error('Task ID already exists.');
          next.tasks.push({ id: c.id, title: c.title, status: 'in_progress', progress: '尚未记录执行结果。', nextStep: '核对当前要求和实际项目状态。', files: [], updatedAt: now, sessionId: request.sessionId });
        } else if (c.type === 'requirement') {
          if (next.requirements.some(r => r.id === c.id)) throw new Error('Requirement ID already exists, including deleted IDs.');
          // A deletion blocks re-extraction from that old event/question, even with another quote.
          const sourceHash = hash(JSON.stringify({ messageId: c.source.messageId, questionId: c.source.questionId }));
          if (next.requirements.some(r => r.status === 'deleted' && r.sourceHash === sourceHash)) throw new Error('This source was forgotten; do not recreate it from old history. A new user statement is required.');
          if (c.taskId && !next.tasks.some(t => t.id === c.taskId)) throw new Error('Task does not exist.');
          if (c.replaces) {
            const previous = next.requirements.find(r => r.id === c.replaces);
            if (!previous || previous.status !== 'active') throw new Error('Replacement must reference an active requirement.');
            if (previous.kind === 'requirement' && c.kind === 'assumption') throw new Error('An assumption cannot replace a confirmed user requirement; preserve the requirement and record the assumption separately.');
            previous.status = 'superseded'; previous.replacedBy = c.id; previous.updatedAt = now;
          }
          next.requirements.push({ id: c.id, text: c.text, kind: c.kind, sourceHash, ...(c.taskId ? { taskId: c.taskId } : {}), source: c.source, status: 'active', updatedAt: now });
        } else if (c.type === 'forget') {
          const previous = next.requirements.find(r => r.id === c.id);
          if (!previous || previous.status === 'deleted') throw new Error('Requirement is absent or already forgotten.');
          // Forget this version and its superseded predecessors. Otherwise an older
          // summary could reintroduce the same rule using a different source event.
          const forgotten = new Set([previous.id]);
          for (let added = true; added;) {
            added = false;
            for (const r of next.requirements) if (r.replacedBy && forgotten.has(r.replacedBy) && !forgotten.has(r.id)) {
              forgotten.add(r.id); added = true;
            }
          }
          for (const r of next.requirements) if (forgotten.has(r.id)) {
            // Keep IDs/fingerprints, not original content. Host history is separate.
            delete r.text; delete r.source;
            r.status = 'deleted'; r.deletedSource = c.source; r.updatedAt = now;
          }
        } else {
          const task = next.tasks.find(t => t.id === c.id);
          if (!task) throw new Error('Task does not exist.');
          if (['paused', 'cancelled'].includes(task.status) && c.status !== task.status && !c.source) throw new Error('Leaving a paused/cancelled state needs a user source.');
          task.status = c.status; task.progress = c.progress; task.nextStep = c.nextStep;
          task.files = await Promise.all(c.files.map(f => this.stamp(f)));
          task.updatedAt = now; task.sessionId = request.sessionId;
        }
      }
      next.revision++; next.updatedAt = now;
      next.operations = [...next.operations, { id: request.operationId, digest, revision: next.revision }].slice(-64);
      validateRecord(next, this.projectRoot, this.projectId);
      const bytes = JSON.stringify(next, null, 2) + '\n';
      if (Buffer.byteLength(bytes) > MAX_BYTES) throw new Error('Project record is full; no data was dropped.');
      signal?.throwIfAborted();
      const temp = await open(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try { await temp.writeFile(bytes); await temp.sync(); } finally { await temp.close(); }
      signal?.throwIfAborted();
      await rename(temporaryPath, this.recordPath); renamed = true;
      const dir = await open(this.directory, constants.O_RDONLY);
      try { await dir.sync(); } finally { await dir.close(); }
      const confirmed = await this.read();
      if (confirmed.revision !== next.revision || confirmed.operations.at(-1)?.id !== request.operationId) throw new Error('Could not confirm the saved record.');
      return { ...base, status: 'saved', revision: next.revision, message: '项目记录已持久保存并读回核对；这不代表功能已完成或代码可以撤销。' };
    } catch (e) {
      return { ...base, status: renamed ? 'unknown' : 'failed', message: `${renamed ? '保存结果尚不能确认，先读取记录核对，不要重复执行项目操作。' : '记录未保存；原有记录和项目文件没有被本工具改写。'} ${e instanceof Error ? e.message : 'Storage error'}` };
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => {});
      if (locked) await rm(lockPath, { force: true }).catch(() => {});
    }
  }
}
