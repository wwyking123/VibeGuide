import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { GuideService } from './service.js';
import { HarnessAdapter } from './host/adapter.js';
import { GuideError } from './contracts.js';
import { desktopCompatibility } from './host/compatibility.js';
import { GuideStore } from './store.js';
import { ProgressTracker } from './progress.js';

export const name = 'vibeguide-guide';
export const inject = ['sessionQuery', 'sessionController', 'llm', 'agentDefaultModel', 'typertGateway', 'agents', 'tools'];
type Config = { runtimeAnchor?: string; storageRoot?: string };

/**
 * Where records live when nothing says otherwise: the folder the one-line installer has always used,
 * so installing through the plugin manager keeps the records of an earlier install.
 */
export const defaultStorageRoot = (env: NodeJS.ProcessEnv = process.env, home = homedir()) =>
  join(env.DSH_HOME?.trim() ? env.DSH_HOME.trim() : join(home, '.dsh'), 'vibeguide-p0-state');

/**
 * Host-side service. Both settings are optional. Installed as a Harness bundle, the Harness itself
 * resolves its packages for code under the profile, so this file is anchor enough. The one-line
 * installer puts the plugin outside the profile, where that does not apply, and passes an anchor.
 */
export async function apply(ctx: any, config: Config = {}) {
  config ??= {};
  if (config.runtimeAnchor !== undefined && !isAbsolute(config.runtimeAnchor)) throw new Error('VibeGuide: runtimeAnchor must be an absolute path.');
  const storageRoot = config.storageRoot ?? defaultStorageRoot();
  if (!isAbsolute(storageRoot)) throw new Error('VibeGuide requires an absolute private storage root.');
  const require = createRequire(config.runtimeAnchor ?? fileURLToPath(import.meta.url));
  const hostPackage = JSON.parse(await readFile(require.resolve('@deepseek-ai/dsh/package.json'), 'utf8'));
  const untestedHost = desktopCompatibility(hostPackage.version) === 'untested' ? String(hostPackage.version) : undefined;
  const load = (name: string) => import(pathToFileURL(require.resolve(name)).href);
  const [{ TypertRemoteService, Remote, RemoteError }, llm] = await Promise.all([
    load('@deepseek-ai/dsh-typert-protocol'), load('@deepseek-ai/dsh-llm'),
  ]);
  let storageError: unknown;
  let tracker: ProgressTracker | undefined;
  try { tracker = new ProgressTracker(await GuideStore.open(storageRoot)); }
  catch (e) { storageError = e; }
  const adapter = new HarnessAdapter(ctx, llm, tracker, untestedHost);
  const service = new GuideService(adapter);
  await service.communication?.recover();
  let stopped = false;
  const queued = new Set<string>();
  const sidework = new Set<Promise<unknown>>();
  const starts = new Map<unknown, Awaited<ReturnType<ProgressTracker['begin']>>>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let worker: Promise<void> | undefined;
  const track = <T>(work: Promise<T>) => { sidework.add(work); void work.finally(() => sidework.delete(work)).catch(() => {}); return work; };
  const wake = (sessionId: string) => {
    if (stopped || !tracker) return;
    queued.add(sessionId);
    if (!timer && !worker) timer = setTimeout(() => {
      timer = undefined;
      worker = (async () => {
        while (queued.size && !stopped) {
          const id = queued.values().next().value!; queued.delete(id);
          try { await adapter.snapshot(id, undefined, true); } catch (e) { tracker!.noteError(id, e); }
        }
      })().finally(() => { worker = undefined; if (queued.size && !stopped) wake(queued.values().next().value!); });
    }, 50);
  };
  if (tracker) {
    ctx.on('session/event', (session: any) => {
      if (session.header?.agentPreset === 'vibeguide') wake(session.id);
      service.communication?.wakeSession(session.id);
    }, { global: true });
    ctx.on('tools/execute', async (exec: any, next: () => Promise<any>) => {
      if (stopped || !exec.agent || exec.name === 'run_code') return next();
      let project: Awaited<ReturnType<HarnessAdapter['projectFor']>> | undefined;
      try {
        const start = await track((async () => {
          project = await adapter.projectFor(exec.agent.session.id);
          if (!project.enabled || stopped) return;
          return tracker!.begin(project.scope, project.root, exec, await adapter.executionOrigin(exec.agent.session.id, exec.callId, exec.rootCallId));
        })());
        if (start) starts.set(exec.token ?? exec, start);
      } catch (e) {
        tracker!.noteError(exec.agent.session.id, e);
        if (project) tracker!.abandon(project.scope, exec.callId);
      }
      // Recording failures must never cancel or replace the actual tool execution.
      return next();
    }, { global: true });
    ctx.on('tools/result', (exec: any, result: any) => {
      const key = exec.token ?? exec, start = starts.get(key); starts.delete(key);
      if (!start || stopped) return;
      void track(tracker!.finish(start, result).catch(e => tracker!.noteError(start.scope.sessionId, e))
        .finally(() => wake(start.scope.sessionId)));
    }, { global: true });
    // Pending event jobs are processed before reading the durable host tail.
    for (const id of await tracker.store.sessions()) wake(id);
  }
  const initializers: Array<(this: any) => void> = [];
  class GuideGateway extends TypertRemoteService {
    constructor(context: any) {
      super(context, 'vibeGuide');
      for (const initialize of initializers) initialize.call(this);
    }
    private owner() {
      // Source-mode reflection still uses the authenticated host Gateway.
      if (this.ctx.invocation?.peer?.principal?.kind !== 'owner') {
        throw new RemoteError('vibeguide/access-denied', 'Only the authenticated desktop owner may use this local plugin.', {});
      }
      if (storageError) throw failure(storageError);
    }
    async getSnapshot(request: unknown, signal: AbortSignal) {
      this.owner(); signal.throwIfAborted();
      try { return await service.getSnapshot(request, signal); }
      catch (e) { throw failure(e); }
    }
    async ask(request: unknown, signal: AbortSignal) {
      this.owner();
      try { return await service.ask(request, signal); }
      catch (e) { throw failure(e); }
    }
    async submit(request: unknown, signal: AbortSignal) {
      this.owner();
      try { return await service.submit(request, signal); }
      catch (e) { throw failure(e); }
    }
    async supportView(request: unknown, signal: AbortSignal) {
      this.owner(); try { if (!service.project) throw new GuideError('unavailable', '记录服务尚未就绪。'); return await service.project.supportView(request, signal); } catch (e) { throw failure(e); }
    }
    async saveSupport(request: unknown, signal: AbortSignal) {
      this.owner(); try { if (!service.project) throw new GuideError('unavailable', '记录服务尚未就绪。'); return await service.project.saveSupport(request, signal); } catch (e) { throw failure(e); }
    }
    async projectView(request: unknown, signal: AbortSignal) {
      this.owner();
      try {
        if (!service.project) throw new GuideError('unavailable', '项目记录服务尚未就绪。');
        return await service.project.view(request, signal);
      } catch (e) { throw failure(e); }
    }
    async overview(request: unknown, signal: AbortSignal) {
      this.owner();
      try {
        if (!service.project) throw new GuideError('unavailable', '项目记录服务尚未就绪。');
        return await service.project.overview(request, signal);
      } catch (e) { throw failure(e); }
    }
    async history(request: unknown, signal: AbortSignal) {
      this.owner();
      try {
        if (!service.project) throw new GuideError('unavailable', '项目记录服务尚未就绪。');
        return await service.project.history(request, signal);
      } catch (e) { throw failure(e); }
    }
    async annotate(request: unknown, signal: AbortSignal) {
      this.owner();
      try {
        if (!service.project) throw new GuideError('unavailable', '项目记录服务尚未就绪。');
        return await service.project.annotate(request, signal);
      } catch (e) { throw failure(e); }
    }
    async handoff(request: unknown, signal: AbortSignal) {
      this.owner();
      try { return await service.handoff(request, signal); }
      catch (e) { throw failure(e); }
    }
    async reviseRequirement(request: unknown, signal: AbortSignal) {
      this.owner();
      try {
        if (!service.project) throw new GuideError('unavailable', '项目记录服务尚未就绪。');
        return await service.project.work.revise(request, signal);
      } catch (e) { throw failure(e); }
    }
    async confirmRequirement(request: unknown, signal: AbortSignal) {
      this.owner();
      try {
        if (!service.project) throw new GuideError('unavailable', '项目记录服务尚未就绪。');
        return await service.project.work.confirm(request, signal);
      } catch (e) { throw failure(e); }
    }
    async analyze(request: unknown, signal: AbortSignal) {
      this.owner();
      try {
        if (!service.project) throw new GuideError('unavailable', '项目记录服务尚未就绪。');
        return await service.project.analyze(request, signal);
      } catch (e) { throw failure(e); }
    }
  }
  function failure(error: unknown) {
    return new RemoteError(`vibeguide/${error instanceof GuideError ? error.code : 'unavailable'}`,
      error instanceof GuideError ? error.message : '暂时无法读取或解释当前状态，主对话开发不受影响。', {});
  }
  for (const method of ['supportView', 'saveSupport', 'getSnapshot', 'ask', 'submit', 'projectView', 'overview', 'history', 'annotate', 'handoff', 'reviseRequirement', 'confirmRequirement', 'analyze'] as const) {
    Remote({ resources: { session: ({ request }: any) => request?.sessionId } })(GuideGateway.prototype[method], {
      kind: 'method', name: method, static: false, private: false,
      addInitializer: (fn: (this: any) => void) => initializers.push(fn),
    });
  }
  new GuideGateway(ctx);
  ctx.effect(() => async () => {
    stopped = true; if (timer) clearTimeout(timer); queued.clear(); service.dispose();
    await service.communication?.close();
    await service.project?.close();
    await worker; await Promise.allSettled([...sidework]); starts.clear();
    await tracker?.close();
  });
}
