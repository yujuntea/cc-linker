// src/review/adapter.ts
//
// v2.1.6 + v2.1.6.1 patches:
// - C1 step 4: PollResult gains `model?: ModelInfo`, populated from state.json.respawnFlags
//              via parseModelFromRespawnFlags, so T6 engine + T8 cli-watch can show the
//              real model name (provider alias is opaque).
// - H2: poll() blocked detection narrowed to spec §4.3 — only state=blocked returns
//       { kind: 'blocked' }. running/working + needs keeps polling (was previously
//       misinterpreted as blocked, which broke busy panes).
//
// Spec §3.2.1: providerEnv 不可信,model must come from respawnFlags (CLI 自己从
// --settings 解析写入)。我们 parse 出来只展示,不驱动任何控制流。
//
// Spawn contract (v2.1.6):
//   `claude --bg <prompt> --settings <path>` with `cwd` via Bun.spawn({cwd}).
//   不要传 --bare / --worktree / --cwd / --model(后面会让 CLI 自己从 --settings 解析,
//   写进 state.json.respawnFlags,我们的 poll 再 parse 出来)。

import { readJobState, type JobStateEnvelope } from '../agent-view/job-state';
import { parseModelFromRespawnFlags } from './model-parser';
import type { BlockedResult, ModelInfo } from './types';

export interface StartSessionOpts {
  prompt: string;
  settingsPath: string;
  cwd: string;
}
export interface ResumeWorkSessionOpts extends StartSessionOpts {
  sessionId: string;
}

export type PollResult =
  | { kind: 'running'; model?: ModelInfo }
  | { kind: 'done'; output: string; sessionId?: string; model?: ModelInfo }
  | { kind: 'blocked'; blocked: BlockedResult }
  | { kind: 'lost' };

export class PollTimeoutError extends Error {}

export interface AdapterDeps {
  jobsDir?: string;
  readJobStateFn?: (short: string, jobsDir?: string) => Promise<JobStateEnvelope | null>;
  spawnFn?: (args: string[], opts: { cwd: string }) => { stdout: string; stderr: string; shortId: string };
}

export class ClaudeBGAdapter {
  private readonly jobsDir?: string;
  private readonly readJobStateFn: (short: string, jobsDir?: string) => Promise<JobStateEnvelope | null>;
  private readonly spawnFn?: AdapterDeps['spawnFn'];

  constructor(deps: AdapterDeps = {}) {
    this.jobsDir = deps.jobsDir;
    this.readJobStateFn = deps.readJobStateFn ?? ((short, dir) => readJobState(short, dir));
    this.spawnFn = deps.spawnFn;
  }

  /**
   * Spawn a new bg session. Returns { shortId, sessionId }.
   * v2.1.6 spawn contract: `claude --bg <prompt> --settings <path>`, cwd via Bun.spawn({cwd}).
   * Do NOT pass --bare/--worktree/--cwd/--model.
   */
  async startSession(opts: StartSessionOpts): Promise<{ shortId: string; sessionId: string }> {
    const args = ['claude', '--bg', opts.prompt, '--settings', opts.settingsPath];
    const { stdout, shortId } = this.runClaude(args, opts.cwd);
    // parse "backgrounded · <shortId>" from stdout
    const match = stdout.match(/backgrounded\s*[·-]\s*([0-9a-f]{8})/i);
    if (!match) throw new Error(`failed to parse shortId from claude --bg output: ${stdout}`);
    const sid = match[1];
    // poll state.json to get sessionId
    const sessionId = await this.waitForSessionId(sid);
    return { shortId: sid, sessionId };
  }

  /** Resume work session: --bg <prompt> --resume <sessionId> --reply-on-resume. New shortId, same sessionId. */
  async resumeWorkSession(opts: ResumeWorkSessionOpts): Promise<{ shortId: string; sessionId: string }> {
    const args = ['claude', '--bg', opts.prompt, '--resume', opts.sessionId, '--reply-on-resume', '--settings', opts.settingsPath];
    const { stdout } = this.runClaude(args, opts.cwd);
    const match = stdout.match(/backgrounded\s*[·-]\s*([0-9a-f]{8})/i);
    if (!match) throw new Error(`failed to parse shortId: ${stdout}`);
    return { shortId: match[1], sessionId: opts.sessionId };
  }

  /**
   * Poll state.json every 500ms until terminal/timeout.
   *
   * v2.1.6.1 H2: blocked detection narrowed to spec §4.3 — only `state === 'blocked'`
   * is treated as blocked. running/working + needs keeps polling (CLI 用 needs 表达
   * 交互等待,但 worker 进程还在跑;以前误归 blocked → busy pane 假死)。
   *
   * v2.1.6.1 C1 step 4: attach `model` (from state.json.respawnFlags) on done/running
   * variants so the engine can publish it to PaneWork/PaneReview.modelName.
   */
  async poll(shortId: string, timeoutMs: number): Promise<PollResult> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const env = await this.readJobStateFn(shortId, this.jobsDir);
      if (!env) return { kind: 'lost' };
      const s = env.state;
      // v2.1.6.1 C1 step 4: parse model from respawnFlags once per call
      const model = parseModelFromRespawnFlags(s.respawnFlags);
      if (s.state === 'done') {
        const output = (s as any).output?.result ?? '';
        return { kind: 'done', output, sessionId: s.sessionId, model: model ?? undefined };
      }
      if (s.state === 'failed' || s.state === 'stopped') return { kind: 'lost' };
      // v2.1.6.1 H2: narrowed — only literal `state === 'blocked'` triggers blocked;
      // running/working + needs continues polling (was previously wrongly aborted).
      if (s.state === 'blocked') {
        return { kind: 'blocked', blocked: { kind: 'unexpected', raw: s.needs ?? s.detail ?? '' } };
      }
      // v2.1.6.1: running/working is a valid intermediate state — return snapshot
      // immediately so callers can update the pane and decide whether to keep polling.
      // (Spec §4.3: poll returns the current envelope; timeout is for callers who want
      // to wait longer, not for us to silently spin.)
      if (s.state === 'running' || s.state === 'working') {
        return { kind: 'running', model: model ?? undefined };
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new PollTimeoutError(`poll timeout for ${shortId} after ${timeoutMs}ms`);
  }

  async stop(shortId: string): Promise<void> {
    // Use '/' as a stable cwd: `claude stop <short>` is a daemon-scope op that does
    // not depend on per-session cwd. Avoiding `process.cwd()` removes the ENOENT
    // risk when the user's working directory is deleted between fork and stop
    // (e.g. cancel/abort flow during an `rm -rf cwd`).
    this.runClaude(['claude', 'stop', shortId], '/');
  }

  private runClaude(args: string[], cwd: string): { stdout: string; stderr: string; shortId: string } {
    if (this.spawnFn) return this.spawnFn(args, { cwd });
    // real spawn: use Bun.spawn synchronously-captured
    const proc = Bun.spawnSync({ cmd: args, cwd, stdout: 'pipe', stderr: 'pipe' });
    const stdout = proc.stdout.toString();
    const stderr = proc.stderr.toString();
    const m = stdout.match(/backgrounded\s*[·-]\s*([0-9a-f]{8})/i);
    return { stdout, stderr, shortId: m?.[1] ?? '' };
  }

  private async waitForSessionId(shortId: string): Promise<string> {
    for (let i = 0; i < 60; i++) {
      const env = await this.readJobStateFn(shortId, this.jobsDir);
      if (env?.state.sessionId) return env.state.sessionId;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`timeout waiting for sessionId of ${shortId}`);
  }
}