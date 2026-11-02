import { validSupport } from './support-types.js';
import type { SupportRecord } from './support-types.js';
import type { ContextRef, Explanation, FileBasis, ModelRoute, Scope } from './contracts.js';
import type { Analysis, OutcomeBinding, RequirementRef, RequirementRevision, WorkView } from './work-types.js';

export type Responsibility = { id: string; title: string; purpose: string; impact: string; files: string[] };
export type Overview = {
  id: string; projectId: string; scope: Scope; requestId: string; requestDigest: string; cacheKey: string;
  createdAt: string; model: ModelRoute; preferenceVersion?: string; basis: FileBasis; sampledFiles: number;
  summary: string; unknowns: string[]; nodes: Responsibility[];
  edges: { from: string; to: string }[];
};
export type Annotation = {
  id: string; requestDigest: string; explanationId: string; action: 'correct' | 'retire';
  text?: string; createdAt: string;
};
export type TrialCard = {
  id: string; projectId: string; scope: Scope; deliveryId: string; requestId: string; requestDigest: string;
  cacheKey: string; requirement: string; basis: FileBasis; createdAt: string;
  steps: { id: string; action: string; expected: string }[];
  requirementRef?: RequirementRef;
};
export type TrialFeedback = {
  id: string; requestDigest: string; cardId: string; stepId: string;
  result: 'pass' | 'fail'; note?: string; createdAt: string;
};
export type ProjectRecord = {
  version: 1; projectId: string; revision: number; support?: SupportRecord;
  overviews: Overview[]; annotations: Annotation[]; trials: TrialCard[]; feedback: TrialFeedback[];
  requirementRevisions: RequirementRevision[]; bindings: OutcomeBinding[]; analyses: Analysis[];
};
export type HistoryItem = Explanation & { contextVersion: string; annotation?: Annotation; fromCurrentSession: boolean };
export type HistoryPage = { items: HistoryItem[]; nextOffset?: number; incomplete: boolean };
export type ProjectView = {
  versions?: { id: string; createdAt: string; summary: string; sampledFiles: number }[];
  projectId: string; fileDigest: string; fileCount: number; complete: boolean;
  overview?: Overview & { historical: boolean; changedNodes: string[]; unmappedChanges: number };
  trials: Array<TrialCard & { historical: boolean; feedback: TrialFeedback[] }>;
  work?: WorkView;
};
export type Focus = { ref: ContextRef; label: string };
export const freshProject = (projectId: string): ProjectRecord => ({ version: 1, projectId, revision: 0, overviews: [], annotations: [], trials: [], feedback: [], requirementRevisions: [], bindings: [], analyses: [] });
export function validProject(value: ProjectRecord, projectId: string): boolean {
  return !!value && value.version === 1 && value.projectId === projectId && Number.isSafeInteger(value.revision)
    && (!value.support || validSupport(value.support))
    && Array.isArray(value.overviews) && value.overviews.length <= 30
    && Array.isArray(value.annotations) && value.annotations.length <= 1000
    && Array.isArray(value.trials) && value.trials.length <= 200
    && Array.isArray(value.feedback) && value.feedback.length <= 2000
    && Array.isArray(value.requirementRevisions) && value.requirementRevisions.length <= 1000
    && Array.isArray(value.bindings) && value.bindings.length <= 500
    && Array.isArray(value.analyses) && value.analyses.length <= 200
    && value.requirementRevisions.every(row => typeof row.id === 'string' && typeof row.version === 'string' && typeof row.text === 'string' && ['active', 'retired'].includes(row.state) && ['related', 'project'].includes(row.applicability))
    && value.bindings.every(row => row.projectId === projectId && row.authority === 'owner-confirmed' && typeof row.trialId === 'string' && typeof row.basis?.digest === 'string' && Array.isArray(row.coverage))
    && value.analyses.every(row => row.projectId === projectId && ['changes', 'goal', 'trouble'].includes(row.kind) && typeof row.summary === 'string' && typeof row.basis?.digest === 'string' && Array.isArray(row.nodes) && Array.isArray(row.sources))
    && value.overviews.every(row => row.projectId === projectId && row.scope?.projectId === projectId && typeof row.id === 'string'
      && typeof row.summary === 'string' && typeof row.basis?.digest === 'string' && !!row.basis.files && Array.isArray(row.unknowns)
      && Array.isArray(row.nodes) && row.nodes.length <= 8 && row.nodes.every(node => typeof node.title === 'string' && typeof node.id === 'string' && Array.isArray(node.files)) && Array.isArray(row.edges))
    && value.annotations.every(row => typeof row.id === 'string' && typeof row.explanationId === 'string' && ['correct', 'retire'].includes(row.action)
      && (row.action !== 'correct' || typeof row.text === 'string'))
    && value.trials.every(row => row.projectId === projectId && typeof row.id === 'string' && typeof row.requirement === 'string'
      && typeof row.basis?.digest === 'string' && Array.isArray(row.steps) && row.steps.length <= 6
      && row.steps.every(step => typeof step.id === 'string' && typeof step.action === 'string' && typeof step.expected === 'string'))
    && value.feedback.every(row => typeof row.id === 'string' && typeof row.cardId === 'string' && typeof row.stepId === 'string' && ['pass', 'fail'].includes(row.result));
}
