// tests/unit/review/output-contract.test.ts
import { describe, it, expect } from 'bun:test';
import { extractJsonBlock, SelfReviewOutputSchema, ReviewOutputSchema, assignIssueFingerprints } from '../../../src/review/output-contract';

describe('extractJsonBlock', () => {
  it('extracts ```json fenced block', () => {
    const out = 'here is review\n```json\n{"issues":[]}\n```\ndone';
    expect(extractJsonBlock(out)).toEqual({ issues: [] });
  });

  // v2.1.6.1.1: qwen3.6 / MiniMax-M3 / GLM emit prose summaries where the only
  // "JSON" present is bareword-keyed (e.g. `{issues:[]}` or `{issues:[],"per_issue":[]}`).
  // Strategy 4 auto-quotes bareword keys then re-parses.
  it('v2.1.6.1.1: extracts JSON with bareword keys (auto-quoted)', () => {
    expect(extractJsonBlock('review complete. {issues:[]} — all clean'))
      .toEqual({ issues: [] });
  });
  it('v2.1.6.1.1: handles mixed quoted + unquoted keys', () => {
    expect(extractJsonBlock('{issues:[], per_issue: [], reasoning: "all clean"}'))
      .toEqual({ issues: [], per_issue: [], reasoning: 'all clean' });
  });

  // v2.1.6.1.1: prose heuristic for non-JSON-faithful models. Triggers ONLY when
  // the output mentions clean markers AND no specific defect markers.
  it('v2.1.6.1.1: extracts clean no-issues from prose-only output', () => {
    expect(extractJsonBlock('working tree clean vs HEAD; no defects; all clean'))
      .toEqual({ issues: [] });
    expect(extractJsonBlock('trivial clean repo confirmed; no issues found; looks good'))
      .toEqual({ issues: [] });
  });
  it('v2.1.6.1.1: rejects when defect markers present alongside "clean"', () => {
    expect(extractJsonBlock('mostly clean, but found one P1 issue in auth.ts'))
      .toBeNull();
    expect(extractJsonBlock('all clean, except critical issue in main.ts'))
      .toBeNull();
  });
  it('v2.1.6.1.1: returns null for ambiguous prose', () => {
    expect(extractJsonBlock('I reviewed the code.')).toBeNull();
    expect(extractJsonBlock('hello world')).toBeNull();
  });

  it('extracts last balanced {} via depth counter (v2.1.5 P2-5)', () => {
    const out = 'text {"a":1} more {"issues":[{"x":{"y":2}}]}';
    expect(extractJsonBlock(out)).toEqual({ issues: [{ x: { y: 2 } }] });
  });

  it('direct JSON.parse fallback', () => {
    expect(extractJsonBlock('{"foo":"bar"}')).toEqual({ foo: 'bar' });
  });

  it('returns null if no JSON', () => {
    expect(extractJsonBlock('just text no json')).toBeNull();
  });
});

describe('SelfReviewOutputSchema', () => {
  it('validates issues without id (engine assigns)', () => {
    const r = SelfReviewOutputSchema.safeParse({ issues: [{ severity: 'P1', location: 'a.ts:1', description: 'x' }] });
    expect(r.success).toBe(true);
  });
  it('rejects unknown severity', () => {
    const r = SelfReviewOutputSchema.safeParse({ issues: [{ severity: 'P9', location: '', description: '' }] });
    expect(r.success).toBe(false);
  });
});

describe('ReviewOutputSchema', () => {
  it('validates issues + per_issue with embedded severity', () => {
    const r = ReviewOutputSchema.safeParse({
      issues: [{ severity: 'P0', location: 'a', description: 'b' }],
      per_issue: [{ issue_id: 'x', severity: 'P0', verdict: 'real', verdict_reason: 'y', fix_applied: true }],
      reasoning: 'z',
    });
    expect(r.success).toBe(true);
  });

  // v2.1.6.1.1: lower-tier models (qwen3.6 / GLM / minimax-M3) often emit only
  // {"issues":[]} with prose wrapper like "no issues found". The relaxed schema
  // should accept that — engine treats absent per_issue as "no verdicts proposed"
  // and converges (0 real blocking = clean).
  it('accepts output with only issues (no per_issue / no reasoning)', () => {
    const r = ReviewOutputSchema.safeParse({
      issues: [],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.per_issue).toEqual([]);
      expect(r.data.reasoning).toBe('');
    }
  });
  it('accepts output with issues + reasoning but no per_issue', () => {
    const r = ReviewOutputSchema.safeParse({
      issues: [{ severity: 'P1', location: 'a', description: 'b' }],
      reasoning: 'found one defect',
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.per_issue).toEqual([]);
  });
  it('still rejects unknown severity', () => {
    const r = ReviewOutputSchema.safeParse({
      issues: [{ severity: 'P9', location: '', description: '' }],
    });
    expect(r.success).toBe(false);
  });
});

describe('assignIssueFingerprints', () => {
  it('assigns id = fingerprint (first 8 hex of SHA256)', () => {
    const issues = assignIssueFingerprints(
      [{ severity: 'P1', location: 'a.ts:1', description: 'bug' }],
      'work',
    );
    expect(issues[0].id).toMatch(/^[0-9a-f]{8}$/);
    expect(issues[0].id).toBe(issues[0].fingerprint);
    expect(issues[0].role).toBe('work');
  });
  it('same content -> same fingerprint (stable across rounds)', () => {
    const a = assignIssueFingerprints([{ severity: 'P1', location: 'a.ts:1', description: 'bug' }], 'work');
    const b = assignIssueFingerprints([{ severity: 'P1', location: 'a.ts:1', description: 'bug' }], 'work');
    expect(a[0].fingerprint).toBe(b[0].fingerprint);
  });
  it('different role -> different fingerprint', () => {
    const a = assignIssueFingerprints([{ severity: 'P1', location: 'a.ts:1', description: 'bug' }], 'work');
    const b = assignIssueFingerprints([{ severity: 'P1', location: 'a.ts:1', description: 'bug' }], 'review');
    expect(a[0].fingerprint).not.toBe(b[0].fingerprint);
  });
});