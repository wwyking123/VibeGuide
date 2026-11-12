import type { TroubleView } from './trouble.js';
import type { FileBasis, Scope, Source } from './contracts.js';

export type RequirementRef = { id: string; version: string };
export type RequirementSource = Source | { sessionId: string; sidebarInputId: string };
export type OriginalRequirement = {
  id: string; scope: Scope; text: string; createdAt: string; source: RequirementSource;
  nativeMessageId?: string; deliveryId?: string; rpcId?: string;
};
export type RequirementRevision = {
  requestId: string; requestDigest: string; id: string; previous: string; version: string;
  text: string; state: 'active' | 'retired'; applicability: 'related' | 'project'; createdAt: string;
};
export type Requirement = OriginalRequirement & {
  version: string; originalText: string; state: 'active' | 'retired'; applicability: 'related' | 'project';
  modifiedAt?: string; forwarded: 'not_forwarded' | 'pending' | 'accepted' | 'unknown';
};
export type Background = RequirementRef & { text: string; source: RequirementSource; reason: 'project' | 'related' | 'selected' };
export type SourceChange = { file: string; before: string; after: string; complete: boolean };
export type OperationRef = { sessionId: string; id: string };
export type OutcomeBinding = {
  id: string; requestDigest: string; projectId: string; requirement: RequirementRef; trialId: string;
  basis: FileBasis; createdAt: string; version: string;
  coverage: Array<{ stepId: string; changes: OperationRef[]; checks: OperationRef[] }>;
  authority: 'owner-confirmed';
};
export type Confirmation = { id: string; requestDigest: string; requirement: RequirementRef; createdAt: string };
export type Outcome = {
  requirement: Requirement; trialId?: string; bindingVersion?: string; evidenceVersion: string;
  state: 'awaiting_delivery' | 'needs_scope' | 'needs_changes' | 'needs_checks' | 'check_failed' | 'needs_feedback' | 'feedback_failed' | 'stale' | 'complete';
  message: string; missing: string[];
  steps: Array<{ id: string; action: string; expected: string; changes: boolean; checks: 'passed' | 'failed' | 'missing'; feedback: 'pass' | 'fail' | 'missing' }>;
  candidates: Array<{ ref: OperationRef; kind: 'change' | 'check'; label: string; outcome: string; current: boolean; linked: boolean }>;
};
export type Analysis = {
  id: string; projectId: string; scope: Scope; requestId: string; requestDigest: string; cacheKey: string;
  kind: 'changes' | 'goal' | 'trouble';
  preferenceVersion?: string; troubleVersion?: string; nextSteps?: { label: string; reason: string; request: string }[]; question: string; createdAt: string; basis: FileBasis; requirementBasis: string;
  overviewId?: string; summary: string; impacts: string[]; unknowns: string[];
  nodes: Array<{ id?: string; title: string; reason: string; files: string[] }>; possibleAdditions: string[];
  sources: string[]; observedChanges: number; coveredChanges: number;
};
export type WorkView = {
  requirements: Requirement[]; outcomes: Outcome[]; analyses: Array<Analysis & { historical: boolean }>;
  historyIncomplete: boolean; trouble?: TroubleView;
};
