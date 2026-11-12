import { hash } from './domain.js';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { pendingChoices } from '../guide/host/choices.js';
import { redact } from '../guide/privacy.js';
import type { HarnessAdapter } from '../guide/host/adapter.js';
import type { GuideSnapshot } from '../guide/contracts.js';
import type { HostPort } from './service.js';
import type { Evidence, Frame, Task } from './types.js';
const contentText = (content: unknown) => Array.isArray(content) ? content.filter(p => p?.type === 'text' && typeof p.text === 'string').map(p => p.text).join('\n') : '';
export class V3Host implements HostPort {
    constructor(private adapter: HarnessAdapter) { }
    async observe(sessionId: string): Promise<Frame> {
        const ctx = this.adapter.ctx;
        const cut = await ctx.sessionQuery.observeSession(sessionId, { projectionMode: 'all' });
        try {
            const events: any[] = cut.events;
            const values = cut.projections?.values ?? {};
            const cwd = values.workingDirectory ?? cut.header?.cwd;
            let root: string | undefined;
            if (typeof cwd === 'string' && isAbsolute(cwd)) {
                try {
                    root = await realpath(cwd);
                }
                catch { /* directory unavailable */ }
            }
            const projectId = root ? createHash('sha256').update(root).digest('hex') : undefined;
            const segmentStart = Math.max(cut.inheritedEventCount ?? 0, ...events.filter(e => e.type === 'working-directory/change').map(e => e.seq));
            const evidence: Evidence[] = [];
            let clipped = false;
            for (const event of events.filter(e => e.seq >= segmentStart).slice(-160)) {
                if (event.surfaceOp !== 'append')
                    continue;
                const message = event.type === 'user/message' ? event.data : event.data?.message;
                if (!message || !['user', 'assistant', 'tool'].includes(message.role))
                    continue;
                if (message.role === 'user' && message.source?.kind !== 'user')
                    continue;
                const t = redact(contentText(message.content));
                if (!t.trim())
                    continue;
                if (t.length > 4000)
                    clipped = true;
                evidence.push({ id: `event:${event.seq}`, seq: event.seq, kind: message.role, text: t.slice(0, 4000) });
            }
            const enabled = (values.agentPreset ?? cut.header?.agentPreset) === 'vibeguide';
            let operations: Frame['operations'] = [], partial = true;
            if (projectId && root && enabled && this.adapter.tracker) {
                const tracked = await this.adapter.tracker.snapshot({ scope: { sessionId, projectId }, root, events: events.filter(e => e.seq >= segmentStart), throughSeq: cut.cursor, segmentStart, liveStatus: ctx.agents?.get(sessionId)?.status, waiting: false, fresh: false });
                const record = await this.adapter.tracker.store.read({ sessionId, projectId });
                operations = record.operations.filter(o => (o.callSeq ?? o.origin?.callSeq ?? -1) >= segmentStart).map(o => ({ id: o.id, key: o.checkKey ?? '', label: o.label ?? o.tool, kind: o.kind, outcome: o.outcome, endedAt: o.endedAt, diagnostic: o.diagnostic, seq: o.callSeq ?? o.origin?.callSeq ?? -1, changedFiles: o.changedFiles, applicable: o.kind === 'check' && tracked.progress.latestCheck?.id === o.id ? tracked.progress.latestCheck.applicability : 'unknown' }));
                partial = record.partial || tracked.progress.tracking === 'partial';
            }
            for (const event of events.filter(e => e.seq >= segmentStart && e.type === 'turn/end' && e.data?.reason?.kind === 'error')) {
                const failure = event.data.reason.error ?? {};
                operations.push({ id: `host-turn-${event.seq}`, key: hash({ kind: 'model', code: failure.code ?? 'unknown', message: String(failure.message ?? '').slice(0, 300) }), label: '主 Agent 生成回复', kind: 'model', outcome: 'failed', endedAt: Number.isFinite(event.time) ? new Date(event.time).toISOString() : undefined, diagnostic: redact(String(failure.message ?? '宿主报告回复失败')).slice(0, 2000), seq: event.seq, changedFiles: [] });
            }
            operations.sort((a, b) => a.seq - b.seq);
            // Evidence sequence and actual host activity are used independently of model output.
            return { sessionId, projectId, projectName: root ? basename(root) : '尚未关联项目', enabled, seq: cut.cursor, segmentStart, busy: ctx.agents?.get(sessionId)?.status === 'running', waiting: pendingChoices(sessionId, events, cut.projections).length > 0, modelReady: !!await this.adapter.modelRoute(values.modelSelection?.next ?? values.modelSelection?.lastUsed, events), evidence: evidence.slice(-40), operations, partial: partial || clipped || evidence.length > 40 };
        }
        finally {
            cut[Symbol.dispose]();
        }
    }
    async purge(task: Task, endSeq: number) {
        if (!task.projectId || !this.adapter.tracker)
            return;
        await this.adapter.tracker.store.update({ sessionId: task.sessionId, projectId: task.projectId }, record => {
            const inside = (seq: number | undefined) => seq !== undefined && seq > task.startSeq && seq <= endSeq;
            record.operations = record.operations.filter(o => !inside(o.callSeq ?? o.origin?.callSeq));
            record.requirements = record.requirements.filter(r => !inside('seq' in r.source ? r.source.seq : undefined));
            record.jobs = record.jobs.filter(j => !inside(j.seq));
        });
    }
    async generate(frame: Frame, source: unknown, system: string, signal: AbortSignal) {
        const cut = await this.adapter.ctx.sessionQuery.observeSession(frame.sessionId, { projectionMode: 'all' });
        let route;
        try {
            const v = cut.projections?.values;
            route = await this.adapter.modelRoute(v?.modelSelection?.next ?? v?.modelSelection?.lastUsed, cut.events);
        }
        finally {
            cut[Symbol.dispose]();
        }
        const snapshot: GuideSnapshot = { scope: { sessionId: frame.sessionId, projectId: frame.projectId ?? `draft:${frame.sessionId}` }, projectName: frame.projectName, enabled: frame.enabled, throughSeq: frame.seq, basis: 'v3', observations: [], choices: [], model: route ? { status: 'ready', route } : { status: 'not_configured' }, limitations: [] };
        // Per-field caps and an overall cap preserve valid JSON instead of slicing its encoding.
        const encoded = JSON.stringify(source);
        if (encoded.length > 54000)
            throw new Error('本次相关资料较多，请缩小选区或问题范围后重试。');
        return this.adapter.generate(snapshot, source, system, signal, 5000);
    }
}
