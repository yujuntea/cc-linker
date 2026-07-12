// src/review/reconciler.ts
// v2.1.6 + v2.1.6.1 patches:
//   T5c      — PANE_LOST 24h timeout + pane-alive check
//   v2.1.6.1 C2b — wrap reconcile() in store.acquireGlobalLock
//                  add maxConcurrent + promoteFn deps + promoteQueued private method
//                  add promoted field to ReconcileResult (already in types.ts)

import type { PipelineStore } from './pipeline-store';
import type { JobStateEnvelope } from '../agent-view/job-state';
import type { PipelineRecord, ReconcileResult, ReviewState } from './types';

const PANE_LOST_TIMEOUT_MS = 24 * 3600 * 1000;

export interface ReconcilerDeps {
  readJobStateFn: (short: string, jobsDir?: string) => Promise<JobStateEnvelope | null>;
  jobsDir?: string;
  /** v2.1.6.1 C2b: max concurrent running pipelines (from profile.guards.maxConcurrentPipelines; default 1). */
  maxConcurrent?: number;
  /** v2.1.6.1 C2b: invoked with promoted pipelineId (typically forks child engine). */
  promoteFn?: (pipelineId: string) => Promise<void>;
}

export class Reconciler {
  constructor(private store: PipelineStore, private deps: ReconcilerDeps) {}

  async reconcile(): Promise<ReconcileResult> {
    const result: ReconcileResult = {
      recovered: 0,
      lostPanes: 0,
      timedOut: [],
      errors: [],
      promoted: 0,
    };
    await this.store.acquireGlobalLock(async () => {
      // (1) promote queued → running if slot free
      await this.promoteQueued(result);
      // (2) PANE_LOST + pane-alive (existing logic — scan the SAME runningIds list post-promote)
      const runningIds = await this.store.listRunning();
      for (const id of runningIds) {
        try {
          const rec = await this.store.read(id);
          if (!rec) continue;
          if (rec.state.kind === 'PANE_LOST') {
            await this.handlePaneLost(rec);
            // re-read: handlePaneLost may have transitioned to ABORTED
            const after = await this.store.read(id);
            if (after?.state.kind === 'ABORTED') result.timedOut.push(id);
            continue;
          }
          if (await this.checkPanesAlive(rec)) {
            result.recovered++;
          } else {
            result.lostPanes++;
          }
        } catch (e) {
          result.errors.push(`${id}: ${e}`);
        }
      }
    });
    return result;
  }

  /** v2.1.6.1 C2b: move oldest queued → running, then call promoteFn to fork engine. */
  private async promoteQueued(result: ReconcileResult): Promise<void> {
    const max = this.deps.maxConcurrent ?? 1;
    const running = await this.store.listRunning();
    if (running.length >= max) return;
    const queued = await this.store.listQueued();
    if (queued.length === 0) return;
    const oldest = [...queued].sort()[0]; // ULID sorts lexicographically == chronologically
    await this.store.move(oldest, 'queued', 'running');
    if (this.deps.promoteFn) await this.deps.promoteFn(oldest);
    result.promoted++;
  }

  private async handlePaneLost(rec: PipelineRecord): Promise<void> {
    const detectedAt = new Date(
      rec.state.kind === 'PANE_LOST' ? rec.state.detectedAt : rec.updatedAt,
    ).getTime();
    if (Date.now() - detectedAt >= PANE_LOST_TIMEOUT_MS) {
      const aborted: ReviewState = {
        kind: 'ABORTED',
        pipelineId: rec.pipelineId,
        round: rec.state.round,
        reason: 'pane_lost_timeout',
        abortedBefore: 'PANE_LOST',
      };
      rec.state = aborted;
      await this.store.save(rec);
      await this.store.move(rec.pipelineId, 'running', 'aborted');
    }
  }

  /** Returns true if all active panes are alive. If a pane is dead, transitions to PANE_LOST + returns false. */
  private async checkPanesAlive(rec: PipelineRecord): Promise<boolean> {
    const shortIds: string[] = [];
    if (rec.panes.work?.currentRoundShortId) shortIds.push(rec.panes.work.currentRoundShortId);
    if (rec.panes.review?.shortId) shortIds.push(rec.panes.review.shortId);
    for (const short of shortIds) {
      const env = await this.deps.readJobStateFn(short, this.deps.jobsDir);
      const dead = !env || env.state.state === 'failed' || env.state.state === 'stopped';
      if (dead) {
        const lost: ReviewState = {
          kind: 'PANE_LOST',
          pipelineId: rec.pipelineId,
          round: rec.state.round,
          lostPane: {
            role: rec.panes.review?.shortId === short ? 'review' : 'work',
            shortId: short,
          },
          detectedAt: new Date().toISOString(),
          retryTarget: rec.state.kind,
        };
        rec.state = lost;
        await this.store.save(rec);
        return false;
      }
    }
    return true;
  }
}
