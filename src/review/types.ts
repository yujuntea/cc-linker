// src/review/types.ts
// v2.1.6 + v2.1.6.1 patches: add modelName to PaneWork/PaneReview (C1) + promoted to ReconcileResult (C2).

export type Phase = 'spec' | 'plan' | 'code' | 'unknown';
export type Severity = 'P0' | 'P1' | 'P2' | 'P3';
export type Role = 'work' | 'review';

export const STATE_KINDS = [
  'PRODUCING', 'SELF_REVIEW_R1', 'SELF_REVIEW_R2', 'FIXING', 'EXTERNAL_REVIEW',
  'PANE_LOST',
  'DONE', 'FAILED', 'ABORTED',
] as const;
export type StateKind = typeof STATE_KINDS[number];

export const TERMINAL_STATES: ReadonlySet<StateKind> = new Set(['DONE', 'FAILED', 'ABORTED']);
export function isTerminal(kind: string): boolean {
  return TERMINAL_STATES.has(kind as StateKind);
}

export interface Issue {
  id: string;                  // = fingerprint (engine-assigned, stable across rounds)
  role: Role;
  severity: Severity;
  location: string;            // file path + line
  description: string;
  suggestion?: string;
  fingerprint: string;         // SHA256(role:severity:location:description) first 8 hex chars
}

export interface PerIssue {
  issueId: string;
  severity: Severity;          // v2.1.5 P1-4: embedded, used for convergence
  verdict: 'real' | 'hallucination';
  verdictReason: string;
  fixApplied: boolean;
  fixSummary?: string;
}

export interface ReviewFixOutput {
  role: 'review';
  issues: Issue[];
  perIssue: PerIssue[];
  reasoning: string;
}

/** adapter.poll 返回此结构当 state.json.state === 'blocked'. v2.1.6: 一律 unexpected. */
export interface BlockedResult {
  kind: 'unexpected';
  raw: string;                 // original needs/detail
}

export type ReviewState =
  | { kind: 'PRODUCING'; pipelineId: string; round: number }
  | { kind: 'SELF_REVIEW_R1'; pipelineId: string; round: number; cycle: 'initial' | 'postfix' }
  | { kind: 'SELF_REVIEW_R2'; pipelineId: string; round: number; cycle: 'initial' | 'postfix' }
  | { kind: 'FIXING'; pipelineId: string; round: number; source: 'SELF_REVIEW_R1' | 'SELF_REVIEW_R2'; inputIssues: Issue[] }
  | { kind: 'EXTERNAL_REVIEW'; pipelineId: string; round: number }
  | { kind: 'PANE_LOST'; pipelineId: string; round: number; lostPane?: { role: Role; shortId: string }; detectedAt: string; retryTarget: StateKind }
  | { kind: 'DONE'; pipelineId: string; round: number; issueTrail: Issue[] }
  | { kind: 'FAILED'; pipelineId: string; round: number; reason: string }
  | { kind: 'ABORTED'; pipelineId: string; round: number; reason: string; abortedBefore?: StateKind };

export interface PaneWork {
  sessionId: string;           // 跨轮不变
  currentRoundShortId?: string;
  provider: string;
  startedAt: string;
  roundShortIds: string[];
  /** v2.1.6.1 patch C1: 由 adapter.poll 从 state.json.respawnFlags 解析填充;cli-watch 优先显示这个而不是 provider alias. */
  modelName?: string;
}
export interface PaneReview {
  role: 'review';
  shortId: string;
  sessionId: string;
  provider: string;
  round: number;
  /** v2.1.6.1 patch C1: 同样由 adapter.poll 从 respawnFlags 解析. */
  modelName?: string;
}
export interface PaneRegistry {
  work?: PaneWork;
  review?: PaneReview;
}

export interface HistoryEvent {
  ts: string;
  fromState: StateKind | null;
  toState: StateKind;
  round: number;
  role: Role | 'human';
  paneShortId?: string;
  paneSessionId?: string;
  providerAlias?: string;
  inputDigest: string;
  outputDigest: string;
  outputSizeBytes: number;
  durationMs: number;
  issues?: Issue[];
}

export interface ParseDegradedEvent {
  ts: string;
  role: Role;
  round: number;
  state: StateKind;
  reason: string;
  recoveredByRetry: boolean;
}

export interface PipelineRecord {
  pipelineId: string;          // ULID
  createdAt: string;
  updatedAt: string;
  ownerOpenId?: string;
  state: ReviewState;
  input: {
    rawInput: string;
    phase: Phase;
    profile: string;
    maxRounds: number;
    cwd: string;
  };
  panes: PaneRegistry;
  history: HistoryEvent[];
  parseDegraded?: ParseDegradedEvent[];
  // v2.1.6: NO checkpoint fields (preProduceCheckpointSha / preReviewCheckpointSha deleted)
}

export interface ParseSuccess<T> { ok: true; data: T; retries: number }
export interface ParseFailure { ok: false; parseDegraded: true; reason: string; raw: string }
/** v2.1.6.1 fix: ParseFailure is non-generic; T-bound only attaches to success variant. */
export type ParseResult<T> = ParseSuccess<T> | ParseFailure;

export interface ReconcileResult {
  recovered: number;
  lostPanes: number;
  timedOut: string[];
  errors: string[];
  /** v2.1.6.1 patch C2: queued → running promotes counted here. */
  promoted: number;
}

export interface ModelInfo {
  name: string;
  contextHint: number | null;  // 仅供报告展示 (spec §3.2.1),不驱动任何阈值.
}
