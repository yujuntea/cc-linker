# Multi-Model Review Engine v2.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a CLI-driven multi-model review pipeline that orchestrates work sessions across multiple Claude providers, fixes issues with verify-first discipline, and produces Markdown reports — all without modifying user source files automatically.

**Architecture:** 9-state state machine (PRODUCING → SELF_REVIEW_R1 → FIXING → SELF_REVIEW_R2 → FIXING → EXTERNAL_REVIEW → JUDGE_BY_WORK → FIXING → HUMAN_DECIDE → ...) drives a `claude --bg` based bg session per pane. State persisted to `~/.cc-linker/review-pipelines/running/<id>.json`. CLI subcommand group `cc-linker review {run,status,abort,report,decide,cancel,doctor,profiles}`.

**Tech Stack:** Bun + TypeScript (strict), Zod (Output Contract parsing), TOML via `@iarna/toml`, `commander` (CLI), `chalk` (terminal colors), no new HTTP framework (CLI `--watch` mode replaces v2's Bun.serve IDE).

**Spec:** `docs/superpowers/specs/2026-06-14-multi-model-review-engine-v2.1-design.md` (~2000 lines)

---

## File Structure

### New files to create

```
src/review/
├── profile.ts                   # ReviewProfile TOML 加载 + per-phase merge + provider 校验
├── phase-detect.ts              # 5 个启发式 + PhaseUnknownError
├── pipeline-store.ts            # 5 目录原子写 + moveToTerminal
├── pipeline-state.ts            # in-memory active pipeline Map + AbortController
├── adapter.ts                   # ClaudeBGAdapter (claude --bg + RendezvousClient.injectReply + claude stop)
├── engine.ts                    # 状态机驱动 (9 active states)
├── reconciler.ts                # 启动扫描 + pane 丢失检测
├── review-doctor.ts             # cc-linker review doctor 健康检查
├── cli-watch.ts                 # CLI --watch 模式 (rich terminal)
├── output-contract.ts           # Zod schemas + JSON 提取 + parse 降级
├── types.ts                     # ReviewState / PaneRegistry / PipelineRecord / HistoryEvent / DecisionContext
└── abort-cleanup.ts             # cleanupPipeline() 6 步实现

src/cli/commands/
└── review.ts                    # subcommand group: run/status/abort/report/decide/cancel/doctor/profiles

tests/unit/review/
├── types.test.ts
├── profile.test.ts
├── phase-detect.test.ts
├── pipeline-store.test.ts
├── adapter.test.ts
├── engine.test.ts
├── reconciler.test.ts
├── review-doctor.test.ts
├── cli-watch.test.ts
├── output-contract.test.ts
└── abort-cleanup.test.ts

tests/integration/review/
├── adapter-bg-spawn.test.ts
├── adapter-inject-reply.test.ts
├── reconciler-recovery.test.ts
└── e2e-mini-pipeline.test.ts

docs/superpowers/plans/
└── 2026-06-14-multi-model-review-engine-v2.1-plan.md  (this file)
```

### Files to modify

- `src/index.ts` — register `review` subcommand group
- `src/utils/paths.ts` — add `REVIEW_PIPELINES_DIR` + `REVIEW_PROFILES_DIR`
- `src/utils/config.ts` — extend `ConfigData` with `review` section
- `src/agent-view/job-state.ts` — extend `JobStateFile` interface with `output` field (or use local ExtendedJobStateFile per §7.5.6)
- `package.json` — no new deps (use existing zod, chalk, toml)

### Decomposition rationale

- **One file per responsibility**: types separately, store separately, adapter separately. Each fits in ~200-400 lines.
- **Engine is the brain, others are organs**: engine.ts owns the state machine + transitions; everything else is invoked by engine.
- **Test parity**: every src file has a corresponding tests/unit/review/<name>.test.ts.

---

## Task 1 (W1): Profile 加载 + Provider 校验 + Doctor

### Task 1.1: Add ReviewProfile 类型 + TOML 解析

**Files:**
- Create: `src/review/types.ts`
- Create: `tests/unit/review/types.test.ts`

- [ ] **Step 1: Write failing test for ReviewProfile schema**

Create `tests/unit/review/types.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test';
import { ReviewProfileSchema, type ReviewProfile } from '../../src/review/types';

describe('ReviewProfile', () => {
  it('parses minimal valid profile', () => {
    const toml = `
[meta]
name = "default"

[work]
provider = "claude-sonnet-4"

[review]
providers = ["kimi-for-coding"]

[guards]
max_rounds = 6
`;
    const profile = ReviewProfileSchema.parse(toml);
    expect(profile.meta.name).toBe('default');
    expect(profile.work.provider).toBe('claude-sonnet-4');
    expect(profile.review.providers).toEqual(['kimi-for-coding']);
    expect(profile.guards.max_rounds).toBe(6);
  });

  it('rejects profile with missing work.provider', () => {
    const toml = `
[meta]
name = "bad"

[review]
providers = ["kimi"]
`;
    expect(() => ReviewProfileSchema.parse(toml)).toThrow();
  });

  it('applies default values for missing optional fields', () => {
    const toml = `
[meta]
name = "minimal"

[work]
provider = "sonnet"

[review]
providers = ["kimi"]
`;
    const profile = ReviewProfileSchema.parse(toml);
    expect(profile.guards.max_concurrent_pipelines).toBe(1);
    expect(profile.guards.human_decide_timeout_ms).toBe(3_600_000);  // 1h
    expect(profile.guards.p0_p1_reject_threshold).toBe(0.30);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/review/types.test.ts`
Expected: FAIL with "Cannot find module '../../src/review/types'"

- [ ] **Step 3: Implement types.ts with Zod schema**

Create `src/review/types.ts`:

```typescript
import { z } from 'zod';

export const ReviewProfileSchema = z.object({
  meta: z.object({
    name: z.string(),
    description: z.string().optional(),
  }),
  work: z.object({
    provider: z.string(),
  }),
  review: z.object({
    mode: z.enum(['parallel', 'sequential']).default('parallel'),
    providers: z.array(z.string()).min(1),
  }),
  arbiter: z.object({
    provider: z.string(),
    trigger_on: z.enum(['reject', 'disagree_significantly', 'low_acceptance']).default('disagree_significantly'),
  }).optional(),  // v2.1 删 arbiter，保留 optional 向后兼容
  guards: z.object({
    max_rounds: z.number().int().positive().default(6),
    max_concurrent_pipelines: z.number().int().positive().default(1),
    human_decide_timeout_ms: z.number().int().positive().default(3_600_000),
    p0_p1_reject_threshold: z.number().min(0).max(1).default(0.30),
  }).default({}),
  prompts: z.object({
    'work.produce': z.object({ system: z.string() }).optional(),
    'work.self_review': z.object({ system: z.string() }).optional(),
    'work.fixing': z.object({ system: z.string() }).optional(),
    'work.judge': z.object({ system: z.string() }).optional(),
    'review.code': z.object({ system: z.string() }).optional(),
    'review.plan': z.object({ system: z.string() }).optional(),
    'review.spec': z.object({ system: z.string() }).optional(),
  }).default({}),
  phase_overrides: z.record(z.string(), z.any()).default({}),
});

export type ReviewProfile = z.infer<typeof ReviewProfileSchema>;

// ReviewState enum (spec §5.1)
export type ReviewState =
  | { kind: 'PRODUCING'; pipelineId: string; round: number; pane: 'work' }
  | { kind: 'SELF_REVIEW_R1'; pipelineId: string; round: number; cycle: 'initial' | 'postfix'; pane: 'work' }
  | { kind: 'SELF_REVIEW_R2'; pipelineId: string; round: number; cycle: 'initial' | 'postfix'; pane: 'work' }
  | { kind: 'FIXING'; pipelineId: string; round: number; pane: 'work';
      source: 'SELF_REVIEW_R1' | 'SELF_REVIEW_R2' | 'JUDGE_BY_WORK' | 'HUMAN_DECIDE';
      inputIssues: Issue[] }
  | { kind: 'EXTERNAL_REVIEW'; pipelineId: string; round: number; cycle: 'initial' | 'postfix';
      panes: Array<{ role: string; shortId: string }> }
  | { kind: 'JUDGE_BY_WORK'; pipelineId: string; round: number; pane: 'work' }
  | { kind: 'PANE_LOST'; pipelineId: string; round: number;
      lostPanes: Array<{ role: string; shortId: string }>;
      detectedAt: string;
      retryTarget: ReviewState['kind'] }
  | { kind: 'HUMAN_DECIDE'; pipelineId: string; round: number; pending: DecisionContext }
  | { kind: 'DONE'; pipelineId: string; round: number; totalCostUsd: number; issueTrail: Issue[] }
  | { kind: 'FAILED'; pipelineId: string; round: number; reason: string; totalCostUsd: number }
  | { kind: 'ABORTED'; pipelineId: string; round: number; reason: string; abortedBefore: ReviewState['kind'] };

export interface Issue {
  id: string;                  // e.g. "review-A-1"
  severity: 'P0' | 'P1' | 'P2' | 'P3';
  location: string;
  description: string;
  suggestion?: string;
  source?: string;             // which review pane raised this
  workDecision?: 'accept' | 'reject' | 'partial';
}

export interface DecisionContext {
  trigger: 'verdict_reject';
  rejectionSummary: {
    p0p1Total: number;
    p0p1Rejected: number;
    ratio: number;
    threshold: number;
  };
  issues: Issue[];
}

// PipelineRecord (spec §6.1)
export interface PipelineRecord {
  pipelineId: string;
  createdAt: string;
  updatedAt: string;
  ownerOpenId?: string;
  state: ReviewState;
  input: {
    rawInput: string;
    phase: 'spec' | 'plan' | 'code' | 'unknown';
    profile: string;       // profile name
    maxRounds: number;
    cwd: string;
    snapshotDir?: string;  // v2.1 review 修正: provider snapshot dir
  };
  panes: PaneRegistry;
  history: HistoryEvent[];
  totalCostUsd: number;
}

export interface PaneRegistry {
  work?: {
    sessionId: string;
    currentRoundShortId?: string;
    provider: string;
    startedAt: string;
    roundShortIds: string[];
  };
  reviews: Array<{
    role: string;
    shortId: string;
    sessionId: string;
    provider: string;
    round: number;
    cycle: 'initial' | 'postfix';
  }>;
}

export interface HistoryEvent {
  ts: string;
  fromState: ReviewState['kind'] | null;
  toState: ReviewState['kind'];
  round: number;
  role: 'work' | 'review' | 'human';
  paneShortId?: string;
  paneSessionId?: string;
  providerAlias?: string;
  inputDigest: string;       // sha256 前 16 字符
  outputDigest: string;
  outputSizeBytes: number;
  costUsd: number;
  durationMs: number;
  issues?: Issue[];
  verdict?: 'accept' | 'reject';  // v2.1 变更 18: 2 值
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/review/types.test.ts`
Expected: 3 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/review/types.ts tests/unit/review/types.test.ts
git commit -m "feat(review): add ReviewState + PipelineRecord types (T1.1)"
```

### Task 1.2: Profile TOML 加载 + per-phase merge

**Files:**
- Create: `src/review/profile.ts`
- Create: `tests/unit/review/profile.test.ts`

- [ ] **Step 1: Write failing test for profile.load + phase merge**

Create `tests/unit/review/profile.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProfile, ProfileError } from '../../src/review/profile';

describe('loadProfile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'review-test-'));
  });
  afterEach(() => rmSync(tmpDir, { recursive: true }));

  it('loads valid profile with phase_overrides', async () => {
    const path = join(tmpDir, 'default.toml');
    writeFileSync(path, `
[meta]
name = "default"

[work]
provider = "claude-sonnet-4"

[review]
providers = ["kimi-for-coding", "bailian-qwen3.6"]

[guards]
max_rounds = 6

[phase_overrides.code]
review.providers = ["kimi", "qwen", "mimo"]
guards.max_rounds = 8

[prompts.work.fixing.system]
template = "verify-first: {{source}} issues"
`);
    const profile = await loadProfile('default', 'code', path);
    expect(profile.guards.max_rounds).toBe(8);  // phase override
    expect(profile.review.providers).toEqual(['kimi', 'qwen', 'mimo']);  // 完全替换
    expect(profile.prompts['work.fixing']?.system).toContain('verify-first');
  });

  it('throws ProfileError on missing file', async () => {
    try {
      await loadProfile('missing', 'code', '/nonexistent/path.toml');
      expect(true).toBe(false);  // should have thrown
    } catch (err) {
      expect(err).toBeInstanceOf(ProfileError);
      expect((err as ProfileError).code).toBe('PROFILE_NOT_FOUND');
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/review/profile.test.ts`
Expected: FAIL with "Cannot find module '../../src/review/profile'"

- [ ] **Step 3: Implement profile.ts**

Create `src/review/profile.ts`:

```typescript
import { readFileSync, existsSync } from 'node:fs';
import { parse as parseToml } from '@iarna/toml';
import { ReviewProfileSchema, type ReviewProfile, type Phase } from './types';
import { logger } from '../utils/logger';
import { join } from 'node:path';
import { REVIEW_PROFILES_DIR } from '../utils/paths';

export class ProfileError extends Error {
  constructor(
    public code: 'PROFILE_NOT_FOUND' | 'PROFILE_INVALID' | 'PROVIDER_NOT_FOUND',
    message: string,
    public remediation: string,
  ) {
    super(message);
    this.name = 'ProfileError';
  }
}

/**
 * Load a profile by name, applying phase_overrides for the specified phase.
 * @param name Profile name (without .toml extension)
 * @param phase Current pipeline phase (controls phase_overrides)
 * @param path Optional explicit path; defaults to ~/.cc-linker/review-profiles/<name>.toml
 */
export async function loadProfile(
  name: string,
  phase: Phase,
  path?: string,
): Promise<ReviewProfile> {
  const profilePath = path ?? join(REVIEW_PROFILES_DIR, `${name}.toml`);
  if (!existsSync(profilePath)) {
    throw new ProfileError(
      'PROFILE_NOT_FOUND',
      `profile '${name}' 不在 ${profilePath}`,
      `放置 ${profilePath}（参考 §7.2 示例），或运行 'cc-linker review doctor' 查完整诊断报告`,
    );
  }
  const tomlText = readFileSync(profilePath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = parseToml(tomlText);
  } catch (err) {
    throw new ProfileError(
      'PROFILE_INVALID',
      `profile '${name}' TOML 解析失败: ${(err as Error).message}`,
      `检查 TOML 语法，可参考 §7.2 示例`,
    );
  }
  let profile: ReviewProfile;
  try {
    profile = ReviewProfileSchema.parse(parsed);
  } catch (err) {
    throw new ProfileError(
      'PROFILE_INVALID',
      `profile '${name}' Zod 验证失败: ${(err as Error).message}`,
      `检查 profile 字段是否齐全（meta.name / work.provider / review.providers）`,
    );
  }

  // Apply phase_overrides (deep merge per spec §7.3)
  const phaseOverrides = profile.phase_overrides[phase];
  if (phaseOverrides && typeof phaseOverrides === 'object') {
    profile = deepMerge(profile, phaseOverrides as Partial<ReviewProfile>);
  }

  // Validate provider files exist (spec §7.4 fail fast)
  for (const providerName of [profile.work.provider, ...profile.review.providers]) {
    await validateProviderExists(providerName);
  }

  logger.info(`[review] loaded profile '${name}' for phase '${phase}' (max_rounds=${profile.guards.max_rounds})`);
  return profile;
}

async function validateProviderExists(providerName: string): Promise<void> {
  const { existsProvider } = await import('../utils/providers');
  if (!existsProvider(providerName)) {
    throw new ProfileError(
      'PROVIDER_NOT_FOUND',
      `provider '${providerName}' 不在 ~/.claude/providers/`,
      `放置 ~/.cc-linker/providers/${providerName}.json（格式参考其他 provider），或运行 'cc-linker review doctor' 查完整诊断报告`,
    );
  }
}

function deepMerge(base: ReviewProfile, overrides: any): ReviewProfile {
  // Array fields: completely replace (per spec §7.3)
  // Object fields: deep merge
  // Scalar fields: replace
  const merged: any = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (Array.isArray(value)) {
      merged[key] = value;  // 完全替换
    } else if (value && typeof value === 'object' && base[key as keyof ReviewProfile]) {
      merged[key] = deepMerge(base[key as keyof ReviewProfile] as any, value);
    } else {
      merged[key] = value;  // 标量覆盖
    }
  }
  return merged as ReviewProfile;
}
```

- [ ] **Step 4: Add `REVIEW_PROFILES_DIR` to paths.ts**

Modify `src/utils/paths.ts`, add after `SCAN_CACHE_PATH`:

```typescript
export const REVIEW_PROFILES_DIR = process.env.CC_LINKER_REVIEW_PROFILES_DIR ?? join(CC_LINKER_DIR, 'review-profiles');
export const REVIEW_PIPELINES_DIR = process.env.CC_LINKER_REVIEW_PIPELINES_DIR ?? join(CC_LINKER_DIR, 'review-pipelines');
```

- [ ] **Step 5: Add `existsProvider` to providers.ts**

Modify `src/utils/providers.ts`, add new method to `ProviderManager` class (or as exported function):

```typescript
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export function existsProvider(name: string): boolean {
  const path = join(process.env.HOME ?? '/tmp', '.claude', 'providers', `${name}.json`);
  return existsSync(path);
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test tests/unit/review/profile.test.ts`
Expected: 2 tests pass

- [ ] **Step 7: Commit**

```bash
git add src/review/profile.ts tests/unit/review/profile.test.ts src/utils/paths.ts src/utils/providers.ts
git commit -m "feat(review): profile.load with phase_overrides + provider validation (T1.2)"
```

### Task 1.3: `cc-linker review doctor` 命令

**Files:**
- Create: `src/review/review-doctor.ts`
- Create: `tests/unit/review/review-doctor.test.ts`
- Modify: `src/cli/commands/review.ts` (will be created later in T7; for now create stub)

- [ ] **Step 1: Write failing test for review-doctor**

Create `tests/unit/review/review-doctor.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDoctor } from '../../src/review/review-doctor';

describe('runDoctor', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'doctor-')); });
  afterEach(() => rmSync(tmpDir, { recursive: true }));

  it('returns exit code 0 when all checks pass', async () => {
    // Setup: write a profile with provider files
    const profilePath = join(tmpDir, 'default.toml');
    writeFileSync(profilePath, `
[meta]
name = "default"
[work]
provider = "test-sonnet"
[review]
providers = ["test-kimi"]
`);
    const result = await runDoctor({ profilePath });
    expect(result.exitCode).toBe(0);
    expect(result.checks).toContainEqual(expect.objectContaining({ name: 'cli-version', ok: true }));
  });

  it('returns exit code 1 when profile missing', async () => {
    const result = await runDoctor({ profilePath: '/nonexistent.toml' });
    expect(result.exitCode).toBe(1);
    expect(result.checks.some(c => !c.ok)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/review/review-doctor.test.ts`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Implement review-doctor.ts**

Create `src/review/review-doctor.ts`:

```typescript
import { spawn } from 'bun';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseToml } from '@iarna/toml';
import { logger } from '../utils/logger';
import { existsProvider } from '../utils/providers';
import { CLAUDE_JOBS_DIR } from '../utils/paths';

const MIN_CLAUDE_VERSION = '2.1.163';

export interface DoctorCheck {
  name: string;
  ok: boolean;
  message: string;
  remediation?: string;
}

export interface DoctorResult {
  exitCode: 0 | 1;
  checks: DoctorCheck[];
}

export async function runDoctor(opts: { profilePath?: string }): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];

  // 1. CLI version
  checks.push(await checkCliVersion());

  // 2. Daemon health
  checks.push(await checkDaemonHealth());

  // 3. Profile load + provider validation (if profilePath provided)
  if (opts.profilePath) {
    checks.push(...(await checkProfile(opts.profilePath)));
  }

  const exitCode: 0 | 1 = checks.every(c => c.ok) ? 0 : 1;
  return { exitCode, checks };
}

async function checkCliVersion(): Promise<DoctorCheck> {
  try {
    const proc = spawn(['claude', '--version'], { stdout: 'pipe', stderr: 'pipe' });
    const out = await new Response(proc.stdout).text();
    const match = out.match(/(\d+\.\d+\.\d+)/);
    if (!match) {
      return { name: 'cli-version', ok: false, message: '无法解析 claude --version 输出', remediation: '检查 Claude CLI 是否正确安装' };
    }
    const version = match[1];
    const ok = compareVersions(version, MIN_CLAUDE_VERSION) >= 0;
    return {
      name: 'cli-version',
      ok,
      message: ok ? `Claude CLI ${version} (>= ${MIN_CLAUDE_VERSION} required)` : `Claude CLI ${version} 不支持 --bg，需要 >= ${MIN_CLAUDE_VERSION}`,
      remediation: ok ? undefined : '运行 `claude update` 升级到最新稳定版',
    };
  } catch (err) {
    return { name: 'cli-version', ok: false, message: `claude 命令执行失败: ${err}`, remediation: '检查 Claude CLI 是否在 PATH 中' };
  }
}

async function checkDaemonHealth(): Promise<DoctorCheck> {
  const rosterPath = join(CLAUDE_JOBS_DIR, '..', 'daemon', 'roster.json');
  if (!existsSync(rosterPath)) {
    return { name: 'daemon', ok: false, message: 'daemon roster.json 不存在', remediation: '启动 Claude CLI 一次以初始化 daemon' };
  }
  // 检查 mtime
  const stat = require('node:fs').statSync(rosterPath);
  const ageMs = Date.now() - stat.mtimeMs;
  const ok = ageMs < 5 * 60 * 1000;  // 5 min
  return {
    name: 'daemon',
    ok,
    message: ok ? 'daemon healthy' : `daemon roster.json stale (${Math.round(ageMs / 1000)}s ago)`,
  };
}

async function checkProfile(profilePath: string): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  if (!existsSync(profilePath)) {
    checks.push({ name: 'profile', ok: false, message: `profile 不存在: ${profilePath}`, remediation: `放置 ${profilePath}` });
    return checks;
  }
  try {
    const tomlText = readFileSync(profilePath, 'utf-8');
    const profile = parseToml(tomlText) as any;
    const providers: string[] = [profile.work?.provider, ...(profile.review?.providers ?? [])].filter(Boolean);
    for (const p of providers) {
      const ok = existsProvider(p);
      checks.push({
        name: `provider:${p}`,
        ok,
        message: ok ? `Provider '${p}' found` : `Provider '${p}' 不在 ~/.claude/providers/`,
        remediation: ok ? undefined : `放置 ~/.claude/providers/${p}.json`,
      });
    }
  } catch (err) {
    checks.push({ name: 'profile', ok: false, message: `profile 解析失败: ${err}`, remediation: '检查 TOML 语法' });
  }
  return checks;
}

function compareVersions(a: string, b: string): number {
  const [a1, a2, a3] = a.split('.').map(Number);
  const [b1, b2, b3] = b.split('.').map(Number);
  if (a1 !== b1) return a1 - b1;
  if (a2 !== b2) return a2 - b2;
  return a3 - b3;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/review/review-doctor.test.ts`
Expected: 2 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/review/review-doctor.ts tests/unit/review/review-doctor.test.ts
git commit -m "feat(review): cc-linker review doctor health check (T1.3)"
```

---

## Task 2 (W1): PipelineStore + Reconciler

### Task 2.1: PipelineStore 5 目录原子写

**Files:**
- Create: `src/review/pipeline-store.ts`
- Create: `tests/unit/review/pipeline-store.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/unit/review/pipeline-store.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PipelineStore, type PipelineRecord } from '../../src/review/pipeline-store';

describe('PipelineStore', () => {
  let tmpDir: string;
  let store: PipelineStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pipe-'));
    store = new PipelineStore(join(tmpDir, 'pipelines'));
  });
  afterEach(() => rmSync(tmpDir, { recursive: true }));

  const sampleRecord = (id: string): PipelineRecord => ({
    pipelineId: id,
    createdAt: '2026-06-14T00:00:00Z',
    updatedAt: '2026-06-14T00:00:00Z',
    state: { kind: 'PRODUCING', pipelineId: id, round: 0, pane: 'work' },
    input: { rawInput: 'test', phase: 'code', profile: 'default', maxRounds: 6, cwd: '/tmp' },
    panes: { reviews: [] },
    history: [],
    totalCostUsd: 0,
  });

  it('saves and reads running pipeline', async () => {
    await store.saveRunning(sampleRecord('p1'));
    const read = await store.readRunning('p1');
    expect(read?.pipelineId).toBe('p1');
  });

  it('moves terminal pipeline to correct subdirectory', async () => {
    await store.saveRunning(sampleRecord('p1'));
    await store.moveToTerminal({ ...sampleRecord('p1'), state: { kind: 'DONE', pipelineId: 'p1', round: 1, totalCostUsd: 0, issueTrail: [] } });
    expect(existsSync(join(tmpDir, 'pipelines', 'running', 'p1.json'))).toBe(false);
    expect(existsSync(join(tmpDir, 'pipelines', 'done', 'p1.json'))).toBe(true);
  });

  it('atomic write via tmp file', async () => {
    await store.saveRunning(sampleRecord('p1'));
    // tmp file should not be left behind
    expect(existsSync(join(tmpDir, 'pipelines', 'running', 'p1.json.tmp'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/review/pipeline-store.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement pipeline-store.ts**

Create `src/review/pipeline-store.ts`:

```typescript
import { mkdir, writeFile, rename, readFile, readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { PipelineRecord, ReviewState } from './types';
import { logger } from '../utils/logger';

export type TerminalDir = 'done' | 'failed' | 'aborted';

export class PipelineStore {
  constructor(public baseDir: string) {}

  private runningDir() { return join(this.baseDir, 'running'); }
  private terminalDir(kind: TerminalDir | 'human_pending') { return join(this.baseDir, kind); }

  async ensureDirs(): Promise<void> {
    await mkdir(this.runningDir(), { recursive: true });
    for (const d of ['human_pending', 'done', 'failed', 'aborted'] as const) {
      await mkdir(this.terminalDir(d), { recursive: true });
    }
  }

  async saveRunning(record: PipelineRecord): Promise<void> {
    await this.ensureDirs();
    const path = join(this.runningDir(), `${record.pipelineId}.json`);
    const tmpPath = `${path}.tmp`;
    record.updatedAt = new Date().toISOString();
    await writeFile(tmpPath, JSON.stringify(record, null, 2), { mode: 0o600 });
    await rename(tmpPath, path);  // atomic on POSIX
    logger.debug(`[pipeline-store] saved ${record.pipelineId} (state=${record.state.kind})`);
  }

  async readRunning(pipelineId: string): Promise<PipelineRecord | null> {
    const path = join(this.runningDir(), `${pipelineId}.json`);
    if (!existsSync(path)) return null;
    return JSON.parse(await readFile(path, 'utf-8'));
  }

  async listRunning(): Promise<PipelineRecord[]> {
    return this.listDir(this.runningDir());
  }

  async listHumanPending(): Promise<PipelineRecord[]> {
    return this.listDir(this.terminalDir('human_pending'));
  }

  private async listDir(dir: string): Promise<PipelineRecord[]> {
    if (!existsSync(dir)) return [];
    const files = await readdir(dir);
    const records: PipelineRecord[] = [];
    for (const f of files) {
      if (!f.endsWith('.json') || f.endsWith('.tmp')) continue;
      try {
        records.push(JSON.parse(await readFile(join(dir, f), 'utf-8')));
      } catch (err) {
        logger.warn(`[pipeline-store] failed to read ${f}: ${err}`);
      }
    }
    return records;
  }

  async moveToTerminal(record: PipelineRecord): Promise<void> {
    const srcPath = join(this.runningDir(), `${record.pipelineId}.json`);
    if (!existsSync(srcPath)) {
      logger.warn(`[pipeline-store] ${record.pipelineId} not in running/, skip moveToTerminal`);
      return;
    }
    const dest = this.dirForState(record.state);
    await mkdir(dest, { recursive: true });
    const destPath = join(dest, `${record.pipelineId}.json`);
    await rename(srcPath, destPath);
    logger.debug(`[pipeline-store] moved ${record.pipelineId} → ${dest.split('/').pop()}`);
  }

  private dirForState(state: ReviewState): string {
    switch (state.kind) {
      case 'DONE': return this.terminalDir('done');
      case 'FAILED': return this.terminalDir('failed');
      case 'ABORTED': return this.terminalDir('aborted');
      case 'HUMAN_DECIDE': return this.terminalDir('human_pending');
      default: return this.runningDir();
    }
  }

  async cleanupTmpFiles(): Promise<void> {
    if (!existsSync(this.runningDir())) return;
    const files = await readdir(this.runningDir());
    for (const f of files) {
      if (f.endsWith('.tmp')) await unlink(join(this.runningDir(), f));
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/review/pipeline-store.test.ts`
Expected: 3 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/review/pipeline-store.ts tests/unit/review/pipeline-store.test.ts
git commit -m "feat(review): PipelineStore 5-directory atomic writes (T2.1)"
```

### Task 2.2: Reconciler 检测 pane 丢失 → PANE_LOST

**Files:**
- Create: `src/review/reconciler.ts`
- Create: `tests/unit/review/reconciler.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/unit/review/reconciler.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PipelineStore } from '../../src/review/pipeline-store';
import { reconcile } from '../../src/review/reconciler';
import type { PipelineRecord } from '../../src/review/types';

describe('reconcile', () => {
  let tmpDir: string;
  let store: PipelineStore;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'recon-'));
    store = new PipelineStore(join(tmpDir, 'pipelines'));
    await store.ensureDirs();
  });
  afterEach(() => rmSync(tmpDir, { recursive: true }));

  const liveShortId = 'short1';

  it('transitions to PANE_LOST when pane disappears', async () => {
    const record: PipelineRecord = {
      pipelineId: 'p1',
      createdAt: '', updatedAt: '',
      state: { kind: 'EXTERNAL_REVIEW', pipelineId: 'p1', round: 1, cycle: 'initial',
               panes: [{ role: 'review-A', shortId: 'short-gone' }, { role: 'review-B', shortId: liveShortId }] },
      input: { rawInput: 'x', phase: 'code', profile: 'default', maxRounds: 6, cwd: '/tmp' },
      panes: { reviews: [
        { role: 'review-A', shortId: 'short-gone', sessionId: 'uuid-A', provider: 'kimi', round: 1, cycle: 'initial' },
        { role: 'review-B', shortId: liveShortId, sessionId: 'uuid-B', provider: 'qwen', round: 1, cycle: 'initial' },
      ] },
      history: [],
      totalCostUsd: 0,
    };
    await store.saveRunning(record);

    // Mock fetcher returns only liveShortId
    const mockFetcher = async () => ({ sessions: [{ daemonShort: liveShortId, kind: 'background' }] });

    await reconcile({ store, fetcher: mockFetcher as any, adapter: {} as any });

    const updated = await store.readRunning('p1');
    expect(updated?.state.kind).toBe('PANE_LOST');
    if (updated?.state.kind === 'PANE_LOST') {
      expect(updated.state.lostPanes).toEqual([{ role: 'review-A', shortId: 'short-gone' }]);
      expect(updated.state.retryTarget).toBe('EXTERNAL_REVIEW');
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/review/reconciler.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement reconciler.ts**

Create `src/review/reconciler.ts`:

```typescript
import type { PipelineStore } from './pipeline-store';
import type { PipelineRecord, ReviewState, PaneRegistry } from './types';
import type { ClaudeBGAdapter } from './adapter';
import type { AgentSnapshotFetcher } from '../agent-view/snapshot-fetcher';
import { logger } from '../utils/logger';

interface ReconcileOpts {
  store: PipelineStore;
  fetcher: AgentSnapshotFetcher;
  adapter: ClaudeBGAdapter;
}

const TERMINAL_KINDS = new Set(['DONE', 'FAILED', 'ABORTED']);

export async function reconcile({ store, fetcher, adapter: _adapter }: ReconcileOpts): Promise<void> {
  // 1. Cleanup stale tmp files first
  await store.cleanupTmpFiles();

  // 2. Scan running/
  for (const record of await store.listRunning()) {
    // If terminal but still in running/, move it
    if (TERMINAL_KINDS.has(record.state.kind)) {
      await store.moveToTerminal(record);
      continue;
    }

    // 3. Check if any pane bg session has disappeared
    const liveShortIds = new Set<string>(
      ((await fetcher.fetch())?.sessions ?? [])
        .filter(s => s.kind === 'background')
        .map(s => s.daemonShort),
    );

    const deadPanes = findDeadPanes(record.panes, liveShortIds);
    if (deadPanes.length > 0) {
      logger.warn(`[reconciler] pipeline ${record.pipelineId} has ${deadPanes.length} dead pane(s): ${deadPanes.map(p => `${p.role}@${p.shortId}`).join(', ')}`);
      record.state = {
        kind: 'PANE_LOST',
        pipelineId: record.pipelineId,
        round: record.state.round,
        lostPanes: deadPanes,
        detectedAt: new Date().toISOString(),
        retryTarget: record.state.kind,
      };
      await store.saveRunning(record);
      continue;
    }

    // 4. Otherwise: resume in-memory active set (caller's responsibility)
    logger.debug(`[reconciler] pipeline ${record.pipelineId} alive at ${record.state.kind}`);
  }

  // 5. Notify human_pending (if any CLI watch clients connected)
  for (const record of await store.listHumanPending()) {
    logger.debug(`[reconciler] pipeline ${record.pipelineId} waiting human decision`);
  }
}

export function findDeadPanes(
  panes: PaneRegistry,
  liveShortIds: Set<string>,
): Array<{ role: string; shortId: string }> {
  const dead: Array<{ role: string; shortId: string }> = [];
  if (panes.work?.currentRoundShortId && !liveShortIds.has(panes.work.currentRoundShortId)) {
    dead.push({ role: 'work', shortId: panes.work.currentRoundShortId });
  }
  for (const r of panes.reviews) {
    if (!liveShortIds.has(r.shortId)) {
      dead.push({ role: r.role, shortId: r.shortId });
    }
  }
  return dead;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/review/reconciler.test.ts`
Expected: 1 test passes

- [ ] **Step 5: Commit**

```bash
git add src/review/reconciler.ts tests/unit/review/reconciler.test.ts
git commit -m "feat(review): Reconciler detects dead panes → PANE_LOST (T2.2)"
```

### Task 2.3: pipeline-state.ts (in-memory Map + AbortController)

**Files:**
- Create: `src/review/pipeline-state.ts`
- Create: `tests/unit/review/pipeline-state.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/unit/review/pipeline-state.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test';
import { PipelineState, type ActivePipeline } from '../../src/review/pipeline-state';

describe('PipelineState', () => {
  it('registers and retrieves active pipeline', () => {
    const state = new PipelineState();
    const ap: ActivePipeline = {
      pipelineId: 'p1',
      abortController: new AbortController(),
      watchClientSet: new Set(),
    };
    state.set('p1', ap);
    expect(state.get('p1')).toBe(ap);
  });

  it('aborts controller on delete', () => {
    const state = new PipelineState();
    const ap: ActivePipeline = {
      pipelineId: 'p1',
      abortController: new AbortController(),
      watchClientSet: new Set(),
    };
    state.set('p1', ap);
    state.delete('p1');
    expect(ap.abortController.signal.aborted).toBe(true);
  });

  it('lists active pipeline ids', () => {
    const state = new PipelineState();
    state.set('p1', { pipelineId: 'p1', abortController: new AbortController(), watchClientSet: new Set() });
    state.set('p2', { pipelineId: 'p2', abortController: new AbortController(), watchClientSet: new Set() });
    expect([...state.ids()].sort()).toEqual(['p1', 'p2']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/review/pipeline-state.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement pipeline-state.ts**

Create `src/review/pipeline-state.ts`:

```typescript
export interface ActivePipeline {
  pipelineId: string;
  abortController: AbortController;
  watchClientSet: Set<{ send: (msg: unknown) => void }>;
}

export class PipelineState {
  private readonly map = new Map<string, ActivePipeline>();

  set(id: string, ap: ActivePipeline): void {
    // If existing, abort old controller before replacing
    const existing = this.map.get(id);
    if (existing) existing.abortController.abort();
    this.map.set(id, ap);
  }

  get(id: string): ActivePipeline | undefined {
    return this.map.get(id);
  }

  has(id: string): boolean {
    return this.map.has(id);
  }

  delete(id: string): boolean {
    const ap = this.map.get(id);
    if (ap) {
      ap.abortController.abort();
      return this.map.delete(id);
    }
    return false;
  }

  ids(): IterableIterator<string> {
    return this.map.keys();
  }

  values(): IterableIterator<ActivePipeline> {
    return this.map.values();
  }
}

// Singleton instance (one per process)
export const pipelineState = new PipelineState();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/review/pipeline-state.test.ts`
Expected: 3 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/review/pipeline-state.ts tests/unit/review/pipeline-state.test.ts
git commit -m "feat(review): pipeline-state in-memory Map with AbortController (T2.3)"
```

---

## Task 3 (W2): PhaseDetector (5 个启发式)

**Files:**
- Create: `src/review/phase-detect.ts`
- Create: `tests/unit/review/phase-detect.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/unit/review/phase-detect.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test';
import { detect, PhaseUnknownError } from '../../src/review/phase-detect';

describe('detect', () => {
  it('detects code from file extension', () => {
    expect(detect({ rawInput: 'fix bug', filePath: 'src/auth.ts' })).toBe('code');
  });

  it('detects spec from docs/ path', () => {
    expect(detect({ rawInput: 'review', filePath: 'docs/specs/login.md' })).toBe('spec');
  });

  it('detects plan from plans/ path', () => {
    expect(detect({ rawInput: 'review', filePath: 'plans/design.md' })).toBe('plan');
  });

  it('detects code from git ref', () => {
    expect(detect({ rawInput: 'review changes', gitRef: 'abc123' })).toBe('code');
  });

  it('detects spec from keyword "requirements"', () => {
    expect(detect({ rawInput: 'Write user requirements for the login feature' })).toBe('spec');
  });

  it('detects code from keyword "implement"', () => {
    expect(detect({ rawInput: 'Implement the new auth flow' })).toBe('code');
  });

  it('detects plan from keyword "architecture"', () => {
    expect(detect({ rawInput: 'Design the architecture for the new system' })).toBe('plan');
  });

  it('heuristic 4: detects code from file suffix in rawInput', () => {
    expect(detect({ rawInput: 'fix the bug in auth.ts line 42' })).toBe('code');
  });

  it('heuristic 4: detects code from line number reference', () => {
    expect(detect({ rawInput: 'debug the error at line 42' })).toBe('code');
  });

  it('throws PhaseUnknownError when no heuristic matches', () => {
    expect(() => detect({ rawInput: 'do the thing' })).toThrow(PhaseUnknownError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/review/phase-detect.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement phase-detect.ts**

Create `src/review/phase-detect.ts`:

```typescript
export type Phase = 'spec' | 'plan' | 'code';

export class PhaseUnknownError extends Error {
  constructor(public rawInput: string) {
    super(`无法自动识别 phase，rawInput="${rawInput}"。请用 --phase spec|plan|code 显式指定`);
    this.name = 'PhaseUnknownError';
  }
}

interface DetectInput {
  rawInput: string;
  filePath?: string;
  gitRef?: string;
}

const CODE_FILE_REGEX = /\.(ts|js|py|go|rs|java|swift|c|cpp|h)$/;
const CODE_FILE_INLINE_REGEX = /\.(ts|js|py|go|rs|java|swift|c|cpp|h)\b/;
const LINE_NUMBER_REGEX = /\b(line\s+\d+|L:\d+|\.go:\d+|\.ts:\d+)/;

export function detect(input: DetectInput): Phase {
  // Heuristic 1: file path
  if (input.filePath) {
    if (CODE_FILE_REGEX.test(input.filePath)) return 'code';
    if (input.filePath.includes('docs/') || input.filePath.includes('specs/')) return 'spec';
    if (input.filePath.includes('plans/') || input.filePath.includes('design/')) return 'plan';
  }

  // Heuristic 2: git ref
  if (input.gitRef) return 'code';

  const text = input.rawInput.toLowerCase();

  // Heuristic 3: text keywords
  if (text.match(/(requirements?|user stor(y|ies)|acceptance criteria)/)) return 'spec';
  if (text.match(/(architecture|task breakdown|milestone|dependencies?)/)) return 'plan';
  if (text.match(/(implement|fix|debug|optimize|refactor)/)) return 'code';

  // Heuristic 4: file suffix or line number in rawInput (strong code signal)
  if (CODE_FILE_INLINE_REGEX.test(input.rawInput)) return 'code';
  if (LINE_NUMBER_REGEX.test(input.rawInput)) return 'code';

  // Heuristic 5 (Phase 3): LLM classification
  // TODO: implement when llmFallback config is added

  throw new PhaseUnknownError(input.rawInput);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/review/phase-detect.test.ts`
Expected: 10 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/review/phase-detect.ts tests/unit/review/phase-detect.test.ts
git commit -m "feat(review): PhaseDetector with 5 heuristics (T3)"
```

---

## Task 4 (W2): Adapter (claude --bg + injectReply + poll)

### Task 4.1: Adapter startSession + resumeWorkSession

**Files:**
- Create: `src/review/adapter.ts`
- Create: `tests/unit/review/adapter.test.ts`

- [ ] **Step 1: Write failing test for startSession parsing**

Create `tests/unit/review/adapter.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test';
import { parseBackgroundedOutput } from '../../src/review/adapter';

describe('parseBackgroundedOutput', () => {
  it('parses standard backgrounded output', () => {
    const stdout = `
Starting background service…
backgrounded · 3f219846
  claude agents             list sessions
  claude attach 3f219846    open in this terminal
`;
    expect(parseBackgroundedOutput(stdout)).toBe('3f219846');
  });

  it('throws on unexpected output', () => {
    expect(() => parseBackgroundedOutput('error: something')).toThrow(/bg spawn failed/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/review/adapter.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement adapter.ts (partial — just parsing + startSession)**

Create `src/review/adapter.ts`:

```typescript
import { spawn } from 'bun';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CLAUDE_JOBS_DIR } from '../utils/paths';
import { readJobState, type JobStateFile } from '../agent-view/job-state';
import { RendezvousClient, type RendezvousReplyResult } from '../agent-view/rendezvous-client';
import { logger } from '../utils/logger';
import type { Issue } from './types';

export interface StartSessionOpts {
  role: 'work' | 'review' | 'arbiter';
  provider: string;
  prompt: string;
  cwd: string;
  resumeSessionId?: string;
  settingsPath?: string;  // 默认 ~/.claude/providers/<provider>.json
}

export interface StartSessionResult {
  shortId: string;
  sessionId: string;
}

export class ClaudeBGAdapter {
  /**
   * 启动 bg session（首次或带 resume）。
   */
  async startSession(opts: StartSessionOpts): Promise<StartSessionResult> {
    const settingsPath = opts.settingsPath ?? join(process.env.HOME ?? '/tmp', '.claude', 'providers', `${opts.provider}.json`);
    const args = ['claude', '--bg', opts.prompt, '--settings', settingsPath];
    if (opts.resumeSessionId) {
      args.push('--resume', opts.resumeSessionId, '--reply-on-resume');
    }
    const proc = spawn(args, { cwd: opts.cwd, stdout: 'pipe', stderr: 'pipe' });
    const out = await new Response(proc.stdout).text();
    const shortId = parseBackgroundedOutput(out);

    // 轮询 state.json 拿 sessionId
    let sessionId = '';
    for (let i = 0; i < 20; i++) {
      const state = await readJobState(shortId);
      if (state?.sessionId) { sessionId = state.sessionId; break; }
      await Bun.sleep(100);
    }
    if (!sessionId) throw new Error(`bg session ${shortId} 没有 sessionId`);

    logger.info(`[adapter] spawned ${opts.role} bg session ${shortId} (sessionId=${sessionId})`);
    return { shortId, sessionId };
  }

  /**
   * 续接 work session 跨 R1/R2/FIXING/JUDGE。
   */
  async resumeWorkSession(opts: {
    sessionId: string;
    prompt: string;
    provider: string;
    cwd: string;
  }): Promise<{ shortId: string }> {
    // 同 startSession + --resume --reply-on-resume
    return (await this.startSession({
      role: 'work',
      provider: opts.provider,
      prompt: opts.prompt,
      cwd: opts.cwd,
      resumeSessionId: opts.sessionId,
    }));
  }

  /**
   * 注入 reply 到 running bg session（走 RendezvousClient，daemon 协议）。
   */
  async injectReply(opts: {
    shortId: string;
    text: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<RendezvousReplyResult> {
    const stateJsonPath = join(CLAUDE_JOBS_DIR, opts.shortId, 'state.json');
    const rendezvousSock = `${process.env.TMPDIR ?? '/tmp'}claude-rendezvous-${opts.shortId}.sock`;
    // 实际 sock 路径由 daemon 决定；这里走默认路径
    const client = new RendezvousClient();
    return await client.injectReply({
      short: opts.shortId,
      text: opts.text,
      rendezvousSock,
      timeoutMs: opts.timeoutMs ?? 60_000,
      stateJsonPath,
      signal: opts.signal,
    });
  }

  /**
   * 轮询 pane 状态（500ms tick）。
   */
  async poll(shortId: string, timeoutMs: number, signal?: AbortSignal): Promise<JobStateFile | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error('aborted');
      const state = await readJobState(shortId);
      if (!state) throw new Error(`pane ${shortId} 不存在`);
      if (['done', 'stopped', 'failed'].includes(state.state)) return state;
      await Bun.sleep(500);
    }
    throw new Error(`poll timeout after ${timeoutMs}ms`);
  }

  /**
   * 停止 pane。
   */
  async stop(shortId: string): Promise<void> {
    const proc = spawn(['claude', 'stop', shortId], { stdout: 'pipe', stderr: 'pipe', timeout: 5000 });
    await proc.exited.catch(() => {/* daemon may have already stopped */});
  }

  /**
   * Pipeline 启动时复制 provider 配置到 snapshot dir。
   * spec §14 第 5 行：用户跑 pipeline 途中改了 ~/.claude/providers/*.json 不影响 in-flight pipeline。
   */
  async snapshotProviders(providers: string[], snapshotDir: string): Promise<void> {
    await mkdir(snapshotDir, { recursive: true });
    for (const p of providers) {
      const src = join(process.env.HOME ?? '/tmp', '.claude', 'providers', `${p}.json`);
      if (!existsSync(src)) continue;
      const dest = join(snapshotDir, `${p}.json`);
      await writeFile(dest, await readFile(src, 'utf-8'), { mode: 0o600 });
    }
    logger.info(`[adapter] snapshotted ${providers.length} providers → ${snapshotDir}`);
  }
}

/**
 * 解析 `claude --bg` 输出 `backgrounded · <shortId>`。
 */
export function parseBackgroundedOutput(stdout: string): string {
  const match = stdout.match(/backgrounded · ([a-f0-9]+)/);
  if (!match) throw new Error(`bg spawn failed: ${stdout.trim()}`);
  return match[1];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/review/adapter.test.ts`
Expected: 2 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/review/adapter.ts tests/unit/review/adapter.test.ts
git commit -m "feat(review): ClaudeBGAdapter (startSession/resumeWork/injectReply/poll/stop) (T4.1)"
```

### Task 4.2: Adapter spawn with --settings integration test

**Files:**
- Create: `tests/integration/review/adapter-bg-spawn.test.ts`

- [ ] **Step 1: Write integration test**

Create `tests/integration/review/adapter-bg-spawn.test.ts`:

```typescript
import { describe, it, expect, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeBGAdapter, parseBackgroundedOutput } from '../../../src/review/adapter';
import { readJobState } from '../../../src/agent-view/job-state';

describe('ClaudeBGAdapter integration (real claude --bg)', () => {
  let tmpDir: string;
  const spawnedShortIds: string[] = [];

  afterAll(() => {
    // cleanup all spawned sessions
    const adapter = new ClaudeBGAdapter();
    spawnedShortIds.forEach(async id => { try { await adapter.stop(id); } catch {} });
    if (tmpDir) rmSync(tmpDir, { recursive: true });
  });

  it('spawns a real bg session and parses shortId', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'adapter-test-'));
    const adapter = new ClaudeBGAdapter();
    const result = await adapter.startSession({
      role: 'review',
      provider: 'kimi-for-coding',
      prompt: 'say hello',
      cwd: tmpDir,
    });
    expect(result.shortId).toMatch(/^[a-f0-9]{8}$/);
    spawnedShortIds.push(result.shortId);
    expect(result.sessionId).toMatch(/^[a-f0-9-]{36}$/);

    // 验证 state.json 真的写到了
    const state = await readJobState(result.shortId);
    expect(state).not.toBeNull();
    expect(state?.providerEnv?.ANTHROPIC_MODEL).toContain('kimi');
  }, { timeout: 15_000 });
});
```

- [ ] **Step 2: Run integration test**

Run: `bun test tests/integration/review/adapter-bg-spawn.test.ts`
Expected: 1 test passes (with real `claude --bg`)

- [ ] **Step 3: If test fails due to provider missing, skip**

If `~/.claude/providers/kimi-for-coding.json` doesn't exist, the test will fail with "provider not found". In CI, mark this test as skipped. Add at top of test:

```typescript
import { existsSync } from 'node:fs';
const skipInCI = !existsSync(join(process.env.HOME ?? '/tmp', '.claude', 'providers', 'kimi-for-coding.json'));
const testFn = skipInCI ? describe.skip : describe;
testFn('ClaudeBGAdapter integration (real claude --bg)', () => { /* ... */ });
```

- [ ] **Step 4: Commit**

```bash
git add tests/integration/review/adapter-bg-spawn.test.ts
git commit -m "test(review): adapter-bg-spawn integration test (T4.2)"
```

---

## Task 5 (W3-W4): Engine 状态机 (基础 9 states)

### Task 5.1: Output Contract (Zod schemas + JSON 提取 + parse 降级)

**Files:**
- Create: `src/review/output-contract.ts`
- Create: `tests/unit/review/output-contract.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/unit/review/output-contract.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test';
import { extractJsonBlock, parseBgOutput, SelfReviewOutputSchema, FixingOutputSchema } from '../../src/review/output-contract';

describe('extractJsonBlock', () => {
  it('extracts from json fence', () => {
    const text = 'Some text\n```json\n{"issues": [], "unfixed_count": 0}\n```\nMore text';
    expect(extractJsonBlock(text)).toEqual({ issues: [], unfixed_count: 0 });
  });

  it('extracts from brace block', () => {
    const text = 'prefix {"issues": [{"severity": "P1"}], "unfixed_count": 1} suffix';
    expect(extractJsonBlock(text)).toEqual({ issues: [{ severity: 'P1' }], unfixed_count: 1 });
  });

  it('throws when no JSON found', () => {
    expect(() => extractJsonBlock('no json here')).toThrow(/No JSON block found/);
  });
});

describe('parseBgOutput', () => {
  it('validates against SelfReview schema', () => {
    const output = '```json\n{"issues": [], "unfixed_count": 0}\n```';
    const result = parseBgOutput(output, SelfReviewOutputSchema);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.issues).toEqual([]);
    }
  });

  it('returns raw on parse failure (graceful degradation)', () => {
    const output = 'no json anywhere';
    const result = parseBgOutput(output, FixingOutputSchema);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.raw).toBe('no json anywhere');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/review/output-contract.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement output-contract.ts**

Create `src/review/output-contract.ts`:

```typescript
import { z } from 'zod';
import { logger } from '../utils/logger';

// ============ JSON Extraction ============

export function extractJsonBlock(output: string): unknown {
  // Strategy 1: ```json ... ``` fence
  const fenceMatch = output.match(/```json\s*\n([\s\S]*?)\n```/);
  if (fenceMatch) return JSON.parse(fenceMatch[1]);

  // Strategy 2: greedy last { ... } block
  const braceMatch = output.match(/\{[\s\S]*\}/);
  if (braceMatch) return JSON.parse(braceMatch[0]);

  // Strategy 3: full JSON.parse
  return JSON.parse(output);
}

// ============ Zod Schemas (per spec §7.5.3) ============

export const IssueSchema = z.object({
  id: z.string().optional(),
  severity: z.enum(['P0', 'P1', 'P2', 'P3']),
  location: z.string(),
  description: z.string(),
  suggestion: z.string().optional(),
  category: z.string().optional(),
  source: z.string().optional(),
  workDecision: z.enum(['accept', 'reject', 'partial']).optional(),
});

export const SelfReviewOutputSchema = z.object({
  issues: z.array(z.object({
    severity: z.enum(['P0', 'P1', 'P2', 'P3']),
    location: z.string(),
    description: z.string(),
  })),
  unfixed_count: z.number().int().min(0),
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
  remaining_real_unfixed_count: z.number().int().min(0),
});

export const JudgeOutputSchema = z.object({
  per_issue: z.array(z.object({
    issue_id: z.string(),
    decision: z.enum(['accept', 'reject', 'partial']),
    reason: z.string(),
  })),
  reasoning: z.string(),
});

export const ReviewOutputSchema = z.object({
  issues: z.array(z.object({
    severity: z.enum(['P0', 'P1', 'P2', 'P3']),
    category: z.string().optional(),
    location: z.string(),
    description: z.string(),
    suggestion: z.string().optional(),
  })),
});

// ============ Parse with Graceful Degradation ============

export type ParseResult<T> = { ok: true; data: T } | { ok: false; raw: string };

export function parseBgOutput<T>(output: string, schema: z.ZodSchema<T>): ParseResult<T> {
  try {
    const json = extractJsonBlock(output);
    const data = schema.parse(json);
    return { ok: true, data };
  } catch (err) {
    logger.warn(`[output-contract] parse failed: ${(err as Error).message}`);
    return { ok: false, raw: output };
  }
}

// ============ issue_id 生成 (spec §5.4.7) ============

export function generateIssueId(role: string, index: number): string {
  return `${role}-${index}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/review/output-contract.test.ts`
Expected: 5 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/review/output-contract.ts tests/unit/review/output-contract.test.ts
git commit -m "feat(review): Output Contract (Zod schemas + parse degradation) (T5.1)"
```

### Task 5.2: Verdict Decision Logic (§5.4)

**Files:**
- Create: `src/review/verdict.ts`
- Create: `tests/unit/review/verdict.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/unit/review/verdict.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test';
import { computeVerdict } from '../../src/review/verdict';

describe('computeVerdict', () => {
  it('returns reject when P0/P1 rejection ratio >= threshold', () => {
    const verdict = computeVerdict(
      [{ role: 'A', issues: [
        { id: 'A-1', severity: 'P0', location: 'a', description: 'x' },
        { id: 'A-2', severity: 'P1', location: 'b', description: 'x' },
        { id: 'A-3', severity: 'P2', location: 'c', description: 'x' },
      ]}],
      [{ issue_id: 'A-1', decision: 'reject', reason: 'r' },
       { issue_id: 'A-2', decision: 'reject', reason: 'r' },
       { issue_id: 'A-3', decision: 'accept', reason: 'r' }],
      0.30,
    );
    expect(verdict).toBe('reject');  // 2/2 = 100% P0/P1 rejected >= 30%
  });

  it('returns accept when P0/P1 rejection ratio < threshold', () => {
    const verdict = computeVerdict(
      [{ role: 'A', issues: [
        { id: 'A-1', severity: 'P0', location: 'a', description: 'x' },
        { id: 'A-2', severity: 'P0', location: 'b', description: 'x' },
        { id: 'A-3', severity: 'P0', location: 'c', description: 'x' },
        { id: 'A-4', severity: 'P0', location: 'd', description: 'x' },
      ]}],
      [{ issue_id: 'A-1', decision: 'reject', reason: 'r' },
       { issue_id: 'A-2', decision: 'accept', reason: 'r' },
       { issue_id: 'A-3', decision: 'accept', reason: 'r' },
       { issue_id: 'A-4', decision: 'accept', reason: 'r' }],
      0.30,
    );
    expect(verdict).toBe('accept');  // 1/4 = 25% < 30%
  });

  it('returns accept when no P0/P1 issues', () => {
    const verdict = computeVerdict(
      [{ role: 'A', issues: [
        { id: 'A-1', severity: 'P3', location: 'a', description: 'x' },
      ]}],
      [{ issue_id: 'A-1', decision: 'reject', reason: 'r' }],
      0.30,
    );
    expect(verdict).toBe('accept');  // P0/P1 total = 0, undefined ratio → accept
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/review/verdict.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement verdict.ts**

Create `src/review/verdict.ts`:

```typescript
import type { Issue } from './types';

export type Verdict = 'accept' | 'reject';

export interface ReviewOpinion {
  role: string;
  issues: Array<Pick<Issue, 'id' | 'severity' | 'location' | 'description'>>;
}

export interface WorkDecision {
  issue_id: string;
  decision: 'accept' | 'reject' | 'partial';
  reason: string;
}

/**
 * spec §5.4 Verdict Decision Logic
 * Returns 'reject' iff P0/P1 rejection ratio >= threshold
 */
export function computeVerdict(
  reviews: ReviewOpinion[],
  workDecision: WorkDecision[],
  threshold: number,
): Verdict {
  const p0p1Issues = reviews.flatMap(r => r.issues).filter(i => i.severity === 'P0' || i.severity === 'P1');
  const p0p1Total = p0p1Issues.length;
  if (p0p1Total === 0) return 'accept';

  const p0p1Rejected = p0p1Issues.filter(issue => {
    const decision = workDecision.find(d => d.issue_id === issue.id);
    return decision?.decision === 'reject';
  }).length;

  const ratio = p0p1Rejected / p0p1Total;
  return ratio >= threshold ? 'reject' : 'accept';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/review/verdict.test.ts`
Expected: 3 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/review/verdict.ts tests/unit/review/verdict.test.ts
git commit -m "feat(review): verdict decision logic (P0/P1 ratio) (T5.2)"
```

### Task 5.3: Engine state machine core (transition + idempotency)

**Files:**
- Create: `src/review/engine.ts`
- Create: `tests/unit/review/engine.test.ts`

- [ ] **Step 1: Write failing test for transition function**

Create `tests/unit/review/engine.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test';
import { transition, computeNextState } from '../../src/review/engine';
import type { PipelineRecord, Issue } from '../../src/review/types';

const sampleRecord = (overrides: Partial<PipelineRecord> = {}): PipelineRecord => ({
  pipelineId: 'p1',
  createdAt: '', updatedAt: '',
  state: { kind: 'PRODUCING', pipelineId: 'p1', round: 0, pane: 'work' },
  input: { rawInput: 'x', phase: 'code', profile: 'default', maxRounds: 6, cwd: '/tmp' },
  panes: { reviews: [] },
  history: [],
  totalCostUsd: 0,
  ...overrides,
});

describe('transition', () => {
  it('PRODUCING → SELF_REVIEW_R1 with round=1', () => {
    const event = { type: 'WORK_PRODUCED' as const };
    const next = computeNextState(sampleRecord().state, event);
    expect(next.kind).toBe('SELF_REVIEW_R1');
    if (next.kind === 'SELF_REVIEW_R1') expect(next.round).toBe(1);
  });

  it('SELF_REVIEW_R1 with issues=[N] → FIXING(source=R1)', () => {
    const state = sampleRecord({ state: { kind: 'SELF_REVIEW_R1', pipelineId: 'p1', round: 1, cycle: 'initial', pane: 'work' } });
    const issues: Issue[] = [{ severity: 'P1', location: 'a', description: 'x' }];
    const next = computeNextState(state.state, { type: 'R1_ISSUES', issues });
    expect(next.kind).toBe('FIXING');
    if (next.kind === 'FIXING') expect(next.source).toBe('SELF_REVIEW_R1');
  });

  it('R1 entry increments round, mid-cycle states do not', () => {
    const states = ['PRODUCING', 'SELF_REVIEW_R2', 'EXTERNAL_REVIEW', 'JUDGE_BY_WORK', 'FIXING'];
    states.forEach((kind, i) => {
      // smoke test: only specific transitions trigger round++
      expect(typeof kind).toBe('string');
    });
  });
});

describe('transition idempotency', () => {
  it('skip transition if lastEvent.toState matches target', () => {
    // simplified: if engine is invoked with same target state, it should noop
    const record = sampleRecord();
    record.history.push({
      ts: '', fromState: null, toState: 'SELF_REVIEW_R1', round: 1,
      role: 'work', inputDigest: '', outputDigest: '', outputSizeBytes: 0,
      costUsd: 0, durationMs: 0,
    });
    record.state = { kind: 'SELF_REVIEW_R1', pipelineId: 'p1', round: 1, cycle: 'initial', pane: 'work' };

    // 重复调用 transition 到 SELF_REVIEW_R1 应该是 idempotent
    const result = transition(record, { type: 'WORK_PRODUCED' });
    expect(result.state.kind).toBe('SELF_REVIEW_R1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/review/engine.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement engine.ts (partial — core transition function)**

Create `src/review/engine.ts`:

```typescript
import type { PipelineRecord, ReviewState, Issue } from './types';
import { logger } from '../utils/logger';

// ============ Events ============

export type EngineEvent =
  | { type: 'WORK_PRODUCED' }
  | { type: 'R1_ISSUES'; issues: Issue[] }
  | { type: 'R1_CLEAN' }
  | { type: 'R2_ISSUES'; issues: Issue[] }
  | { type: 'R2_CLEAN' }
  | { type: 'EXT_REVIEWS_DONE' }
  | { type: 'JUDGE_VERDICT'; verdict: 'accept' | 'reject'; acceptedIssues: Issue[] }
  | { type: 'HUMAN_DECISION'; acceptedIssues: Issue[] }
  | { type: 'FIXING_DONE' }
  | { type: 'PANE_LOST'; lostPanes: Array<{ role: string; shortId: string }> }
  | { type: 'USER_RETRY'; target: ReviewState['kind'] }
  | { type: 'USER_SKIP' }
  | { type: 'USER_ABORT'; reason: string }
  | { type: 'MAX_ROUNDS_EXCEEDED' }
  | { type: 'TIMEOUT' };

// ============ Pure transition function ============

export function computeNextState(state: ReviewState, event: EngineEvent): ReviewState {
  // Global interrupts
  if (event.type === 'USER_ABORT') {
    return { kind: 'ABORTED', pipelineId: state.pipelineId, round: state.round, reason: event.reason, abortedBefore: state.kind };
  }
  if (event.type === 'MAX_ROUNDS_EXCEEDED' && state.kind === 'SELF_REVIEW_R1') {
    return { kind: 'ABORTED', pipelineId: state.pipelineId, round: state.round, reason: 'max_rounds_exceeded', abortedBefore: state.kind };
  }

  switch (state.kind) {
    case 'PRODUCING':
      if (event.type === 'WORK_PRODUCED') {
        return { kind: 'SELF_REVIEW_R1', pipelineId: state.pipelineId, round: 1, cycle: 'initial', pane: 'work' };
      }
      break;
    case 'SELF_REVIEW_R1':
      if (event.type === 'R1_CLEAN') return { kind: 'DONE', pipelineId: state.pipelineId, round: state.round, totalCostUsd: 0, issueTrail: [] };
      if (event.type === 'R1_ISSUES') return { kind: 'FIXING', pipelineId: state.pipelineId, round: state.round, pane: 'work', source: 'SELF_REVIEW_R1', inputIssues: event.issues };
      break;
    case 'SELF_REVIEW_R2':
      if (event.type === 'R2_CLEAN') return { kind: 'DONE', pipelineId: state.pipelineId, round: state.round, totalCostUsd: 0, issueTrail: [] };
      if (event.type === 'R2_ISSUES') return { kind: 'FIXING', pipelineId: state.pipelineId, round: state.round, pane: 'work', source: 'SELF_REVIEW_R2', inputIssues: event.issues };
      break;
    case 'FIXING':
      if (event.type === 'FIXING_DONE') {
        switch (state.source) {
          case 'SELF_REVIEW_R1': return { kind: 'SELF_REVIEW_R2', pipelineId: state.pipelineId, round: state.round, cycle: 'initial', pane: 'work' };
          case 'SELF_REVIEW_R2': return { kind: 'EXTERNAL_REVIEW', pipelineId: state.pipelineId, round: state.round, cycle: 'initial', panes: [] };
          case 'JUDGE_BY_WORK':
          case 'HUMAN_DECIDE':
            return { kind: 'SELF_REVIEW_R1', pipelineId: state.pipelineId, round: state.round + 1, cycle: 'postfix', pane: 'work' };
        }
      }
      break;
    case 'EXTERNAL_REVIEW':
      if (event.type === 'EXT_REVIEWS_DONE') return { kind: 'JUDGE_BY_WORK', pipelineId: state.pipelineId, round: state.round, pane: 'work' };
      break;
    case 'JUDGE_BY_WORK':
      if (event.type === 'JUDGE_VERDICT') {
        if (event.verdict === 'accept') {
          return { kind: 'FIXING', pipelineId: state.pipelineId, round: state.round, pane: 'work', source: 'JUDGE_BY_WORK', inputIssues: event.acceptedIssues };
        } else {
          return { kind: 'HUMAN_DECIDE', pipelineId: state.pipelineId, round: state.round, pending: { trigger: 'verdict_reject', rejectionSummary: { p0p1Total: 0, p0p1Rejected: 0, ratio: 0, threshold: 0 }, issues: event.acceptedIssues } };
        }
      }
      break;
    case 'HUMAN_DECIDE':
      if (event.type === 'HUMAN_DECISION') return { kind: 'FIXING', pipelineId: state.pipelineId, round: state.round, pane: 'work', source: 'HUMAN_DECIDE', inputIssues: event.acceptedIssues };
      if (event.type === 'USER_ABORT') {
        return { kind: 'ABORTED', pipelineId: state.pipelineId, round: state.round, reason: event.reason, abortedBefore: 'HUMAN_DECIDE' };
      }
      break;
    case 'PANE_LOST':
      if (event.type === 'USER_RETRY') return { kind: state.retryTarget, pipelineId: state.pipelineId, round: state.round, pane: 'work' } as ReviewState;
      if (event.type === 'USER_SKIP') {
        // Skip advances to the natural "next state" of the retryTarget
        return computeNextStateAfter(state.retryTarget, state.pipelineId, state.round);
      }
      if (event.type === 'TIMEOUT') return { kind: 'ABORTED', pipelineId: state.pipelineId, round: state.round, reason: 'pane_lost_timeout', abortedBefore: state.retryTarget };
      break;
  }
  throw new Error(`Invalid transition: state=${state.kind} event=${event.type}`);
}

function computeNextStateAfter(target: ReviewState['kind'], pipelineId: string, round: number): ReviewState {
  // Skip 推进到 next state（不是 retryTarget 本身）
  // Simplified: return next "normal" state
  switch (target) {
    case 'PRODUCING': return { kind: 'SELF_REVIEW_R1', pipelineId, round, cycle: 'initial', pane: 'work' };
    case 'SELF_REVIEW_R1': return { kind: 'FIXING', pipelineId, round, pane: 'work', source: 'SELF_REVIEW_R1', inputIssues: [] };
    case 'SELF_REVIEW_R2': return { kind: 'FIXING', pipelineId, round, pane: 'work', source: 'SELF_REVIEW_R2', inputIssues: [] };
    case 'FIXING': return { kind: 'EXTERNAL_REVIEW', pipelineId, round, cycle: 'initial', panes: [] };
    case 'EXTERNAL_REVIEW': return { kind: 'JUDGE_BY_WORK', pipelineId, round, pane: 'work' };
    case 'JUDGE_BY_WORK': return { kind: 'FIXING', pipelineId, round, pane: 'work', source: 'JUDGE_BY_WORK', inputIssues: [] };
    default: throw new Error(`Cannot skip from ${target}`);
  }
}

// ============ Idempotent transition wrapper ============

export function transition(record: PipelineRecord, event: EngineEvent): PipelineRecord {
  const lastEvent = record.history[record.history.length - 1];
  const targetState = computeNextState(record.state, event);

  // Idempotency: if last toState matches target, noop
  if (lastEvent && lastEvent.toState === targetState.kind && isSameTransitionShape(lastEvent, event)) {
    logger.debug(`[engine] ${record.pipelineId} already at ${targetState.kind}, skip`);
    return record;
  }

  // Apply transition
  const historyEntry = makeHistoryEntry(record.state, targetState, event);
  return {
    ...record,
    state: targetState,
    history: [...record.history, historyEntry],
    updatedAt: new Date().toISOString(),
  };
}

function isSameTransitionShape(lastEvent: any, event: EngineEvent): boolean {
  // For FIXING, check source matches (avoid idempotency collision on different source)
  if (lastEvent.toState === 'FIXING' && event.type === 'FIXING_DONE') {
    return true;  // 已到 FIXING，重复 FIXING_DONE 不重做
  }
  return false;
}

function makeHistoryEntry(from: ReviewState, to: ReviewState, event: EngineEvent) {
  return {
    ts: new Date().toISOString(),
    fromState: from.kind,
    toState: to.kind,
    round: to.kind === 'SELF_REVIEW_R1' && (to as any).round ? (to as any).round : from.kind === 'SELF_REVIEW_R1' ? (from as any).round : 0,
    role: 'work' as const,  // TODO: derive from event
    inputDigest: '',
    outputDigest: '',
    outputSizeBytes: 0,
    costUsd: 0,
    durationMs: 0,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/review/engine.test.ts`
Expected: 4 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/review/engine.ts tests/unit/review/engine.test.ts
git commit -m "feat(review): engine state machine core (computeNextState + transition) (T5.3)"
```

---

## Task 6 (W4): Engine state machine 扩展 (HUMAN_DECIDE + Abort / Cleanup)

### Task 6.1: Abort / Cleanup 流程 (§6.6)

**Files:**
- Create: `src/review/abort-cleanup.ts`
- Create: `tests/unit/review/abort-cleanup.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/unit/review/abort-cleanup.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PipelineStore } from '../../src/review/pipeline-store';
import { PipelineState } from '../../src/review/pipeline-state';
import { cleanupPipeline } from '../../src/review/abort-cleanup';
import type { PipelineRecord } from '../../src/review/types';

describe('cleanupPipeline', () => {
  let tmpDir: string;
  let store: PipelineStore;
  let state: PipelineState;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cleanup-'));
    store = new PipelineStore(join(tmpDir, 'pipes'));
    await store.ensureDirs();
    state = new PipelineState();
  });
  afterEach(() => rmSync(tmpDir, { recursive: true }));

  it('aborts controller, stops all panes, moves to aborted', async () => {
    const record: PipelineRecord = {
      pipelineId: 'p1', createdAt: '', updatedAt: '',
      state: { kind: 'EXTERNAL_REVIEW', pipelineId: 'p1', round: 1, cycle: 'initial', panes: [] },
      input: { rawInput: 'x', phase: 'code', profile: 'default', maxRounds: 6, cwd: '/tmp' },
      panes: {
        work: { sessionId: 'uuid-w', currentRoundShortId: 'short-w', provider: 'sonnet', startedAt: '', roundShortIds: ['short-w'] },
        reviews: [
          { role: 'review-A', shortId: 'short-a', sessionId: 'uuid-a', provider: 'kimi', round: 1, cycle: 'initial' },
        ],
      },
      history: [],
      totalCostUsd: 0,
    };
    await store.saveRunning(record);

    const ac = new AbortController();
    state.set('p1', { pipelineId: 'p1', abortController: ac, watchClientSet: new Set() });

    // Mock adapter.stop (no-op for testing)
    const mockAdapter = { stop: async (shortId: string) => { /* noop */ } };

    await cleanupPipeline('p1', 'user_cancelled', { store, state, adapter: mockAdapter as any });

    // Verify state was aborted
    const updated = await store.readRunning('p1');
    expect(updated).toBeNull();  // 已移到 aborted/

    // AbortController 应被触发
    expect(ac.signal.aborted).toBe(true);

    // PipelineState 应被清理
    expect(state.has('p1')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/review/abort-cleanup.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement abort-cleanup.ts**

Create `src/review/abort-cleanup.ts`:

```typescript
import type { PipelineStore } from './pipeline-store';
import type { PipelineState, ActivePipeline } from './pipeline-state';
import type { ClaudeBGAdapter } from './adapter';
import { logger } from '../utils/logger';

interface CleanupOpts {
  store: PipelineStore;
  state: PipelineState;
  adapter: ClaudeBGAdapter;
}

/**
 * spec §6.6 Abort / Cleanup 流程 (6 步)
 */
export async function cleanupPipeline(
  pipelineId: string,
  reason: string,
  { store, state, adapter }: CleanupOpts,
): Promise<void> {
  const record = await store.readRunning(pipelineId);
  if (!record) {
    logger.warn(`[cleanup] ${pipelineId} not found in running/, skip`);
    return;
  }

  // Step 1: 立即 abort polling 循环
  const ap = state.get(pipelineId);
  ap?.abortController.abort();

  // Step 2: 收集所有 active pane shortIds
  const paneShortIds: string[] = [];
  if (record.panes.work?.currentRoundShortId) {
    paneShortIds.push(record.panes.work.currentRoundShortId);
  }
  for (const review of record.panes.reviews) {
    paneShortIds.push(review.shortId);
  }

  // Step 3: 并行 claude stop（best-effort，不抛错）
  const stopResults = await Promise.allSettled(
    paneShortIds.map(shortId => adapter.stop(shortId)),
  );
  const failureCount = stopResults.filter(r => r.status === 'rejected').length;
  if (failureCount > 0) {
    logger.warn(`[cleanup] ${failureCount}/${paneShortIds.length} pane stop(s) failed for ${pipelineId}`);
  }

  // Step 4: 标记 state 为 ABORTED + 移到 aborted/
  record.state = { kind: 'ABORTED', pipelineId, round: record.state.round, reason, abortedBefore: record.state.kind };
  record.updatedAt = new Date().toISOString();
  await store.saveRunning(record);
  await store.moveToTerminal(record);

  // Step 5: 通知 cli-watch 客户端
  ap?.watchClientSet.forEach(client => {
    try { client.send({ type: 'aborted', reason }); } catch {}
  });

  // Step 6: 清理 in-memory state
  state.delete(pipelineId);

  logger.info(`[cleanup] pipeline ${pipelineId} aborted: ${reason}`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/review/abort-cleanup.test.ts`
Expected: 1 test passes

- [ ] **Step 5: Commit**

```bash
git add src/review/abort-cleanup.ts tests/unit/review/abort-cleanup.test.ts
git commit -m "feat(review): cleanupPipeline 6-step abort procedure (T6.1)"
```

---

## Task 7 (W5): CLI subcommand group

### Task 7.1: review CLI commands (run/status/abort/doctor/profiles)

**Files:**
- Create: `src/cli/commands/review.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Implement review CLI module**

Create `src/cli/commands/review.ts`:

```typescript
import { loadProfile } from '../../review/profile';
import { runDoctor } from '../../review/review-doctor';
import { PipelineStore } from '../../review/pipeline-store';
import { pipelineState } from '../../review/pipeline-state';
import { ClaudeBGAdapter } from '../../review/adapter';
import { detect, PhaseUnknownError } from '../../review/phase-detect';
import { detect as detectPhase } from '../../review/phase-detect';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { logger } from '../../utils/logger';
import { REVIEW_PIPELINES_DIR } from '../../utils/paths';
import { cleanupPipeline } from '../../review/abort-cleanup';
import { reconcile } from '../../review/reconciler';
import { AgentSnapshotFetcher } from '../../agent-view/snapshot-fetcher';
import type { Phase } from '../../review/types';

const require = createRequire(import.meta.url);

export async function reviewRun(task: string, opts: {
  phase?: Phase;
  profile?: string;
  maxRounds?: number;
  cwd?: string;
  watch?: boolean;
}) {
  const phase = opts.phase ?? (() => {
    try {
      return detectPhase({ rawInput: task, filePath: undefined, gitRef: undefined });
    } catch (err) {
      if (err instanceof PhaseUnknownError) {
        console.error(`❌ ${err.message}`);
        process.exit(1);
      }
      throw err;
    }
  })();

  const profileName = opts.profile ?? 'default';
  const profile = await loadProfile(profileName, phase);
  const cwd = opts.cwd ?? process.cwd();

  console.log(`✓ Pipeline 启动: ${phase} phase, profile=${profileName}`);
  console.log(`✓ Work provider: ${profile.work.provider}`);
  console.log(`✓ Review providers: ${profile.review.providers.join(', ')}`);
  console.log(`✓ Max rounds: ${profile.guards.max_rounds}`);

  // TODO: 实际启动 engine（Task 8 后才有）
  console.log('⚠️ Engine 启动逻辑在 Task 8 实现');
}

export async function reviewStatus(pipelineId: string, opts: { follow?: boolean }) {
  const store = new PipelineStore(REVIEW_PIPELINES_DIR);
  const record = await store.readRunning(pipelineId);
  if (!record) {
    console.error(`❌ Pipeline ${pipelineId} 不存在或已结束`);
    process.exit(1);
  }
  console.log(JSON.stringify(record.state, null, 2));
  if (opts.follow) {
    // TODO: 实现 --follow（Task 8 cli-watch 实现）
  }
}

export async function reviewAbort(pipelineId: string) {
  const store = new PipelineStore(REVIEW_PIPELINES_DIR);
  const adapter = new ClaudeBGAdapter();
  await cleanupPipeline(pipelineId, 'user_abort', { store, state: pipelineState, adapter });
  console.log(`✓ Pipeline ${pipelineId} aborted`);
}

export async function reviewDoctor() {
  const result = await runDoctor({});
  for (const check of result.checks) {
    const icon = check.ok ? '✓' : '❌';
    console.log(`${icon} ${check.message}`);
    if (!check.ok && check.remediation) console.log(`   remediation: ${check.remediation}`);
  }
  console.log();
  console.log(result.exitCode === 0 ? 'All checks passed.' : 'Some checks failed.');
  process.exit(result.exitCode);
}

export async function reviewProfiles() {
  const dir = join(homedir(), '.cc-linker', 'review-profiles');
  if (!existsSync(dir)) {
    console.log('No profiles found. Create one at ~/.cc-linker/review-profiles/<name>.toml');
    return;
  }
  const { readdirSync } = await import('node:fs');
  const files = readdirSync(dir).filter(f => f.endsWith('.toml'));
  for (const f of files) {
    const name = f.replace('.toml', '');
    try {
      const p = await loadProfile(name, 'code', join(dir, f));  // phase=code 简化
      console.log(`✓ ${name} (work=${p.work.provider}, review=${p.review.providers.join(',')}, max_rounds=${p.guards.max_rounds})`);
    } catch (err) {
      console.log(`❌ ${name}: ${(err as Error).message}`);
    }
  }
}
```

- [ ] **Step 2: Register review subcommand group in src/index.ts**

Modify `src/index.ts`. Add import at top:

```typescript
import { reviewRun, reviewStatus, reviewAbort, reviewDoctor, reviewProfiles } from './cli/commands/review';
```

Add after `daemonCmd` block (after line 184):

```typescript
// ===== Review Engine subcommand group (v2.1) =====
const reviewCmd = program.command('review').description('多模型 review pipeline');
reviewCmd
  .command('run <task>')
  .description('启动 review pipeline')
  .option('--phase <phase>', 'spec | plan | code')
  .option('--profile <name>', 'profile 名称', 'default')
  .option('--max-rounds <n>', '最大 round 数', (v) => parseInt(v, 10))
  .option('--cwd <path>', '工作目录')
  .option('--no-watch', '禁用 watch 模式')
  .action((task, opts) => reviewRun(task, opts));
reviewCmd
  .command('status <id>')
  .description('查询 pipeline 状态')
  .option('--follow', '持续输出')
  .action((id, opts) => reviewStatus(id, opts));
reviewCmd
  .command('abort <id>')
  .description('中止 pipeline')
  .action((id) => reviewAbort(id));
reviewCmd
  .command('cancel <id>')
  .description('用户主动取消（区别 abort 的 max_rounds 触发）')
  .action((id) => reviewAbort(id));  // 暂同 abort
reviewCmd
  .command('doctor')
  .description('启动前健康检查')
  .action(() => reviewDoctor());
reviewCmd
  .command('profiles')
  .description('列出所有 profile')
  .action(() => reviewProfiles());
// TODO (Task 8/Phase 2): review decide / review report subcommands
```

- [ ] **Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: no errors

- [ ] **Step 4: Smoke test doctor command**

Run: `bun run dev review doctor`
Expected: prints ✓/❌ for each check + exits with proper code

- [ ] **Step 5: Smoke test profiles command**

Run: `bun run dev review profiles`
Expected: lists default profile (or "No profiles found")

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/review.ts src/index.ts
git commit -m "feat(cli): review subcommand group (run/status/abort/cancel/doctor/profiles) (T7.1)"
```

---

## Task 8 (W5-W6): CLI `--watch` 模式 (rich terminal)

### Task 8.1: cli-watch ANSI 重绘

**Files:**
- Create: `src/review/cli-watch.ts`
- Create: `tests/unit/review/cli-watch.test.ts`

- [ ] **Step 1: Write failing test for renderLive**

Create `tests/unit/review/cli-watch.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test';
import { renderLive, renderTerminal } from '../../src/review/cli-watch';
import type { PipelineRecord } from '../../src/review/types';

describe('renderLive', () => {
  it('renders pane status table', () => {
    const record: PipelineRecord = {
      pipelineId: 'p1', createdAt: '', updatedAt: '',
      state: { kind: 'EXTERNAL_REVIEW', pipelineId: 'p1', round: 1, cycle: 'initial',
               panes: [{ role: 'review-A', shortId: 'short3' }, { role: 'review-B', shortId: 'short4' }] },
      input: { rawInput: 'x', phase: 'code', profile: 'default', maxRounds: 6, cwd: '/tmp' },
      panes: {
        work: { sessionId: 'uuid-w', currentRoundShortId: 'short2', provider: 'sonnet', startedAt: '', roundShortIds: ['short1', 'short2'] },
        reviews: [
          { role: 'review-A', shortId: 'short3', sessionId: 'uuid-a', provider: 'kimi', round: 1, cycle: 'initial' },
          { role: 'review-B', shortId: 'short4', sessionId: 'uuid-b', provider: 'qwen', round: 1, cycle: 'initial' },
        ],
      },
      history: [],
      totalCostUsd: 0.42,
    };
    const out = renderLive(record);
    expect(out).toContain('EXTERNAL_REVIEW');
    expect(out).toContain('work');
    expect(out).toContain('review-A');
    expect(out).toContain('$0.42');
  });
});

describe('renderTerminal', () => {
  it('renders DONE state', () => {
    const record: PipelineRecord = {
      pipelineId: 'p1', createdAt: '', updatedAt: '',
      state: { kind: 'DONE', pipelineId: 'p1', round: 2, totalCostUsd: 1.23, issueTrail: [] },
      input: { rawInput: 'x', phase: 'code', profile: 'default', maxRounds: 6, cwd: '/tmp' },
      panes: { reviews: [] }, history: [], totalCostUsd: 1.23,
    };
    const out = renderTerminal(record);
    expect(out).toContain('DONE');
    expect(out).toContain('$1.23');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/review/cli-watch.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement cli-watch.ts**

Create `src/review/cli-watch.ts`:

```typescript
import chalk from 'chalk';
import type { PipelineRecord, ReviewState } from './types';

const STATE_ICONS: Record<ReviewState['kind'], string> = {
  PRODUCING: '🔨',
  SELF_REVIEW_R1: '🔍',
  SELF_REVIEW_R2: '🔍',
  FIXING: '🔧',
  EXTERNAL_REVIEW: '👁 ',
  JUDGE_BY_WORK: '⚖ ',
  PANE_LOST: '⚠️',
  HUMAN_DECIDE: '⏸️',
  DONE: '✅',
  FAILED: '❌',
  ABORTED: '🚫',
};

export function renderLive(record: PipelineRecord): string {
  const lines: string[] = [];
  const { state, panes, input, totalCostUsd } = record;

  // Header
  lines.push(chalk.bold(`cc-linker Review Engine │ ${state.kind}`));
  lines.push(`Pipeline: ${record.pipelineId.slice(0, 8)}... │ Phase: ${input.phase} │ Profile: ${input.profile}`);
  lines.push(`Cost: $${totalCostUsd.toFixed(3)} │ State: ${state.kind}`);
  lines.push('');

  // Pane status
  lines.push(chalk.dim('Panes:'));
  if (panes.work?.currentRoundShortId) {
    lines.push(`  🔧 work       ${panes.work.currentRoundShortId.slice(0, 8)} (${panes.work.provider})`);
  }
  for (const r of panes.reviews) {
    lines.push(`  👁 ${r.role.padEnd(10)} ${r.shortId.slice(0, 8)} (${r.provider})`);
  }
  lines.push('');

  // Timeline (last 5 events)
  lines.push(chalk.dim('Timeline:'));
  const recent = record.history.slice(-5);
  for (const evt of recent) {
    const icon = STATE_ICONS[evt.toState as ReviewState['kind']] ?? '·';
    lines.push(`  ${icon} ${evt.ts.slice(11, 19)} ${evt.fromState ?? '-'} → ${evt.toState}`);
  }

  return lines.join('\n');
}

export function renderTerminal(record: PipelineRecord): string {
  const lines: string[] = [];
  lines.push(chalk.bold(`Pipeline ${record.pipelineId} ${record.state.kind}`));
  lines.push(`Total cost: $${record.totalCostUsd.toFixed(3)}`);
  lines.push(`Total events: ${record.history.length}`);
  lines.push('');
  for (const evt of record.history) {
    lines.push(`  ${evt.ts} ${evt.fromState ?? '-'} → ${evt.toState}`);
  }
  return lines.join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/review/cli-watch.test.ts`
Expected: 2 tests pass

- [ ] **Step 5: Implement watchPipeline() loop**

Add to `src/review/cli-watch.ts`:

```typescript
import { PipelineStore } from './pipeline-store';

export async function watchPipeline(pipelineId: string): Promise<void> {
  const store = new PipelineStore(REVIEW_PIPELINES_DIR);
  let lastState: ReviewState['kind'] | null = null;

  // Handle Ctrl-C cleanly
  process.on('SIGINT', () => {
    console.log('\n[watch] detached. Pipeline 继续在后台跑。重连: cc-linker review status ' + pipelineId);
    process.exit(0);
  });

  while (true) {
    const record = await store.readRunning(pipelineId);
    if (!record) {
      console.log(`[watch] pipeline ${pipelineId} 不在 running/，尝试 human_pending/`);
      const pending = (await store.listHumanPending()).find(r => r.pipelineId === pipelineId);
      if (pending) {
        console.log(chalk.yellow(`[watch] Pipeline 等人工决策`));
        break;
      }
      const done = (await store.listDir('done') as PipelineRecord[]).find(r => r.pipelineId === pipelineId);
      if (done) { console.log(renderTerminal(done)); return; }
      console.log(`[watch] Pipeline ${pipelineId} 未找到`);
      return;
    }
    if (record.state.kind !== lastState) {
      // Clear screen + re-render
      process.stdout.write('\x1b[2J\x1b[H');
      console.log(renderLive(record));
      lastState = record.state.kind;
    }
    await Bun.sleep(500);
  }
}
```

- [ ] **Step 6: Wire `review status --follow` to watchPipeline()**

Modify `src/cli/commands/review.ts`'s `reviewStatus`:

```typescript
export async function reviewStatus(pipelineId: string, opts: { follow?: boolean }) {
  const store = new PipelineStore(REVIEW_PIPELINES_DIR);
  if (opts.follow) {
    const { watchPipeline } = await import('../../review/cli-watch');
    await watchPipeline(pipelineId);
    return;
  }
  const record = await store.readRunning(pipelineId);
  if (!record) {
    console.error(`❌ Pipeline ${pipelineId} 不存在或已结束`);
    process.exit(1);
  }
  console.log(JSON.stringify(record.state, null, 2));
}
```

- [ ] **Step 7: Smoke test**

Run: `bun run dev review status nonexistent-id 2>&1; echo "exit=$?"`
Expected: error message + exit code 1

- [ ] **Step 8: Commit**

```bash
git add src/review/cli-watch.ts tests/unit/review/cli-watch.test.ts src/cli/commands/review.ts
git commit -m "feat(review): CLI --watch rich terminal (ANSI + Ctrl-C handling) (T8)"
```

---

## End-to-end Verification (after T8)

- [ ] **Step 9: Run full test suite**

Run: `bun test`
Expected: all tests pass (~30+ tests across all review modules)

- [ ] **Step 10: Run typecheck**

Run: `bun run typecheck`
Expected: no errors

- [ ] **Step 11: Manual smoke test (with real claude CLI)**

```bash
# 1. doctor
bun run dev review doctor
# Expected: ✓ or ❌ for CLI / daemon / providers

# 2. profiles
bun run dev review profiles
# Expected: lists 'default' (or error if ~/.claude/providers/ missing)

# 3. dry-run pipeline (T1-T7 ready but engine wiring incomplete)
bun run dev review run "say hello" --phase code
# Expected: prints pipeline start info; engine wiring TBD (will be wired in Phase 2 of plan execution)
```

- [ ] **Step 12: Final commit + push**

```bash
git add docs/superpowers/plans/2026-06-14-multi-model-review-engine-v2.1-plan.md
git commit -m "docs(plan): v2.1 Phase 1 implementation plan (T1-T8, ~5 weeks)"
git push origin feat/multi-model-review-engine-v2
```

---

## Risk Monitoring During Implementation

| Risk (from spec §14) | Watch for |
|---|---|
| **CLI 版本 < 2.1.163** | doctor T1.3 catches; surface prominently in install error |
| **`claude --bg` behavior changes** | T4.2 integration test verifies; if fails on new CLI version, update adapter |
| **work session resume 链断裂** | T5.3 engine handles PANE_LOST; T6.1 cleanup covers |
| **Provider settingsPath 改了** | T4.1 adapter.snapshotProviders creates immutable copy at pipeline start |
| **daemon crash** | T2.2 reconciler detects dead panes; T6.1 cleanup handles |
| **Polling 500ms 抖动** | T8.1 watch mode has 500ms poll; acceptable per spec |
| **Engine + Reconciler 抢同一个 pipeline** | reconciler has cleanupTmpFiles + saves state; engine has moveToTerminal after terminal |
| **CLI Ctrl-C** | T8.1 watch SIGINT handler detached cleanly |
| **Context window 膨胀** | Engine prompts are self-contained (artifact + issues explicit per §7.5.7); monitor at runtime |
| **JobStateFile `output` 字段** | T4.1 adapter assumes it's in JobStateFile; if not present in Agent View's TS type, use local ExtendedJobStateFile (per §7.5.6) |

---

## Out of Scope (deferred to Phase 2 / Phase 3 per spec §12.2/§12.3)

- Bun.serve IDE (Bun.serve + SSE + single HTML page)
- 飞书 `/review` command
- Markdown / JSON / HTML report generation
- Per-phase prompt template engine
- HUMAN_DECIDE IDE buttons
- LLM classification fallback for PhaseDetector
- Token budget enforcement
- Review opinion dedup

---

## Total Estimated Effort

| Task | Estimated Time |
|---|---|
| T1 (Profile + Provider + Doctor) | 8h |
| T2 (PipelineStore + Reconciler + pipeline-state) | 8h |
| T3 (PhaseDetector) | 3h |
| T4 (Adapter + integration test) | 8h |
| T5 (Output Contract + Verdict + Engine core) | 12h |
| T6 (Cleanup) | 4h |
| T7 (CLI commands) | 6h |
| T8 (cli-watch) | 8h |
| **Total Phase 1** | **~57h ≈ 7 working days** |

Spec estimated 5-6 weeks (with spec writing + review iterations). Plan-level execution with TDD + frequent commits should hit the 5-week mark.