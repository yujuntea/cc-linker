// tests/unit/review/cli-watch.test.ts
// v2.1.6 + v2.1.6.1 patch C1 step 6: renderLive prefers pane.modelName ?? pane.provider.
import { describe, it, expect } from 'bun:test';
import { renderLive } from '../../../src/review/cli-watch';
import type { PipelineRecord } from '../../../src/review/types';

describe('renderLive', () => {
  it('renders pipeline header + state + round', () => {
    const rec = {
      pipelineId: '01XYZ', state: { kind: 'EXTERNAL_REVIEW', pipelineId: '01XYZ', round: 3 },
      input: { phase: 'code', profile: 'default' },
    } as any as PipelineRecord;
    const out = renderLive(rec);
    expect(out).toContain('01XYZ');
    expect(out).toContain('EXTERNAL_REVIEW');
    expect(out).toContain('Round: 3');
  });

  it('renders pane status with work + review', () => {
    const rec = {
      pipelineId: 'p1', state: { kind: 'PRODUCING', pipelineId: 'p1', round: 0 },
      input: { phase: 'code', profile: 'default' },
      panes: {
        work: { sessionId: 's', currentRoundShortId: 'short1', provider: 'sonnet', startedAt: '', roundShortIds: ['short1'] },
        review: { role: 'review', shortId: 'short5', sessionId: 'r', provider: 'kimi', round: 1 },
      },
    } as any as PipelineRecord;
    const out = renderLive(rec);
    expect(out).toContain('work');
    expect(out).toContain('short1');
  });

  it('terminal state returns final render', () => {
    const rec = {
      pipelineId: 'p1', state: { kind: 'DONE', pipelineId: 'p1', round: 2, issueTrail: [] },
      input: { phase: 'code', profile: 'default' },
    } as any as PipelineRecord;
    const out = renderLive(rec);
    expect(out).toContain('DONE');
  });
});