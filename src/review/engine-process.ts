// src/review/engine-process.ts
// v2.1.6 + v2.1.6.1 patch C2d: fork / pid / SIGTERM / long-running engine loop.
//
// C2d: the reconciler constructed in runEngineLoop now gets
//   maxConcurrent: profile.guards.maxConcurrentPipelines
//   promoteFn:    async (id) => forkEngine(id)
// so the reconciler can promote queued → running when a slot frees up.

import { existsSync, writeFileSync, readFileSync, unlinkSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { spawn, spawnSync } from 'child_process';
import { isPidAlive } from '../utils/pid';
import { enginePidPath, REVIEW_PIPELINES_DIR } from './paths';
import { PipelineStore } from './pipeline-store';
import { Reconciler } from './reconciler';
import { ReviewEngine } from './engine';
import { ClaudeBGAdapter } from './adapter';
import { readJobState } from '../agent-view/job-state';
import type { PipelineRecord } from './types';
import type { ResolvedProfile } from './profile';

interface EnginePidEntry {
  pid: number;
  /** wall-clock ms when engine started — v2.1.5 P1-5 PID reuse protection. */
  startTime: number;
}

/** Write {pid, startTime} JSON pidfile. v2.1.5 P1-5 PID-reuse defence. */
export function writeEnginePid(pidFile: string, pid: number, startTime: number): void {
  mkdirSync(dirname(pidFile), { recursive: true });
  writeFileSync(pidFile, JSON.stringify({ pid, startTime }), { mode: 0o600 });
}

/**
 * Read pidfile + verify the pid is still alive (and *is* the cc-linker/review process
 * — best-effort command-name check filters out PID reuse).
 * Returns the pid, or null if dead / reused / missing / malformed.
 */
export function readEnginePidWithCheck(pidFile: string): number | null {
  if (!existsSync(pidFile)) return null;
  try {
    const entry = JSON.parse(readFileSync(pidFile, 'utf8')) as EnginePidEntry;
    if (!isPidAlive(entry.pid)) return null;
    // best-effort PID-reuse defence: ps -o command= should mention cc-linker/review.
    // Phase 3 will tighten this to a strict /proc/<pid> lstart comparison.
    try {
      const cmd = spawnSync('ps', ['-o', 'command=', '-p', String(entry.pid)], { encoding: 'utf8' }).stdout ?? '';
      if (!/cc-linker|review/.test(cmd)) return null;
    } catch {
      // ps failed — trust isPidAlive
    }
    return entry.pid;
  } catch {
    return null;
  }
}

export function isEngineAlive(pipelineId: string): boolean {
  return readEnginePidWithCheck(enginePidPath(pipelineId)) !== null;
}

/**
 * Fork the engine as a detached background process running `review _engine-loop <id>`.
 * Uses getExecutablePath() (matches start.ts/img-proxy pattern) so argv[1] resolves
 * correctly under compiled-binary mode.
 *
 * v2.1.6.1 post-review fix (M5): when `child.pid` is undefined (fork failed silently),
 * the cli claims `✓ Pipeline started` but no engine is alive. Throw so callers
 * (review run / cancelOrAbort / reconciler promote) surface the failure.
 */
export async function forkEngine(pipelineId: string): Promise<void> {
  const { getExecutablePath } = await import('../utils/executable');
  const pidFile = enginePidPath(pipelineId);
  mkdirSync(dirname(pidFile), { recursive: true });
  const exe = getExecutablePath();
  const child = spawn(exe, ['review', '_engine-loop', pipelineId], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, CC_LINKER_REVIEW_ENGINE_CHILD: '1' },
  });
  child.unref();
  if (child.pid === undefined) {
    throw new Error(`forkEngine: child.pid is undefined for pipeline ${pipelineId} (spawn failed silently)`);
  }
  writeEnginePid(pidFile, child.pid, Date.now());
}

/** SIGTERM the engine (graceful, 3s grace), then SIGKILL + clear pidfile. */
export async function killEngine(pipelineId: string): Promise<void> {
  const pidFile = enginePidPath(pipelineId);
  const pid = readEnginePidWithCheck(pidFile);
  if (pid === null) {
    if (existsSync(pidFile)) unlinkSync(pidFile);
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
    for (let i = 0; i < 30; i++) {
      if (!isPidAlive(pid)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (isPidAlive(pid)) process.kill(pid, 'SIGKILL');
  } catch {
    // already dead — fine
  }
  if (existsSync(pidFile)) unlinkSync(pidFile);
}

/**
 * The long-running engine loop. Runs inside the forked child process.
 * Drives the pipeline state machine + reconciles every 60s.
 *
 * v2.1.6.1 patch C2d: the Reconciler is wired with `maxConcurrent` from the profile
 * and a `promoteFn` that spawns a fresh `forkEngine` for any queued pipeline that
 * takes the freed-up slot.
 */
export async function runEngineLoop(pipelineId: string): Promise<void> {
  const store = new PipelineStore(REVIEW_PIPELINES_DIR);
  const adapter = new ClaudeBGAdapter();
  const engine = new ReviewEngine(store, adapter);

  const profile = await loadProfileForPipeline(pipelineId);
  const reconciler = new Reconciler(store, {
    readJobStateFn: readJobState,
    maxConcurrent: profile.guards.maxConcurrentPipelines,
    promoteFn: async (id: string) => {
      await forkEngine(id);
    },
  });

  const rec = await store.read(pipelineId);
  if (!rec) throw new Error(`pipeline ${pipelineId} not found`);

  // Run the pipeline and reconcile concurrently. Reconciliation catches PANE_LOST
  // (24h timeout → ABORTED) + auto-promotes queued when a slot frees (C2d).
  // rec.input.phase is the wider Phase union including 'unknown', but the `review run`
  // CLI validates via detect() so this is always one of the three valid phases at runtime.
  const phase = rec.input.phase as 'spec' | 'plan' | 'code';
  const pipelinePromise = engine.runPipeline(pipelineId, rec.input.rawInput, phase, profile);
  const reconcileTimer = setInterval(() => {
    reconciler.reconcile().catch(() => {});
  }, 60_000);

  try {
    await pipelinePromise;
  } finally {
    clearInterval(reconcileTimer);
  }
}

/** v2.1.6.1: load profile using phase recorded in the pipeline record. */
async function loadProfileForPipeline(pipelineId: string): Promise<ResolvedProfile> {
  const store = new PipelineStore(REVIEW_PIPELINES_DIR);
  const rec: PipelineRecord | null = await store.read(pipelineId);
  if (!rec) throw new Error(`pipeline ${pipelineId} not found`);
  const { loadProfile } = await import('./profile');
  return loadProfile(rec.input.profile, rec.input.phase);
}
