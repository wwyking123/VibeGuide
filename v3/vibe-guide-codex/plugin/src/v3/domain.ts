import { createHash } from 'node:crypto';
import type { Brief, Frame, Issue, OperationFact, Task } from './types.js';
export const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const frameBasis = (frame: Frame, task: Task) => hash({ revision: task.revision, brief: task.brief, evidence: frame.evidence, ops: frame.operations, partial: frame.partial });
export const emptyBrief = (): Brief => ({ audience: '', goal: '', flow: '', scope: '', acceptance: '', constraints: '', openQuestions: '' });
export function ready(brief: Brief, contradictions: string[]) { return ['audience', 'goal', 'flow', 'scope', 'acceptance'].every(k => brief[k as keyof Brief].trim()) && !contradictions.length; }
export function transfer(brief: Brief) {
    const labels: Record<keyof Brief, string> = { audience: '给谁使用', goal: '要解决的问题', flow: '核心使用流程', scope: '首版范围', acceptance: '怎样算做成', constraints: '约束与首版不做什么', openQuestions: '尚待确认（不得当作已决定）' };
    return '请按照以下任务说明开展工作；遇到影响核心流程的未定事项，请先说明取舍再实施。\n\n' + (Object.keys(labels) as (keyof Brief)[]).map(k => `${labels[k]}：\n${brief[k].trim() || '尚未明确，请不要自行当作用户决定。'}`).join('\n\n');
}
const normalized = (s: string) => s.replace(/\b\d{4}-\d\d-\d\d[^\s]*/g, '<time>').replace(/\b[0-9a-f]{16,}\b/gi, '<id>').slice(0, 300);
export const operationKey = (op: OperationFact) => op.key || hash({ kind: op.kind, label: normalized(op.label) });
/** Group only the same operation target. An unrelated pass never resolves a failure. */
export function reconcileIssues(previous: Issue[], frame: Frame, now: number): Issue[] {
    const result = structuredClone(previous);
    const groups = new Map<string, OperationFact[]>();
    for (const op of frame.operations) {
        const k = operationKey(op);
        groups.set(k, [...(groups.get(k) ?? []), op]);
    }
    for (const [key, ops] of groups) {
        const last = ops.at(-1)!;
        const failures = ops.filter(op => op.outcome === 'failed');
        if (!failures.length)
            continue;
        let item = result.find(i => i.fingerprint === key && i.category === 'tool');
        const basis = hash(ops);
        if (last.outcome === 'succeeded') {
            if (item) {
                item.state = 'resolved';
                item.stale = true;
                item.basis = basis;
            }
            continue;
        }
        if (last.outcome !== 'failed') {
            if (item)
                item.stale = true;
            continue;
        }
        const failedAt = Date.parse(last.endedAt ?? '') || now;
        const initial = Date.parse(failures[0].endedAt ?? '') || now;
        if (now - failedAt < 10000 || (frame.busy && now - failedAt < 120000)) {
            if (item && item.basis !== basis)
                item.stale = true;
            continue;
        }
        if (!item) {
            item = { id: `issue-${hash({ key, start: failures[0].id }).slice(0, 24)}`, fingerprint: key, category: 'tool', state: 'open', count: 0, firstSeenAt: initial, lastSeenAt: failedAt, evidenceRefs: [], summary: '', impact: '', nextStep: '', transfer: '', basis: '', stale: false };
            result.push(item);
        }
        if (item.state === 'dismissed' && item.basis === basis)
            continue;
        const changed = item.basis !== basis;
        item.count = failures.length;
        item.lastSeenAt = failedAt;
        item.evidenceRefs = failures.slice(-4).map(op => `op:${op.id}`);
        if (changed) {
            item.state = 'open';
            item.summary = `“${last.label || last.kind}”${failures.length > 1 ? `已出现 ${failures.length} 次失败记录` : '没有成功完成'}。`;
            item.impact = '这一步的结果还不能确认，尚不能据此判断功能已可用。';
            item.nextStep = '请主 Agent 核对这一步的实际失败原因，做最小修改，再重复同一检查。';
            item.transfer = `请先核对当前任务中“${last.label || last.kind}”最近一次失败的原因，保留现有数据和已确认需求，采用最小改动解决后重新检查。若证据不足，请先补充检查，不要猜测根因或重置项目。`;
            item.basis = basis;
            item.stale = false;
        }
    }
    return result.slice(-40);
}
export function deliveryCandidate(frame: Frame) {
    if (frame.busy || frame.waiting || frame.operations.some(op => op.outcome === 'pending'))
        return false;
    const last = frame.evidence.at(-1);
    return last?.kind === 'assistant' && /(?:已完成|已经完成|已实现|已交付|可以试用|本阶段完成|实现完成)/.test(last.text) && !/(?:尚未完成|还没完成|未完成|没有完成)/.test(last.text);
}
