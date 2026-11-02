import type { GuideRecord } from './store.js';
import type { FileBasis, Scope } from './contracts.js';
import type { ProjectRecord } from './project-types.js';
import { hash } from './files.js';
import { redact } from './privacy.js';
export type TroubleView = {
  version: string; incomplete: boolean;
  attempts: { id: string; label: string; result: string; at: string; changed: number; diagnostic?: string }[];
  failures: { id: string; label: string; count: number; current: boolean; exitCode?: number }[];
  feedback: { id: string; action: string; note?: string; historical: boolean }[];
};
/** Repetition means the same native check failed repeatedly, not that the model diagnosed the same bug. */
export function troubleView(scope: Scope, sessions: GuideRecord[], project: ProjectRecord, files: FileBasis, incomplete = false): TroubleView {
  const ops = sessions.filter(row => row.scope.sessionId === scope.sessionId && row.scope.projectId === scope.projectId).flatMap(row => row.operations).filter(op => op.endedAt).sort((a, b) => a.startedAt.localeCompare(b.startedAt) || (a.callSeq ?? 0) - (b.callSeq ?? 0));
  const groups = new Map<string, typeof ops>();
  for (const op of ops) if (op.kind === 'check' && op.checkKey) groups.set(op.checkKey, [...(groups.get(op.checkKey) ?? []), op]);
  const failures: TroubleView['failures'] = [];
  for (const checks of groups.values()) {
    const latest = checks.at(-1)!;
    if (latest.outcome !== 'failed') continue;
    let count = 0;
    for (let i = checks.length - 1; i >= 0 && checks[i].outcome === 'failed'; i--) count++;
    failures.push({ id: latest.id, label: redact(latest.label ?? '自动检查').slice(0, 180), count, exitCode: latest.exitCode,
      current: !!files.complete && !!latest.baseline?.complete && latest.afterDigest === files.digest && latest.applicability === 'unchanged' });
  }
  const attempts = ops.filter(op => op.kind === 'check' || op.changedFiles.length || op.outcome === 'failed').slice(-12).map(op => ({ id: op.id, label: redact(op.label ?? (op.kind === 'check' ? '自动检查' : op.changedFiles.length ? '修改项目内容' : '工具操作')).slice(0, 180),
    result: op.outcome, at: op.endedAt!, changed: op.changedFiles.length, diagnostic: op.diagnostic }));
  const feedback: TroubleView['feedback'] = [];
  for (const card of project.trials.filter(row => row.scope.sessionId === scope.sessionId)) for (const step of card.steps) {
    const latest = project.feedback.filter(row => row.cardId === card.id && row.stepId === step.id).at(-1);
    if (latest?.result === 'fail') feedback.push({ id: latest.id, action: step.action, note: latest.note, historical: card.basis.digest !== files.digest });
  }
  const result = { incomplete, attempts, failures: failures.slice(-8), feedback: feedback.slice(-8) };
  return { ...result, version: hash(result) };
}
