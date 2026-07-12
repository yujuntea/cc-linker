// tests/unit/review/reconciler.test.ts
// v2.1.6 + v2.1.6.1 patches:
//   T5c     — 4 cases: PANE_LOST 24h timeout + pane-alive checks
//   C2b     — 2 new cases: promote queued when slot free + no promote when running full

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PipelineStore } from '../../../src/review/pipeline-store';
import { Reconciler } from '../../../src/review/reconciler';
import type { PipelineRecord } from '../../../src/review/types';

let tmpRoot: string;
let store: PipelineStore;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cc-reconcile-'));
  store = new PipelineStore(tmpRoot);
});
afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));

function paneLostRecord(id: string, ageHours: number): PipelineRecord {
  const detectedAt = new Date(Date.now() - ageHours * 3600 * 1000).toISOString();
  return {
    pipelineId: id, createdAt: detectedAt, updatedAt: detectedAt,
    state: { kind: 'PANE_LOST', pipelineId: id, round: 1, detectedAt, retryTarget: 'EXTERNAL_REVIEW' },
    input: { rawInput: '', phase: 'code', profile: 'default', maxRounds: 6, cwd: '/tmp' },
    panes: {}, history: [],
  };
}

describe('Reconciler', () => {
  it('PANE_LOST older than 24h -> ABORTED (moved to aborted/)', async () => {
    await store.create(paneLostRecord('old', 25));
    const r = new Reconciler(store, { readJobStateFn: async () => null });
    const result = await r.reconcile();
    expect(result.timedOut).toContain('old');
    const rec = await store.read('old');
    expect(rec?.state.kind).toBe('ABORTED');
  });

  it('PANE_LOST younger than 24h -> left alone', async () => {
    await store.create(paneLostRecord('young', 2));
    const r = new Reconciler(store, { readJobStateFn: async () => null });
    await r.reconcile();
    const rec = await store.read('young');
    expect(rec?.state.kind).toBe('PANE_LOST');
  });

  it('running pipeline with dead pane -> PANE_LOST', async () => {
    const rec: PipelineRecord = {
      pipelineId: 'p1', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      state: { kind: 'PRODUCING', pipelineId: 'p1', round: 0 },
      input: { rawInput: '', phase: 'code', profile: 'default', maxRounds: 6, cwd: '/tmp' },
      panes: { work: { sessionId: 's1', currentRoundShortId: 'dead1234', provider: 'x', startedAt: '', roundShortIds: ['dead1234'] } },
      history: [],
    };
    await store.create(rec);
    const r = new Reconciler(store, { readJobStateFn: async () => null }); // null = dead
    const result = await r.reconcile();
    expect(result.lostPanes).toBeGreaterThan(0);
    const after = await store.read('p1');
    expect(after?.state.kind).toBe('PANE_LOST');
  });

  it('running pipeline with alive pane -> no change', async () => {
    const rec: PipelineRecord = {
      pipelineId: 'p2', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      state: { kind: 'PRODUCING', pipelineId: 'p2', round: 0 },
      input: { rawInput: '', phase: 'code', profile: 'default', maxRounds: 6, cwd: '/tmp' },
      panes: { work: { sessionId: 's1', currentRoundShortId: 'alive123', provider: 'x', startedAt: '', roundShortIds: ['alive123'] } },
      history: [],
    };
    await store.create(rec);
    const r = new Reconciler(store, { readJobStateFn: async () => ({ state: { state: 'running', tempo: 'active', detail: null, needs: null }, short: 'alive123', path: '', mtimeMs: 0, readAt: 0 } as any) });
    const result = await r.reconcile();
    expect(result.lostPanes).toBe(0);
    const after = await store.read('p2');
    expect(after?.state.kind).toBe('PRODUCING');
  });

  // ── v2.1.6.1 C2b: queued promotion tests ────────────────────────────────

  it('running empty + queued has 1 → promote + promoteFn called', async () => {
    const queuedId = '01J9XQ7YH1ABCDEF0000000000';
    const rec: PipelineRecord = {
      pipelineId: queuedId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      state: { kind: 'PRODUCING', pipelineId: queuedId, round: 0 },
      input: { rawInput: '', phase: 'code', profile: 'default', maxRounds: 6, cwd: '/tmp' },
      panes: {}, history: [],
    };
    await store.create(rec, 'queued');

    let promoteFnCalled: string | null = null;
    const moveSpy = spyOn(store, 'move');
    const r = new Reconciler(store, {
      readJobStateFn: async () => null,
      promoteFn: async (id) => { promoteFnCalled = id; },
    });
    const result = await r.reconcile();

    expect(result.promoted).toBe(1);
    expect(promoteFnCalled).toBe(queuedId);
    // store.move('01J9XQ7YH1ABCDEF0000000000', 'queued', 'running') was called
    const moveCalls = moveSpy.mock.calls.filter(
      (c) => c[0] === queuedId && c[1] === 'queued' && c[2] === 'running',
    );
    expect(moveCalls.length).toBeGreaterThan(0);
    // pipeline now lives in running/
    expect((await store.listRunning())).toContain(queuedId);
    expect((await store.listQueued())).not.toContain(queuedId);
  });

  it('running full (>= maxConcurrent) + queued has 1 → no promote', async () => {
    // Fill the running bucket to maxConcurrent=1
    const runningRec: PipelineRecord = {
      pipelineId: '01J9XQ7YH1RUNNING00000000',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      state: { kind: 'PRODUCING', pipelineId: '01J9XQ7YH1RUNNING00000000', round: 0 },
      input: { rawInput: '', phase: 'code', profile: 'default', maxRounds: 6, cwd: '/tmp' },
      panes: {}, history: [],
    };
    await store.create(runningRec);

    const queuedId = '01J9XQ7YH1QUEUED00000000A';
    const queuedRec: PipelineRecord = {
      ...runningRec, pipelineId: queuedId,
    };
    await store.create(queuedRec, 'queued');

    let promoteFnCalled = 0;
    const moveSpy = spyOn(store, 'move');
    const r = new Reconciler(store, {
      readJobStateFn: async () => null,
      maxConcurrent: 1, // running has 1 already -> full
      promoteFn: async () => { promoteFnCalled++; },
    });
    const result = await r.reconcile();

    expect(result.promoted).toBe(0);
    expect(promoteFnCalled).toBe(0);
    // pipeline stays in queued/ — running count still 1
    expect((await store.listQueued())).toContain(queuedId);
    expect((await store.listRunning())).not.toContain(queuedId);
    // No move(queued -> running) call
    const queuedToRunning = moveSpy.mock.calls.filter(
      (c) => c[0] === queuedId && c[1] === 'queued' && c[2] === 'running',
    );
    expect(queuedToRunning.length).toBe(0);
  });
});
