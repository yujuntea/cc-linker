// tests/unit/review/pipeline-store.test.ts
// v2.1.6 + v2.1.6.1 patches:
//   T5  — 5 tests for CRUD + atomic moves
//   C2a — bucket-aware create
//   H1  — dynamic-bucket per-pipeline lock
//   C2a — global root .lock

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PipelineStore } from '../../../src/review/pipeline-store';
import type { PipelineRecord } from '../../../src/review/types';

let tmpRoot: string;
let store: PipelineStore;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cc-review-test-'));
  store = new PipelineStore(tmpRoot);
});
afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));

function makeRecord(id: string): PipelineRecord {
  return {
    pipelineId: id,
    createdAt: '2026-07-12T00:00:00Z',
    updatedAt: '2026-07-12T00:00:00Z',
    state: { kind: 'PRODUCING', pipelineId: id, round: 0 },
    input: { rawInput: 'fix NPE', phase: 'code', profile: 'default', maxRounds: 6, cwd: '/tmp' },
    panes: {},
    history: [],
  };
}

describe('PipelineStore', () => {
  it('create writes running/<id>/pipeline.json', async () => {
    await store.create(makeRecord('abc'));
    const r = await store.read('abc');
    expect(r?.pipelineId).toBe('abc');
    expect(r?.state.kind).toBe('PRODUCING');
  });

  it('save updates atomically (tmp+rename)', async () => {
    const rec = makeRecord('abc');
    await store.create(rec);
    rec.state = { kind: 'SELF_REVIEW_R1', pipelineId: 'abc', round: 1, cycle: 'initial' };
    await store.save(rec);
    const r = await store.read('abc');
    expect(r?.state.kind).toBe('SELF_REVIEW_R1');
  });

  it('move running -> done (atomic dir rename)', async () => {
    await store.create(makeRecord('abc'));
    await store.move('abc', 'running', 'done');
    const r = await store.read('abc');
    expect(r?.pipelineId).toBe('abc');
    // running dir no longer has it
    expect(await store.listRunning()).not.toContain('abc');
  });

  it('listRunning returns ids in running/', async () => {
    await store.create(makeRecord('a'));
    await store.create(makeRecord('b'));
    const ids = await store.listRunning();
    expect(ids.sort()).toEqual(['a', 'b']);
  });

  it('read returns null for missing id', async () => {
    expect(await store.read('nonexistent')).toBeNull();
  });

  // ── v2.1.6.1 patches ─────────────────────────────────────────────────────

  it('create(record, "queued") writes to queued/<id>/pipeline.json', async () => {
    await store.create(makeRecord('abc'), 'queued');
    expect(existsSync(join(tmpRoot, 'queued', 'abc', 'pipeline.json'))).toBe(true);
    // not in running
    expect(await store.listRunning()).not.toContain('abc');
    // readable via read() (finds it across buckets)
    const r = await store.read('abc');
    expect(r?.pipelineId).toBe('abc');
  });

  it('acquirePipelineLock works on a pipeline moved from running/ to done/', async () => {
    await store.create(makeRecord('abc'));
    await store.move('abc', 'running', 'done');
    // H1: lock must follow the pipeline into its new bucket
    let lockedUnderDone = false;
    await store.acquirePipelineLock('abc', async () => {
      lockedUnderDone = existsSync(join(tmpRoot, 'done', 'abc', '.lock'));
    });
    expect(lockedUnderDone).toBe(true);
    // not created under running/
    expect(existsSync(join(tmpRoot, 'running', 'abc', '.lock'))).toBe(false);
  });

  it('acquireGlobalLock uses root/.lock', async () => {
    let lockFileExisted = false;
    await store.acquireGlobalLock(async () => {
      // proper-lockfile creates <path>.lock alongside the lockfile itself,
      // so we assert the root/.lock (target) is present.
      lockFileExisted = existsSync(join(tmpRoot, '.lock'));
    });
    expect(lockFileExisted).toBe(true);
  });

  it('findBucketPublic returns the current bucket', async () => {
    await store.create(makeRecord('abc'), 'queued');
    expect(await store.findBucketPublic('abc')).toBe('queued');
    await store.move('abc', 'queued', 'running');
    expect(await store.findBucketPublic('abc')).toBe('running');
    await store.move('abc', 'running', 'done');
    expect(await store.findBucketPublic('abc')).toBe('done');
    expect(await store.findBucketPublic('nope')).toBeNull();
  });
});