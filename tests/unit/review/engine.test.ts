// tests/unit/review/engine.test.ts
import { describe, it, expect } from 'bun:test';
import { isClean, externalReviewConverges, computeNextState, renderReport } from '../../../src/review/engine';
import type { Issue, PipelineRecord, ReviewFixOutput, ReviewState } from '../../../src/review/types';

describe('isClean', () => {
  it('no P0/P1/P2 -> clean', () => {
    expect(isClean([{ id: 'x', role: 'work', severity: 'P3', location: '', description: '', fingerprint: 'x' }])).toBe(true);
  });
  it('has P1 -> not clean', () => {
    expect(isClean([{ id: 'x', role: 'work', severity: 'P1', location: '', description: '', fingerprint: 'x' }])).toBe(false);
  });
  it('empty -> clean', () => {
    expect(isClean([])).toBe(true);
  });
});

describe('externalReviewConverges', () => {
  const mk = (perIssue: any[]): ReviewFixOutput => ({ role: 'review', issues: [], reasoning: '', perIssue: perIssue });
  it('0 real P0/P1/P2 -> converges (DONE)', () => {
    expect(externalReviewConverges(mk([
      { issueId: 'a', severity: 'P3', verdict: 'real', verdictReason: '', fixApplied: false },
      { issueId: 'b', severity: 'P1', verdict: 'hallucination', verdictReason: '', fixApplied: false },
    ]))).toBe(true);
  });
  it('1 real P0 -> not converges (postfix round+1)', () => {
    expect(externalReviewConverges(mk([
      { issueId: 'a', severity: 'P0', verdict: 'real', verdictReason: '', fixApplied: true },
    ]))).toBe(false);
  });
});

describe('computeNextState', () => {
  it('PRODUCING + work_done -> SELF_REVIEW_R1 round=1', () => {
    const s: ReviewState = { kind: 'PRODUCING', pipelineId: 'p', round: 0 };
    const next = computeNextState(s, { type: 'work_done', clean: true }, 6);
    expect(next.kind).toBe('SELF_REVIEW_R1');
    if (next.kind === 'SELF_REVIEW_R1') expect(next.round).toBe(1);
  });
  it('SELF_REVIEW_R1 + found P0/P1/P2 -> FIXING source=R1', () => {
    const s: ReviewState = { kind: 'SELF_REVIEW_R1', pipelineId: 'p', round: 1, cycle: 'initial' };
    const next = computeNextState(s, { type: 'review_done', clean: false, issues: [] }, 6);
    expect(next.kind).toBe('FIXING');
    if (next.kind === 'FIXING') expect(next.source).toBe('SELF_REVIEW_R1');
  });
  it('FIXING source=R1 done -> SELF_REVIEW_R2', () => {
    const s: ReviewState = { kind: 'FIXING', pipelineId: 'p', round: 1, source: 'SELF_REVIEW_R1', inputIssues: [] };
    const next = computeNextState(s, { type: 'fix_done' }, 6);
    expect(next.kind).toBe('SELF_REVIEW_R2');
  });
  it('EXTERNAL_REVIEW + converges -> DONE', () => {
    const s: ReviewState = { kind: 'EXTERNAL_REVIEW', pipelineId: 'p', round: 1 };
    const next = computeNextState(s, { type: 'external_done', converges: true }, 6);
    expect(next.kind).toBe('DONE');
  });
  it('EXTERNAL_REVIEW + not converges -> SELF_REVIEW_R1 postfix round+1', () => {
    const s: ReviewState = { kind: 'EXTERNAL_REVIEW', pipelineId: 'p', round: 1 };
    const next = computeNextState(s, { type: 'external_done', converges: false }, 6);
    expect(next.kind).toBe('SELF_REVIEW_R1');
    if (next.kind === 'SELF_REVIEW_R1') { expect(next.cycle).toBe('postfix'); expect(next.round).toBe(2); }
  });
  it('entering SELF_REVIEW_R1 with round+1 > max -> ABORTED max_rounds_exceeded (v2.1.5 P2-2)', () => {
    const s: ReviewState = { kind: 'EXTERNAL_REVIEW', pipelineId: 'p', round: 6 };
    const next = computeNextState(s, { type: 'external_done', converges: false }, 6);
    expect(next.kind).toBe('ABORTED');
    if (next.kind === 'ABORTED') expect(next.reason).toBe('max_rounds_exceeded');
  });
  it('blocked -> ABORTED unexpected_blocked (v2.1.6)', () => {
    const s: ReviewState = { kind: 'PRODUCING', pipelineId: 'p', round: 0 };
    const next = computeNextState(s, { type: 'blocked', raw: 'rate limited' }, 6);
    expect(next.kind).toBe('ABORTED');
    if (next.kind === 'ABORTED') expect(next.reason).toBe('unexpected_blocked');
  });
});

describe('renderReport (v2.1.6.1 patch C4)', () => {
  const mkRec = (state: ReviewState, history: any[] = [], parseDegraded?: any[]): PipelineRecord => ({
    pipelineId: 'rp01',
    createdAt: '2026-07-12T00:00:00Z',
    updatedAt: '2026-07-12T00:00:01Z',
    state,
    input: { rawInput: 'fix NPE', phase: 'code', profile: 'default', maxRounds: 6, cwd: '/tmp' },
    panes: {
      work: { sessionId: 's1', currentRoundShortId: 'w1', provider: 'claude-sonnet-4', startedAt: '2026-07-12T00:00:00Z', roundShortIds: ['w1'], modelName: 'MiniMax-M3' },
      review: { role: 'review', shortId: 'r1', sessionId: 's2', provider: 'kimi-coding', round: 1, modelName: 'kimi-for-coding' },
    },
    history,
    ...(parseDegraded ? { parseDegraded } : {}),
  });

  it('renders DONE header with state', async () => {
    const md = await renderReport(mkRec({ kind: 'DONE', pipelineId: 'rp01', round: 2, issueTrail: [] }));
    expect(md).toContain('# Review Report — rp01');
    expect(md).toContain('Final state: **DONE**');
    expect(md).toContain('Phase: code');
    expect(md).toContain('MiniMax-M3');
    expect(md).toContain('kimi-for-coding');
  });

  it('renders ABORTED with reason', async () => {
    const md = await renderReport(mkRec({ kind: 'ABORTED', pipelineId: 'rp01', round: 6, reason: 'max_rounds_exceeded', abortedBefore: 'EXTERNAL_REVIEW' }));
    expect(md).toContain('Final state: **ABORTED**');
    expect(md).toContain('Abort reason: max_rounds_exceeded');
  });

  it('renders empty Issues section when no issues', async () => {
    const md = await renderReport(mkRec({ kind: 'DONE', pipelineId: 'rp01', round: 1, issueTrail: [] }));
    expect(md).toContain('## Issues');
    expect(md).toContain('_No issues recorded._');
  });

  it('renders parseDegraded events', async () => {
    const md = await renderReport(mkRec(
      { kind: 'FAILED', pipelineId: 'rp01', round: 1, reason: 'review_parse_degraded' },
      [],
      [{ ts: '2026-07-12T00:00:02Z', role: 'review', round: 1, state: 'EXTERNAL_REVIEW', reason: 'parse timeout', recoveredByRetry: false }],
    ));
    expect(md).toContain('## Parse Degradation');
    expect(md).toContain('parse timeout');
  });

  it('renders timeline from history', async () => {
    const md = await renderReport(mkRec({ kind: 'DONE', pipelineId: 'rp01', round: 1, issueTrail: [] }, [
      { ts: '2026-07-12T00:00:01Z', fromState: null, toState: 'PRODUCING', round: 0, role: 'work', inputDigest: '', outputDigest: '', outputSizeBytes: 0, durationMs: 1000 },
      { ts: '2026-07-12T00:00:30Z', fromState: 'PRODUCING', toState: 'SELF_REVIEW_R1', round: 1, role: 'work', inputDigest: '', outputDigest: '', outputSizeBytes: 0, durationMs: 2000 },
    ]));
    expect(md).toContain('## Timeline');
    expect(md).toContain('SELF_REVIEW_R1');
  });
});
