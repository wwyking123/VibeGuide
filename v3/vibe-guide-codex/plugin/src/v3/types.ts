export const briefKeys = ['audience', 'goal', 'flow', 'scope', 'acceptance', 'constraints', 'openQuestions'] as const;
export type BriefKey = typeof briefKeys[number];
export type Brief = Record<BriefKey, string>;
export type Evidence = {
    id: string;
    seq: number;
    kind: 'user' | 'assistant' | 'tool';
    text: string;
};
export type OperationFact = {
    id: string;
    key: string;
    label: string;
    kind: string;
    outcome: string;
    endedAt?: string;
    diagnostic?: string;
    seq: number;
    changedFiles: string[];
    applicable?: string;
};
export type Frame = {
    sessionId: string;
    projectId?: string;
    projectName: string;
    enabled: boolean;
    seq: number;
    segmentStart: number;
    busy: boolean;
    waiting: boolean;
    modelReady: boolean;
    evidence: Evidence[];
    operations: OperationFact[];
    partial: boolean;
};
export type Issue = {
    id: string;
    fingerprint: string;
    category: 'tool' | 'reported';
    state: 'open' | 'resolved' | 'dismissed';
    count: number;
    firstSeenAt: number;
    lastSeenAt: number;
    evidenceRefs: string[];
    summary: string;
    impact: string;
    nextStep: string;
    transfer: string;
    basis: string;
    stale: boolean;
    diagnosisBasis?: string;
};
export type SideAnswer = {
    id: string;
    question: string;
    selection?: string;
    text: string;
    evidenceRefs: string[];
    basis: string;
    createdAt: string;
    threadId: string;
};
export type Recap = {
    id: string;
    title: string;
    basis: string;
    throughSeq: number;
    createdAt: string;
    sections: {
        title: string;
        text: string;
        evidenceRefs: string[];
    }[];
    limitations: string[];
    verification: string;
};
export type Task = {
    id: string;
    sessionId: string;
    projectId?: string;
    segmentStart: number;
    startSeq: number;
    endSeq?: number;
    revision: number;
    title: string;
    state: 'draft' | 'active' | 'review' | 'closed' | 'archived';
    brief: Brief;
    confirmed: boolean;
    turns: {
        question: string;
        answer: string;
    }[];
    nextQuestion: string;
    options: string[];
    contradictions: string[];
    issues: Issue[];
    answers: SideAnswer[];
    recaps: Recap[];
    evidence: Evidence[];
    operations: OperationFact[];
    transfer: string;
    settings: {
        autoDiagnosis: boolean;
        autoRecap: boolean;
    };
    usage: {
        diagnosis: number;
        recap: number;
        manual: number;
    };
    requests: {
        id: string;
        digest: string;
        status: 'pending' | 'done' | 'failed';
    }[];
    createdAt: string;
    updatedAt: string;
};
export type SessionTasks = {
    schemaVersion: 3;
    activeId?: string;
    tasks: Task[];
};
export type View = {
    task?: Task;
    tasks: {
        id: string;
        title: string;
        state: Task['state'];
        revision: number;
    }[];
    frame: Frame;
    basis: string;
    busy: boolean;
    needsBinding: boolean;
    capabilities: {
        draft: false;
        selection: 'message-dom';
        monitoring: boolean;
    };
};
