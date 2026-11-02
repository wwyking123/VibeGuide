import type { FileBasis, Operation } from './contracts.js';
import type { GuideRecord } from './store.js';
import type { ProjectRecord, TrialCard } from './project-types.js';
import type { OperationRef, Outcome, OutcomeBinding, Requirement } from './work-types.js';
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
  const trial = project.trials.filter(card => card.requirementRef?.id === requirement.id).at(-1);
  const binding = project.bindings.filter(row => row.requirement.id === requirement.id && row.trialId === trial?.id).at(-1);
  const rows = operationRows(sessions), byId = new Map(rows.map(row => [opKey(row.ref), row.operation]));
  const nativeSeq = 'seq' in requirement.source ? requirement.source.seq : undefined;
  const result: Outcome = { requirement, trialId: trial?.id, bindingVersion: binding?.version,
    evidenceVersion: evidenceVersion(requirement, trial, sessions, files), state: 'needs_scope', message: '', missing: [], steps: [],
    candidates: rows.filter(row => row.operation.endedAt && (row.operation.kind === 'check' || row.operation.changedFiles.length)).slice(-40).map(({ ref, operation: op }) => ({
      ref, kind: op.kind === 'check' ? 'check' : 'change', label: op.label ?? (op.kind === 'check' ? '检查命令' : '文件改动'), outcome: op.outcome,
      current: op.kind === 'check' ? currentCheck(op, files) : currentChange(op, files),
      linked: ref.sessionId === requirement.scope.sessionId && nativeSeq !== undefined && !!op.origin?.userSeqs.includes(nativeSeq),
    })) };
  const delivery = sessions.flatMap(row => row.deliveries).find(row => row.id === requirement.deliveryId);
  if (requirement.deliveryId && delivery?.state !== 'accepted') result.state = 'awaiting_delivery';
  else if (!trial || !binding) result.state = 'needs_scope';
  else if (requirement.state !== 'active' || trial.requirementRef?.version !== requirement.version || binding.requirement.version !== requirement.version || trial.basis.digest !== files.digest || binding.basis.digest !== files.digest) result.state = 'stale';
  else {
    result.steps = trial.steps.map(step => {
      const coverage = binding.coverage.find(row => row.stepId === step.id);
      const changes = coverage?.changes.map(ref => byId.get(opKey(ref))).filter((op): op is Operation => !!op) ?? [];
      const checks = coverage?.checks.map(ref => byId.get(opKey(ref))).filter((op): op is Operation => !!op) ?? [];
      const lastChange = Math.max(0, ...changes.map(op => Date.parse(op.endedAt ?? '')));
      const changesValid = !!coverage?.changes.length && changes.length === coverage.changes.length && changes.every(op => currentChange(op, files));
      const validChecks = checks.filter(op => currentCheck(op, files) && Date.parse(op.startedAt) >= lastChange);
      const latestFeedback = project.feedback.filter(row => row.cardId === trial.id && row.stepId === step.id).at(-1);
      return { id: step.id, action: step.action, expected: step.expected, changes: changesValid,
        checks: validChecks.some(op => op.outcome === 'failed' || op.exitCode !== 0) ? 'failed' as const
          : coverage?.checks.length && validChecks.length === coverage.checks.length && validChecks.every(op => op.outcome === 'succeeded' && op.exitCode === 0) ? 'passed' as const : 'missing' as const,
        feedback: latestFeedback?.result ?? 'missing' as const };
    });
    // A later, attributable failure is not hidden by selecting an earlier successful command.
    const relevantFailure = rows.some(({ ref, operation: op }) => currentCheck(op, files) && op.outcome === 'failed'
      && !rows.some(row => row.ref.sessionId === ref.sessionId && op.checkKey && row.operation.checkKey === op.checkKey && currentCheck(row.operation, files)
        && row.operation.outcome === 'succeeded' && Date.parse(row.operation.startedAt) > Date.parse(op.endedAt ?? '')));
    if (relevantFailure) result.missing.push('当前版本仍有失败检查；尚未证明与这条要求无关，不能确认完成');
    result.state = rows.some(({ operation: op }) => !op.endedAt && ['edit', 'other', 'check'].includes(op.kind)) ? 'needs_checks' : result.steps.some(step => step.feedback === 'fail') ? 'feedback_failed'
      : relevantFailure || result.steps.some(step => step.checks === 'failed') ? 'check_failed'
      : !result.steps.length || result.steps.some(step => !step.changes) ? 'needs_changes'
      : result.steps.some(step => step.checks !== 'passed') ? 'needs_checks'
      : result.steps.some(step => step.feedback !== 'pass') ? 'needs_feedback' : 'complete';
  }
  const messages: Record<Outcome['state'], string> = {
    awaiting_delivery: '要求尚未确认送达主对话', needs_scope: '对应范围待核对', needs_changes: '还缺当前版本对应的实际改动', needs_checks: '检查仍待补齐或重新运行',
    check_failed: '对应检查尚未通过', needs_feedback: '检查已通过，等待你试用确认', feedback_failed: '你反馈的体验问题仍待解决', stale: '要求或文件已经变化，需要重新核对', complete: '本次要求在你确认的范围内已完成',
  };
  result.message = messages[result.state];
  if (!trial) result.missing.push('还没有为这条要求准备试用步骤');
  if (!binding) result.missing.push('还没有确认试用步骤、实际改动和检查之间的对应范围');
  if (!files.complete) result.missing.push('项目读取范围不完整，不能确认检查仍适用');
  for (const step of result.steps) {
    if (!step.changes) result.missing.push(`${step.action}：实际改动待核对`);
    if (step.checks !== 'passed') result.missing.push(`${step.action}：${step.checks === 'failed' ? '检查失败' : '缺少适用检查'}`);
    if (step.feedback !== 'pass') result.missing.push(`${step.action}：${step.feedback === 'fail' ? '你反馈不符合预期' : '尚未收到试用反馈'}`);
  }
  return result;
}
