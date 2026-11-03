/** VibeGuide-owned wire types. No host classes, secrets or filesystem paths. */
import type { Background, OriginalRequirement, RequirementRef, SourceChange } from './work-types.js';
export type Scope = { projectId: string; sessionId: string };
export type Source = { sessionId: string; seq: number; eventId?: string };
export type Choice = {
  id: string; version: string; question: string;
  options: Array<{ id: string; label: string; description?: string }>;
  source: Source; state: 'pending' | 'answered' | 'replaced';
};
export type Observation = {
  id: string; kind: 'user' | 'assistant' | 'tool';
  text: string; source: Source;
};
export type ModelRoute = { provider: string; model: string };
export type Activity = 'reading' | 'editing' | 'checking' | 'working' | 'waiting' | 'idle' | 'unknown';
export type FileBasis = {
  digest: string; files: Record<string, string>; complete: boolean; capturedAt: string;
};
export type Operation = {
  id: string; kind: 'read' | 'edit' | 'check' | 'wait' | 'other'; tool: string;
  startedAt: string; endedAt?: string; callSeq?: number; resultSeq?: number;
  outcome: 'pending' | 'succeeded' | 'failed' | 'unknown';
  diagnostic?: string; receiptHash?: string; exitCode?: number; changedFiles: string[];
  baseline?: FileBasis; afterDigest?: string; applicability: 'unchanged' | 'changed' | 'unknown';
  beforeDigest?: string; checkKey?: string; label?: string; sourceChanges?: SourceChange[];
  afterFiles?: Record<string, string | null>;
  origin?: { turn: number; startSeq: number; userSeqs: number[]; callSeq: number };
  changeOwnership?: 'exclusive' | 'unknown';
};
export type Progress = {
  activity: Activity; revision: number; throughSeq: number; tracking: 'complete' | 'partial';
  changedFiles: number; edits: number; latestCheck?: Pick<Operation, 'id' | 'startedAt' | 'endedAt' | 'outcome' | 'exitCode' | 'applicability'>;
  checks: number; notice?: string;
};
export type GuideSnapshot = {
  scope: Scope;
  projectName: string;
  turn?: number;
  preferenceVersion?: string;
  enabled: boolean;
  throughSeq: number;
  basis: string;
  observations: Observation[];
  choices: Choice[];
  model: { status: 'ready'; route: ModelRoute } | { status: 'not_configured' };
  /** Harness version newer than the verified ones; the sidebar still loads. */
  untestedHost?: string;
  limitations: string[];
  progress?: Progress;
  explanations?: Explanation[];
  inputs?: GuideInput[];
  deliveries?: Delivery[];
  excludedExplanationIds?: string[];
  context?: { label: string; text: string };
};
export type ContextRef = { kind: 'node' | 'explanation' | 'analysis'; id: string; version: string };
export type AskRequest = {
  sessionId: string; clientRequestId: string; question: string;
  basis: string; choiceId?: string; choiceVersion?: string; context?: ContextRef;
};
export type Explanation = {
  preferenceVersion?: string; sourceKind?: "glossary";
  id: string; scope: Scope; question: string; text: string;
  basis: string; state: 'current' | 'historical';
  model: ModelRoute; createdAt: string; cached: boolean;
  choiceId?: string; choiceVersion?: string; promptVersion?: string;
  context?: ContextRef; contextLabel?: string; contextDigest?: string;
  analysisId?: string; workBasis?: string;
  /** One concrete change the owner may send with one click; never sent without that click. */
  suggestion?: string;
};

export type InputRequest = {
  sessionId: string; projectId: string; clientRequestId: string;
  statement: string; basis: string; replyTo?: string; context?: ContextRef;
  background?: RequirementRef[];
};
export type GuideInput = {
  id: string; digest: string; statement: string; statements: string[]; basis: string; createdAt: string;
  kind: 'explain' | 'modify' | 'clarify' | 'redirect' | 'cancel';
  state: 'pending' | 'done' | 'failed'; message?: string; replyTo?: string; resolvedBy?: string;
  explanationId?: string; deliveryId?: string; choiceId?: string; choiceVersion?: string;
  candidateModification?: boolean;
  handoff?: HandoffSource;
  context?: ContextRef;
  background?: RequirementRef[];
};
export type Delivery = {
  id: string; inputId: string; scope: Scope; requestId: string; contentDigest: string;
  userStatement: string; clarificationStatements: string[]; content: string;
  createdAt: string; updatedAt: string;
  state: 'pending' | 'dispatching' | 'queued' | 'accepted' | 'unknown' | 'failed';
  source?: Source & { messageId?: string }; notice?: string;
  background?: Background[]; requirementContent?: string;
};
export type HandoffSource = { kind: 'explanation'; id: string } | { kind: 'step'; id: string; index: number };
export type HandoffRequest = { sessionId: string; projectId: string; clientRequestId: string; source: HandoffSource };
export type InputResult = { input: GuideInput; explanation?: Explanation; delivery?: Delivery };

export class GuideError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'GuideError'; }
}
export function object(value: unknown, fields: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) {
    throw new GuideError('invalid_input', '输入格式不正确，请重新尝试。');
  }
}
export function text(value: unknown, max = 4000): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) {
    throw new GuideError('invalid_input', '输入为空或过长，请缩短后重试。');
  }
}
export function requestId(value: unknown): asserts value is string {
  text(value, 100);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value)) throw new GuideError('invalid_input', '请求标识无效。');
}
export function handoffSource(value: unknown): asserts value is HandoffSource {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GuideError('invalid_input', '请选择要发送的改法。');
  const row = value as Record<string, unknown>;
  if (row.kind === 'explanation') object(row, ['kind', 'id']);
  else if (row.kind === 'step') { object(row, ['kind', 'id', 'index']); if (!Number.isSafeInteger(row.index) || (row.index as number) < 0 || (row.index as number) > 2) throw new GuideError('invalid_input', '请选择要发送的建议。'); }
  else throw new GuideError('invalid_input', '请选择要发送的改法。');
  text(row.id, 200);
}
export function contextRef(value: unknown): asserts value is ContextRef {
  object(value, ['kind', 'id', 'version']);
  if (!['node', 'explanation', 'analysis'].includes(String(value.kind))) throw new GuideError('invalid_input', '请选择需要追问的内容。');
  text(value.id, 200); text(value.version, 100);
}
