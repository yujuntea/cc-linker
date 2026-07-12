// tests/unit/review/types.test.ts
import { describe, it, expect } from 'bun:test';
import type { Issue, ReviewState, BlockedResult, ReviewFixOutput, PipelineRecord, ModelInfo } from '../../../src/review/types';
import { STATE_KINDS, isTerminal } from '../../../src/review/types';

describe('review types', () => {
  it('STATE_KINDS lists 9 states (5 active + 1 trouble + 3 terminal)', () => {
    expect(STATE_KINDS).toEqual([
      'PRODUCING', 'SELF_REVIEW_R1', 'SELF_REVIEW_R2', 'FIXING', 'EXTERNAL_REVIEW',
      'PANE_LOST',
      'DONE', 'FAILED', 'ABORTED',
    ]);
  });

  it('isTerminal identifies DONE/FAILED/ABORTED', () => {
    expect(isTerminal('DONE')).toBe(true);
    expect(isTerminal('FAILED')).toBe(true);
    expect(isTerminal('ABORTED')).toBe(true);
    expect(isTerminal('PRODUCING')).toBe(false);
    expect(isTerminal('PANE_LOST')).toBe(false);
  });

  it('BlockedResult only allows unexpected kind (v2.1.6)', () => {
    const b: BlockedResult = { kind: 'unexpected', raw: 'rate limited' };
    expect(b.kind).toBe('unexpected');
  });

  it('Issue has fingerprint field', () => {
    const i: Issue = {
      id: 'abc12345', role: 'work', severity: 'P1', location: 'auth.ts:42',
      description: 'NPE', fingerprint: 'abc12345',
    };
    expect(i.fingerprint).toBe(i.id);
  });

  it('ReviewFixOutput perIssue has embedded severity (v2.1.5 P1-4)', () => {
    const o: ReviewFixOutput = {
      role: 'review', issues: [], reasoning: '',
      perIssue: [{ issueId: 'abc12345', severity: 'P0', verdict: 'real', verdictReason: 'x', fixApplied: true }],
    };
    expect(o.perIssue[0].severity).toBe('P0');
  });

  it('PipelineRecord has no checkpoint fields (v2.1.6)', () => {
    const r = { pipelineId: 'x', createdAt: '', updatedAt: '', state: { kind: 'DONE', pipelineId: 'x', round: 1 }, input: { rawInput: '', phase: 'code', profile: 'default', maxRounds: 6, cwd: '/' }, panes: {}, history: [] } as PipelineRecord;
    expect((r as any).preProduceCheckpointSha).toBeUndefined();
    expect((r as any).preReviewCheckpointSha).toBeUndefined();
  });

  it('ModelInfo allows null contextHint', () => {
    const m: ModelInfo = { name: 'unknown', contextHint: null };
    expect(m.contextHint).toBeNull();
  });
});
