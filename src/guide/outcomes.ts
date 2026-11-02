import type { FileBasis, Operation } from './contracts.js';
import type { GuideRecord } from './store.js';
import type { ProjectRecord, TrialCard } from './project-types.js';
import type { OperationRef, Outcome, Requirement } from './work-types.js';
import { hash } from './files.js';

export const opKey = (ref: OperationRef) => `${ref.sessionId}:${ref.id}`;
export function operationRows(sessions: GuideRecord[]) {
  return sessions.flatMap(session => session.operations.map(operation => ({ ref: { sessionId: session.scope.sessionId, id: operation.id }, operation })));
}
export function currentChange(op: Operation, files: FileBasis) {
  return !!(files.complete && op.receiptHash && op.changeOwnership === 'exclusive' && op.outcome === 'succeeded'
    && op.changedFiles.length && op.afterFiles && op.changedFiles.every(file => Object.hasOwn(op.afterFiles!, file) && op.afterFiles![file] === (files.files[file] ?? null)));
}
export function currentCheck(op: Operation, files: FileBasis) {
  return !!(files.complete && op.kind === 'check' && op.receiptHash && op.baseline?.complete
    && op.baseline.digest === files.digest && op.applicability === 'unchanged' && op.endedAt && typeof op.exitCode === 'number');
}
export function evidenceVersion(requirement: Requirement, trial: TrialCard | undefined, sessions: GuideRecord[], files: FileBasis) {
  return hash({ requirement: { id: requirement.id, version: requirement.version }, trial: trial?.id ?? null, files: files.digest,
    operations: operationRows(sessions).map(row => ({ ...row.ref, operation: row.operation })) });
}
export function assessOutcome(requirement: Requirement, project: ProjectRecord, sessions: GuideRecord[], files: FileBasis): Outcome {
  const rows = operationRows(sessions);
  const nativeSeq = 'seq' in requirement.source ? requirement.source.seq : undefined;
  const result: Outcome = { requirement,
    evidenceVersion: evidenceVersion(requirement, undefined, sessions, files), state: 'needs_scope', message: '', missing: [], steps: [],
    candidates: rows.filter(row => row.operation.endedAt && (row.operation.kind === 'check' || row.operation.changedFiles.length)).slice(-40).map(({ ref, operation: op }) => ({
      ref, kind: op.kind === 'check' ? 'check' : 'change', label: op.label ?? (op.kind === 'check' ? '检查命令' : '文件改动'), outcome: op.outcome,
      current: op.kind === 'check' ? currentCheck(op, files) : currentChange(op, files),
      linked: ref.sessionId === requirement.scope.sessionId && nativeSeq !== undefined && !!op.origin?.userSeqs.includes(nativeSeq),
    })) };
  const delivery = sessions.flatMap(row => row.deliveries).find(row => row.id === requirement.deliveryId);
  const confirmed = (project.confirmations ?? []).some(row => row.requirement.id === requirement.id && row.requirement.version === requirement.version);
  const linked = result.candidates.filter(row => row.linked && row.outcome === 'succeeded');
  const working = rows.some(({ ref, operation: op }) => ref.sessionId === requirement.scope.sessionId && !op.endedAt && ['edit', 'other', 'check'].includes(op.kind));
  // A later, attributable failure is not hidden by an earlier successful command.
  // Failures in other sessions of the same project belong to their own requirements.
  const failing = rows.some(({ ref, operation: op }) => ref.sessionId === requirement.scope.sessionId && currentCheck(op, files) && op.outcome === 'failed'
    && !rows.some(row => row.ref.sessionId === ref.sessionId && op.checkKey && row.operation.checkKey === op.checkKey && currentCheck(row.operation, files)
      && row.operation.outcome === 'succeeded' && Date.parse(row.operation.startedAt) > Date.parse(op.endedAt ?? '')));
  if (requirement.deliveryId && delivery?.state !== 'accepted') result.state = 'awaiting_delivery';
  else if (confirmed) result.state = 'complete';
  else if (working) result.state = 'needs_changes';
  else if (failing) result.state = 'check_failed';
  else if (!linked.some(row => row.kind === 'change')) result.state = 'needs_changes';
  else result.state = 'needs_feedback';
  const messages: Record<Outcome['state'], string> = {
    awaiting_delivery: '还没送到主对话', needs_scope: '还在做', needs_changes: '还在做', needs_checks: '还缺检查',
    check_failed: '检查没通过', needs_feedback: '可以试用了', feedback_failed: '你试用时发现的问题还没解决', stale: '要求变了，需要重新做', complete: '已完成',
  };
  result.message = messages[result.state];
  if (failing) result.missing.push('当前版本有检查没通过');
  if (!files.complete) result.missing.push('项目读取范围不完整，改动记录可能不全');
  return result;
}
