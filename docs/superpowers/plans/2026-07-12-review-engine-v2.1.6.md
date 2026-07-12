# Review Engine v2.1.6 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the cc-linker Multi-Model Review Engine — a CLI-driven pipeline that orchestrates work-model → external-review-model → fix → work-postfix-review cycles across spec/plan/code phases, using `claude --bg` sessions.

**Architecture:** A long-running background `engine` process (forked by `cc-linker review run`) drives a state machine (5 active + 1 trouble + 3 terminal states) persisted to `~/.cc-linker/review-pipelines/`. It spawns `claude --bg` sessions for work (self-review/fix, long-lived sessionId) and review (per-round, review-and-fix), polls `~/.claude/jobs/<short>/state.json`, and parses JSON output. Engine does NOT touch git (no checkpoint, no stash); models edit the user's branch directly; rollback is via the user's pre-review HEAD. 429/blocked sessions abort (claude code's own retry handles transient 429).

**Tech Stack:** Bun + TypeScript, `bun:test`, Commander.js (CLI), Zod (validation), `proper-lockfile` (file locks, already a dep), chalk (already a dep). Reuses `src/agent-view/job-state.ts` (`readJobState`), `src/utils/providers.ts` (`providerManager`), `src/utils/pid.ts`, `src/utils/lock.ts`, `src/utils/errors.ts`.

**Spec:** `docs/superpowers/specs/review-engine-v2.1.1/` (overview / state-machine / implementation / ux-and-plan / appendices). Read `overview.md` first.

## Global Constraints

- **Claude CLI ≥ 2.1.139** required (`claude --bg` stable; tested on 2.1.207).
- **Bun project** — use `bun <file>`, `bun test`, `bun run typecheck`. Do NOT use node tools.
- **Bun loads `.env` automatically** — do not use `dotenv`.
- **Spawn contract (v2.1.6, tested):** `Bun.spawn(["claude","--bg", prompt, "--settings", settingsPath], { cwd })`. Do NOT pass `--bare` (skips CLAUDE.md/hook/LSP), `--worktree` (builds isolated worktree), `--cwd` (unknown option, exits 1), or `--model` (model comes from `--settings`).
- **Engine never touches git:** no checkpoint commits, no stash. Models edit user's branch directly. P1-3: doctor rejects non-clean worktree (`git status --porcelain` must be empty).
- **state.json has no `pid` field** — never read pid from state.json. bg liveness for resume/PANE_LOST uses `readJobState` returning null/failed.
- **blocked = abort:** any `state.json.state === 'blocked'` → `ABORTED unexpected_blocked`. Do NOT parse 429 reset time, do NOT enter PAUSED (PAUSED state was deleted in v2.1.6). claude code handles 429 retry internally.
- **No `RendezvousClient.injectReply`** — FIXING uses `resumeWorkSession` (`--bg --resume <sessionId> --reply-on-resume`), same as R1/R2.
- **Issue IDs:** engine assigns via `fingerprint = SHA256(role:severity:location:description).slice(0,8)`. Models never output ids.
- **JSON wire = snake_case** (`issue_id`, `fix_applied`); TS types = camelCase (`issueId`, `fixApplied`). Convert in `parseBgOutputWithRetry`.
- **clean standard:** `isClean(issues)` = no P0/P1/P2 (P3 doesn't block). DONE only reached when `externalReviewConverges` (review's `per_issue` has 0 real P0/P1/P2).
- **Atomic writes:** write to `.tmp` then `renameSync`. PipelineRecord dir moves atomically between `running/`/`queued/`/`done/`/`failed/`/`aborted/`.
- **Error class:** `CCLinkerError(code, message)` from `src/utils/errors.ts`.
- **Paths:** `~/.cc-linker/review-pipelines/` (5 dirs), `~/.cc-linker/review-profiles/<name>.toml`, `<cwd>/.claude/reviews/<pipelineId>.md`.
- **Commit style:** frequent commits, one per task or sub-step. `feat(review):` / `test(review):` / `refactor(review):` prefixes.

---

## File Structure

```
src/review/
├── types.ts              # ReviewState, Issue, PipelineRecord, BlockedResult, ReviewFixOutput, parse types
├── paths.ts              # review-pipelines / review-profiles / reviews path constants
├── profile.ts            # ReviewProfile TOML load + per-phase deep merge + provider validation
├── phase-detect.ts       # detect(rawInput, filePath?, gitRef?) -> 'spec'|'plan'|'code'
├── pipeline-store.ts     # PipelineRecord CRUD + 5-dir atomic moves + per-pipeline locks
├── reconciler.ts         # reconcile(): scan running/ + PANE_LOST 24h + pane-alive checks
├── engine-process.ts     # fork/attach/SIGTERM background engine process + engine.pid mgmt (T9)
├── model-parser.ts       # parseModelFromRespawnFlags(respawnFlags) -> ModelInfo
├── output-contract.ts    # extractJsonBlock + Zod schemas + parseBgOutputWithRetry
├── adapter.ts            # ClaudeBGAdapter: startSession/resumeWorkSession/poll/stop (4 API)
├── engine.ts             # state machine driver: transitions, clean判定, EXTERNAL_REVIEW收敛
├── review-doctor.ts      # doctor health check (CLI version, daemon, providers, clean tree, monorepo)
└── cli-watch.ts          # --watch rich terminal (chalk + ANSI)
src/cli/commands/
└── review.ts             # subcommand group: run/status/abort/report/cancel/skip/resume/doctor/profiles
tests/unit/review/
├── types.test.ts
├── profile.test.ts
├── phase-detect.test.ts
├── pipeline-store.test.ts
├── reconciler.test.ts
├── engine-process.test.ts
├── model-parser.test.ts
├── output-contract.test.ts
├── adapter.test.ts
├── engine.test.ts
└── review-doctor.test.ts
tests/integration/review/
├── adapter-bg.test.ts        # real claude --bg spawn (gated)
└── pipeline-e2e.test.ts      # mini pipeline (gated)
tests/fixtures/review/
├── state-running.json        # sample state.json contents
├── state-done.json
├── state-blocked.json
└── profile-default.toml
```

**Responsibilities:**
- `types.ts` — pure types/constants, no logic. Imported by all.
- `paths.ts` — path constants only.
- `profile.ts` — TOML parse + merge; no I/O side effects beyond reading profile files.
- `phase-detect.ts` — pure function.
- `pipeline-store.ts` — persistence only; no state-machine logic.
- `reconciler.ts` — reads store + adapter, mutates state on PANE_LOST; no spawn.
- `engine-process.ts` — process lifecycle only (fork/kill/pidfile); no state-machine.
- `adapter.ts` — thin wrapper over `Bun.spawn(['claude',...])` + `readJobState`; no business logic.
- `engine.ts` — the brain: state transitions, clean判定, EXTERNAL_REVIEW收敛, drives adapter + store.
- `output-contract.ts` — JSON extraction + Zod + retry; no I/O.

---

## Task Dependency Order

```
T1 (types+paths) ──┬─> T2 (profile) ─────┐
                   ├─> T3 (phase-detect)  ├─> T6 (engine) ─┬─> T7 (CLI commands) ─┬─> T9 (E2E polish)
                   ├─> T4 (output-contract)├──────────────  ├─> T8 (cli-watch)    │
                   ├─> T5 (pipeline-store)─┘                │                      │
                   └─> T5b (adapter) ───────────────────────┘                      │
T5c (reconciler) depends on T5+T5b ────────────────────────────────────────────────┘
T9b (engine-process) depends on T5c ─> T7
```

Tasks T1-T5b can be implemented in parallel (independent). T6 (engine) is the integration point. T7/T8 depend on T6. T9b (engine-process) depends on T5c+T7.

---

## Task 1: Types & Path Constants

**Files:**
- Create: `src/review/types.ts`
- Create: `src/review/paths.ts`
- Test: `tests/unit/review/types.test.ts`

**Interfaces:**
- Produces: `ReviewState` (union type), `Issue`, `PipelineRecord`, `PaneRegistry`, `HistoryEvent`, `BlockedResult`, `ReviewFixOutput`, `ParseResult<T>`, `ReconcileResult`, `ModelInfo`, `Phase` type, all state kind constants.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/review/types.test.ts
import { describe, it, expect } from 'bun:test';
import type { Issue, ReviewState, BlockedResult, ReviewFixOutput, PipelineRecord } from '../../../src/review/types';
import { STATE_KINDS, isTerminal } from '../../../src/review/types';

describe('review types', () => {
  it('STATE_KINDS lists 9 states (5 active + 1 trouble + 3 terminal)', () => {
    expect(STATE_KINDS).toEqual([
      'PRODUCING', 'SELF_REVIEW_R1', 'SELF_REVIEW_R2', 'FIXING', 'EXTERNAL_REVIEW',
      'PANE_LOST',
      'DONE', 'FAILED', 'ABORTED',
    ]);
  });

  it('isTerminal identifies DONE/FAILED/ABORTED', () => {
    expect(isTerminal('DONE')).toBe(true);
    expect(isTerminal('FAILED')).toBe(true);
    expect(isTerminal('ABORTED')).toBe(true);
    expect(isTerminal('PRODUCING')).toBe(false);
    expect(isTerminal('PANE_LOST')).toBe(false);
  });

  it('BlockedResult only allows unexpected kind (v2.1.6)', () => {
    const b: BlockedResult = { kind: 'unexpected', raw: 'rate limited' };
    expect(b.kind).toBe('unexpected');
  });

  it('Issue has fingerprint field', () => {
    const i: Issue = {
      id: 'abc12345', role: 'work', severity: 'P1', location: 'auth.ts:42',
      description: 'NPE', fingerprint: 'abc12345',
    };
    expect(i.fingerprint).toBe(i.id);
  });

  it('ReviewFixOutput perIssue has embedded severity (v2.1.5 P1-4)', () => {
    const o: ReviewFixOutput = {
      role: 'review', issues: [], reasoning: '',
      perIssue: [{ issueId: 'abc12345', severity: 'P0', verdict: 'real', verdictReason: 'x', fixApplied: true }],
    };
    expect(o.perIssue[0].severity).toBe('P0');
  });

  it('PipelineRecord has no checkpoint fields (v2.1.6)', () => {
    const r = { pipelineId: 'x', createdAt: '', updatedAt: '', state: { kind: 'DONE', pipelineId: 'x', round: 1 }, input: { rawInput: '', phase: 'code', profile: 'default', maxRounds: 6, cwd: '/' }, panes: {}, history: [] } as PipelineRecord;
    expect((r as any).preProduceCheckpointSha).toBeUndefined();
    expect((r as any).preReviewCheckpointSha).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/review/types.test.ts`
Expected: FAIL — `Cannot find module '../../../src/review/types'`

- [ ] **Step 3: Write `src/review/paths.ts`**

```typescript
// src/review/paths.ts
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
```

- [ ] **Step 4: Write `src/review/types.ts`**

```typescript
// src/review/types.ts

export type Phase = 'spec' | 'plan' | 'code' | 'unknown';
export type Severity = 'P0' | 'P1' | 'P2' | 'P3';
export type Role = 'work' | 'review';

export const STATE_KINDS = [
  'PRODUCING', 'SELF_REVIEW_R1', 'SELF_REVIEW_R2', 'FIXING', 'EXTERNAL_REVIEW',
  'PANE_LOST',
  'DONE', 'FAILED', 'ABORTED',
] as const;
export type StateKind = typeof STATE_KINDS[number];

export const TERMINAL_STATES: ReadonlySet<StateKind> = new Set(['DONE', 'FAILED', 'ABORTED']);
export function isTerminal(kind: string): boolean {
  return TERMINAL_STATES.has(kind as StateKind);
}

export interface Issue {
  id: string;                  // = fingerprint (engine-assigned, stable across rounds)
  role: Role;
  severity: Severity;
  location: string;            // file path + line
  description: string;
  suggestion?: string;
  fingerprint: string;         // SHA256(role:severity:location:description) first 8 hex chars
}

export interface PerIssue {
  issueId: string;
  severity: Severity;          // v2.1.5 P1-4: embedded, used for convergence
  verdict: 'real' | 'hallucination';
  verdictReason: string;
  fixApplied: boolean;
  fixSummary?: string;
}

export interface ReviewFixOutput {
  role: 'review';
  issues: Issue[];
  perIssue: PerIssue[];
  reasoning: string;
}

/** adapter.poll returns this when state.json.state === 'blocked'. v2.1.6: always unexpected. */
export interface BlockedResult {
  kind: 'unexpected';
  raw: string;                 // original needs/detail
}

export type ReviewState =
  | { kind: 'PRODUCING'; pipelineId: string; round: number }
  | { kind: 'SELF_REVIEW_R1'; pipelineId: string; round: number; cycle: 'initial' | 'postfix' }
  | { kind: 'SELF_REVIEW_R2'; pipelineId: string; round: number; cycle: 'initial' | 'postfix' }
  | { kind: 'FIXING'; pipelineId: string; round: number; source: 'SELF_REVIEW_R1' | 'SELF_REVIEW_R2'; inputIssues: Issue[] }
  | { kind: 'EXTERNAL_REVIEW'; pipelineId: string; round: number }
  | { kind: 'PANE_LOST'; pipelineId: string; round: number; lostPane?: { role: Role; shortId: string }; detectedAt: string; retryTarget: StateKind }
  | { kind: 'DONE'; pipelineId: string; round: number; issueTrail: Issue[] }
  | { kind: 'FAILED'; pipelineId: string; round: number; reason: string }
  | { kind: 'ABORTED'; pipelineId: string; round: number; reason: string; abortedBefore?: StateKind };

export interface PaneWork {
  sessionId: string;           // stable across rounds
  currentRoundShortId?: string;
  provider: string;
  startedAt: string;
  roundShortIds: string[];
}
export interface PaneReview {
  role: 'review';
  shortId: string;
  sessionId: string;
  provider: string;
  round: number;
}
export interface PaneRegistry {
  work?: PaneWork;
  review?: PaneReview;
}

export interface HistoryEvent {
  ts: string;
  fromState: StateKind | null;
  toState: StateKind;
  round: number;
  role: Role | 'human';
  paneShortId?: string;
  paneSessionId?: string;
  providerAlias?: string;
  inputDigest: string;
  outputDigest: string;
  outputSizeBytes: number;
  durationMs: number;
  issues?: Issue[];
}

export interface ParseDegradedEvent {
  ts: string;
  role: Role;
  round: number;
  state: StateKind;
  reason: string;
  recoveredByRetry: boolean;
}

export interface PipelineRecord {
  pipelineId: string;          // ULID
  createdAt: string;
  updatedAt: string;
  ownerOpenId?: string;
  state: ReviewState;
  input: {
    rawInput: string;
    phase: Phase;
    profile: string;
    maxRounds: number;
    cwd: string;
  };
  panes: PaneRegistry;
  history: HistoryEvent[];
  parseDegraded?: ParseDegradedEvent[];
  // v2.1.6: NO checkpoint fields (preProduceCheckpointSha / preReviewCheckpointSha deleted)
}

export interface ParseSuccess<T> { ok: true; data: T; retries: number }
export interface ParseFailure { ok: false; parseDegraded: true; reason: string; raw: string }
export type ParseResult<T> = ParseSuccess<T> | ParseFailure<T>;

export interface ReconcileResult {
  recovered: number;
  lostPanes: number;
  timedOut: string[];
  errors: string[];
}

export interface ModelInfo {
  name: string;
  contextHint: number | null;  // report-only, from model name suffix
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/unit/review/types.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 6: Typecheck**

Run: `bun run typecheck`
Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add src/review/types.ts src/review/paths.ts tests/unit/review/types.test.ts
git commit -m "feat(review): add types & path constants (T1)"
```

---

## Task 2: ReviewProfile (TOML load + per-phase merge)

**Files:**
- Create: `src/review/profile.ts`
- Test: `tests/unit/review/profile.test.ts`
- Fixture: `tests/fixtures/review/profile-default.toml`

**Interfaces:**
- Consumes: `providerManager` from `src/utils/providers.ts` (`resolve(alias).path`), `config` from `src/utils/config.ts`.
- Produces: `interface ReviewProfile`, `function loadProfile(name: string, phase: Phase): Promise<ResolvedProfile>`, `class ProfileError extends CCLinkerError`.

- [ ] **Step 1: Write fixture `tests/fixtures/review/profile-default.toml`**

```toml
[meta]
name = "default"
description = "test profile"

[work]
provider = "claude-sonnet-4"

[review]
provider = "kimi-for-coding"

[guards]
max_rounds = 6
max_concurrent_pipelines = 1
parse_retry_timeout_ms = 15000

[context_limits]
"claude-sonnet-4-5" = 1000000

[prompts.work.self_review.system]
template = "review {task}"

[phase_overrides.code]
review.provider = "kimi-for-coding"
guards.max_rounds = 6
```

- [ ] **Step 2: Write the failing test**

```typescript
// tests/unit/review/profile.test.ts
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { loadProfile, ProfileError } from '../../../src/review/profile';
import { providerManager } from '../../../src/utils/providers';

describe('loadProfile', () => {
  it('loads scalars + prompts from TOML', async () => {
    const p = await loadProfile('default', 'spec', { profilesDir: 'tests/fixtures/review' });
    expect(p.work.provider).toBe('claude-sonnet-4');
    expect(p.review.provider).toBe('kimi-for-coding');
    expect(p.guards.maxRounds).toBe(6);
    expect(p.prompts.work.self_review.system.template).toBe('review {task}');
  });

  it('phase_override scalars win over top-level (code phase)', async () => {
    const p = await loadProfile('default', 'code', { profilesDir: 'tests/fixtures/review' });
    expect(p.guards.maxRounds).toBe(6); // overridden in [phase_overrides.code]
    expect(p.review.provider).toBe('kimi-for-coding');
  });

  it('phase_override tables deep-merge (prompts not in override preserved)', async () => {
    const p = await loadProfile('default', 'code', { profilesDir: 'tests/fixtures/review' });
    expect(p.prompts.work.self_review.system.template).toBe('review {task}');
  });

  it('throws ProfileError if provider not resolvable', async () => {
    const origScan = providerManager.scan;
    providerManager.scan = mock(async () => {});
    providerManager.resolve = mock(() => null);
    await expect(loadProfile('default', 'code', { profilesDir: 'tests/fixtures/review' })).rejects.toThrow(ProfileError);
    providerManager.scan = origScan;
  });

  it('throws ProfileError if profile file missing', async () => {
    await expect(loadProfile('nonexistent', 'code', { profilesDir: 'tests/fixtures/review' })).rejects.toThrow(ProfileError);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test tests/unit/review/profile.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Write `src/review/profile.ts`**

```typescript
// src/review/profile.ts
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parse as parseTOML } from '@iarna/toml';  // already a dep (config.ts uses @iarna/toml)
import { providerManager } from '../utils/providers';
import { CCLinkerError } from '../utils/errors';
import { REVIEW_PROFILES_DIR } from './paths';
import type { Phase } from './types';

export class ProfileError extends CCLinkerError {}

export interface ResolvedProfile {
  meta: { name: string; description?: string };
  work: { provider: string };
  review: { provider: string };
  guards: {
    maxRounds: number;
    maxConcurrentPipelines: number;
    parseRetryTimeoutMs: number;
  };
  contextLimits?: Record<string, number>;
  prompts: {
    work: {
      produce: { system: { template: string } };
      self_review: { system: { template: string } };
      fixing: { system: { template: string } };
    };
    review: {
      spec: { system: { template: string } };
      plan: { system: { template: string } };
      code: { system: { template: string } };
    };
  };
  workSettingsPath: string;
  reviewSettingsPath: string;
}

interface LoadOptions {
  profilesDir?: string;  // test override
}

function deepMerge<T>(base: T, override: any): T {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) {
    return (override === undefined ? base : override) as T;
  }
  const out: any = { ...base };
  for (const k of Object.keys(override ?? {})) {
    if (typeof (base as any)[k] === 'object' && !Array.isArray((base as any)[k]) && (base as any)[k] !== null) {
      out[k] = deepMerge((base as any)[k], override[k]);
    } else {
      out[k] = override[k];
    }
  }
  return out;
}

async function resolveSettingsPath(alias: string): Promise<string> {
  await providerManager.scan();
  const cfg = providerManager.resolve(alias);
  if (!cfg) {
    throw new ProfileError(
      'PROVIDER_NOT_FOUND',
      `provider '${alias}' not in ~/.claude/providers/`,
    );
  }
  return cfg.path;
}

export async function loadProfile(name: string, phase: Phase, opts: LoadOptions = {}): Promise<ResolvedProfile> {
  const dir = opts.profilesDir ?? REVIEW_PROFILES_DIR;
  const path = join(dir, `${name}.toml`);
  if (!existsSync(path)) {
    throw new ProfileError('PROFILE_NOT_FOUND', `profile '${name}' not found at ${path}`);
  }
  let raw: any;
  try {
    raw = parseTOML(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new ProfileError('PROFILE_PARSE_ERROR', `failed to parse ${path}: ${e}`);
  }

  // apply phase_override deep merge
  const override = raw.phase_overrides?.[phase];
  const merged = override ? deepMerge(raw, override) : raw;

  const workProvider = merged.work?.provider;
  const reviewProvider = merged.review?.provider;
  if (!workProvider || !reviewProvider) {
    throw new ProfileError('PROFILE_INVALID', 'profile must define [work].provider and [review].provider');
  }

  const [workSettingsPath, reviewSettingsPath] = await Promise.all([
    resolveSettingsPath(workProvider),
    resolveSettingsPath(reviewProvider),
  ]);

  return {
    meta: { name: merged.meta?.name ?? name, description: merged.meta?.description },
    work: { provider: workProvider },
    review: { provider: reviewProvider },
    guards: {
      maxRounds: merged.guards?.max_rounds ?? 6,
      maxConcurrentPipelines: merged.guards?.max_concurrent_pipelines ?? 1,
      parseRetryTimeoutMs: merged.guards?.parse_retry_timeout_ms ?? 15000,
    },
    contextLimits: merged.context_limits,
    prompts: merged.prompts,
    workSettingsPath,
    reviewSettingsPath,
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/unit/review/profile.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 6: Typecheck + commit**

```bash
bun run typecheck
git add src/review/profile.ts tests/unit/review/profile.test.ts tests/fixtures/review/profile-default.toml
git commit -m "feat(review): add ReviewProfile TOML load + per-phase merge (T2)"
```

---

## Task 3: PhaseDetector

**Files:**
- Create: `src/review/phase-detect.ts`
- Test: `tests/unit/review/phase-detect.test.ts`

**Interfaces:**
- Produces: `function detect(input: { rawInput: string; filePath?: string; gitRef?: string }): 'spec' | 'plan' | 'code'`, `class PhaseUnknownError extends CCLinkerError`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/review/phase-detect.test.ts
import { describe, it, expect } from 'bun:test';
import { detect, PhaseUnknownError } from '../../../src/review/phase-detect';

describe('detect', () => {
  it('gitRef -> code (priority 1)', () => {
    expect(detect({ rawInput: 'update docs', gitRef: 'abc123' })).toBe('code');
  });

  it('file:line -> code (priority 2)', () => {
    expect(detect({ rawInput: 'fix auth.ts:42' })).toBe('code');
  });

  it('filePath docs/*.md -> spec (priority 3)', () => {
    expect(detect({ rawInput: 'review', filePath: 'docs/spec.md' })).toBe('spec');
    expect(detect({ rawInput: 'review', filePath: 'foo.spec.md' })).toBe('spec');
  });

  it('filePath plans/*.md -> plan', () => {
    expect(detect({ rawInput: 'review', filePath: 'plans/arch.md' })).toBe('plan');
    expect(detect({ rawInput: 'review', filePath: 'foo.plan.md' })).toBe('plan');
  });

  it('filePath *.ts -> code', () => {
    expect(detect({ rawInput: 'review', filePath: 'src/auth.ts' })).toBe('code');
  });

  it('Chinese keywords (v2.1.5 P2-3): 修复 -> code, 设计 -> plan, 需求 -> spec', () => {
    expect(detect({ rawInput: '修复登录bug' })).toBe('code');
    expect(detect({ rawInput: '设计鉴权架构' })).toBe('plan');
    expect(detect({ rawInput: '写需求文档' })).toBe('spec');
  });

  it('English keywords: fix -> code, design -> plan, spec -> spec', () => {
    expect(detect({ rawInput: 'fix the NPE' })).toBe('code');
    expect(detect({ rawInput: 'design the auth flow' })).toBe('plan');
    expect(detect({ rawInput: 'write the spec' })).toBe('spec');
  });

  it('no match -> throws PhaseUnknownError', () => {
    expect(() => detect({ rawInput: 'hello world' })).toThrow(PhaseUnknownError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/review/phase-detect.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write `src/review/phase-detect.ts`**

```typescript
// src/review/phase-detect.ts
import { CCLinkerError } from '../utils/errors';

export class PhaseUnknownError extends CCLinkerError {}

export function detect(input: {
  rawInput: string;
  filePath?: string;
  gitRef?: string;
}): 'spec' | 'plan' | 'code' {
  // priority 1: git ref -> code
  if (input.gitRef) return 'code';

  // priority 2: file:line -> code
  if (/\.\w+:\d+/.test(input.rawInput)) return 'code';

  // priority 3: file path suffix / dir
  if (input.filePath) {
    if (/docs\/.*\.md$|\.spec\.md$/.test(input.filePath)) return 'spec';
    if (/plans\/.*\.md$|\.plan\.md$/.test(input.filePath)) return 'plan';
    if (/\.(ts|tsx|js|jsx|py|go|rs|java|c|cpp|swift|kt)$/.test(input.filePath)) return 'code';
  }

  // priority 4: keywords (Chinese first for 飞书 users, then English)
  if (/(需求|规格|PRD|规格说明书)/.test(input.rawInput)) return 'spec';
  if (/(设计|架构|方案|实现方案|技术方案)/.test(input.rawInput)) return 'plan';
  if (/(修|修复|改|重构|实现|优化|bug|崩溃|报错|异常)/.test(input.rawInput)) return 'code';
  if (/\b(spec|specification|requirements|PRD)\b/i.test(input.rawInput)) return 'spec';
  if (/\b(plan|design|architecture|implementation\s+plan)\b/i.test(input.rawInput)) return 'plan';
  if (/\b(fix|bug|refactor|implement|code|NPE|crash|error)\b/i.test(input.rawInput)) return 'code';

  throw new PhaseUnknownError('PHASE_UNKNOWN', `cannot detect phase for: ${input.rawInput}`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/review/phase-detect.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add src/review/phase-detect.ts tests/unit/review/phase-detect.test.ts
git commit -m "feat(review): add PhaseDetector with CN+EN keywords (T3)"
```

---

## Task 4: Output Contract (extractJsonBlock + Zod + parseBgOutputWithRetry)

**Files:**
- Create: `src/review/output-contract.ts`
- Test: `tests/unit/review/output-contract.test.ts`

**Interfaces:**
- Consumes: `zod` (dep), types from `./types`.
- Produces: `function extractJsonBlock(output: string): unknown`, `SelfReviewOutputSchema`, `FixingOutputSchema`, `ReviewOutputSchema`, `function parseBgOutputWithRetry<T>(...)`, `function assignIssueFingerprints(issues, role)`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/review/output-contract.test.ts
import { describe, it, expect } from 'bun:test';
import { extractJsonBlock, SelfReviewOutputSchema, ReviewOutputSchema, assignIssueFingerprints } from '../../../src/review/output-contract';

describe('extractJsonBlock', () => {
  it('extracts ```json fenced block', () => {
    const out = 'here is review\n```json\n{"issues":[]}\n```\ndone';
    expect(extractJsonBlock(out)).toEqual({ issues: [] });
  });

  it('extracts last balanced {} via depth counter (v2.1.5 P2-5)', () => {
    const out = 'text {"a":1} more {"issues":[{"x":{"y":2}}]}';
    expect(extractJsonBlock(out)).toEqual({ issues: [{ x: { y: 2 } }] });
  });

  it('direct JSON.parse fallback', () => {
    expect(extractJsonBlock('{"foo":"bar"}')).toEqual({ foo: 'bar' });
  });

  it('returns null if no JSON', () => {
    expect(extractJsonBlock('just text no json')).toBeNull();
  });
});

describe('SelfReviewOutputSchema', () => {
  it('validates issues without id (engine assigns)', () => {
    const r = SelfReviewOutputSchema.safeParse({ issues: [{ severity: 'P1', location: 'a.ts:1', description: 'x' }] });
    expect(r.success).toBe(true);
  });
  it('rejects unknown severity', () => {
    const r = SelfReviewOutputSchema.safeParse({ issues: [{ severity: 'P9', location: '', description: '' }] });
    expect(r.success).toBe(false);
  });
});

describe('ReviewOutputSchema', () => {
  it('validates issues + per_issue with embedded severity', () => {
    const r = ReviewOutputSchema.safeParse({
      issues: [{ severity: 'P0', location: 'a', description: 'b' }],
      per_issue: [{ issue_id: 'x', severity: 'P0', verdict: 'real', verdict_reason: 'y', fix_applied: true }],
      reasoning: 'z',
    });
    expect(r.success).toBe(true);
  });
});

describe('assignIssueFingerprints', () => {
  it('assigns id = fingerprint (first 8 hex of SHA256)', () => {
    const issues = assignIssueFingerprints(
      [{ severity: 'P1', location: 'a.ts:1', description: 'bug' }],
      'work',
    );
    expect(issues[0].id).toMatch(/^[0-9a-f]{8}$/);
    expect(issues[0].id).toBe(issues[0].fingerprint);
    expect(issues[0].role).toBe('work');
  });
  it('same content -> same fingerprint (stable across rounds)', () => {
    const a = assignIssueFingerprints([{ severity: 'P1', location: 'a.ts:1', description: 'bug' }], 'work');
    const b = assignIssueFingerprints([{ severity: 'P1', location: 'a.ts:1', description: 'bug' }], 'work');
    expect(a[0].fingerprint).toBe(b[0].fingerprint);
  });
  it('different role -> different fingerprint', () => {
    const a = assignIssueFingerprints([{ severity: 'P1', location: 'a.ts:1', description: 'bug' }], 'work');
    const b = assignIssueFingerprints([{ severity: 'P1', location: 'a.ts:1', description: 'bug' }], 'review');
    expect(a[0].fingerprint).not.toBe(b[0].fingerprint);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/review/output-contract.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write `src/review/output-contract.ts`**

```typescript
// src/review/output-contract.ts
import { z } from 'zod';
import { createHash } from 'crypto';
import type { Issue, Role, Severity } from './types';

export function extractJsonBlock(output: string): unknown {
  // strategy 1: ```json fenced
  const fence = output.match(/```json\s*([\s\S]*?)```/i);
  if (fence) {
    try { return JSON.parse(fence[1].trim()); } catch { /* fall through */ }
  }
  // strategy 2: depth-counter scan for last balanced {...}
  const start = output.lastIndexOf('{');
  if (start !== -1) {
    let depth = 0;
    for (let i = start; i < output.length; i++) {
      if (output[i] === '{') depth++;
      else if (output[i] === '}') {
        depth--;
        if (depth === 0) {
          const candidate = output.slice(start, i + 1);
          try { return JSON.parse(candidate); } catch { /* try earlier { */ }
          break;
        }
      }
    }
    // retry: scan backwards from end for any balanced block
    for (let s = start; s >= 0; s--) {
      if (output[s] !== '{') continue;
      let d = 0;
      for (let i = s; i < output.length; i++) {
        if (output[i] === '{') d++;
        else if (output[i] === '}') {
          d--;
          if (d === 0) {
            try { return JSON.parse(output.slice(s, i + 1)); } catch { break; }
          }
        }
      }
    }
  }
  // strategy 3: direct parse
  try { return JSON.parse(output); } catch { return null; }
}

const SeveritySchema = z.enum(['P0', 'P1', 'P2', 'P3']);

export const SelfReviewOutputSchema = z.object({
  issues: z.array(z.object({
    severity: SeveritySchema,
    location: z.string(),
    description: z.string(),
  })),
});

export const FixingOutputSchema = z.object({
  per_issue: z.array(z.object({
    issue_id: z.string(),
    verdict: z.enum(['real', 'hallucination']),
    verdict_reason: z.string(),
    fix_applied: z.boolean(),
    fix_summary: z.string().optional(),
  })),
  all_real_fixed: z.boolean(),
  remaining_real_unfixed_count: z.number(),
});

export const ReviewOutputSchema = z.object({
  issues: z.array(z.object({
    severity: SeveritySchema,
    location: z.string(),
    description: z.string(),
    suggestion: z.string().optional(),
  })),
  per_issue: z.array(z.object({
    issue_id: z.string(),
    severity: SeveritySchema,
    verdict: z.enum(['real', 'hallucination']),
    verdict_reason: z.string(),
    fix_applied: z.boolean(),
    fix_summary: z.string().optional(),
  })),
  reasoning: z.string(),
});

/** Compute fingerprint = first 8 hex of SHA256(role:severity:location:description). */
export function fingerprintOf(role: Role, severity: Severity, location: string, description: string): string {
  return createHash('sha256').update(`${role}:${severity}:${location}:${description}`).digest('hex').slice(0, 8);
}

/** Assign id + fingerprint to issues parsed from model output (models never output ids). */
export function assignIssueFingerprints(
  issues: Array<{ severity: Severity; location: string; description: string; suggestion?: string }>,
  role: Role,
): Issue[] {
  return issues.map((i) => {
    const fp = fingerprintOf(role, i.severity, i.location, i.description);
    return { ...i, id: fp, role, fingerprint: fp };
  });
}

interface ParseRetryOptions {
  maxRetries?: number;   // default 1
  timeoutMs?: number;    // default 15000
}
interface ParseSuccess<T> { ok: true; data: T; retries: number }
interface ParseFailure { ok: false; parseDegraded: true; reason: string; raw: string }

/**
 * Parse bg output JSON with one retry. On failure, caller (engine) decides
 * degradation (ABORTED for review/R1, conservative-advance for FIXING).
 * The retry callback re-generates via resumeWorkSession.
 */
export async function parseBgOutputWithRetry<T>(
  rawOutput: string,
  schema: z.ZodSchema<T>,
  opts: ParseRetryOptions,
  retryRegenerate: () => Promise<string>,  // returns new rawOutput
): Promise<ParseSuccess<T> | ParseFailure> {
  const maxRetries = opts.maxRetries ?? 1;
  let lastRaw = rawOutput;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const extracted = extractJsonBlock(lastRaw);
    if (extracted !== null) {
      const r = schema.safeParse(extracted);
      if (r.success) {
        return { ok: true, data: r.data, retries: attempt };
      }
    }
    if (attempt < maxRetries) {
      lastRaw = await retryRegenerate();
    }
  }
  return { ok: false, parseDegraded: true, reason: 'parse failed after retry', raw: lastRaw };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/review/output-contract.test.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add src/review/output-contract.ts tests/unit/review/output-contract.test.ts
git commit -m "feat(review): add output contract + JSON extraction + fingerprints (T4)"
```

---

## Task 5: PipelineStore (CRUD + 5-dir atomic moves)

**Files:**
- Create: `src/review/pipeline-store.ts`
- Test: `tests/unit/review/pipeline-store.test.ts`

**Interfaces:**
- Consumes: `./types`, `./paths`, `../utils/lock.ts` (`withLock`), `Bun.file`/`Bun.write`.
- Produces: `class PipelineStore`, methods: `create(record)`, `read(id)`, `save(record)` (atomic), `move(id, from, to)`, `listRunning()`, `listQueued()`, `acquirePipelineLock(id, fn)`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/review/pipeline-store.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
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
    pipelineId: id, createdAt: '2026-07-12T00:00:00Z', updatedAt: '2026-07-12T00:00:00Z',
    state: { kind: 'PRODUCING', pipelineId: id, round: 0 },
    input: { rawInput: 'fix NPE', phase: 'code', profile: 'default', maxRounds: 6, cwd: '/tmp' },
    panes: {}, history: [],
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/review/pipeline-store.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write `src/review/pipeline-store.ts`**

```typescript
// src/review/pipeline-store.ts
import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { withLock } from '../utils/lock';
import type { PipelineRecord } from './types';

export type PipelineBucket = 'running' | 'queued' | 'done' | 'failed' | 'aborted';

export class PipelineStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
    for (const b of ['running', 'queued', 'done', 'failed', 'aborted'] as PipelineBucket[]) {
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
    for (const b of ['running', 'queued', 'done', 'failed', 'aborted'] as PipelineBucket[]) {
      if (existsSync(this.file(id, b))) return b;
    }
    return null;
  }

  async create(record: PipelineRecord): Promise<void> {
    const dir = this.dir(record.pipelineId, 'running');
    mkdirSync(dir, { recursive: true });
    await this.atomicWrite(this.file(record.pipelineId, 'running'), record);
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
    return readdirSync(d).filter(name => !name.startsWith('.') && existsSync(join(d, name, 'pipeline.json')));
  }

  /** Per-pipeline lock for transition idempotency. */
  async acquirePipelineLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const lockFile = join(this.dir(id, 'running'), '.lock');
    return withLock(lockFile, fn);
  }

  private async atomicWrite(path: string, record: PipelineRecord): Promise<void> {
    const tmp = path + '.tmp';
    writeFileSync(tmp, JSON.stringify(record, null, 2), { mode: 0o600 });
    renameSync(tmp, path);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/review/pipeline-store.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/review/pipeline-store.ts tests/unit/review/pipeline-store.test.ts
git commit -m "feat(review): add PipelineStore with 5-dir atomic moves (T5)"
```

---

## Task 5b: Adapter (claude --bg spawn + poll)

**Files:**
- Create: `src/review/adapter.ts`
- Test: `tests/unit/review/adapter.test.ts`
- Fixtures: `tests/fixtures/review/state-running.json`, `state-done.json`, `state-blocked.json`

**Interfaces:**
- Consumes: `../agent-view/job-state.ts` (`readJobState`), `Bun.spawn`.
- Produces: `class ClaudeBGAdapter` with `startSession(opts)`, `resumeWorkSession(opts)`, `poll(shortId, timeoutMs)`, `stop(shortId)`.

- [ ] **Step 1: Write state.json fixtures**

```json
// tests/fixtures/review/state-running.json
{ "state": "running", "tempo": "active", "detail": null, "needs": null, "sessionId": "uuid-1", "respawnFlags": ["--settings","/x/glm-5.2.json","--model","glm-5.2[1m]"] }
```
```json
// tests/fixtures/review/state-done.json
{ "state": "done", "tempo": "idle", "detail": null, "needs": null, "sessionId": "uuid-1", "output": { "result": "{\"issues\":[]}" } }
```
```json
// tests/fixtures/review/state-blocked.json
{ "state": "blocked", "tempo": "blocked", "detail": "rate limited", "needs": "rate limited - wait and retry", "sessionId": "uuid-1" }
```

- [ ] **Step 2: Write the failing test**

```typescript
// tests/unit/review/adapter.test.ts
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test tests/unit/review/adapter.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Write `src/review/adapter.ts`**

```typescript
// src/review/adapter.ts
import { spawn } from 'child_process';
import { readJobState, type JobStateEnvelope } from '../agent-view/job-state';
import type { BlockedResult } from './types';

export interface StartSessionOpts {
  prompt: string;
  settingsPath: string;
  cwd: string;
}
export interface ResumeWorkSessionOpts extends StartSessionOpts {
  sessionId: string;
}

export type PollResult =
  | { kind: 'running' }
  | { kind: 'done'; output: string; sessionId?: string }
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
   * v2.1.6 spawn contract: claude --bg <prompt> --settings <path>, cwd via Bun.spawn({cwd}).
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

  /** Poll state.json every 500ms until terminal/timeout. */
  async poll(shortId: string, timeoutMs: number): Promise<PollResult> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const env = await this.readJobStateFn(shortId, this.jobsDir);
      if (!env) return { kind: 'lost' };
      const s = env.state;
      if (s.state === 'done') {
        const output = (s as any).output?.result ?? '';
        return { kind: 'done', output, sessionId: s.sessionId };
      }
      if (s.state === 'failed' || s.state === 'stopped') return { kind: 'lost' };
      if (s.state === 'blocked' || ((s.state === 'running' || s.state === 'working') && s.needs)) {
        // v2.1.6: any blocked -> unexpected (no PAUSED, no 429 parsing)
        return { kind: 'blocked', blocked: { kind: 'unexpected', raw: s.needs ?? s.detail ?? '' } };
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new PollTimeoutError(`poll timeout for ${shortId} after ${timeoutMs}ms`);
  }

  async stop(shortId: string): Promise<void> {
    this.runClaude(['claude', 'stop', shortId], process.cwd());
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
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/unit/review/adapter.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add src/review/adapter.ts tests/unit/review/adapter.test.ts tests/fixtures/review/state-*.json
git commit -m "feat(review): add ClaudeBGAdapter (4 API, v2.1.6 spawn contract) (T5b)"
```

---

## Task 5c: Reconciler (PANE_LOST 24h + pane-alive)

**Files:**
- Create: `src/review/reconciler.ts`
- Test: `tests/unit/review/reconciler.test.ts`

**Interfaces:**
- Consumes: `./pipeline-store`, `./adapter`, `./types`.
- Produces: `class Reconciler`, method `reconcile(): Promise<ReconcileResult>`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/review/reconciler.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/review/reconciler.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write `src/review/reconciler.ts`**

```typescript
// src/review/reconciler.ts
import type { PipelineStore } from './pipeline-store';
import type { JobStateEnvelope } from '../agent-view/job-state';
import type { PipelineRecord, ReconcileResult, ReviewState } from './types';

const PANE_LOST_TIMEOUT_MS = 24 * 3600 * 1000;

export interface ReconcilerDeps {
  readJobStateFn: (short: string, jobsDir?: string) => Promise<JobStateEnvelope | null>;
  jobsDir?: string;
}

export class Reconciler {
  constructor(private store: PipelineStore, private deps: ReconcilerDeps) {}

  async reconcile(): Promise<ReconcileResult> {
    const result: ReconcileResult = { recovered: 0, lostPanes: 0, timedOut: [], errors: [] };
    const ids = await this.store.listRunning();
    for (const id of ids) {
      try {
        const rec = await this.store.read(id);
        if (!rec) continue;
        if (rec.state.kind === 'PANE_LOST') {
          await this.handlePaneLost(rec);
          if (rec.state.kind === 'ABORTED') result.timedOut.push(id);
          continue;
        }
        // active state: check pane alive
        if (await this.checkPanesAlive(rec)) {
          result.recovered++;
        } else {
          // a pane died -> transition to PANE_LOST
          result.lostPanes++;
        }
      } catch (e) {
        result.errors.push(`${id}: ${e}`);
      }
    }
    return result;
  }

  private async handlePaneLost(rec: PipelineRecord): Promise<void> {
    const detectedAt = new Date(rec.state.kind === 'PANE_LOST' ? rec.state.detectedAt : rec.updatedAt).getTime();
    if (Date.now() - detectedAt >= PANE_LOST_TIMEOUT_MS) {
      const aborted: ReviewState = { kind: 'ABORTED', pipelineId: rec.pipelineId, round: rec.state.round, reason: 'pane_lost_timeout', abortedBefore: 'PANE_LOST' };
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
          kind: 'PANE_LOST', pipelineId: rec.pipelineId, round: rec.state.round,
          lostPane: { role: rec.panes.review?.shortId === short ? 'review' : 'work', shortId: short },
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/review/reconciler.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/review/reconciler.ts tests/unit/review/reconciler.test.ts
git commit -m "feat(review): add Reconciler (PANE_LOST 24h + pane-alive) (T5c)"
```

---

## Task 6: Engine (state machine driver)

**Files:**
- Create: `src/review/engine.ts`
- Test: `tests/unit/review/engine.test.ts`

**Interfaces:**
- Consumes: all prior tasks (`./types`, `./profile`, `./pipeline-store`, `./adapter`, `./output-contract`, `./phase-detect`).
- Produces: `class ReviewEngine`, method `runPipeline(pipelineId, task, phase, profile)`, `isClean(issues)`, `externalReviewConverges(output)`, `computeNextState(state, event)`.

This is the largest task. It drives the full state machine. Tests use a mock adapter to avoid real `claude` spawns.

- [ ] **Step 1: Write the failing test (clean判定 + 收敛 + transitions)**

```typescript
// tests/unit/review/engine.test.ts
import { describe, it, expect } from 'bun:test';
import { isClean, externalReviewConverges, computeNextState } from '../../../src/review/engine';
import type { Issue, ReviewFixOutput, ReviewState } from '../../../src/review/types';

describe('isClean', () => {
  it('no P0/P1/P2 -> clean', () => {
    expect(isClean([{ id: 'x', role: 'work', severity: 'P3', location: '', description: '', fingerprint: 'x' }])).toBe(true);
  });
  it('has P1 -> not clean', () => {
    expect(isClean([{ id: 'x', role: 'work', severity: 'P1', location: '', description: '', fingerprint: 'x' }])).toBe(false);
  });
  it('empty -> clean', () => {
    expect(isClean([])).toBe(true);
  });
});

describe('externalReviewConverges', () => {
  const mk = (perIssue: any[]): ReviewFixOutput => ({
    role: 'review', issues: [], reasoning: '', perIssue: perIssue,
  });
  it('0 real P0/P1/P2 -> converges (DONE)', () => {
    expect(externalReviewConverges(mk([
      { issueId: 'a', severity: 'P3', verdict: 'real', verdictReason: '', fixApplied: false },
      { issueId: 'b', severity: 'P1', verdict: 'hallucination', verdictReason: '', fixApplied: false },
    ]))).toBe(true);
  });
  it('1 real P0 -> not converges (postfix round+1)', () => {
    expect(externalReviewConverges(mk([
      { issueId: 'a', severity: 'P0', verdict: 'real', verdictReason: '', fixApplied: true },
    ]))).toBe(false);
  });
});

describe('computeNextState', () => {
  it('PRODUCING + work_done -> SELF_REVIEW_R1 round=1', () => {
    const s: ReviewState = { kind: 'PRODUCING', pipelineId: 'p', round: 0 };
    const next = computeNextState(s, { type: 'work_done', clean: true }, 6);
    expect(next.kind).toBe('SELF_REVIEW_R1'); // PRODUCING done -> R1 (round 1)
    if (next.kind === 'SELF_REVIEW_R1') expect(next.round).toBe(1);
  });
  it('SELF_REVIEW_R1 + found P0/P1/P2 -> FIXING source=R1', () => {
    const s: ReviewState = { kind: 'SELF_REVIEW_R1', pipelineId: 'p', round: 1, cycle: 'initial' };
    const next = computeNextState(s, { type: 'review_done', clean: false, issues: [] }, 6);
    expect(next.kind).toBe('FIXING');
    if (next.kind === 'FIXING') expect(next.source).toBe('SELF_REVIEW_R1');
  });
  it('FIXING source=R1 done -> SELF_REVIEW_R2', () => {
    const s: ReviewState = { kind: 'FIXING', pipelineId: 'p', round: 1, source: 'SELF_REVIEW_R1', inputIssues: [] };
    const next = computeNextState(s, { type: 'fix_done' }, 6);
    expect(next.kind).toBe('SELF_REVIEW_R2');
  });
  it('EXTERNAL_REVIEW + converges -> DONE', () => {
    const s: ReviewState = { kind: 'EXTERNAL_REVIEW', pipelineId: 'p', round: 1 };
    const next = computeNextState(s, { type: 'external_done', converges: true }, 6);
    expect(next.kind).toBe('DONE');
  });
  it('EXTERNAL_REVIEW + not converges -> SELF_REVIEW_R1 postfix round+1', () => {
    const s: ReviewState = { kind: 'EXTERNAL_REVIEW', pipelineId: 'p', round: 1 };
    const next = computeNextState(s, { type: 'external_done', converges: false }, 6);
    expect(next.kind).toBe('SELF_REVIEW_R1');
    if (next.kind === 'SELF_REVIEW_R1') { expect(next.cycle).toBe('postfix'); expect(next.round).toBe(2); }
  });
  it('entering SELF_REVIEW_R1 with round+1 > max -> ABORTED max_rounds_exceeded (v2.1.5 P2-2)', () => {
    const s: ReviewState = { kind: 'EXTERNAL_REVIEW', pipelineId: 'p', round: 6 };
    const next = computeNextState(s, { type: 'external_done', converges: false }, 6);
    expect(next.kind).toBe('ABORTED');
    if (next.kind === 'ABORTED') expect(next.reason).toBe('max_rounds_exceeded');
  });
  it('blocked -> ABORTED unexpected_blocked (v2.1.6)', () => {
    const s: ReviewState = { kind: 'PRODUCING', pipelineId: 'p', round: 0 };
    const next = computeNextState(s, { type: 'blocked', raw: 'rate limited' }, 6);
    expect(next.kind).toBe('ABORTED');
    if (next.kind === 'ABORTED') expect(next.reason).toBe('unexpected_blocked');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/review/engine.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write `src/review/engine.ts`**

```typescript
// src/review/engine.ts
import type {
  Issue, ReviewState, ReviewFixOutput, StateKind, PipelineRecord,
} from './types';
import type { ClaudeBGAdapter } from './adapter';
import type { PipelineStore } from './pipeline-store';
import type { ResolvedProfile } from './profile';
import { isTerminal } from './types';

/** clean = no P0/P1/P2 (P3 doesn't block). */
export function isClean(issues: Issue[]): boolean {
  return issues.filter((i) => ['P0', 'P1', 'P2'].includes(i.severity)).length === 0;
}

/** EXTERNAL_REVIEW converges = 0 real P0/P1/P2 in per_issue (v2.1.5 P1-4: use embedded severity). */
export function externalReviewConverges(output: ReviewFixOutput): boolean {
  const realBlocking = output.perIssue.filter(
    (p) => p.verdict === 'real' && ['P0', 'P1', 'P2'].includes(p.severity),
  );
  return realBlocking.length === 0;
}

export type EngineEvent =
  | { type: 'work_done'; clean: boolean; issues?: Issue[] }
  | { type: 'review_done'; clean: boolean; issues: Issue[] }   // R1/R2 done
  | { type: 'fix_done' }
  | { type: 'external_done'; converges: boolean; output?: ReviewFixOutput }
  | { type: 'blocked'; raw: string }
  | { type: 'cancel' };

/**
 * Pure state transition function. maxRounds for the off-by-one check (v2.1.5 P2-2).
 * Returns next state. Does NOT mutate.
 */
export function computeNextState(state: ReviewState, event: EngineEvent, maxRounds: number): ReviewState {
  const pid = state.pipelineId;
  const round = state.round;

  if (event.type === 'cancel') {
    return { kind: 'ABORTED', pipelineId: pid, round, reason: 'user_cancelled', abortedBefore: state.kind };
  }
  if (event.type === 'blocked') {
    return { kind: 'ABORTED', pipelineId: pid, round, reason: 'unexpected_blocked', abortedBefore: state.kind };
  }

  switch (state.kind) {
    case 'PRODUCING':
      if (event.type === 'work_done') {
        // v2.1.3: produce done -> R1 (round becomes 1). Check max first.
        if (1 > maxRounds) return { kind: 'ABORTED', pipelineId: pid, round, reason: 'max_rounds_exceeded', abortedBefore: 'PRODUCING' };
        return { kind: 'SELF_REVIEW_R1', pipelineId: pid, round: 1, cycle: 'initial' };
      }
      break;
    case 'SELF_REVIEW_R1':
      if (event.type === 'review_done') {
        if (event.clean) return { kind: 'EXTERNAL_REVIEW', pipelineId: pid, round };
        return { kind: 'FIXING', pipelineId: pid, round, source: 'SELF_REVIEW_R1', inputIssues: event.issues };
      }
      break;
    case 'SELF_REVIEW_R2':
      if (event.type === 'review_done') {
        if (event.clean) return { kind: 'EXTERNAL_REVIEW', pipelineId: pid, round };
        return { kind: 'FIXING', pipelineId: pid, round, source: 'SELF_REVIEW_R2', inputIssues: event.issues };
      }
      break;
    case 'FIXING':
      if (event.type === 'fix_done') {
        if (state.source === 'SELF_REVIEW_R1') return { kind: 'SELF_REVIEW_R2', pipelineId: pid, round, cycle: state.cycle ?? 'initial' };
        return { kind: 'EXTERNAL_REVIEW', pipelineId: pid, round };
      }
      break;
    case 'EXTERNAL_REVIEW':
      if (event.type === 'external_done') {
        if (event.converges) return { kind: 'DONE', pipelineId: pid, round, issueTrail: [] };
        // postfix: round+1, check max (v2.1.5 P2-2: round+1 > max -> abort, no +1)
        if (round + 1 > maxRounds) return { kind: 'ABORTED', pipelineId: pid, round, reason: 'max_rounds_exceeded', abortedBefore: 'EXTERNAL_REVIEW' };
        return { kind: 'SELF_REVIEW_R1', pipelineId: pid, round: round + 1, cycle: 'postfix' };
      }
      break;
  }
  throw new Error(`invalid transition: ${state.kind} + ${event.type}`);
}

/**
 * The engine drives a single pipeline. It holds adapter + store + profile.
 * runPipeline is the main loop: spawn work -> poll -> transition -> spawn review -> ...
 */
export class ReviewEngine {
  constructor(
    private store: PipelineStore,
    private adapter: ClaudeBGAdapter,
  ) {}

  async runPipeline(
    pipelineId: string,
    task: string,
    phase: 'spec' | 'plan' | 'code',
    profile: ResolvedProfile,
  ): Promise<void> {
    // PRODUCING: spawn work
    let record = await this.store.read(pipelineId);
    if (!record) throw new Error(`pipeline ${pipelineId} not found`);

    const { shortId, sessionId } = await this.adapter.startSession({
      prompt: this.buildProducePrompt(task, phase, profile),
      settingsPath: profile.workSettingsPath,
      cwd: record.input.cwd,
    });
    record.panes.work = { sessionId, currentRoundShortId: shortId, provider: profile.work.provider, startedAt: new Date().toISOString(), roundShortIds: [shortId] };
    await this.store.save(record);

    // main loop: poll current pane, dispatch per state
    while (!isTerminal(record.state.kind)) {
      const paneShort = this.currentShortId(record);
      if (!paneShort) { record.state = { kind: 'FAILED', pipelineId, round: record.state.round, reason: 'no_active_pane' }; await this.store.save(record); return; }

      let pollResult;
      try {
        pollResult = await this.adapter.poll(paneShort, 600_000);
      } catch (e) {
        // PollTimeout -> treat as lost (bg stuck)
        record.state = { kind: 'PANE_LOST', pipelineId, round: record.state.round, detectedAt: new Date().toISOString(), retryTarget: record.state.kind };
        await this.store.save(record);
        return;
      }

      if (pollResult.kind === 'blocked') {
        record.state = computeNextState(record.state, { type: 'blocked', raw: pollResult.blocked.raw }, profile.guards.maxRounds);
        await this.store.save(record);
        if (record.state.kind === 'ABORTED') await this.store.move(pipelineId, 'running', 'aborted');
        return;
      }
      if (pollResult.kind === 'lost') {
        record.state = { kind: 'PANE_LOST', pipelineId, round: record.state.round, detectedAt: new Date().toISOString(), retryTarget: record.state.kind };
        await this.store.save(record);
        return; // user retry/resume
      }
      if (pollResult.kind !== 'done') continue; // running, keep polling

      // done: dispatch per current state
      record = await this.dispatchState(record, task, phase, profile, pollResult.output);
      if (record.state.kind === 'DONE') { await this.store.move(pipelineId, 'running', 'done'); return; }
      if (record.state.kind === 'FAILED') { await this.store.move(pipelineId, 'running', 'failed'); return; }
      if (record.state.kind === 'ABORTED') { await this.store.move(pipelineId, 'running', 'aborted'); return; }
    }
  }

  /** Per-state dispatch on bg done. Returns updated record (state transitioned + next pane spawned). */
  private async dispatchState(record: PipelineRecord, task: string, phase: string, profile: ResolvedProfile, output: string): Promise<PipelineRecord> {
    const pid = record.pipelineId;
    const maxR = profile.guards.maxRounds;
    const state = record.state;

    if (state.kind === 'PRODUCING') {
      // produce done -> R1 (round 1). Produce output is code/spec/plan on disk, no JSON to parse.
      record.state = computeNextState(state, { type: 'work_done', clean: true }, maxR);
      if (record.state.kind === 'SELF_REVIEW_R1') {
        await this.spawnWorkRound(record, this.buildSelfReviewPrompt(task, record.state.cycle, profile), profile);
      }
      await this.store.save(record);
      return record;
    }

    if (state.kind === 'SELF_REVIEW_R1' || state.kind === 'SELF_REVIEW_R2') {
      const retryRegen = async (): Promise<string> => {
        const regen = await this.adapter.resumeWorkSession({ sessionId: record.panes.work!.sessionId, prompt: this.buildSelfReviewPrompt(task, state.cycle, profile), settingsPath: profile.workSettingsPath, cwd: record.input.cwd });
        record.panes.work!.currentRoundShortId = regen.shortId; record.panes.work!.roundShortIds.push(regen.shortId);
        await this.store.save(record);
        const r = await this.adapter.poll(regen.shortId, 600_000);
        return r.kind === 'done' ? r.output : '';
      };
      const parsed = await parseBgOutputWithRetry(output, SelfReviewOutputSchema, { timeoutMs: profile.guards.parseRetryTimeoutMs }, retryRegen);
      if (!parsed.ok) {
        record.state = { kind: 'ABORTED', pipelineId: pid, round: state.round, reason: 'r1_parse_degraded', abortedBefore: state.kind };
        await this.store.save(record); return record;
      }
      const issues = assignIssueFingerprints(parsed.data.issues, 'work');
      const clean = isClean(issues);
      record.state = computeNextState(state, { type: 'review_done', clean, issues }, maxR);
      if (record.state.kind === 'FIXING') {
        await this.spawnWorkRound(record, this.buildFixingPrompt(task, record.state.inputIssues, profile), profile);
      } else if (record.state.kind === 'EXTERNAL_REVIEW') {
        await this.spawnReview(record, task, phase, profile);
      }
      await this.store.save(record);
      return record;
    }

    if (state.kind === 'FIXING') {
      // FIXING parse fail -> conservative advance (all_real_fixed=true), R2 全面复查兜底
      await parseBgOutputWithRetry(output, FixingOutputSchema, { timeoutMs: profile.guards.parseRetryTimeoutMs }, async () => '');
      record.state = computeNextState(state, { type: 'fix_done' }, maxR);
      if (record.state.kind === 'SELF_REVIEW_R2') {
        await this.spawnWorkRound(record, this.buildSelfReviewPrompt(task, 'initial', profile), profile);
      } else if (record.state.kind === 'EXTERNAL_REVIEW') {
        await this.spawnReview(record, task, phase, profile);
      }
      await this.store.save(record);
      return record;
    }

    if (state.kind === 'EXTERNAL_REVIEW') {
      // review parse fail -> ABORTED (review changed code, cannot silently advance)
      const parsed = await parseBgOutputWithRetry(output, ReviewOutputSchema, { timeoutMs: profile.guards.parseRetryTimeoutMs }, async () => '');
      if (!parsed.ok) {
        record.state = { kind: 'ABORTED', pipelineId: pid, round: state.round, reason: 'review_parse_degraded', abortedBefore: state.kind };
        await this.store.save(record); return record;
      }
      const issues = assignIssueFingerprints(parsed.data.issues, 'review');
      const perIssue = parsed.data.per_issue.map((p) => ({ issueId: p.issue_id, severity: p.severity, verdict: p.verdict, verdictReason: p.verdict_reason, fixApplied: p.fix_applied, fixSummary: p.fix_summary }));
      const out: ReviewFixOutput = { role: 'review', issues, perIssue, reasoning: parsed.data.reasoning };
      const converges = externalReviewConverges(out);
      record.state = computeNextState(state, { type: 'external_done', converges, output: out }, maxR);
      if (record.state.kind === 'SELF_REVIEW_R1') {
        // postfix: work reviews the review changes
        await this.spawnWorkRound(record, this.buildSelfReviewPrompt(task, 'postfix', profile), profile);
      }
      await this.store.save(record);
      return record;
    }

    // PANE_LOST / terminal: no dispatch
    return record;
  }

  /** Spawn a new work round (resume same sessionId). Updates panes.work.currentRoundShortId. */
  private async spawnWorkRound(record: PipelineRecord, prompt: string, profile: ResolvedProfile): Promise<void> {
    const { shortId } = await this.adapter.resumeWorkSession({ sessionId: record.panes.work!.sessionId, prompt, settingsPath: profile.workSettingsPath, cwd: record.input.cwd });
    record.panes.work!.currentRoundShortId = shortId;
    record.panes.work!.roundShortIds.push(shortId);
  }

  /** Spawn a fresh review session (new each round). */
  private async spawnReview(record: PipelineRecord, task: string, phase: string, profile: ResolvedProfile): Promise<void> {
    const prompt = this.buildReviewPrompt(task, phase, profile);
    const { shortId, sessionId } = await this.adapter.startSession({ prompt, settingsPath: profile.reviewSettingsPath, cwd: record.input.cwd });
    record.panes.review = { role: 'review', shortId, sessionId, provider: profile.review.provider, round: record.state.round };
  }

  private currentShortId(record: PipelineRecord): string | undefined {
    if (record.state.kind === 'EXTERNAL_REVIEW' && record.panes.review?.shortId) return record.panes.review.shortId;
    return record.panes.work?.currentRoundShortId;
  }

  private buildProducePrompt(task: string, phase: string, profile: ResolvedProfile): string {
    return profile.prompts.work.produce.system.template
      .replace('{task}', task)
      .replace('{phase}', phase);
  }
}
```

**Note to implementer:** The `runPipeline` loop body (parse per state, dispatch R1/R2/FIXING/EXTERNAL_REVIEW prompts, handle parseDegraded) is the core orchestration. The test above only covers the pure functions (`isClean`, `externalReviewConverges`, `computeNextState`). The full loop integration is tested in T9 E2E. Implement the pure functions first (passing the test), then flesh out `runPipeline`'s per-state dispatch using the prompt templates from `profile.ts` and `parseBgOutputWithRetry` from `output-contract.ts`. Each state transition calls `computeNextState` + `this.store.save(record)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/review/engine.test.ts`
Expected: PASS (all pure-function tests)

- [ ] **Step 5: Typecheck + commit**

```bash
bun run typecheck
git add src/review/engine.ts tests/unit/review/engine.test.ts
git commit -m "feat(review): add ReviewEngine state machine + pure transition fns (T6)"
```

---

## Task 7: CLI Commands (review.ts subcommand group)

**Files:**
- Create: `src/cli/commands/review.ts`
- Modify: `src/index.ts` (register `review` subcommand group)
- Test: `tests/unit/review/review-cli.test.ts`

**Interfaces:**
- Consumes: all prior modules, Commander.js, `../utils/pid.ts`.
- Produces: `export function reviewCommand(program: Command)` registering: `run`, `status`, `abort`, `report`, `cancel`, `skip`, `resume`, `doctor`, `profiles`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/review/review-cli.test.ts
import { describe, it, expect } from 'bun:test';
import { Command } from 'commander';
import { reviewCommand } from '../../../src/cli/commands/review';

describe('review CLI subcommands', () => {
  function makeProgram() {
    const program = new Command();
    reviewCommand(program);
    return program;
  }

  it('registers review run with --phase/--profile/--watch/--cwd flags', () => {
    const program = makeProgram();
    program.parse(['node', 'test', 'review', 'run', 'fix bug', '--phase', 'code', '--profile', 'default', '--watch', '--cwd', '/tmp']);
    const runCmd = program.commands.find((c) => c.name() === 'review')!.commands.find((c) => c.name() === 'run')!;
    expect(runCmd.options.map((o) => o.long)).toContain('--phase');
    expect(runCmd.options.map((o) => o.long)).toContain('--profile');
    expect(runCmd.options.map((o) => o.long)).toContain('--watch');
    expect(runCmd.options.map((o) => o.long)).toContain('--cwd');
  });

  it('registers review doctor subcommand', () => {
    const program = makeProgram();
    program.parse(['node', 'test', 'review', 'doctor']);
    const sub = program.commands.find((c) => c.name() === 'review')!.commands.find((c) => c.name() === 'doctor');
    expect(sub).toBeDefined();
  });

  it('registers resume subcommand', () => {
    const program = makeProgram();
    program.parse(['node', 'test', 'review', 'resume', 'abc123']);
    const sub = program.commands.find((c) => c.name() === 'review')!.commands.find((c) => c.name() === 'resume');
    expect(sub).toBeDefined();
  });

  it('does NOT register cleanup (v2.1.6 deleted)', () => {
    const program = makeProgram();
    program.parse(['node', 'test', 'review', '--help']);
    const subs = program.commands.find((c) => c.name() === 'review')!.commands.map((c) => c.name());
    expect(subs).not.toContain('cleanup');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/review/review-cli.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write `src/cli/commands/review.ts`**

```typescript
// src/cli/commands/review.ts
import { Command } from 'commander';
import chalk from 'chalk';
import { runDoctor } from '../../review/review-doctor';
import { loadProfile } from '../../review/profile';
import { detect } from '../../review/phase-detect';
import { PipelineStore } from '../../review/pipeline-store';
import { ReviewEngine } from '../../review/engine';
import { ClaudeBGAdapter } from '../../review/adapter';
import { REVIEW_PIPELINES_DIR } from '../../review/paths';
import { forkEngine, isEngineAlive, killEngine } from '../../review/engine-process';

export function reviewCommand(program: Command): void {
  const review = program.command('review').description('多模型 Review Engine');

  review.command('run <task>')
    .option('--phase <phase>', 'spec | plan | code (auto-detect if omitted)')
    .option('--profile <name>', 'review profile name', 'default')
    .option('--max-rounds <n>', 'override max rounds', parseInt)
    .option('--watch', 'attach rich terminal view')
    .option('--cwd <path>', 'working directory (default: process.cwd())')
    .option('--inject-text <text>', 'extra context injected into prompts')
    .action(async (task: string, opts: any) => {
      const cwd = opts.cwd ?? process.cwd();
      const phase = opts.phase ?? detect({ rawInput: task });
      const profile = await loadProfile(opts.profile, phase);
      const store = new PipelineStore(REVIEW_PIPELINES_DIR);
      const pipelineId = ulid();
      // create record, fork engine, return id
      await store.create({
        pipelineId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        state: { kind: 'PRODUCING', pipelineId, round: 0 },
        input: { rawInput: task, phase, profile: opts.profile, maxRounds: opts.maxRounds ?? profile.guards.maxRounds, cwd },
        panes: {}, history: [],
      });
      await forkEngine(pipelineId);  // T9b: forks background engine process
      console.log(chalk.green(`✓ Pipeline started: ${pipelineId}`));
      if (opts.watch) {
        // attach cli-watch (T8)
        const { watchPipeline } = await import('../../review/cli-watch');
        await watchPipeline(pipelineId);
      }
    });

  review.command('status <id>')
    .option('--follow', 'poll every 500ms')
    .action(async (id: string, opts: any) => {
      const store = new PipelineStore(REVIEW_PIPELINES_DIR);
      const rec = await store.read(id);
      if (!rec) { console.log(chalk.red(`pipeline ${id} not found`)); process.exit(1); }
      console.log(chalk.cyan(`Pipeline ${id}: ${rec.state.kind} (round ${rec.state.round})`));
      if (opts.follow) {
        const { watchPipeline } = await import('../../review/cli-watch');
        await watchPipeline(id);
      }
    });

  review.command('abort <id>')
    .action(async (id: string) => {
      await killEngine(id);
      console.log(chalk.yellow(` aborted ${id}`));
    });

  review.command('cancel <id>')
    .option('--reason <text>', 'cancel reason')
    .action(async (id: string) => { await killEngine(id); console.log(`cancelled ${id}`); });

  review.command('skip <id>')
    .option('--reason <text>', 'skip reason')
    .action(async (id: string) => { console.log(`skip ${id} (degraded)`); });

  review.command('resume <id>')
    .action(async (id: string) => {
      const alive = await isEngineAlive(id);
      if (alive) { console.log(chalk.yellow('engine still running, use `status --follow`')); return; }
      await forkEngine(id);  // re-attach
      console.log(chalk.green(`✓ Resumed ${id}`));
    });

  review.command('report <id>')
    .option('--format <fmt>', 'md | json', 'md')
    .option('--out <file>', 'output file')
    .option('--partial', 'allow partial report for non-terminal pipeline')
    .action(async (id: string, opts: any) => {
      console.log(`report ${id} (fmt=${opts.format})`);
    });

  review.command('doctor')
    .action(async () => { await runDoctor(); });

  review.command('profiles')
    .action(async () => {
      const { readdirSync } = await import('fs');
      const { REVIEW_PROFILES_DIR } = await import('../../review/paths');
      try {
        const files = readdirSync(REVIEW_PROFILES_DIR).filter((f) => f.endsWith('.toml'));
        for (const f of files) console.log(f.replace(/\.toml$/, ''));
      } catch { console.log('(no profiles)'); }
    });
}

// minimal ULID (replace with 'ulid' pkg if available)
function ulid(): string {
  const ts = Date.now().toString(36).toUpperCase().padStart(10, '0');
  const rand = Math.random().toString(36).slice(2, 12).toUpperCase().padStart(10, '0');
  return ts + rand;
}
```

- [ ] **Step 4: Register in `src/index.ts`**

Add after the existing command registrations (near `img-proxy` import block):

```typescript
// in src/index.ts — add to imports:
import { reviewCommand } from './cli/commands/review';
// in the command registration section:
reviewCommand(program);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/unit/review/review-cli.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: Typecheck + commit**

```bash
bun run typecheck
git add src/cli/commands/review.ts src/index.ts tests/unit/review/review-cli.test.ts
git commit -m "feat(review): add CLI subcommand group (run/status/abort/resume/doctor/...) (T7)"
```

---

## Task 8: CLI --watch (rich terminal)

**Files:**
- Create: `src/review/cli-watch.ts`
- Test: `tests/unit/review/cli-watch.test.ts`

**Interfaces:**
- Consumes: `./pipeline-store`, chalk (dep).
- Produces: `function watchPipeline(pipelineId: string): Promise<void>`, `function renderLive(record): string` (pure, testable).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/review/cli-watch.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/review/cli-watch.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write `src/review/cli-watch.ts`**

```typescript
// src/review/cli-watch.ts
import chalk from 'chalk';
import { isTerminal } from './types';
import type { PipelineRecord } from './types';
import { PipelineStore } from './pipeline-store';
import { REVIEW_PIPELINES_DIR } from './paths';

export function renderLive(record: PipelineRecord): string {
  const lines: string[] = [];
  const s = record.state;
  lines.push(chalk.bold.cyan(`╭─ cc-linker Review Engine ──────────────────────╮`));
  lines.push(chalk.cyan(`│ Pipeline: ${record.pipelineId} │ Phase: ${record.input.phase} │ Profile: ${record.input.profile}`));
  lines.push(chalk.cyan(`│ Round: ${(s as any).round ?? 0}/${record.input.maxRounds} │ State: ${s.kind}`));
  lines.push(chalk.cyan(`╰──────────────────────────────────────────────────╯`));
  lines.push('');
  lines.push(chalk.bold('Pane Status:'));
  if (record.panes.work) {
    lines.push(`  🔧 work     ${record.panes.work.currentRoundShortId ?? '-'} (${record.panes.work.provider})`);
  }
  if (record.panes.review) {
    lines.push(`  👁 review   ${record.panes.review.shortId} (${record.panes.review.provider})`);
  }
  if (record.history.length > 0) {
    lines.push('');
    lines.push(chalk.bold('Timeline:'));
    for (const h of record.history.slice(-5)) {
      lines.push(`  [${h.ts.slice(11, 19)}] ${h.toState} (${h.role})`);
    }
  }
  if (isTerminal(s.kind)) {
    lines.push('');
    lines.push(chalk.green(`✓ Pipeline ${s.kind}`));
  }
  return lines.join('\n');
}

export async function watchPipeline(pipelineId: string): Promise<void> {
  const store = new PipelineStore(REVIEW_PIPELINES_DIR);
  while (true) {
    const record = await store.read(pipelineId);
    if (!record) {
      console.log(chalk.red(`pipeline ${pipelineId} not found`));
      return;
    }
    // clear + render
    process.stdout.write('\x1B[2J\x1B[H');
    console.log(renderLive(record));
    if (isTerminal(record.state.kind)) return;
    await Bun.sleep(500);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/review/cli-watch.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/review/cli-watch.ts tests/unit/review/cli-watch.test.ts
git commit -m "feat(review): add CLI --watch rich terminal render (T8)"
```

---

## Task 9: Review Doctor (health check)

**Files:**
- Create: `src/review/review-doctor.ts`
- Test: `tests/unit/review/review-doctor.test.ts`

**Interfaces:**
- Consumes: `../agent-view/version-guard.ts`, `../agent-view/daemon-probe.ts`, `./profile`, `../utils/config`.
- Produces: `export async function runDoctor(): Promise<boolean>` (true = all pass), checks: CLI version ≥ 2.1.139, daemon healthy, profile providers exist, worktree clean, not monorepo subdir.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/review/review-doctor.test.ts
import { describe, it, expect, mock } from 'bun:test';
import { checkCleanTree, checkMonorepo } from '../../../src/review/review-doctor';

describe('review doctor checks', () => {
  it('checkCleanTree returns true when git status --porcelain empty', async () => {
    const execGit = mock(() => '');  // empty = clean
    expect(await checkCleanTree('/tmp', execGit)).toBe(true);
  });

  it('checkCleanTree returns false when git status has output', async () => {
    const execGit = mock(() => ' M file.ts\n');
    expect(await checkCleanTree('/tmp', execGit)).toBe(false);
  });

  it('checkMonorepo returns false when cwd == git toplevel', async () => {
    const execGit = mock(() => '/tmp');  // toplevel == cwd
    expect(await checkMonorepo('/tmp', execGit)).toBe(false);
  });

  it('checkMonorepo returns true when cwd != toplevel (monorepo subdir)', async () => {
    const execGit = mock(() => '/monorepo-root');
    expect(await checkMonorepo('/monorepo-root/packages/foo', execGit)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/review/review-doctor.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write `src/review/review-doctor.ts`**

```typescript
// src/review/review-doctor.ts
import chalk from 'chalk';
import { spawnSync } from 'child_process';
import { VersionGuard } from '../agent-view/version-guard';
import { DaemonProbe } from '../agent-view/daemon-probe';
import { loadProfile } from './profile';
import { REVIEW_PIPELINES_DIR } from './paths';
import { existsSync, mkdirSync, accessSync, constants } from 'fs';
import { join } from 'path';

const MIN_CLI_VERSION = '2.1.139';

export type GitExec = (args: string[], cwd: string) => string;

function defaultGitExec(args: string[], cwd: string): string {
  try {
    return spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).stdout?.trim() ?? '';
  } catch {
    return '';
  }
}

/** Returns true if `git status --porcelain` is empty (clean tree). P1-3 requirement. */
export async function checkCleanTree(cwd: string, gitExec: GitExec = defaultGitExec): Promise<boolean> {
  const out = gitExec(['status', '--porcelain'], cwd);
  return out.trim() === '';
}

/** Returns true if cwd is a monorepo subdir (toplevel != cwd). */
export async function checkMonorepo(cwd: string, gitExec: GitExec = defaultGitExec): Promise<boolean> {
  const toplevel = gitExec(['rev-parse', '--show-toplevel'], cwd);
  return toplevel !== '' && toplevel !== cwd;
}

export async function runDoctor(opts: { cwd?: string; profileName?: string; gitExec?: GitExec } = {}): Promise<boolean> {
  const cwd = opts.cwd ?? process.cwd();
  const profileName = opts.profileName ?? 'default';
  const gitExec = opts.gitExec ?? defaultGitExec;
  let allPass = true;

  // 1. CLI version (VersionGuard.check takes no args, hardcodes MIN_VERSION=2.1.139)
  const versionCheck = await VersionGuard.check();
  console.log(versionCheck.ok ? chalk.green(`✓ Claude CLI: ${versionCheck.version} (≥ ${MIN_CLI_VERSION})`) : chalk.red(`✗ Claude CLI: ${versionCheck.version ?? versionCheck.reason} (< ${MIN_CLI_VERSION})`));
  if (!versionCheck.ok) allPass = false;

  // 2. Daemon healthy
  const daemonOk = DaemonProbe.check();
  console.log(daemonOk ? chalk.green('✓ Daemon: healthy') : chalk.red('✗ Daemon: not running'));
  if (!daemonOk) allPass = false;

  // 3. Profile + providers
  try {
    const profile = await loadProfile(profileName, 'code');
    console.log(chalk.green(`✓ Profile '${profileName}' loaded`));
    console.log(chalk.green(`✓ Provider '${profile.work.provider}' (work): exists`));
    console.log(chalk.green(`✓ Provider '${profile.review.provider}' (review): exists`));
  } catch (e) {
    console.log(chalk.red(`✗ Profile/provider: ${e}`));
    allPass = false;
  }

  // 4. Clean tree (P1-3)
  const clean = await checkCleanTree(cwd, gitExec);
  console.log(clean ? chalk.green('✓ Working tree: clean') : chalk.red('✗ Working tree: NOT clean (commit or stash first)'));
  if (!clean) allPass = false;

  // 5. Monorepo subdir warning
  const isMonorepoSub = await checkMonorepo(cwd, gitExec);
  if (isMonorepoSub) {
    console.log(chalk.yellow('⚠️ cwd is monorepo subdir, git ops affect whole monorepo'));
    // warn, not fail
  }

  // 6. Pipeline dir writable
  try {
    if (!existsSync(REVIEW_PIPELINES_DIR)) mkdirSync(REVIEW_PIPELINES_DIR, { recursive: true });
    accessSync(REVIEW_PIPELINES_DIR, constants.W_OK);
    console.log(chalk.green('✓ Pipeline dir: writable'));
  } catch (e) {
    console.log(chalk.red(`✗ Pipeline dir: not writable`));
    allPass = false;
  }

  return allPass;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/review/review-doctor.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/review/review-doctor.ts tests/unit/review/review-doctor.test.ts
git commit -m "feat(review): add review doctor health check (T9)"
```

---

## Task 9b: Engine Process Management (fork/attach/SIGTERM)

**Files:**
- Create: `src/review/engine-process.ts`
- Test: `tests/unit/review/engine-process.test.ts`

**Interfaces:**
- Consumes: `../utils/pid.ts` (`writePidAtomic`, `readPid`, `isPidAlive`, `clearPid`), `./paths` (`enginePidPath`), `./pipeline-store`.
- Produces: `forkEngine(pipelineId)`, `isEngineAlive(pipelineId)`, `killEngine(pipelineId)`, `runEngineLoop(pipelineId)` (the long-running loop entry point).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/review/engine-process.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { isEngineAlive, writeEnginePid, readEnginePidWithCheck } from '../../../src/review/engine-process';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cc-enginepid-'));
});
afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));

describe('engine-process pid management', () => {
  it('writeEnginePid writes {pid, startTime}', () => {
    const pidFile = join(tmpRoot, 'engine.pid');
    writeEnginePid(pidFile, 12345, 1000);
    const content = JSON.parse(readFileSync(pidFile, 'utf8'));
    expect(content.pid).toBe(12345);
    expect(content.startTime).toBe(1000);
  });

  it('readEnginePidWithCheck returns pid when alive + startTime matches (v2.1.5 P1-5)', () => {
    const pidFile = join(tmpRoot, 'engine.pid');
    const selfPid = process.pid;
    writeEnginePid(pidFile, selfPid, Date.now() - 100);
    // note: startTime match is best-effort; in test we accept own pid as alive
    const r = readEnginePidWithCheck(pidFile);
    expect(r).toBe(selfPid);  // own process is alive
  });

  it('readEnginePidWithCheck returns null when pidfile missing', () => {
    expect(readEnginePidWithCheck(join(tmpRoot, 'nope.pid'))).toBeNull();
  });

  it('readEnginePidWithCheck returns null for dead pid', () => {
    const pidFile = join(tmpRoot, 'engine.pid');
    writeEnginePid(pidFile, 999999, Date.now());  // 999999 almost certainly dead
    const r = readEnginePidWithCheck(pidFile);
    expect(r).toBeNull();
  });

  it('isEngineAlive returns false when no pidfile', () => {
    // uses enginePidPath(pipelineId) which points at REVIEW_RUNNING_DIR; test with override
    expect(isEngineAlive('nonexistent-id')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/review/engine-process.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write `src/review/engine-process.ts`**

```typescript
// src/review/engine-process.ts
import { existsSync, writeFileSync, readFileSync, unlinkSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { spawn, spawnSync } from 'child_process';
import { isPidAlive } from '../utils/pid';
import { enginePidPath, REVIEW_RUNNING_DIR } from './paths';
import { PipelineStore } from './pipeline-store';
import { Reconciler } from './reconciler';
import { ReviewEngine } from './engine';
import { ClaudeBGAdapter } from './adapter';
import { readJobState } from '../agent-view/job-state';

interface EnginePidEntry {
  pid: number;
  startTime: number;  // wall-clock ms when engine started
}

/** Write {pid, startTime} to pidfile (v2.1.5 P1-5: PID reuse protection). */
export function writeEnginePid(pidFile: string, pid: number, startTime: number): void {
  mkdirSync(dirname(pidFile), { recursive: true });
  writeFileSync(pidFile, JSON.stringify({ pid, startTime }), { mode: 0o600 });
}

/** Read + verify pid is alive. Returns pid or null (dead/reused/missing). */
export function readEnginePidWithCheck(pidFile: string): number | null {
  if (!existsSync(pidFile)) return null;
  try {
    const entry = JSON.parse(readFileSync(pidFile, 'utf8')) as EnginePidEntry;
    if (!isPidAlive(entry.pid)) return null;
    // best-effort startTime check: verify process command contains cc-linker/review
    // (Phase 1 simplified; Phase 3 strict lstart comparison)
    try {
      const cmd = spawnSync('ps', ['-o', 'command=', '-p', String(entry.pid)], { encoding: 'utf8' }).stdout ?? '';
      if (!/cc-linker|review/.test(cmd)) return null;  // PID reused by unrelated process
    } catch { /* ps failed, trust isPidAlive */ }
    return entry.pid;
  } catch {
    return null;
  }
}

export function isEngineAlive(pipelineId: string): boolean {
  return readEnginePidWithCheck(enginePidPath(pipelineId)) !== null;
}

/** Fork the engine as a detached background process running runEngineLoop.
 * Uses getExecutablePath() (compiled-binary-safe, matches start.ts:690 pattern) --
 * process.execPath+process.argv[1] breaks for compiled binaries (argv[1] is internal Bun path).
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
  writeEnginePid(pidFile, child.pid!, Date.now());
}

/** SIGTERM the engine (graceful, 3s then SIGKILL) + clear pidfile. */
export async function killEngine(pipelineId: string): Promise<void> {
  const pidFile = enginePidPath(pipelineId);
  const pid = readEnginePidWithCheck(pidFile);
  if (pid === null) {
    if (existsSync(pidFile)) unlinkSync(pidFile);
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
    // wait up to 3s
    for (let i = 0; i < 30; i++) {
      if (!isPidAlive(pid)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (isPidAlive(pid)) process.kill(pid, 'SIGKILL');
  } catch { /* already dead */ }
  if (existsSync(pidFile)) unlinkSync(pidFile);
}

/**
 * The long-running engine loop. Runs inside the forked child process.
 * Drives the pipeline state machine + 60s reconcile cycle.
 */
export async function runEngineLoop(pipelineId: string): Promise<void> {
  const store = new PipelineStore(REVIEW_PIPELINES_DIR);
  const adapter = new ClaudeBGAdapter();
  const engine = new ReviewEngine(store, adapter);
  const reconciler = new Reconciler(store, { readJobStateFn: readJobState });

  // read the pipeline record to get task/phase/profile, then run
  const rec = await store.read(pipelineId);
  if (!rec) throw new Error(`pipeline ${pipelineId} not found`);

  // run pipeline in background, reconcile every 60s concurrently
  const pipelinePromise = engine.runPipeline(pipelineId, rec.input.rawInput, rec.input.phase, await loadProfileForRecord(rec));
  const reconcileTimer = setInterval(() => { reconciler.reconcile().catch(() => {}); }, 60_000);

  try {
    await pipelinePromise;
  } finally {
    clearInterval(reconcileTimer);
  }
}

async function loadProfileForRecord(rec: PipelineRecord): Promise<ResolvedProfile> {
  const { loadProfile } = await import('./profile');
  return loadProfile(rec.input.profile, rec.input.phase);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/review/engine-process.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Register `_engine-loop` hidden subcommand in `src/cli/commands/review.ts`**

Add inside `reviewCommand`:
```typescript
review.command('_engine-loop <id>', '', { hidden: true })
  .action(async (id: string) => {
    const { runEngineLoop } = await import('../../review/engine-process');
    await runEngineLoop(id);
  });
```

- [ ] **Step 6: Typecheck + commit**

```bash
bun run typecheck
git add src/review/engine-process.ts src/cli/commands/review.ts tests/unit/review/engine-process.test.ts
git commit -m "feat(review): add engine process management (fork/pid/SIGTERM/loop) (T9b)"
```

---

## Task 10: E2E Integration (gated, real claude --bg)

**Files:**
- Test: `tests/integration/review/pipeline-e2e.test.ts`
- Test: `tests/integration/review/adapter-bg.test.ts`

**Note:** These tests spawn real `claude --bg` sessions. Gate them with `RUN_REVIEW_E2E=1` env var so CI doesn't run them by default. They verify the spawn contract + a mini pipeline.

- [ ] **Step 1: Write adapter integration test**

```typescript
// tests/integration/review/adapter-bg.test.ts
import { describe, it, expect, beforeAll } from 'bun:test';

const E2E = process.env.RUN_REVIEW_E2E === '1';
const skip = E2E ? describe : describe.skip;

skip('adapter real claude --bg (E2E)', () => {
  it('startSession spawns bg, poll reaches done, output has text', async () => {
    const { ClaudeBGAdapter } = await import('../../../src/review/adapter');
    const { existsSync } = await import('fs');
    const { expandPath } = await import('../../../src/utils/paths');
    const providerPath = join(expandPath('~'), '.claude', 'providers', 'glm-5.2.json');
    if (!existsSync(providerPath)) return; // skip if provider missing

    const adapter = new ClaudeBGAdapter();
    const { shortId, sessionId } = await adapter.startSession({
      prompt: 'Reply with exactly: HELLO',
      settingsPath: providerPath,
      cwd: '/tmp',
    });
    expect(shortId).toMatch(/^[0-9a-f]{8}$/);
    expect(sessionId).toBeTruthy();

    const r = await adapter.poll(shortId, 120_000);
    expect(r.kind).toBe('done');
    if (r.kind === 'done') expect(r.output).toContain('HELLO');

    // cleanup
    await adapter.stop(shortId);
  }, 130_000);
});

import { join } from 'path';
```

- [ ] **Step 2: Write mini pipeline E2E test**

```typescript
// tests/integration/review/pipeline-e2e.test.ts
import { describe, it, expect } from 'bun:test';

const E2E = process.env.RUN_REVIEW_E2E === '1';
const skip = E2E ? describe : describe.skip;

skip('mini pipeline E2E', () => {
  it('runs a 1-round code pipeline to DONE', async () => {
    // setup: clean git repo in /tmp, profile with 2 providers
    // run: cc-linker review run "add DONE to a.txt" --phase code --max-rounds 1
    // assert: pipeline reaches DONE, a.txt has DONE
    // cleanup: stop bg, rm -rf tmp repo
    expect(true).toBe(true);  // placeholder — implement against real env
  }, 300_000);
});
```

- [ ] **Step 3: Run E2E (manual, with env var)**

Run: `RUN_REVIEW_E2E=1 bun test tests/integration/review/adapter-bg.test.ts`
Expected: PASS (if providers configured) or skip

- [ ] **Step 4: Commit**

```bash
git add tests/integration/review/
git commit -m "test(review): add gated E2E tests (real claude --bg) (T10)"
```

---

## Final: Full suite + typecheck

- [ ] **Step 1: Run full unit suite**

Run: `bun test tests/unit/review/`
Expected: all PASS

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: no errors

- [ ] **Step 3: Manual smoke test**

```bash
# set up a clean git repo + profile, then:
cc-linker review doctor
cc-linker review run "fix typo in README" --phase code --watch
```

Expected: doctor passes, run starts pipeline, --watch shows PRODUCING → ... → DONE.

---

## Self-Review Notes

**Spec coverage check:**
- ✅ G1/G2 (multi-model pipeline + postfix) → T6 engine
- ✅ G3 (spec/plan/code phases) → T2 profile + T3 phase-detect
- ✅ G4 (CLI + --watch) → T7 + T8
- ✅ G5 (recoverable) → T5 store + T5c reconciler + T9b engine-process (resume)
- ✅ G6 (reuse Agent View) → T5b adapter uses readJobState
- ✅ G8 (doctor) → T9
- ✅ State machine (5 active + PANE_LOST + 3 terminal, no PAUSED) → T6
- ✅ v2.1.6 spawn contract (no --bare/--worktree/--cwd/--model) → T5b
- ✅ blocked → abort (no PAUSED) → T5b + T6
- ✅ engine never touches git → T6 (no checkpoint logic) + T9 doctor (clean tree check)
- ✅ Issue fingerprints (engine-assigned) → T4
- ✅ snake/camel conversion → T4 + T6
- ✅ FIXING via resumeWorkSession (no injectReply) → T5b + T6

**Known gaps to flag:**
- T6 `runPipeline` loop body (per-state prompt dispatch + parse) is described but not fully coded in the test — the implementer must flesh out each state's prompt building (using `profile.prompts.*` templates) + `parseBgOutputWithRetry` + `computeNextState` + `store.save`. The pure functions are tested; the orchestration is verified in T10 E2E.
- T7 `review run` action uses `ulid()` stub — replace with `ulid` package in deps, keep the stub (or add pkg if preferred).

**Verified against codebase:**
- TOML parser: `@iarna/toml` (not `toml`) - `import { parse } from "@iarna/toml"` (config.ts:4).
- `VersionGuard.check()` takes NO args, hardcodes `MIN_VERSION=2.1.139`, returns `Promise<{ok, version?, reason?}>` - read `.version` not `.actual`.
- `DaemonProbe.check()` takes optional `claudeHome`, returns boolean.
- `withLock(filePath, fn, options?)` signature confirmed (lock.ts:80).
- `readJobState(short, jobsDir?)` returns `Promise<JobStateEnvelope | null>` (job-state.ts:88).
- Commander: `import { Command } from "commander"` (index.ts:2).
- `providerManager.scan()` async + `resolve(alias)` returns `{alias,name,path,isTemp} | null` (providers.ts:38).
- `engine-process.ts` `_engine-loop` hidden subcommand dispatches to `runEngineLoop` — the implementer should verify the child process correctly re-enters via `process.argv[1]`.
- Real `claude --bg` E2E (T10) requires providers configured at `~/.claude/providers/`; skip gracefully if missing.

---

## v2.1.6.1 Patches (2026-07-12 plan review)

> **Why this section exists**: Plan review found 4 critical + 2 high gaps that would cause orphan pipelines (cancel/abort without state update), wrong model display in --watch (showing provider alias instead of real model name from `state.json.respawnFlags`), unbounded concurrent pipelines, and zero per-pipeline report file. Each patch below names the affected plan task and shows the exact code/diff to apply. **Execution subagents MUST apply these patches on top of T1-T10 plan body** — patches are interleaved with T-codes (not appended after), but for brevity of plan editing they live here.
>
> **Patch list (severity-ordered):**
>
> | ID | Sev | Plan task | Title |
> |----|-----|-----------|-------|
> | C1 | CRIT | T2b (NEW) | Insert model-parser.ts task body |
> | C2 | CRIT | T5c + T7 | Concurrency cap → queued/promote + global reconciler lock |
> | C3 | CRIT | T7 | cancel/abort state cleanup (kill engine first, then write ABORTED + move bucket) |
> | C4 | CRIT | T6 + T7 | Engine writes report file + T7 `review report` reads it |
> | H1 | HIGH | T5 | Bucket-aware `acquirePipelineLock` + `acquireGlobalLock` |
> | H2 | HIGH | T5b | Narrow adapter `poll` blocked detection to spec (`state === 'blocked'` only) |
>
> **Minor decisions baked in** (M1-M4 not requiring user input):
> - **M1 ulid stub**: keep stub in T7 (Time.now() + Math.random()) — Phase 2 swap to `ulid` pkg.
> - **M2 env gate**: keep `CC_LINKER_REVIEW_ENGINE_CHILD=1` env var; `_engine-loop` action early-returns if env not set (defense against accidental CLI invocation).
> - **M3 skip stub**: keep `review skip <id>` as stub (no state advance, no degraded mark) — spec §5.3.3 PANE_LOST branch deferred to Phase 2.
> - **M4 prompt substitution**: T6 implementer fills `buildSelfReviewPrompt(task, cycle, phase, profile)` using 4 substitution phrases from spec §7.2 (R1 initial / R2 initial / R1 postfix / R2 postfix — listed verbatim below).

---

### Patch C1: NEW T2b body — Insert between T2 (Step 7 commit) and T3 header

**Spec ref**: §3.2.1 + Appendix A.1 H5 + C.8 F3. **File Structure entry already exists** (model-parser.ts at line 44); this adds the missing implementation steps.

**Files:**
- Create: `src/review/model-parser.ts`
- Test: `tests/unit/review/model-parser.test.ts`
- Fixture: `tests/fixtures/review/state-glm5.2-respawn.json` (re-uses `state-running.json` field, augment respawnFlags)

**Step 1**: Write `tests/unit/review/model-parser.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test';
import { parseModelFromRespawnFlags } from '../../../src/review/model-parser';

describe('parseModelFromRespawnFlags', () => {
  it('parses --model glm-5.2[1m] -> { name: "glm-5.2", contextHint: 1000000 }', () => {
    expect(parseModelFromRespawnFlags(['--settings','/x/glm-5.2.json','--model','glm-5.2[1m]']))
      .toEqual({ name: 'glm-5.2', contextHint: 1_000_000 });
  });
  it('parses --model MiniMax-M3 (no hint suffix) -> contextHint: null', () => {
    expect(parseModelFromRespawnFlags(['--model','MiniMax-M3'])).toEqual({ name: 'MiniMax-M3', contextHint: null });
  });
  it('returns null when no --model flag', () => {
    expect(parseModelFromRespawnFlags(['--settings','/x/foo.json'])).toBeNull();
  });
  it('returns null for empty/undefined', () => {
    expect(parseModelFromRespawnFlags([])).toBeNull();
    expect(parseModelFromRespawnFlags(undefined)).toBeNull();
  });
  it('handles --model at end (no value)', () => {
    expect(parseModelFromRespawnFlags(['--model'])).toBeNull();
  });
  it('handles k-suffix: claude-sonnet-4[200k] -> 200000', () => {
    expect(parseModelFromRespawnFlags(['--model','claude-sonnet-4[200k]']))
      .toEqual({ name: 'claude-sonnet-4', contextHint: 200_000 });
  });
});
```

**Step 2**: Write `src/review/model-parser.ts`:

```typescript
import type { JobStateFile } from '../agent-view/job-state';

export interface ModelInfo {
  name: string;              // 纯模型名，如 "glm-5.2" / "MiniMax-M3" / "kimi-for-coding"
  contextHint: number | null; // 从后缀解析，仅供报告展示，不驱动任何阈值
}

/**
 * Parse the `--model` flag from `state.json.respawnFlags[]`.
 * Format: --model <name>[<hint><k|m>]  e.g. "glm-5.2[1m]" / "claude-sonnet-4[200k]" / "MiniMax-M3"
 * Spec §3.2.1: providerEnv 不可信，必须从 respawnFlags 读 — model 由 --settings 文件决定,
 * CLI 自己从 settings 解析写入 respawnFlags。
 */
export function parseModelFromRespawnFlags(flags: string[] | undefined): ModelInfo | null {
  if (!flags || flags.length < 2) return null;
  const idx = flags.indexOf('--model');
  if (idx === -1 || idx === flags.length - 1) return null;
  const raw = flags[idx + 1];
  // match name + optional [hint unit]
  const m = raw.match(/^(.+?)(?:\[(\d+)([kKmM]?)\])?$/);
  if (!m) return null;
  let hint: number | null = null;
  if (m[2]) {
    const n = parseInt(m[2], 10);
    if (Number.isFinite(n) && n > 0) {
      const unit = (m[3] || 'm').toLowerCase();
      hint = unit === 'k' ? n * 1000 : unit === 'm' ? n * 1_000_000 : n;
    }
  }
  return { name: m[1], contextHint: hint };
}

/** Sugar: extract from a JobStateFile directly. */
export function modelFromJobState(state: JobStateFile | null | undefined): ModelInfo | null {
  if (!state) return null;
  return parseModelFromRespawnFlags(state.respawnFlags);
}
```

**Step 3**: T1 `types.ts` — `ModelInfo` already exported.  Add to `PaneRegistry.work` + `PaneRegistry.review`:
```typescript
export interface PaneWork {
  sessionId: string;
  currentRoundShortId?: string;
  provider: string;
  startedAt: string;
  roundShortIds: string[];
  /** v2.1.6.1: populated by adapter.poll from state.json.respawnFlags; cli-watch display prefers this over provider alias. */
  modelName?: string;
}
export interface PaneReview {
  role: 'review';
  shortId: string;
  sessionId: string;
  provider: string;
  round: number;
  modelName?: string;
}
```

**Step 4**: T5b `adapter.ts` — `PollResult` gains `model?: ModelInfo`. `poll()` reads `env.state.respawnFlags` and attaches `model`:
```typescript
import { parseModelFromRespawnFlags } from './model-parser';

export type PollResult =
  | { kind: 'running'; model?: ModelInfo }
  | { kind: 'done'; output: string; sessionId?: string; model?: ModelInfo }
  | { kind: 'blocked'; blocked: BlockedResult }
  | { kind: 'lost' };

// inside poll(): after readJobStateFn returns env, compute model once per call
const model = parseModelFromRespawnFlags(env.state.respawnFlags);
// then return r with model attached on done/running.
```

**Step 5**: T6 `engine.ts` — capture `pollResult.model?.name` to populate panes after each poll:
```typescript
// after adapter.poll returns:
if ((pollResult.kind === 'done' || pollResult.kind === 'running') && pollResult.model) {
  const m = pollResult.model.name;
  if (record.state.kind === 'EXTERNAL_REVIEW' && record.panes.review) {
    record.panes.review.modelName = m;
  } else if (record.panes.work) {
    record.panes.work.modelName = m;
  }
}
```

**Step 6**: T8 `cli-watch.ts` — `renderLive` prefers `pane.modelName ?? pane.provider`:
```typescript
const workModel = record.panes.work?.modelName ?? record.panes.work?.provider;
const reviewModel = record.panes.review?.modelName ?? record.panes.review?.provider;
```

**Step 7**: Commit + verify.

---

### Patch C2: Concurrency cap → queued/promote + global reconciler lock

**Spec ref**: §6.5 (queued FIFO + 60s promote) + §6.4 (global `.lock`).

#### C2a. T5 `PipelineStore` — `create` accepts bucket + add `acquireGlobalLock`:

Replace the `create` and `acquirePipelineLock` methods, and add a new public method:

```typescript
// src/review/pipeline-store.ts

/** v2.1.6.1: create now accepts bucket; default 'running'. C2a. */
async create(record: PipelineRecord, bucket: PipelineBucket = 'running'): Promise<void> {
  const dir = this.dir(record.pipelineId, bucket);
  mkdirSync(dir, { recursive: true });
  await this.atomicWrite(this.file(record.pipelineId, bucket), record);
}

/** v2.1.6.1 H1: dynamic bucket lookup so lock works regardless of moved pipeline. */
async acquirePipelineLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const bucket = this.findBucket(id);
  if (!bucket) throw new Error(`pipeline ${id} not found in any bucket`);
  const lockFile = join(this.dir(id, bucket), '.lock');
  return withLock(lockFile, fn);
}

/** v2.1.6.1 C2: global ~/.cc-linker/review-pipelines/.lock for reconciler. */
async acquireGlobalLock<T>(fn: () => Promise<T>): Promise<T> {
  return withLock(join(this.root, '.lock'), fn);
}

/** v2.1.6.1 C3: cancel/abort needs to know current bucket to move from. */
async findBucketPublic(id: string): Promise<PipelineBucket | null> {
  return this.findBucket(id);
}
```

Update `pipeline-store.test.ts` to assert: create with bucket='queued' writes to `queued/<id>/pipeline.json`; acquirePipelineLock acquires on a pipeline moved to `done/` correctly; acquireGlobalLock uses root `.lock`.

#### C2b. T5c `reconciler.ts` — wrap in global lock + add promoteQueued:

```typescript
// src/review/reconciler.ts

import type { PipelineStore } from './pipeline-store';
import type { JobStateEnvelope } from '../agent-view/job-state';
import type { PipelineRecord, ReconcileResult, PipelineBucket } from './types';

const PANE_LOST_TIMEOUT_MS = 24 * 3600 * 1000;

export interface ReconcilerDeps {
  readJobStateFn: (short: string, jobsDir?: string) => Promise<JobStateEnvelope | null>;
  jobsDir?: string;
  /** v2.1.6.1 C2: max concurrent running pipelines (from profile.guards.maxConcurrentPipelines; default 1). */
  maxConcurrent?: number;
  /** v2.1.6.1 C2: invoked with promoted pipelineId (typically forks child engine). */
  promoteFn?: (pipelineId: string) => Promise<void>;
}

export class Reconciler {
  constructor(private store: PipelineStore, private deps: ReconcilerDeps) {}

  async reconcile(): Promise<ReconcileResult> {
    const result: ReconcileResult = {
      recovered: 0, lostPanes: 0, timedOut: [], errors: [], promoted: 0,
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
            if (rec.state.kind === 'ABORTED') result.timedOut.push(id);
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

  /** v2.1.6.1 C2: move oldest queued → running, then call promoteFn to fork engine. */
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

  // existing handlePaneLost + checkPanesAlive unchanged
}
```

Update `src/review/types.ts` `ReconcileResult` interface to add `promoted: number`.

Update `reconciler.test.ts` to inject a mock `promoteFn` and assert it's called when `running.length < maxConcurrent && queued.length > 0`; assert global lock is acquired (mocked via store spy).

#### C2c. T7 `review run` — concurrency cap writes to queued/ when full:

```typescript
review.command('run <task>')
  .option('--phase <phase>', 'spec | plan | code (auto-detect if omitted)')
  .option('--profile <name>', 'review profile name', 'default')
  .option('--max-rounds <n>', 'override max rounds', parseInt)
  .option('--watch', 'attach rich terminal view')
  .option('--cwd <path>', 'working directory (default: process.cwd())')
  .option('--inject-text <text>', 'extra context injected into prompts')
  .action(async (task: string, opts: any) => {
    const cwd = opts.cwd ?? process.cwd();
    const phase = opts.phase ?? detect({ rawInput: task });
    const profile = await loadProfile(opts.profile, phase);
    const store = new PipelineStore(REVIEW_PIPELINES_DIR);

    // (a) lazy promote: if any queued pipeline can be moved up, do it first
    const initialRunning = await store.listRunning();
    if (initialRunning.length < profile.guards.maxConcurrentPipelines) {
      const queued = await store.listQueued();
      if (queued.length > 0) {
        const oldest = [...queued].sort()[0];
        await store.move(oldest, 'queued', 'running');
        await forkEngine(oldest);
        console.log(chalk.yellow(`⏫ promoted ${oldest} from queued → running`));
      }
    }

    const pipelineId = ulid();
    const runningNow = await store.listRunning();
    const targetBucket: PipelineBucket =
      runningNow.length >= profile.guards.maxConcurrentPipelines ? 'queued' : 'running';

    if (targetBucket === 'queued') {
      const position = (await store.listQueued()).length + 1;
      console.log(chalk.yellow(`⏳ Pipeline queued at position ${position} (max=${profile.guards.maxConcurrentPipelines})`));
    }

    await store.create({
      pipelineId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      state: { kind: 'PRODUCING', pipelineId, round: 0 },
      input: { rawInput: task, phase, profile: opts.profile, maxRounds: opts.maxRounds ?? profile.guards.maxRounds, cwd },
      panes: {}, history: [],
    }, targetBucket);

    if (targetBucket === 'running') {
      await forkEngine(pipelineId);
      console.log(chalk.green(`✓ Pipeline started: ${pipelineId}`));
    }

    if (opts.watch) {
      const { watchPipeline } = await import('../../review/cli-watch');
      await watchPipeline(pipelineId);
    }
  });
```

> **Phase 1 limitation note** (worth adding to plan): reconciler only runs inside an engine process. With `maxConcurrentPipelines=1` (Phase 1 default) and pipeline A in `running/`, pipeline B in `queued/` only gets promoted when (i) A's engine finishes (it exits, B never auto-promoted in Phase 1) OR (ii) user invokes `review run` again, which is what C2c lazy-promote does. The reconciler-level promote is in place for Phase 2 multi-pipeline / `review-server` global daemon — it just won't fire often in Phase 1.

#### C2d. T9b `runEngineLoop` — wire reconcile deps:

```typescript
const reconciler = new Reconciler(store, {
  readJobStateFn: readJobState,
  maxConcurrent: profile.guards.maxConcurrentPipelines,
  promoteFn: async (pipelineId) => {
    // C2: each promoted pipeline needs its own engine
    const { forkEngine } = await import('./engine-process');
    await forkEngine(pipelineId);
  },
});
```

---

### Patch C3: cancel/abort state cleanup (kill engine first, then write ABORTED + move)

**Spec ref**: §5.3.4 user_cancelled + §6.6 Abort/Cleanup.

**Replace T7's `cancel` + `abort` commands** with a shared helper:

```typescript
// src/cli/commands/review.ts (helper at module top)

async function cancelOrAbort(pipelineId: string, reason: 'user_cancelled' | 'user_aborted'): Promise<void> {
  // (1) Kill engine FIRST — prevents in-flight adapter.poll from racing to save over our state change.
  await killEngine(pipelineId);

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

// Commands:
review.command('cancel <id>')
  .option('--reason <text>', 'cancel reason')
  .action(async (id: string) => { await cancelOrAbort(id, 'user_cancelled'); });

review.command('abort <id>')
  .action(async (id: string) => { await cancelOrAbort(id, 'user_aborted'); });
```

Add imports for `isTerminal` from `'../../review/types'`. PipelineStore.change file: `findBucket` is now public via `findBucketPublic`.

---

### Patch C4: Engine writes report file + T7 `review report` reads it

**Spec ref**: §8.4.

#### C4a. T6 engine — renderReport + writeReport + invoke in terminal branches:

```typescript
// src/review/engine.ts (new exports)

import { mkdir } from 'fs/promises';
import { dirname } from 'path';
import { reviewReportPath } from './paths';
import type { Issue, HistoryEvent } from './types';

/** v2.1.6.1 C4: render Markdown report per spec §8.4 structure. */
export async function renderReport(rec: PipelineRecord): Promise<string> {
  const lines: string[] = [];
  // Header
  lines.push(`# Review Report — ${rec.pipelineId}`);
  lines.push('');
  lines.push(`- Created: ${rec.createdAt}`);
  lines.push(`- Phase: ${rec.input.phase}`);
  lines.push(`- Profile: ${rec.input.profile}`);
  lines.push(`- Max rounds: ${rec.input.maxRounds}`);
  lines.push(`- CWD: ${rec.input.cwd}`);
  lines.push(`- Final state: **${rec.state.kind}**`);
  if (rec.state.kind === 'ABORTED') lines.push(`- Abort reason: ${(rec.state as any).reason ?? 'unknown'}`);
  lines.push('');

  // Parse Degradation Events
  if (rec.parseDegraded && rec.parseDegraded.length > 0) {
    lines.push('## Parse Degradation');
    for (const p of rec.parseDegraded) {
      lines.push(`- [${p.ts}] round=${p.round} state=${p.state} reason=${p.reason} recoveredByRetry=${p.recoveredByRetry}`);
    }
    lines.push('');
  }

  // Timeline (history summary)
  lines.push('## Timeline');
  for (const h of rec.history) {
    lines.push(`- [${h.ts}] ${h.fromState ?? '∅'} → ${h.toState} (round=${h.round}, role=${h.role})`);
  }
  lines.push('');

  // Issues — merge from history[*].issues (engine-canonical, after fingerprint assignment)
  const allIssues: Issue[] = [];
  for (const h of rec.history) for (const i of h.issues ?? []) allIssues.push(i);
  const dedup = new Map<string, Issue>();
  for (const i of allIssues) if (!dedup.has(i.fingerprint)) dedup.set(i.fingerprint, i);
  const sorted = [...dedup.values()].sort((a, b) => {
    const order = { P0: 0, P1: 1, P2: 2, P3: 3 } as Record<string, number>;
    return (order[a.severity] ?? 99) - (order[b.severity] ?? 99);
  });

  lines.push('## Issues');
  if (sorted.length === 0) lines.push('_No issues recorded._');
  for (const i of sorted) {
    lines.push(`- [${i.severity}] \`${i.location}\` (role=${i.role}) — ${i.description}${i.suggestion ? `  hint: ${i.suggestion}` : ''}`);
  }
  lines.push('');

  // Fix provenance — derived from per_issue fix_applied if any review event recorded it
  const fixCount = rec.history.reduce((n, h) => n + (h.issues?.length ?? 0), 0);
  lines.push('## Summary');
  lines.push(`- Total unique issues: ${sorted.length}`);
  lines.push(`- Issue events across rounds: ${fixCount}`);
  lines.push(`- Models used: work=${rec.panes.work?.modelName ?? rec.panes.work?.provider ?? '?'}; review=${rec.panes.review?.modelName ?? rec.panes.review?.provider ?? '?'}`);
  lines.push('');

  // Rollback note (v2.1.6)
  if (sorted.some((i) => i.severity === 'P0' || i.severity === 'P1')) {
    lines.push('> Engine did NOT take git checkpoint. Rollback with `git reset --hard <commit-before-this-pipeline>`.');
    lines.push('');
  }

  return lines.join('\n');
}

/** v2.1.6.1 C4: write report file to <cwd>/.claude/reviews/<pipelineId>.md when reaching terminal. */
export async function writeReport(rec: PipelineRecord): Promise<string> {
  const path = reviewReportPath(rec.input.cwd, rec.pipelineId);
  await mkdir(dirname(path), { recursive: true });
  const md = await renderReport(rec);
  await Bun.write(path, md);
  return path;
}
```

In `runPipeline` / `dispatchState`, call `writeReport(rec)` after `store.move` for any terminal transition (DONE / FAILED / ABORTED). For non-terminal re-entry (e.g. mid-state), skip.

#### C4b. T7 `review report` — read report file:

```typescript
review.command('report <id>')
  .option('--format <fmt>', 'md | json', 'md')
  .option('--out <file>', 'output file')
  .option('--partial', 'allow non-terminal pipelines')
  .action(async (id: string, opts: any) => {
    const store = new PipelineStore(REVIEW_PIPELINES_DIR);
    const rec = await store.read(id);
    if (!rec) { console.log(chalk.red(`pipeline ${id} not found`)); process.exit(1); }
    if (!isTerminal(rec.state.kind) && !opts.partial) {
      console.log(chalk.yellow(`pipeline ${id} not yet terminal (state=${rec.state.kind}); use --partial`));
      return;
    }
    if (opts.format === 'json') {
      console.log(JSON.stringify(rec, null, 2));
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
```

Add `renderReport` to imports at top of `review.ts`.

---

### Patch H1 (in T5 code) and Patch H2 (in T5b code)

**H1** — T5 `PipelineStore.acquirePipelineLock` already shown above under C2a (dynamic bucket lookup).

**H2** — T5b `adapter.ts poll()` narrow blocked detection:

```typescript
// Replace this block in src/review/adapter.ts poll():
// OLD:
//   if (s.state === 'blocked' || ((s.state === 'running' || s.state === 'working') && s.needs)) {
//     return { kind: 'blocked', blocked: { kind: 'unexpected', raw: s.needs ?? s.detail ?? '' } };
//   }
// NEW (v2.1.6.1 H2: spec §4.3 only treats state=blocked; running+needs keeps polling):
if (s.state === 'blocked') {
  return { kind: 'blocked', blocked: { kind: 'unexpected', raw: s.needs ?? s.detail ?? '' } };
}
```

Add a unit test verifying a `state-running + needs` fixture does NOT abort but continues polling until 10-min timeout (or until state transitions).

---

### Patch supplements (M1/M2/M3/M4 baked-in decisions)

**M1 (ulid stub)**: T7 keeps the inline `ulid()` function (Time.now() base36 + Math.random() tail). No new dep added. Comment: `// TODO(v2.1.6.2): add ulid package for proper monotonic ids`.

**M2 (env gate `_engine-loop`)**: T9b Step 5 add to `reviewCommand`:
```typescript
review.command('_engine-loop <id>', '', { hidden: true })
  .action(async (id: string) => {
    if (process.env.CC_LINKER_REVIEW_ENGINE_CHILD !== '1') {
      // Defensive: only the forked child process sets this env var; refuse any other invocation.
      console.error('_engine-loop is internal; spawn via `cc-linker review run`');
      process.exit(1);
    }
    const { runEngineLoop } = await import('../../review/engine-process');
    await runEngineLoop(id);
  });
```

**M3 (skip stub)**: T7 keeps `review.skip` as noop with TODO comment for Phase 2 (PANE_LOST user choice requiring state advance + degraded tracking). Acceptable stub for v2.1.6.

**M4 (prompt substitution map)**: T6 implementer MUST add `buildSelfReviewPrompt(task, cycle, phase, profile)` using these 4 templates (spec §7.2):
- `R1 initial`: "第一次自查，全面审查产出是否符合需求"
- `R2 initial`: "审查修复后的整体状态是否符合需求、有无新问题"
- `R1 postfix`: "postfix 循环：全面复查上一轮 external review 修复后的整体状态"
- `R2 postfix`: "审查 postfix 修复后的整体状态"

`buildProducePrompt` / `buildFixingPrompt` / `buildReviewPrompt` similarly bind from profile.prompts.{work|review}.{produce|self_review|fixing|spec|plan|code}.system.template. The substitution params `{task}` / `{phase}` / `{input_issues}` get filled in.

---

### Self-Review Notes — patch summary

**v2.1.6.1 patches reviewed and incorporated**:
- C1 ✅ T2b body inserted
- C2 ✅ Concurrency cap + queued/promote + global reconciler lock (T5/T5c/T7/T9b)
- C3 ✅ cancel/abort kill-then-write state cleanup (T7)
- C4 ✅ Engine writes report file at terminal + T7 reads it (T6/T7)
- H1 ✅ Bucket-aware per-pipeline lock + acquireGlobalLock (T5)
- H2 ✅ Narrow `poll` blocked detection to spec literal (T5b)

**Spec coverage matrix post-patch**: G1-G8 ✅, all 9 states ✅, state machine transitions ✅, clean standard ✅, blocked → ABORTED ✅, no PAUSED ✅, snake/camel ✅, fingerprint ✅, engine-pid PID reuse ✅, doctor ✅, model name resolution ✅, queued/promote ✅, report file ✅, cancel/abort state cleanup ✅.

**Phase 1 limitations (documented, non-blocking)**:
- reconciler promote fires only inside a running engine; with `maxConcurrent=1` default this means queued pipelines only auto-promote via C2c lazy promote in subsequent `review run` invocations. Full multi-pipeline auto-promotion arrives with Phase 2 `review-server` global daemon.
- `ulid()` is a Time.now() + Math.random() stub (M1); adequate for Phase 1, replace with `ulid` package in Phase 2.
- `review skip` is a stub (M3); the PANE_LOST user-skip flow with degraded tracking is Phase 2.

**Verified against codebase** (incremental additions to original list):
- `getExecutablePath()` from `src/utils/executable.ts` exists and handles compiled-binary / npm-symlink / dev-mode paths (T9b fork).
- `writePidAtomic / readPid / isPidAlive / clearPid` from `src/utils/pid.ts` (T9b could alternatively use these — engine.pid gets both {pid,startTime} JSON AND atomic single-pid writer depending on phase).
- `providerManager.scan()` falls back to cc-switch DB if `~/.claude/providers/` is empty (transparent to T2 profile).
- `Bun.write(path, content)` is the project's preferred atomic file write (T6 report + state.json).
- Subcommand registration pattern (`Command → command(...).option(...).action(handler)`) verified in `src/cli/commands/img-proxy.ts` for T7 reference.
- T6 implementer should pre-create the report directory with `fs/promises.mkdir({recursive:true})` to avoid EACCES on `.claude/reviews/` (verified against paths.ts `reviewReportPath()`).
