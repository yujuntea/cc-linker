import { describe, it, expect, mock } from 'bun:test';
import { ClaudeBGAdapter } from '../../../src/review/adapter';
import { readJobState } from '../../../src/agent-view/job-state';

describe('ClaudeBGAdapter.poll', () => {
  it('returns done with output when state=done', async () => {
    const adapter = new ClaudeBGAdapter({
      jobsDir: 'tests/fixtures/review',
      readJobStateFn: (short) => readJobState(short, 'tests/fixtures/review'),
    });
    // fixture file: state-done.json => short 'state-done'
    const r = await adapter.poll('state-done', 1000);
    expect(r.kind).toBe('done');
    if (r.kind === 'done') expect(r.output).toContain('issues');
  });

  it('returns blocked (unexpected) when state=blocked (v2.1.6)', async () => {
    const adapter = new ClaudeBGAdapter({
      jobsDir: 'tests/fixtures/review',
      readJobStateFn: (short) => readJobState(short, 'tests/fixtures/review'),
    });
    const r = await adapter.poll('state-blocked', 1000);
    expect(r.kind).toBe('blocked');
    if (r.kind === 'blocked') expect(r.blocked.kind).toBe('unexpected');
  });

  it('returns running when state=running', async () => {
    const adapter = new ClaudeBGAdapter({
      jobsDir: 'tests/fixtures/review',
      readJobStateFn: (short) => readJobState(short, 'tests/fixtures/review'),
    });
    const r = await adapter.poll('state-running', 1000);
    expect(r.kind).toBe('running');
  });

  it('returns lost when readJobState returns null', async () => {
    const adapter = new ClaudeBGAdapter({
      jobsDir: 'tests/fixtures/review',
      readJobStateFn: mock(async () => null),
    });
    const r = await adapter.poll('missing', 1000);
    expect(r.kind).toBe('lost');
  });
});