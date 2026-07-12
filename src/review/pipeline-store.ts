// src/review/pipeline-store.ts
// v2.1.6 + v2.1.6.1 patches:
//   T5    — 5-dir CRUD + atomic moves + per-pipeline lock
//   C2a   — create(record, bucket='running') accepts bucket
//           + acquireGlobalLock<T>(fn) new method
//           + findBucketPublic(id) renamed from private findBucket
//   H1    — acquirePipelineLock uses findBucket(id) dynamically
//           (lock under whatever bucket the pipeline currently lives in).

import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import { withLock } from '../utils/lock';
import type { PipelineRecord } from './types';

export type PipelineBucket = 'running' | 'queued' | 'done' | 'failed' | 'aborted';

const ALL_BUCKETS: PipelineBucket[] = ['running', 'queued', 'done', 'failed', 'aborted'];

export class PipelineStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
    for (const b of ALL_BUCKETS) {
      const d = join(root, b);
      if (!existsSync(d)) mkdirSync(d, { recursive: true });
    }
  }

  private dir(id: string, bucket: PipelineBucket): string {
    return join(this.root, bucket, id);
  }

  private file(id: string, bucket: PipelineBucket): string {
    return join(this.dir(id, bucket), 'pipeline.json');
  }

  /** Find which bucket an id lives in, or null. */
  private findBucket(id: string): PipelineBucket | null {
    for (const b of ALL_BUCKETS) {
      if (existsSync(this.file(id, b))) return b;
    }
    return null;
  }

  /** v2.1.6.1 C3: cancel/abort needs to know current bucket to move from. */
  async findBucketPublic(id: string): Promise<PipelineBucket | null> {
    return this.findBucket(id);
  }

  /** v2.1.6.1 C2a: create now accepts bucket; default 'running'. */
  async create(record: PipelineRecord, bucket: PipelineBucket = 'running'): Promise<void> {
    const dir = this.dir(record.pipelineId, bucket);
    mkdirSync(dir, { recursive: true });
    await this.atomicWrite(this.file(record.pipelineId, bucket), record);
  }

  async read(id: string): Promise<PipelineRecord | null> {
    const bucket = this.findBucket(id);
    if (!bucket) return null;
    try {
      const raw = await Bun.file(this.file(id, bucket)).text();
      return JSON.parse(raw) as PipelineRecord;
    } catch {
      return null;
    }
  }

  async save(record: PipelineRecord): Promise<void> {
    const bucket = this.findBucket(record.pipelineId);
    if (!bucket) throw new Error(`pipeline ${record.pipelineId} not found in any bucket`);
    record.updatedAt = new Date().toISOString();
    await this.atomicWrite(this.file(record.pipelineId, bucket), record);
  }

  async move(id: string, from: PipelineBucket, to: PipelineBucket): Promise<void> {
    const srcDir = this.dir(id, from);
    const dstDir = this.dir(id, to);
    if (!existsSync(srcDir)) throw new Error(`pipeline ${id} not in ${from}`);
    mkdirSync(dstDir, { recursive: true });
    // atomic: rename the whole dir
    renameSync(srcDir, dstDir);
  }

  async listRunning(): Promise<string[]> {
    return this.list('running');
  }
  async listQueued(): Promise<string[]> {
    return this.list('queued');
  }
  private list(bucket: PipelineBucket): string[] {
    const d = join(this.root, bucket);
    if (!existsSync(d)) return [];
    return readdirSync(d).filter(
      name => !name.startsWith('.') && existsSync(join(d, name, 'pipeline.json'))
    );
  }

  /** v2.1.6.1 H1: dynamic bucket lookup so lock works regardless of moved pipeline. */
  async acquirePipelineLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const bucket = this.findBucket(id);
    if (!bucket) throw new Error(`pipeline ${id} not found in any bucket`);
    const lockFile = join(this.dir(id, bucket), '.lock');
    return withLock(lockFile, fn);
  }

  /** v2.1.6.1 C2a: global ~/.cc-linker/review-pipelines/.lock for reconciler. */
  async acquireGlobalLock<T>(fn: () => Promise<T>): Promise<T> {
    return withLock(join(this.root, '.lock'), fn);
  }

  private async atomicWrite(path: string, record: PipelineRecord): Promise<void> {
    const tmp = path + '.tmp';
    writeFileSync(tmp, JSON.stringify(record, null, 2), { mode: 0o600 });
    renameSync(tmp, path);
  }
}