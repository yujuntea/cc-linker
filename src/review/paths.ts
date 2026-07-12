// src/review/paths.ts
// v2.1.6 + v2.1.6.1 patch: 5 目录原子迁移 + 全局 reconciler 锁路径.
import { join } from 'path';
import { CC_LINKER_DIR } from '../utils/paths';

export const REVIEW_PIPELINES_DIR = join(CC_LINKER_DIR, 'review-pipelines');
export const REVIEW_RUNNING_DIR = join(REVIEW_PIPELINES_DIR, 'running');
export const REVIEW_QUEUED_DIR = join(REVIEW_PIPELINES_DIR, 'queued');
export const REVIEW_DONE_DIR = join(REVIEW_PIPELINES_DIR, 'done');
export const REVIEW_FAILED_DIR = join(REVIEW_PIPELINES_DIR, 'failed');
export const REVIEW_ABORTED_DIR = join(REVIEW_PIPELINES_DIR, 'aborted');
export const REVIEW_GLOBAL_LOCK = join(REVIEW_PIPELINES_DIR, '.lock');

export const REVIEW_PROFILES_DIR = join(CC_LINKER_DIR, 'review-profiles');

/** <cwd>/.claude/reviews/<pipelineId>.md — report path lives in the bg session cwd. */
export function reviewReportPath(cwd: string, pipelineId: string): string {
  return join(cwd, '.claude', 'reviews', `${pipelineId}.md`);
}

/** engine.pid lives inside the per-pipeline running dir. */
export function enginePidPath(pipelineId: string): string {
  return join(REVIEW_RUNNING_DIR, pipelineId, 'engine.pid');
}
