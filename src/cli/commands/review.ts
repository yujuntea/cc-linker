// src/cli/commands/review.ts
// v2.1.6 + v2.1.6.1 patches:
//   T7          — register review subcommand group (run/status/abort/cancel/skip/resume/report/doctor/profiles)
//   v2.1.6.1 C2c — review run: lazy promote queued if slot free, write to queued/ if full
//   v2.1.6.1 C3  — cancel/abort share cancelOrAbort(id, reason) helper:
//                   kill engine FIRST, then per-pipeline-lock → read → write ABORTED → save → move
//   v2.1.6.1 C4b — review report: read record, renderReport, output to stdout or --out
//   v2.1.6.1 M2  — _engine-loop action early-returns unless CC_LINKER_REVIEW_ENGINE_CHILD === '1'
//                  (added by T9b, this entry point must be present in T7)
//   v2.1.6.1 M3  — review skip stays as TODO stub (Phase 2 user-skip flow)

import { Command } from 'commander';
import chalk from 'chalk';
import { readdirSync } from 'fs';
import { runDoctor } from '../../review/review-doctor';
import { loadProfile } from '../../review/profile';
import { detect } from '../../review/phase-detect';
import { PipelineStore } from '../../review/pipeline-store';
import { renderReport } from '../../review/engine';
import { isTerminal } from '../../review/types';
import {
  REVIEW_PIPELINES_DIR,
  REVIEW_PROFILES_DIR,
} from '../../review/paths';

// v2.1.6.1 patch C3: kill engine FIRST, then per-pipeline-lock + read + write ABORTED + save + move.
// Imports of `killEngine` + `forkEngine` + `isEngineAlive` resolve at runtime via dynamic import
// because src/review/engine-process.ts is created in T9b (deferred).
type EngineProcessModule = {
  killEngine(pipelineId: string): Promise<void>;
  forkEngine(pipelineId: string): Promise<void>;
  isEngineAlive(pipelineId: string): Promise<boolean>;
  runEngineLoop(pipelineId: string): Promise<void>;
};

async function loadEngineProcess(): Promise<EngineProcessModule> {
  // v2.1.6.1 + T9b: engine-process.ts created by T9b. The dynamic import path
  // is resolved at runtime; we cast through `unknown` to defer module resolution
  // until T9b ships — typecheck is satisfied via the local EngineProcessModule shape.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = await (import('../../review/engine-process') as unknown as Promise<any>);
  return mod as EngineProcessModule;
}

// v2.1.6.1 patch C3: shared helper for `review cancel` and `review abort`.
async function cancelOrAbort(
  pipelineId: string,
  reason: 'user_cancelled' | 'user_aborted',
): Promise<void> {
  // (1) Kill engine FIRST — prevents in-flight adapter.poll from racing to save over our state change.
  let engineMod: EngineProcessModule;
  try {
    engineMod = await loadEngineProcess();
  } catch (e) {
    console.log(chalk.red(`engine-process module unavailable: ${(e as Error).message}`));
    return;
  }
  try {
    await engineMod.killEngine(pipelineId);
  } catch (e) {
    console.log(chalk.yellow(`killEngine warning: ${(e as Error).message}`));
  }

  // (2) Acquire per-pipeline lock, then write ABORTED + move bucket.
  const store = new PipelineStore(REVIEW_PIPELINES_DIR);
  await store.acquirePipelineLock(pipelineId, async () => {
    const rec = await store.read(pipelineId);
    if (!rec) {
      console.log(chalk.yellow(`pipeline ${pipelineId} not found (already gone?)`));
      return;
    }
    if (isTerminal(rec.state.kind)) {
      console.log(chalk.yellow(`already ${rec.state.kind}, no-op`));
      return;
    }
    const fromBucket = (await store.findBucketPublic(pipelineId)) ?? 'running';
    const before = rec.state.kind;
    rec.state = {
      kind: 'ABORTED',
      pipelineId,
      round: rec.state.round,
      reason,
      abortedBefore: before,
    };
    rec.history.push({
      ts: new Date().toISOString(),
      fromState: before,
      toState: 'ABORTED',
      round: rec.state.round,
      role: 'human',
      inputDigest: '',
      outputDigest: '',
      outputSizeBytes: 0,
      durationMs: 0,
    });
    await store.save(rec);
    await store.move(pipelineId, fromBucket, 'aborted');
    console.log(chalk.yellow(`✓ ${before} → ABORTED (${reason})`));
  });
}

// M1: inline ulid() stub. Adequate for Phase 1; replace with `ulid` package in v2.1.6.2.
// TODO(v2.1.6.2): add ulid package for proper monotonic ids.
function ulid(): string {
  const ts = Date.now().toString(36).toUpperCase().padStart(10, '0');
  const rand = Math.random().toString(36).slice(2, 12).toUpperCase().padStart(10, '0');
  return ts + rand;
}

export function reviewCommand(program: Command): void {
  const review = program
    .command('review')
    .description('多模型 Review Engine (run/status/cancel/report/...)');

  // --- run ---
  // v2.1.6.1 C2c: list running, lazy promote queued if slot free, then write to queued if full
  // or running if not. forkEngine happens only when targetBucket === 'running'.
  review
    .command('run <task>')
    .description('启动一个 review pipeline (自动检测 phase / 默认 profile)')
    .option('--phase <phase>', 'spec | plan | code (auto-detect if omitted)')
    .option('--profile <name>', 'review profile name', 'default')
    .option('--max-rounds <n>', 'override max rounds', (v) => parseInt(v, 10))
    .option('--watch', 'attach rich terminal view')
    .option('--cwd <path>', 'working directory (default: process.cwd())')
    .option('--inject-text <text>', 'extra context injected into prompts')
    .action(async (task: string, opts: any) => {
      const cwd = opts.cwd ?? process.cwd();
      let phase: 'spec' | 'plan' | 'code';
      try {
        phase = opts.phase ?? detect({ rawInput: task });
      } catch (e) {
        console.log(chalk.red(`phase detection failed: ${(e as Error).message}`));
        process.exit(1);
      }
      const profile = await loadProfile(opts.profile, phase);
      const store = new PipelineStore(REVIEW_PIPELINES_DIR);

      // (a) v2.1.6.1 C2c: lazy promote — if any queued pipeline can be moved up, do it first.
      const initialRunning = await store.listRunning();
      if (initialRunning.length < profile.guards.maxConcurrentPipelines) {
        const queued = await store.listQueued();
        if (queued.length > 0) {
          const oldest = [...queued].sort()[0];
          await store.move(oldest, 'queued', 'running');
          try {
            const engineMod = await loadEngineProcess();
            await engineMod.forkEngine(oldest);
          } catch (e) {
            console.log(chalk.yellow(`forkEngine for promoted ${oldest} failed: ${(e as Error).message}`));
          }
          console.log(chalk.yellow(`⏫ promoted ${oldest} from queued → running`));
        }
      }

      const pipelineId = ulid();
      const runningNow = await store.listRunning();
      const targetBucket: 'running' | 'queued' =
        runningNow.length >= profile.guards.maxConcurrentPipelines ? 'queued' : 'running';

      if (targetBucket === 'queued') {
        const position = (await store.listQueued()).length + 1;
        console.log(chalk.yellow(`⏳ Pipeline queued at position ${position} (max=${profile.guards.maxConcurrentPipelines})`));
      }

      await store.create(
        {
          pipelineId,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          state: { kind: 'PRODUCING', pipelineId, round: 0 },
          input: {
            rawInput: task,
            phase,
            profile: opts.profile,
            maxRounds: opts.maxRounds ?? profile.guards.maxRounds,
            cwd,
          },
          panes: {},
          history: [],
        },
        targetBucket,
      );

      if (targetBucket === 'running') {
        try {
          const engineMod = await loadEngineProcess();
          await engineMod.forkEngine(pipelineId);
        } catch (e) {
          console.log(chalk.red(`forkEngine failed: ${(e as Error).message}`));
          process.exit(1);
        }
        console.log(chalk.green(`✓ Pipeline started: ${pipelineId}`));
      }

      if (opts.watch) {
        const { watchPipeline } = await import('../../review/cli-watch');
        await watchPipeline(pipelineId);
      }
    });

  // --- status ---
  review
    .command('status <id>')
    .description('查看 pipeline 当前状态')
    .option('--follow', 'poll every 500ms')
    .action(async (id: string, opts: any) => {
      const store = new PipelineStore(REVIEW_PIPELINES_DIR);
      const rec = await store.read(id);
      if (!rec) {
        console.log(chalk.red(`pipeline ${id} not found`));
        process.exit(1);
      }
      console.log(chalk.cyan(`Pipeline ${id}: ${rec.state.kind} (round ${rec.state.round})`));
      if (opts.follow) {
        const { watchPipeline } = await import('../../review/cli-watch');
        await watchPipeline(id);
      }
    });

  // --- cancel ---
  // v2.1.6.1 C3: uses cancelOrAbort(id, 'user_cancelled')
  review
    .command('cancel <id>')
    .description('取消 pipeline (graceful — 等当前轮结束 + 写 ABORTED + 移动到 aborted/)')
    .option('--reason <text>', 'cancel reason')
    .action(async (id: string) => {
      await cancelOrAbort(id, 'user_cancelled');
    });

  // --- abort ---
  // v2.1.6.1 C3: uses cancelOrAbort(id, 'user_aborted')
  review
    .command('abort <id>')
    .description('立即中止 pipeline (硬中断 — 不等当前轮)')
    .action(async (id: string) => {
      await cancelOrAbort(id, 'user_aborted');
    });

  // --- skip ---
  // v2.1.6.1 M3: stub for v2.1.6. Phase 2 will wire PANE_LOST user-skip → state advance + degraded tracking.
  review
    .command('skip <id>')
    .description('skip current round (Phase 2 — stub in v2.1.6)')
    .option('--reason <text>', 'skip reason')
    .action(async (id: string) => {
      // TODO(v2.1.6.2): implement PANE_LOST skip flow + degraded tracking.
      console.log(chalk.gray(`skip ${id} (degraded) — stub in v2.1.6`));
    });

  // --- resume ---
  review
    .command('resume <id>')
    .description('re-attach engine to an existing pipeline')
    .action(async (id: string) => {
      let alive = false;
      try {
        const engineMod = await loadEngineProcess();
        alive = await engineMod.isEngineAlive(id);
      } catch (e) {
        console.log(chalk.yellow(`engine-process module unavailable: ${(e as Error).message}`));
      }
      if (alive) {
        console.log(chalk.yellow('engine still running, use `status --follow`'));
        return;
      }
      try {
        const engineMod = await loadEngineProcess();
        await engineMod.forkEngine(id);
      } catch (e) {
        console.log(chalk.red(`forkEngine failed: ${(e as Error).message}`));
        process.exit(1);
      }
      console.log(chalk.green(`✓ Resumed ${id}`));
    });

  // --- report ---
  // v2.1.6.1 C4b: read record, renderReport, output to stdout or --out.
  review
    .command('report <id>')
    .description('渲染 pipeline 报告 (markdown 默认; --format json)')
    .option('--format <fmt>', 'md | json', 'md')
    .option('--out <file>', 'output file')
    .option('--partial', 'allow partial report for non-terminal pipeline')
    .action(async (id: string, opts: any) => {
      const store = new PipelineStore(REVIEW_PIPELINES_DIR);
      const rec = await store.read(id);
      if (!rec) {
        console.log(chalk.red(`pipeline ${id} not found`));
        process.exit(1);
      }
      if (!isTerminal(rec.state.kind) && !opts.partial) {
        console.log(
          chalk.yellow(
            `pipeline ${id} not yet terminal (state=${rec.state.kind}); use --partial`,
          ),
        );
        return;
      }
      if (opts.format === 'json') {
        const out = JSON.stringify(rec, null, 2);
        if (opts.out) {
          await Bun.write(opts.out, out);
          console.log(chalk.green(`✓ wrote ${opts.out}`));
        } else {
          console.log(out);
        }
        return;
      }
      const md = await renderReport(rec);
      if (opts.out) {
        await Bun.write(opts.out, md);
        console.log(chalk.green(`✓ wrote ${opts.out}`));
      } else {
        console.log(md);
      }
    });

  // --- doctor ---
  review
    .command('doctor')
    .description('健康检查: CLI 版本 / daemon / profile / clean tree / pipeline dir')
    .action(async () => {
      const ok = await runDoctor();
      if (!ok) process.exit(1);
    });

  // --- profiles ---
  review
    .command('profiles')
    .description('列出已安装的 review profile (从 ~/.cc-linker/review-profiles/)')
    .action(async () => {
      try {
        const files = readdirSync(REVIEW_PROFILES_DIR).filter((f) => f.endsWith('.toml'));
        if (files.length === 0) {
          console.log(chalk.gray('(no profiles)'));
          return;
        }
        for (const f of files) console.log(f.replace(/\.toml$/, ''));
      } catch {
        console.log(chalk.gray('(no profiles)'));
      }
    });

  // --- _engine-loop ---
  // v2.1.6.1 M2: only the forked child process sets CC_LINKER_REVIEW_ENGINE_CHILD=1;
  // refuse any other invocation. The actual runEngineLoop() is exported from
  // src/review/engine-process.ts (created by T9b) and resolved at runtime via
  // dynamic import.
  review
    .command('_engine-loop <id>', '', { hidden: true })
    .description('internal — only spawnable via cc-linker review run')
    .action(async (id: string) => {
      if (process.env.CC_LINKER_REVIEW_ENGINE_CHILD !== '1') {
        // Defensive: only the forked child process sets this env var; refuse any other invocation.
        console.error('_engine-loop is internal; spawn via `cc-linker review run`');
        process.exit(1);
      }
      try {
        const engineMod = await loadEngineProcess();
        await engineMod.runEngineLoop(id);
      } catch (e) {
        console.error(chalk.red(`runEngineLoop failed: ${(e as Error).message}`));
        process.exit(1);
      }
    });
}