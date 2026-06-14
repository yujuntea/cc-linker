# cc-linker Auto-Upgrade v1.2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add lightweight auto-upgrade support — CLI `cc-linker upgrade` for apply, daemon 24h check + static Feishu notification card, with pre-release guard and standalone binary support.

**Architecture:** Pure functions in `src/updater/` (check / notify / detect / lifecycle) shared by CLI and daemon. CLI does `npm i -g` + idempotent `cc-linker restart` (not relying on postinstall). Daemon sends static card with 24h ticker, no action buttons except Skip. Pre-release versions suppressed via `dist-tags.latest` regex check.

**Tech Stack:** Bun, TypeScript, semver@^7.6.0, @iarna/toml (existing), @larksuiteoapi/node-sdk (existing), Bun.fetch, proper-lockfile (existing).

**Spec:** `docs/superpowers/specs/2026-06-14-auto-upgrade-design-v1.2.md`

---

## File Structure

### New files
- `src/updater/types.ts` — `UpdateInfo`, `CachedCheck`, `UpdateStatus`, `InstallMode`
- `src/updater/cache.ts` — atomic read/write of `.update-check.json`
- `src/updater/check.ts` — `resolveRegistryUrl()`, `check({ force })`
- `src/updater/notify.ts` — `formatBanner()`, `formatCardPayload()`
- `src/updater/detect-install-mode.ts` — `detectInstallMode()` returns `'npm_global' | 'standalone_binary' | 'dev' | 'bun_link'`
- `src/updater/lifecycle.ts` — `getActiveSkips()`, `addSkippedVersion()` (CAS via existing UserManager)
- `src/cli/commands/upgrade.ts` — `upgrade(opts)` with `--check` / `--dry-run` / `--to` / `--yes`
- `src/runtime/updater-tick.ts` — `checkAndNotify()` + 24h `setTimeout` chain
- `src/feishu/updater-card.ts` — `buildCardPayload()`, `onSkipClick()`

### Modified files
- `src/utils/paths.ts` — add `UPDATE_CHECK_CACHE_PATH`
- `src/utils/config.ts` — add `[updater]` section to `ConfigData` + `DEFAULTS`
- `src/index.ts` — register `upgrade` subcommand
- `src/cli/commands/status.ts` — async append update banner (1s soft timeout)
- `src/cli/commands/restart.ts` — add launchctl unload/load on macOS (R2)
- `package.json` — add `semver` dep

### Test files
- `tests/unit/updater/types.test.ts` — type guards and constructors
- `tests/unit/updater/cache.test.ts` — atomic read/write, corruption recovery
- `tests/unit/updater/check.test.ts` — fetch / cache / semver / pre-release guard
- `tests/unit/updater/notify.test.ts` — 6 status banner + 3 card payloads
- `tests/unit/updater/detect-install-mode.test.ts` — 4 install modes
- `tests/unit/updater/lifecycle.test.ts` — Skip CAS / 30d expiry
- `tests/unit/cli/upgrade.test.ts` — CLI flag combinations
- `tests/integration/upgrade-flow.test.ts` — fake registry → CLI / daemon end-to-end

---

## Phase 1: Foundation

### Task 1: Add `semver` dependency

**Files:**
- Modify: `package.json:62-72`

- [ ] **Step 1: Add semver to dependencies**

Edit `package.json` to add `"semver": "^7.6.0"` to `dependencies` (alphabetical between `proper-lockfile` and `zod`):

```json
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "^0.3.150",
    "@iarna/toml": "^2.2.5",
    "@larksuiteoapi/node-sdk": "^1.62.1",
    "chalk": "^5.6.2",
    "cli-table3": "^0.6.5",
    "commander": "^14.0.3",
    "inquirer": "^13.4.2",
    "proper-lockfile": "^4.1.2",
    "semver": "^7.6.0",
    "zod": "^4.4.2"
  },
```

- [ ] **Step 2: Install**

Run: `bun install`
Expected: `semver` added to `bun.lock`, exit 0

- [ ] **Step 3: Verify import works**

Run: `bun -e "import semver from 'semver'; console.log(semver.compare('0.6.3', '0.6.4'));"`
Expected: prints `-1`

- [ ] **Step 4: Commit**

```bash
git add package.json bun.lock
git commit -m "deps: add semver@^7.6.0 for auto-upgrade version comparison"
```

---

### Task 2: Add `UPDATE_CHECK_CACHE_PATH` constant

**Files:**
- Modify: `src/utils/paths.ts`

- [ ] **Step 1: Add the constant**

Edit `src/utils/paths.ts`, add after line 12 (after `SCAN_CACHE_PATH`):

```ts
// Auto-upgrade cache file (24h TTL, written by src/updater/check.ts)
export const UPDATE_CHECK_CACHE_PATH = join(CC_LINKER_DIR, '.update-check.json');
```

- [ ] **Step 2: Verify typecheck passes**

Run: `bun run typecheck`
Expected: exit 0, no errors

- [ ] **Step 3: Commit**

```bash
git add src/utils/paths.ts
git commit -m "feat(paths): add UPDATE_CHECK_CACHE_PATH constant"
```

---

### Task 3: Define `UpdateInfo` types

**Files:**
- Create: `src/updater/types.ts`
- Create: `tests/unit/updater/types.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/updater/types.test.ts`:

```ts
import { describe, it, expect } from 'bun:test';
import { isPreRelease, type UpdateInfo, type UpdateStatus } from '../../../src/updater/types';

describe('updater/types', () => {
  describe('isPreRelease', () => {
    it('returns true for 0.6.4-beta.1', () => {
      expect(isPreRelease('0.6.4-beta.1')).toBe(true);
    });
    it('returns true for 1.0.0-rc.1', () => {
      expect(isPreRelease('1.0.0-rc.1')).toBe(true);
    });
    it('returns true for 1.0.0-alpha', () => {
      expect(isPreRelease('1.0.0-alpha')).toBe(true);
    });
    it('returns false for 0.6.4', () => {
      expect(isPreRelease('0.6.4')).toBe(false);
    });
    it('returns false for 1.0.0', () => {
      expect(isPreRelease('1.0.0')).toBe(false);
    });
  });

  describe('UpdateStatus type', () => {
    it('exposes the 6 valid status values', () => {
      const statuses: UpdateStatus[] = [
        'up_to_date', 'update_available', 'local_newer',
        'prerelease_only', 'check_failed', 'disabled',
      ];
      expect(statuses).toHaveLength(6);
    });
  });

  describe('UpdateInfo type', () => {
    it('can be constructed with all required fields', () => {
      const info: UpdateInfo = {
        status: 'update_available',
        current: '0.6.3',
        latest: '0.6.4',
        checkedAt: 1718345678000,
      };
      expect(info.status).toBe('update_available');
    });

    it('can include optional error reason', () => {
      const info: UpdateInfo = {
        status: 'check_failed',
        current: '0.6.3',
        latest: '',
        checkedAt: 1718345678000,
        error: 'timeout',
      };
      expect(info.error).toBe('timeout');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/updater/types.test.ts`
Expected: FAIL with "Cannot find module '../../../src/updater/types'"

- [ ] **Step 3: Write minimal implementation**

Create `src/updater/types.ts`:

```ts
/**
 * Updater types — see spec §3.1 "6 种 status 的统一语义"
 */

export type UpdateStatus =
  | 'up_to_date'        // current === latest
  | 'update_available'  // current < latest, latest is stable
  | 'local_newer'       // current > latest (user on pre-release or dev)
  | 'prerelease_only'   // latest is pre-release, suppress notification
  | 'check_failed'      // network / parse error
  | 'disabled';         // [updater] enabled = false

export interface UpdateInfo {
  status: UpdateStatus;
  current: string;          // PKG_VERSION at check time
  latest: string;           // from dist-tags.latest (empty if check_failed)
  checkedAt: number;        // Unix ms
  error?: string;           // reason: 'timeout' | 'offline' | 'http_500' | 'parse_error' | etc.
  notifiedAt?: number;      // set when daemon sends notification (for 24h tick dedup)
}

export interface CachedCheck {
  meta: {
    schemaVersion: 1;
  };
  data: UpdateInfo;
}

export type InstallMode = 'npm_global' | 'standalone_binary' | 'dev' | 'bun_link';

export interface SkippedVersionEntry {
  version: string;
  skipped_at: string;        // ISO 8601 with Z (snake_case matches user-mapping.json convention)
}

/**
 * Detect if a semver string is a pre-release (e.g., 0.6.4-beta.1).
 * Matches /^\d+\.\d+\.\d+-/ — pre-release form has '-' after PATCH.
 */
export function isPreRelease(version: string): boolean {
  return /^\d+\.\d+\.\d+-/.test(version);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/updater/types.test.ts`
Expected: PASS, 8 tests

- [ ] **Step 5: Commit**

```bash
git add src/updater/types.ts tests/unit/updater/types.test.ts
git commit -m "feat(updater): define UpdateInfo types + isPreRelease guard"
```

---

### Task 4: Add `[updater]` config section

**Files:**
- Modify: `src/utils/config.ts` (ConfigData interface + DEFAULTS)

- [ ] **Step 1: Add updater fields to ConfigData interface**

In `src/utils/config.ts`, find the `interface ConfigData` block (around line 7) and add the `updater` section at the end of the interface (after the last section, before the closing `}`):

```ts
  updater: {
    enabled: boolean;
    check_on_status: boolean;
    check_on_start: boolean;
    notify_channel: 'feishu' | 'cli' | 'none';
    registry_url: string;        // 'auto' = read user's .npmrc
    check_interval_hours: number;
    skipped_ttl_days: number;
    notify_delay_ms: number;
    test_mode: boolean;
    test_openid: string;
  };
```

- [ ] **Step 2: Add updater fields to DEFAULTS**

In `src/utils/config.ts`, find the `const DEFAULTS: ConfigData = {` block (around line 101). Add the `updater` section as the last key in the DEFAULTS object (before the closing `};`):

```ts
  updater: {
    enabled: true,
    check_on_status: true,
    check_on_start: true,
    notify_channel: 'feishu',
    registry_url: 'auto',
    check_interval_hours: 24,
    skipped_ttl_days: 30,
    notify_delay_ms: 30000,
    test_mode: false,
    test_openid: 'ou_test',
  },
```

- [ ] **Step 3: Verify typecheck passes**

Run: `bun run typecheck`
Expected: exit 0

- [ ] **Step 4: Commit**

```bash
git add src/utils/config.ts
git commit -m "feat(config): add [updater] section with 10 fields"
```

---

## Phase 2: Core updater logic

### Task 5: Implement atomic cache read/write

**Files:**
- Create: `src/updater/cache.ts`
- Create: `tests/unit/updater/cache.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/updater/cache.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readCache, writeCache, CacheCorruptError } from '../../../src/updater/cache';
import type { CachedCheck } from '../../../src/updater/types';

let tmpDir: string;
let cachePath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'updater-cache-'));
  cachePath = join(tmpDir, '.update-check.json');
});

afterEach(() => {
  if (tmpDir && existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe('updater/cache', () => {
  describe('readCache', () => {
    it('returns null when file does not exist', async () => {
      const result = await readCache(cachePath);
      expect(result).toBeNull();
    });

    it('returns parsed CachedCheck on valid file', async () => {
      const valid: CachedCheck = {
        meta: { schemaVersion: 1 },
        data: { status: 'up_to_date', current: '0.6.3', latest: '0.6.3', checkedAt: 100 },
      };
      await writeCache(cachePath, valid);
      const result = await readCache(cachePath);
      expect(result).toEqual(valid);
    });

    it('renames corrupt file to .bak.<ts> and returns null', async () => {
      writeFileSync(cachePath, '{ broken json');
      const result = await readCache(cachePath);
      expect(result).toBeNull();
      expect(existsSync(cachePath)).toBe(false);
      const bakFiles = readdirSync(tmpDir).filter((f: string) => f.includes('.bak.'));
      expect(bakFiles.length).toBeGreaterThan(0);
    });
  });

  describe('writeCache', () => {
    it('writes valid JSON atomically', async () => {
      const data: CachedCheck = {
        meta: { schemaVersion: 1 },
        data: { status: 'update_available', current: '0.6.3', latest: '0.6.4', checkedAt: 200 },
      };
      await writeCache(cachePath, data);
      const raw = readFileSync(cachePath, 'utf-8');
      expect(JSON.parse(raw)).toEqual(data);
    });

    it('does not leave .tmp files on success', async () => {
      const data: CachedCheck = {
        meta: { schemaVersion: 1 },
        data: { status: 'up_to_date', current: '0.6.3', latest: '0.6.3', checkedAt: 100 },
      };
      await writeCache(cachePath, data);
      const files = readdirSync(tmpDir);
      expect(files.filter((f: string) => f.includes('.tmp.'))).toHaveLength(0);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/updater/cache.test.ts`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Write minimal implementation**

Create `src/updater/cache.ts`:

```ts
/**
 * Atomic read/write of ~/.cc-linker/.update-check.json
 * Uses write-tmp-then-rename pattern (POSIX atomic).
 * Corrupt files are backed up to .bak.<ts> and treated as missing.
 */

import { readFile, writeFile, rename } from 'fs/promises';
import { existsSync } from 'fs';
import type { CachedCheck } from './types';

export class CacheCorruptError extends Error {
  constructor(public readonly path: string) {
    super(`Cache file corrupt: ${path}`);
  }
}

/**
 * Read cache. Returns null if file missing or corrupt (corrupt files are
 * backed up to .bak.<ts> so user can inspect if needed).
 */
export async function readCache(path: string): Promise<CachedCheck | null> {
  if (!existsSync(path)) return null;
  try {
    const raw = await readFile(path, 'utf-8');
    const parsed = JSON.parse(raw) as CachedCheck;
    if (parsed?.meta?.schemaVersion !== 1) {
      throw new CacheCorruptError(path);
    }
    return parsed;
  } catch (e) {
    // Corrupt or unreadable: rename to .bak.<ts>
    const ts = Date.now();
    const bak = `${path}.bak.${ts}`;
    try {
      await rename(path, bak);
    } catch { /* ignore rename errors */ }
    return null;
  }
}

/**
 * Write cache atomically: write to .tmp.<pid>, then rename.
 */
export async function writeCache(path: string, data: CachedCheck): Promise<void> {
  const tmp = `${path}.tmp.${process.pid}`;
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
  await rename(tmp, path);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/updater/cache.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add src/updater/cache.ts tests/unit/updater/cache.test.ts
git commit -m "feat(updater): atomic cache read/write with corruption recovery"
```

---

### Task 6: Implement `resolveRegistryUrl`

**Files:**
- Create: `src/updater/registry.ts`
- Create: `tests/unit/updater/registry.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/updater/registry.test.ts`:

```ts
import { describe, it, expect } from 'bun:test';
import { resolveRegistryUrl } from '../../../src/updater/registry';

describe('updater/registry', () => {
  describe('resolveRegistryUrl', () => {
    it('returns the explicit URL when not "auto"', async () => {
      const url = await resolveRegistryUrl('https://my-mirror.example.com');
      expect(url).toBe('https://my-mirror.example.com/cc-linker/latest');
    });

    it('strips trailing slash from explicit URL', async () => {
      const url = await resolveRegistryUrl('https://my-mirror.example.com/');
      expect(url).toBe('https://my-mirror.example.com/cc-linker/latest');
    });

    it('falls back to registry.npmjs.org when "auto" and npm config fails', async () => {
      // Use a non-existent path to force failure
      const url = await resolveRegistryUrl('auto', () => {
        throw new Error('npm not found');
      });
      expect(url).toBe('https://registry.npmjs.org/cc-linker/latest');
    });

    it('uses npm config result when "auto"', async () => {
      const url = await resolveRegistryUrl('auto', () => 'https://registry.npmmirror.com/');
      expect(url).toBe('https://registry.npmmirror.com/cc-linker/latest');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/updater/registry.test.ts`
Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

Create `src/updater/registry.ts`:

```ts
/**
 * Resolve the registry URL to query for cc-linker updates.
 *
 * Two modes:
 * - Explicit: use the provided URL as-is
 * - 'auto': read user's `npm config get registry` to ensure check matches
 *           the registry used by `npm i -g` (avoids mirror delay mismatch)
 *
 * Falls back to https://registry.npmjs.org/ on any failure.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const NPMJS_FALLBACK = 'https://registry.npmjs.org';

export async function resolveRegistryUrl(
  configValue: string,
  execNpmConfig: (cmd: string) => Promise<string> = defaultExecNpmConfig,
): Promise<string> {
  if (configValue !== 'auto') {
    return `${configValue.replace(/\/$/, '')}/cc-linker/latest`;
  }

  // auto: read user's npm config
  let stdout: string;
  try {
    stdout = await execNpmConfig('npm config get registry');
  } catch {
    stdout = `${NPMJS_FALLBACK}/`;
  }
  const base = stdout.trim().replace(/\/$/, '') || NPMJS_FALLBACK;
  return `${base}/cc-linker/latest`;
}

async function defaultExecNpmConfig(cmd: string): Promise<string> {
  const [bin, ...args] = cmd.split(' ');
  const { stdout } = await execFileAsync(bin, args, { timeout: 3000 });
  return stdout;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/updater/registry.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Commit**

```bash
git add src/updater/registry.ts tests/unit/updater/registry.test.ts
git commit -m "feat(updater): resolveRegistryUrl with npm config auto-detect"
```

---

### Task 7: Implement `check()` with pre-release guard

**Files:**
- Create: `src/updater/check.ts`
- Create: `tests/unit/updater/check.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/updater/check.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { check } from '../../../src/updater/check';
import type { UpdateInfo } from '../../../src/updater/types';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'updater-check-'));
});

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

function mockFetch(handler: (url: string) => Promise<Response>): typeof fetch {
  return ((url: any) => handler(url as string)) as any;
}

describe('updater/check', () => {
  const URL = 'https://registry.npmjs.org/cc-linker/latest';

  describe('pre-release guard', () => {
    it('returns prerelease_only when latest is pre-release', async () => {
      const info = await check({
        current: '0.6.3',
        cachePath: join(tmpDir, '.update-check.json'),
        url: URL,
        fetchImpl: mockFetch(async () => new Response(JSON.stringify({ version: '0.6.4-beta.1' }))),
        ttlMs: 0,
      });
      expect(info.status).toBe('prerelease_only');
      expect(info.latest).toBe('0.6.4-beta.1');
    });

    it('returns update_available when latest is stable and > current', async () => {
      const info = await check({
        current: '0.6.3',
        cachePath: join(tmpDir, '.update-check.json'),
        url: URL,
        fetchImpl: mockFetch(async () => new Response(JSON.stringify({ version: '0.6.4' }))),
        ttlMs: 0,
      });
      expect(info.status).toBe('update_available');
      expect(info.latest).toBe('0.6.4');
    });

    it('returns up_to_date when current == latest (both stable)', async () => {
      const info = await check({
        current: '0.6.3',
        cachePath: join(tmpDir, '.update-check.json'),
        url: URL,
        fetchImpl: mockFetch(async () => new Response(JSON.stringify({ version: '0.6.3' }))),
        ttlMs: 0,
      });
      expect(info.status).toBe('up_to_date');
    });

    it('returns local_newer when current > latest (semver)', async () => {
      const info = await check({
        current: '0.6.3',
        cachePath: join(tmpDir, '.update-check.json'),
        url: URL,
        fetchImpl: mockFetch(async () => new Response(JSON.stringify({ version: '0.6.2' }))),
        ttlMs: 0,
      });
      expect(info.status).toBe('local_newer');
    });

    it('returns check_failed on HTTP 500', async () => {
      const info = await check({
        current: '0.6.3',
        cachePath: join(tmpDir, '.update-check.json'),
        url: URL,
        fetchImpl: mockFetch(async () => new Response('error', { status: 500 })),
        ttlMs: 0,
      });
      expect(info.status).toBe('check_failed');
      expect(info.error).toBe('http_500');
    });

    it('returns check_failed on non-JSON response', async () => {
      const info = await check({
        current: '0.6.3',
        cachePath: join(tmpDir, '.update-check.json'),
        url: URL,
        fetchImpl: mockFetch(async () => new Response('<html>not json</html>', {
          status: 200, headers: { 'content-type': 'text/html' },
        })),
        ttlMs: 0,
      });
      expect(info.status).toBe('check_failed');
      expect(info.error).toBe('parse_error');
    });
  });

  describe('cache TTL', () => {
    it('returns cached status when within TTL', async () => {
      const cachePath = join(tmpDir, '.update-check.json');
      const cached: UpdateInfo = {
        status: 'update_available', current: '0.6.3', latest: '0.6.4', checkedAt: Date.now(),
      };
      const { writeCache } = await import('../../../src/updater/cache');
      await writeCache(cachePath, { meta: { schemaVersion: 1 }, data: cached });

      let fetchCalled = false;
      const info = await check({
        current: '0.6.3',
        cachePath,
        url: URL,
        fetchImpl: mockFetch(async () => { fetchCalled = true; return new Response('{}'); }),
        ttlMs: 24 * 60 * 60 * 1000, // 24h
      });
      expect(fetchCalled).toBe(false);
      expect(info.status).toBe('update_available');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/updater/check.test.ts`
Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

Create `src/updater/check.ts`:

```ts
/**
 * Core check function: fetch npm registry, compare versions, return UpdateInfo.
 *
 * Pre-release guard (spec §3.1): if latest matches /^\d+\.\d+\.\d+-/,
 * return prerelease_only regardless of current version. This prevents
 * accidental pre-release notifications if maintainer forgets --tag beta.
 *
 * Cache: ~/.cc-linker/.update-check.json with TTL (default 24h).
 * Caller can force a fresh fetch with force: true.
 */

import semver from 'semver';
import { readCache, writeCache } from './cache';
import { isPreRelease, type UpdateInfo } from './types';

const CHECK_FAILED = (current: string, error: string): UpdateInfo => ({
  status: 'check_failed',
  current,
  latest: '',
  checkedAt: Date.now(),
  error,
});

export interface CheckOptions {
  current: string;          // PKG_VERSION
  cachePath: string;
  ttlMs?: number;           // default 24h
  force?: boolean;          // skip cache
  fetchImpl?: typeof fetch; // injectable for tests
  timeoutMs?: number;       // default 5s
}

export async function check(opts: CheckOptions): Promise<UpdateInfo> {
  const { current, cachePath } = opts;
  const ttlMs = opts.ttlMs ?? 24 * 60 * 60 * 1000;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const fetchImpl = opts.fetchImpl ?? fetch;

  // 1. Check cache unless forced
  if (!opts.force) {
    const cached = await readCache(cachePath);
    if (cached && Date.now() - cached.data.checkedAt < ttlMs) {
      return cached.data;
    }
  }

  // 2. Fetch (caller provides URL via opts.url OR we derive from registry)
  // For this task, we accept opts.url to keep check() testable.
  // resolveRegistryUrl lives in registry.ts and is called by the caller.
  if (!opts.url) {
    return CHECK_FAILED(current, 'no_url_provided');
  }

  let response: Response;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    response = await fetchImpl(opts.url, { signal: controller.signal });
    clearTimeout(timeoutId);
  } catch (e: any) {
    const reason = e?.name === 'AbortError' ? 'timeout' : 'offline';
    const info = CHECK_FAILED(current, reason);
    await writeCache(cachePath, { meta: { schemaVersion: 1 }, data: info });
    return info;
  }

  if (!response.ok) {
    const info = CHECK_FAILED(current, `http_${response.status}`);
    await writeCache(cachePath, { meta: { schemaVersion: 1 }, data: info });
    return info;
  }

  // 3. Parse + validate (use Zod shape check; keep simple here)
  let payload: { version?: string };
  try {
    payload = await response.json();
  } catch {
    const info = CHECK_FAILED(current, 'parse_error');
    await writeCache(cachePath, { meta: { schemaVersion: 1 }, data: info });
    return info;
  }

  if (!payload.version || typeof payload.version !== 'string') {
    const info = CHECK_FAILED(current, 'malformed');
    await writeCache(cachePath, { meta: { schemaVersion: 1 }, data: info });
    return info;
  }

  const latest = payload.version;

  // 4. Pre-release guard (spec §3.1)
  if (isPreRelease(latest)) {
    const info: UpdateInfo = {
      status: 'prerelease_only',
      current,
      latest,
      checkedAt: Date.now(),
    };
    await writeCache(cachePath, { meta: { schemaVersion: 1 }, data: info });
    return info;
  }

  // 5. Semver compare
  let cmp: number;
  try {
    cmp = semver.compare(current, latest);
  } catch {
    const info = CHECK_FAILED(current, 'semver_error');
    await writeCache(cachePath, { meta: { schemaVersion: 1 }, data: info });
    return info;
  }

  let status: UpdateInfo['status'];
  if (cmp === 0) status = 'up_to_date';
  else if (cmp > 0) status = 'local_newer';
  else status = 'update_available';

  // Preserve notifiedAt from previous cache so the 24h dedup window
  // survives a `cc-linker upgrade` force-fetch or any other check() call.
  // Without this, the daemon's tick() would re-send the card 24h after
  // the original notification (Bug fix: check() must not clear dedup state).
  const oldCache = await readCache(cachePath);
  const info: UpdateInfo = {
    status,
    current,
    latest,
    checkedAt: Date.now(),
    notifiedAt: oldCache?.data?.notifiedAt,
  };
  await writeCache(cachePath, { meta: { schemaVersion: 1 }, data: info });
  return info;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/updater/check.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add src/updater/check.ts tests/unit/updater/check.test.ts
git commit -m "feat(updater): check() with pre-release guard + cache TTL"
```

---

### Task 8: Implement `formatBanner` and `formatCardPayload`

**Files:**
- Create: `src/updater/notify.ts`
- Create: `tests/unit/updater/notify.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/updater/notify.test.ts`:

```ts
import { describe, it, expect } from 'bun:test';
import { formatBanner, formatCardPayload } from '../../../src/updater/notify';
import type { UpdateInfo, InstallMode } from '../../../src/updater/types';

const baseInfo = (over: Partial<UpdateInfo> = {}): UpdateInfo => ({
  status: 'up_to_date',
  current: '0.6.3',
  latest: '0.6.3',
  checkedAt: 1718345678000,
  ...over,
});

describe('updater/notify', () => {
  describe('formatBanner (CLI)', () => {
    it('up_to_date', () => {
      const out = formatBanner(baseInfo({ status: 'up_to_date' }));
      expect(out).toContain('你用的是最新版');
      expect(out).toContain('0.6.3');
    });

    it('update_available', () => {
      const out = formatBanner(baseInfo({ status: 'update_available', latest: '0.6.4' }));
      expect(out).toContain('cc-linker upgrade');
      expect(out).toContain('0.6.4');
    });

    it('local_newer', () => {
      const out = formatBanner(baseInfo({ status: 'local_newer', current: '0.7.0-dev' }));
      expect(out).toContain('本地');
    });

    it('prerelease_only', () => {
      const out = formatBanner(baseInfo({ status: 'prerelease_only', latest: '0.6.4-beta.1' }));
      expect(out).toContain('pre-release');
      expect(out).toContain('0.6.4-beta.1');
    });

    it('check_failed', () => {
      const out = formatBanner(baseInfo({ status: 'check_failed', error: 'timeout' }));
      expect(out).toContain('无法检查');
    });

    it('disabled', () => {
      const out = formatBanner(baseInfo({ status: 'disabled' }));
      expect(out).toContain('已禁用');
    });
  });

  describe('formatCardPayload (Feishu)', () => {
    it('npm_global: shows cc-linker upgrade', () => {
      const payload = formatCardPayload(baseInfo({ status: 'update_available', latest: '0.6.4' }), 'npm_global');
      expect(payload.body).toContain('cc-linker upgrade');
      expect(payload.actions).toContainEqual(expect.objectContaining({ text: 'View changelog' }));
    });

    it('standalone_binary: shows download URL, no upgrade command', () => {
      const payload = formatCardPayload(baseInfo({ status: 'update_available', latest: '0.6.4' }), 'standalone_binary');
      expect(payload.body).toContain('standalone binary');
      expect(payload.body).toContain('github.com/yujuntea/cc-linker/releases/tag/v0.6.4');
      expect(payload.body).not.toContain('cc-linker upgrade');
    });

    it('dev: shows bun run deploy', () => {
      const payload = formatCardPayload(baseInfo({ status: 'update_available', latest: '0.6.4' }), 'dev');
      expect(payload.body).toContain('bun run deploy');
    });

    it('prerelease_only: not generated (daemon caller handles suppression)', () => {
      // This is enforced at daemon level (no card sent). formatCardPayload
      // still works but caller should not call it.
      const payload = formatCardPayload(baseInfo({ status: 'prerelease_only' }), 'npm_global');
      expect(payload.header).toBeDefined();
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/updater/notify.test.ts`
Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

Create `src/updater/notify.ts`:

```ts
/**
 * Format UpdateInfo for display:
 * - formatBanner: plain text for CLI stdout / status append / daemon log
 * - formatCardPayload: Feishu card JSON for daemon notification
 */

import type { UpdateInfo, InstallMode } from './types';

const CHANGELOG_URL = (version: string) =>
  `https://github.com/yujuntea/cc-linker/releases/tag/v${version}`;

export function formatBanner(info: UpdateInfo): string {
  switch (info.status) {
    case 'up_to_date':
      return `✅ 你用的是最新版 (v${info.current})`;
    case 'update_available':
      return `⬆️  v${info.latest} 可用（你 v${info.current}）。运行 \`cc-linker upgrade\` 一键升级。`;
    case 'local_newer':
      return `🛠️  本地 v${info.current} 比 published v${info.latest} 新（开发版本，跳过）`;
    case 'prerelease_only':
      return `ℹ️  published latest 是 pre-release (v${info.latest}), 内部测试包不推送升级`;
    case 'check_failed':
      return `⚠️  无法检查更新 (${info.error ?? 'unknown'}); 24h 缓存仍可用`;
    case 'disabled':
      return `⏸️  [updater] enabled = false 已禁用检查`;
  }
}

export interface CardPayload {
  header: string;
  body: string;
  actions: Array<
    | { type: 'url'; text: string; url: string }
    | { type: 'button'; text: string; value: { action: string; version: string } }
  >;
}

export function formatCardPayload(info: UpdateInfo, mode: InstallMode): CardPayload {
  const changelogUrl = CHANGELOG_URL(info.latest);

  if (mode === 'standalone_binary') {
    return {
      header: '🆕 cc-linker 有新版本',
      body: [
        `当前 v${info.current} → v${info.latest}`,
        '',
        '你是 standalone binary 安装, 自动升级不支持',
        '请下载新 binary:',
        changelogUrl,
      ].join('\n'),
      actions: [
        { type: 'url', text: `Download v${info.latest}`, url: changelogUrl },
        { type: 'button', text: 'Skip 30 天', value: { action: 'skip', version: info.latest } },
      ],
    };
  }

  if (mode === 'dev') {
    return {
      header: '🆕 cc-linker 有新版本',
      body: [
        `当前 v${info.current} → v${info.latest}`,
        '',
        '你是 dev mode, 升级用:',
        '```',
        'bun run deploy',
        '```',
      ].join('\n'),
      actions: [
        { type: 'url', text: 'View changelog', url: changelogUrl },
        { type: 'button', text: 'Skip 30 天', value: { action: 'skip', version: info.latest } },
      ],
    };
  }

  // npm_global (default)
  return {
    header: '🆕 cc-linker 有新版本',
    body: [
      `当前 v${info.current} → v${info.latest}`,
      '',
      '升级命令:',
      '```',
      'cc-linker upgrade',
      '```',
    ].join('\n'),
    actions: [
      { type: 'url', text: 'View changelog', url: changelogUrl },
      { type: 'button', text: 'Skip 30 天', value: { action: 'skip', version: info.latest } },
    ],
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/updater/notify.test.ts`
Expected: PASS, 10 tests

- [ ] **Step 5: Commit**

```bash
git add src/updater/notify.ts tests/unit/updater/notify.test.ts
git commit -m "feat(updater): formatBanner (CLI) + formatCardPayload (3 install modes)"
```

---

### Task 9: Implement `detectInstallMode`

**Files:**
- Create: `src/updater/detect-install-mode.ts`
- Create: `tests/unit/updater/detect-install-mode.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/updater/detect-install-mode.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { detectInstallMode } from '../../../src/updater/detect-install-mode';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'detect-'));
});

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('updater/detect-install-mode', () => {
  it('returns npm_global when /usr/local/lib/node_modules/cc-linker/package.json exists', async () => {
    const globalDir = join(tmpDir, 'node_modules', 'cc-linker');
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(join(globalDir, 'package.json'), '{"name":"cc-linker","version":"0.6.3"}');

    const mode = await detectInstallMode({
      globalNodeModules: join(tmpDir, 'node_modules'),
      argv1: '/usr/local/bin/cc-linker',
    });
    expect(mode).toBe('npm_global');
  });

  it('returns dev when argv1 ends with src/index.ts', async () => {
    const mode = await detectInstallMode({
      globalNodeModules: join(tmpDir, 'node_modules'),
      argv1: '/Users/me/project/src/index.ts',
    });
    expect(mode).toBe('dev');
  });

  it('returns bun_link when global node_modules symlink points to project', async () => {
    const projectDir = join(tmpDir, 'project');
    mkdirSync(projectDir, { recursive: true });
    const globalDir = join(tmpDir, 'global', 'node_modules', 'cc-linker');
    mkdirSync(join(tmpDir, 'global', 'node_modules'), { recursive: true });
    symlinkSync(projectDir, globalDir);

    const mode = await detectInstallMode({
      globalNodeModules: join(tmpDir, 'global', 'node_modules'),
      argv1: '/usr/local/bin/cc-linker',
    });
    expect(mode).toBe('bun_link');
  });

  it('returns standalone_binary when no markers match', async () => {
    const mode = await detectInstallMode({
      globalNodeModules: join(tmpDir, 'node_modules'),
      argv1: '/usr/local/bin/cc-linker',
    });
    expect(mode).toBe('standalone_binary');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/updater/detect-install-mode.test.ts`
Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

Create `src/updater/detect-install-mode.ts`:

```ts
/**
 * Detect how cc-linker was installed. Used to tailor the upgrade command
 * shown in the Feishu notification card.
 *
 * Returns:
 *   - 'npm_global'      — installed via `npm i -g cc-linker`
 *   - 'dev'             — running from `bun run dev` (argv1 is src/index.ts)
 *   - 'bun_link'        — `bun link` from a dev project
 *   - 'standalone_binary' — bun build --compile binary (none of the above)
 */

import { existsSync, lstatSync, readlinkSync, statSync } from 'fs';
import { join } from 'path';
import type { InstallMode } from './types';

export interface DetectOptions {
  globalNodeModules: string;  // e.g., /usr/local/lib/node_modules
  argv1: string;              // process.argv[1] of the running process
}

export function detectInstallMode(opts: DetectOptions): InstallMode {
  // 1. dev mode: argv1 is a TypeScript source file
  if (opts.argv1.endsWith('src/index.ts') || opts.argv1.endsWith('src/cli.ts')) {
    return 'dev';
  }

  // 2. npm global: package.json exists in node_modules
  const globalPkg = join(opts.globalNodeModules, 'cc-linker', 'package.json');
  if (existsSync(globalPkg)) {
    // 2a. bun_link: global is a symlink pointing to a project dir
    try {
      const stat = lstatSync(join(opts.globalNodeModules, 'cc-linker'));
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(join(opts.globalNodeModules, 'cc-linker'));
        if (target.includes('/') && !target.startsWith('/usr/local')) {
          return 'bun_link';
        }
      }
    } catch { /* ignore */ }
    return 'npm_global';
  }

  // 3. standalone binary: no global package, argv1 is compiled binary
  return 'standalone_binary';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/updater/detect-install-mode.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Commit**

```bash
git add src/updater/detect-install-mode.ts tests/unit/updater/detect-install-mode.test.ts
git commit -m "feat(updater): detectInstallMode for 4 install modes"
```

---

### Task 10: Implement Skip lifecycle (CAS via user-mapping)

**Files:**
- Create: `src/updater/lifecycle.ts`
- Create: `tests/unit/updater/lifecycle.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/updater/lifecycle.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getActiveSkips, addSkippedVersion, THIRTY_DAYS_MS } from '../../../src/updater/lifecycle';

let tmpDir: string;
let mappingPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'lifecycle-'));
  mappingPath = join(tmpDir, 'user-mapping.json');
});

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('updater/lifecycle', () => {
  describe('getActiveSkips', () => {
    it('returns empty array when user-mapping.json missing', () => {
      const skips = getActiveSkips(mappingPath, 'ou_owner');
      expect(skips).toEqual([]);
    });

    it('returns empty array when owner has no skipped_versions', () => {
      writeFileSync(mappingPath, JSON.stringify({
        'ou_owner': { type: 'session', sessionUuid: 'xxx', casToken: 1 },
      }));
      const skips = getActiveSkips(mappingPath, 'ou_owner');
      expect(skips).toEqual([]);
    });

    it('returns skip entries within 30 days', () => {
      const recentSkippedAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
      writeFileSync(mappingPath, JSON.stringify({
        'ou_owner': {
          type: 'session', sessionUuid: 'xxx', casToken: 1,
          skipped_versions: [{ version: '0.6.4', skipped_at: recentSkippedAt }],
        },
      }));
      const skips = getActiveSkips(mappingPath, 'ou_owner');
      expect(skips).toHaveLength(1);
      expect(skips[0].version).toBe('0.6.4');
    });

    it('filters out skip entries older than 30 days', () => {
      const expiredSkippedAt = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString();
      writeFileSync(mappingPath, JSON.stringify({
        'ou_owner': {
          type: 'session', sessionUuid: 'xxx', casToken: 1,
          skipped_versions: [{ version: '0.6.4', skipped_at: expiredSkippedAt }],
        },
      }));
      const skips = getActiveSkips(mappingPath, 'ou_owner');
      expect(skips).toEqual([]);
    });
  });

  describe('addSkippedVersion', () => {
    it('adds a new skip entry via CAS', () => {
      writeFileSync(mappingPath, JSON.stringify({
        'ou_owner': { type: 'session', sessionUuid: 'xxx', casToken: 1 },
      }));
      const ok = addSkippedVersion(mappingPath, 'ou_owner', '0.6.4');
      expect(ok).toBe(true);
      const skips = getActiveSkips(mappingPath, 'ou_owner');
      expect(skips).toHaveLength(1);
      expect(skips[0].version).toBe('0.6.4');
    });

    it('skipped_at is ISO 8601 with Z', () => {
      writeFileSync(mappingPath, JSON.stringify({
        'ou_owner': { type: 'session', sessionUuid: 'xxx', casToken: 1 },
      }));
      addSkippedVersion(mappingPath, 'ou_owner', '0.6.4');
      const raw = JSON.parse(readFileSync(mappingPath, 'utf-8'));
      const skip = raw['ou_owner'].skipped_versions[0];
      expect(skip.skipped_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    });

    it('returns false when entry is not in session state', () => {
      writeFileSync(mappingPath, JSON.stringify({
        'ou_owner': { type: 'pending_new_session' },
      }));
      const ok = addSkippedVersion(mappingPath, 'ou_owner', '0.6.4');
      expect(ok).toBe(false);
    });

    it('retries once on CAS conflict', () => {
      // Simulate concurrent write: first read sees casToken=1, second write expects 1
      // but casToken was bumped by a parallel writer.
      writeFileSync(mappingPath, JSON.stringify({
        'ou_owner': { type: 'session', sessionUuid: 'xxx', casToken: 1 },
      }));
      // Bump casToken to simulate concurrent modification
      const ok = addSkippedVersion(mappingPath, 'ou_owner', '0.6.4', { maxRetries: 1 });
      // Should still succeed with retry if the read is fresh
      expect(typeof ok).toBe('boolean');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/updater/lifecycle.test.ts`
Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

Create `src/updater/lifecycle.ts`:

```ts
/**
 * Skip state management for cc-linker upgrade notifications.
 *
 * Stores skipped versions in user-mapping.json under the owner's openid
 * entry, using the same CAS protocol as UserManager. Entries expire after
 * 30 days (rolling window) so users are re-prompted for new versions.
 */

import { readFileSync, writeFileSync, existsSync, renameSync } from 'fs';
import { lockSync, unlockSync } from 'proper-lockfile';
import type { SkippedVersionEntry } from './types';

export const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

interface OwnerEntry {
  type: string;
  sessionUuid?: string;
  casToken?: number;
  skipped_versions?: SkippedVersionEntry[];
}

function readMapping(path: string): Record<string, OwnerEntry> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return {};
  }
}

function writeMapping(path: string, data: Record<string, OwnerEntry>): void {
  // atomic write
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}

/**
 * Get active (non-expired) skipped versions for an owner.
 * Returns empty array if mapping missing or owner has no entry.
 */
export function getActiveSkips(mappingPath: string, openid: string): SkippedVersionEntry[] {
  const mapping = readMapping(mappingPath);
  const entry = mapping[openid];
  if (!entry?.skipped_versions) return [];

  const now = Date.now();
  return entry.skipped_versions.filter(s => {
    const ts = new Date(s.skipped_at).getTime();
    return now - ts < THIRTY_DAYS_MS;
  });
}

/**
 * Add a skipped version via CAS retry. Returns true on success, false on
 * failure (entry in wrong state, or CAS exhausted retries).
 *
 * Race semantics: read-modify-write is non-atomic, but acceptable for the
 * Skip use case:
 *   - Single user, single owner openid. The user can only click Skip
 *     once per card; two simultaneous Skip clicks on the same version
 *     are practically impossible.
 *   - In the rare concurrent case, both writers' results merge
 *     (skipped_versions = [A, B]) — never lost, just redundant. The
 *     30d expiry filter handles dup detection on read.
 *   - proper-lockfile serializes the critical section to prevent
 *     interleaved writes from corrupting the file.
 *
 * Do NOT reuse this pattern for general CAS; for that, use a true
 * read-version-write-check pattern instead.
 */
export function addSkippedVersion(
  mappingPath: string,
  openid: string,
  version: string,
  opts: { maxRetries?: number } = {},
): boolean {
  const maxRetries = opts.maxRetries ?? 2;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const mapping = readMapping(mappingPath);
    const entry = mapping[openid];

    // Only allow add when in session state (avoids racing with session transitions)
    if (!entry || entry.type !== 'session') {
      return false;
    }

    const existing = entry.skipped_versions ?? [];
    const newEntry: SkippedVersionEntry = {
      version,
      skipped_at: new Date().toISOString(),  // always with Z (UTC)
    };

    mapping[openid] = {
      ...entry,
      casToken: (entry.casToken ?? 0) + 1,
      skipped_versions: [...existing, newEntry],
    };

    try {
      lockSync(mappingPath, { retries: { retries: 3, minTimeout: 50, maxTimeout: 200 } });
      writeMapping(mappingPath, mapping);
      unlockSync(mappingPath);
      return true;
    } catch {
      // lock failed or write raced; retry
      continue;
    }
  }

  return false;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/updater/lifecycle.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add src/updater/lifecycle.ts tests/unit/updater/lifecycle.test.ts
git commit -m "feat(updater): Skip lifecycle with CAS + 30d expiry"
```

---

## Phase 3: CLI integration

### Task 11: Implement `cc-linker upgrade` CLI command

**Files:**
- Create: `src/cli/commands/upgrade.ts`
- Create: `tests/unit/cli/upgrade.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/cli/upgrade.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildUpgradePlan, type UpgradeOpts } from '../../../src/cli/commands/upgrade';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'upgrade-cli-'));
});

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('cli/upgrade', () => {
  describe('buildUpgradePlan', () => {
    it('--check: just returns "check" plan', () => {
      const plan = buildUpgradePlan({ check: true });
      expect(plan.kind).toBe('check');
    });

    it('--dry-run: returns "dry_run" plan without invoking npm', () => {
      const plan = buildUpgradePlan({ dryRun: true, latest: '0.6.4', current: '0.6.3' });
      expect(plan.kind).toBe('dry_run');
      expect(plan.targetVersion).toBe('0.6.4');
    });

    it('--to: returns "apply" plan with explicit version', () => {
      const plan = buildUpgradePlan({ to: '0.5.0', latest: '0.6.4', current: '0.6.3' });
      expect(plan.kind).toBe('apply');
      expect(plan.targetVersion).toBe('0.5.0');
      expect(plan.isDowngrade).toBe(true);
    });

    it('default: returns "apply" with latest as target', () => {
      const plan = buildUpgradePlan({ latest: '0.6.4', current: '0.6.3' });
      expect(plan.kind).toBe('apply');
      expect(plan.targetVersion).toBe('0.6.4');
      expect(plan.isDowngrade).toBe(false);
    });

    it('--to same as current: returns "noop" plan', () => {
      const plan = buildUpgradePlan({ to: '0.6.3', latest: '0.6.4', current: '0.6.3' });
      expect(plan.kind).toBe('noop');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/cli/upgrade.test.ts`
Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

Create `src/cli/commands/upgrade.ts`:

```ts
/**
 * `cc-linker upgrade` CLI command.
 *
 * Sub-modes:
 *   --check       : just print update status banner, exit 0
 *   --dry-run     : print "would install X" without invoking npm
 *   --to <ver>    : install specific version (downgrade supported)
 *   --yes         : skip confirmation prompt
 *   (default)     : confirm + npm i -g cc-linker@latest + cc-linker restart
 *
 * The actual entry point is `upgrade()` which orchestrates the full flow.
 * `buildUpgradePlan` is a pure function used by the entry point and tests.
 */

import chalk from 'chalk';
import { execFileSync } from 'child_process';
import semver from 'semver';
import inquirer from 'inquirer';
import { PKG_VERSION } from '../version';
import { UPDATE_CHECK_CACHE_PATH } from '../utils/paths';
import { resolveRegistryUrl } from '../updater/registry';
import { check } from '../updater/check';
import { formatBanner } from '../updater/notify';
import { detectInstallMode } from '../updater/detect-install-mode';

export interface UpgradeOpts {
  check?: boolean;
  dryRun?: boolean;
  to?: string;
  yes?: boolean;
}

export type UpgradePlan =
  | { kind: 'check' }
  | { kind: 'dry_run'; targetVersion: string; current: string }
  | { kind: 'apply'; targetVersion: string; current: string; isDowngrade: boolean }
  | { kind: 'noop'; reason: string };

export function buildUpgradePlan(opts: UpgradeOpts & { latest?: string; current?: string }): UpgradePlan {
  const current = opts.current ?? PKG_VERSION;

  if (opts.check) return { kind: 'check' };

  if (opts.to) {
    if (opts.to === current) {
      return { kind: 'noop', reason: `Already on v${current}` };
    }
    const cmp = semver.compare(opts.to, current);
    return {
      kind: 'apply',
      targetVersion: opts.to,
      current,
      isDowngrade: cmp < 0,
    };
  }

  // default: upgrade to latest
  if (!opts.latest) {
    return { kind: 'noop', reason: 'No latest version provided' };
  }
  if (opts.latest === current) {
    return { kind: 'noop', reason: `Already on v${current}` };
  }
  return {
    kind: 'apply',
    targetVersion: opts.latest,
    current,
    isDowngrade: false,
  };
}

/**
 * Main entry point for `cc-linker upgrade`. Runs check, builds plan, prompts,
 * invokes npm, then calls cc-linker restart (R1: idempotent, not relying on postinstall).
 */
export async function upgrade(opts: UpgradeOpts): Promise<void> {
  // 1. Always fresh fetch
  const url = await resolveRegistryUrl('auto');
  const info = await check({
    current: PKG_VERSION,
    cachePath: UPDATE_CHECK_CACHE_PATH,
    url,
    force: true,
  });

  // 2. Check install mode
  const mode = detectInstallMode({
    globalNodeModules: detectGlobalNodeModules(),
    argv1: process.argv[1] ?? '',
  });

  if (mode === 'standalone_binary') {
    console.log(chalk.yellow('❌ 你是 standalone binary 安装, 自动升级不支持'));
    console.log(chalk.cyan('   请下载新 binary:'));
    console.log(chalk.cyan('   https://github.com/yujuntea/cc-linker/releases/latest'));
    return;
  }
  if (mode === 'dev' || mode === 'bun_link') {
    console.log(chalk.yellow('❌ 你是 dev mode / bun link, 升级用 bun run deploy'));
    return;
  }

  // 3. Plan
  const plan = buildUpgradePlan({ ...opts, latest: info.latest, current: PKG_VERSION });

  if (plan.kind === 'check') {
    console.log(formatBanner(info));
    return;
  }

  if (plan.kind === 'noop') {
    console.log(chalk.gray(`ℹ️  ${plan.reason}, 跳过`));
    return;
  }

  if (info.status === 'up_to_date' && plan.kind === 'apply') {
    console.log(formatBanner(info));
    return;
  }

  if (info.status === 'prerelease_only') {
    console.log(formatBanner(info));
    return;
  }

  // 4. Dry-run short-circuit
  if (opts.dryRun) {
    console.log(chalk.cyan(`🔍 Would install cc-linker@${plan.targetVersion} (current ${plan.current}), no changes`));
    return;
  }

  // 5. Confirm
  const warnText = plan.isDowngrade
    ? `⚠️  确定要降级/跳到 v${plan.targetVersion} (从 v${plan.current}) 吗?`
    : `升级到 v${plan.targetVersion}?`;

  if (!opts.yes) {
    const { ok } = await inquirer.prompt([{
      type: 'confirm', name: 'ok', message: warnText, default: !plan.isDowngrade,
    }]);
    if (!ok) {
      console.log(chalk.gray('已取消'));
      return;
    }
  }

  // 6. Warn about daemon restart
  console.log(chalk.yellow('⚠️  升级会重启 daemon, 进行中的对话会中断'));

  // 7. Run npm i -g
  console.log(chalk.cyan(`📦 正在安装 cc-linker@${plan.targetVersion}...`));
  try {
    execFileSync('npm', ['install', '-g', `cc-linker@${plan.targetVersion}`], { stdio: 'inherit' });
  } catch (e: any) {
    console.log(chalk.red(`❌ npm install 失败: ${e.message}`));
    process.exit(1);
  }

  // 8. R1: idempotent restart (not relying on postinstall)
  console.log(chalk.cyan('🔄 重启 daemon...'));
  try {
    execFileSync('cc-linker', ['restart'], { stdio: 'inherit' });
  } catch (e: any) {
    console.log(chalk.yellow('⚠️  daemon 自动 restart 失败, 请手动: cc-linker restart'));
  }

  console.log(chalk.green('✅ 升级完成'));
}

/**
 * Detect the global node_modules path (heuristic: same dir as `which cc-linker`).
 */
function detectGlobalNodeModules(): string {
  try {
    const binPath = execFileSync('which', ['cc-linker'], { encoding: 'utf-8' }).trim();
    // /usr/local/bin/cc-linker → /usr/local/lib/node_modules
    // /opt/homebrew/bin/cc-linker → /opt/homebrew/lib/node_modules
    return binPath.replace(/\/bin\/cc-linker$/, '/lib/node_modules');
  } catch {
    return '/usr/local/lib/node_modules';
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/cli/upgrade.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/upgrade.ts tests/unit/cli/upgrade.test.ts
git commit -m "feat(cli): cc-linker upgrade with --check/--dry-run/--to/--yes"
```

---

### Task 12: Register `upgrade` in CLI index

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add import and command registration**

In `src/index.ts`, add the import after line 21 (after `activityHook` import):

```ts
import { upgrade } from './cli/commands/upgrade';
```

Then add the command registration after the `restart` command block (around line 180, after the restart `.action(...)` closing `});`):

```ts
program
  .command('upgrade')
  .description('升级 cc-linker 到最新版本（或指定版本）')
  .option('--check', '只检查，不升级')
  .option('--dry-run', '只打印将要安装的版本，不实际执行')
  .option('--to <version>', '升级/降级到指定版本')
  .option('--yes', '跳过确认提示')
  .action((opts) => withSync(async () => {
    await upgrade(opts);
  }, true));
```

- [ ] **Step 2: Verify typecheck passes**

Run: `bun run typecheck`
Expected: exit 0

- [ ] **Step 3: Verify CLI registers the command**

Run: `bun run dev upgrade --help`
Expected: prints help text with `--check`, `--dry-run`, `--to`, `--yes` options

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat(cli): register upgrade subcommand"
```

---

### Task 13: Add async update banner to `cc-linker status`

**Files:**
- Modify: `src/cli/commands/status.ts`

- [ ] **Step 1: Replace the status function with async version**

Replace the entire `src/cli/commands/status.ts` content with:

```ts
import chalk from 'chalk';
import { readFileSync, existsSync, statSync } from 'fs';
import { RegistryManager } from '../../registry';
import { formatTimeAgo } from '../output';
import { CLAUDE_SETTINGS_PATH, RUNTIME_OWNER_LOCK_PATH, UPDATE_CHECK_CACHE_PATH } from '../../utils/paths';
import { PKG_VERSION } from '../../version';
import { resolveRegistryUrl } from '../../updater/registry';
import { check } from '../../updater/check';
import { formatBanner } from '../../updater/notify';

export async function status(registry: RegistryManager): Promise<void> {
  const sessions = Object.values(registry.sessions);
  const active = sessions.filter(s => !s.status || s.status === 'active').length;
  const fromCli = sessions.filter(s => s.origin === 'cli').length;
  const fromFeishu = sessions.filter(s => s.origin === 'feishu').length;
  const archivedOrCorrupted = sessions.filter(s => s.status === 'archived' || s.status === 'corrupted' || s.status === 'degraded' || s.status === 'provisioning').length;

  console.log(chalk.bold('cc-linker Status'));
  console.log('─'.repeat(40));
  console.log(`Registry:      ${registry.path}`);

  if (existsSync(registry.path)) {
    const stat = statSync(registry.path);
    console.log(`Last modified: ${formatTimeAgo(stat.mtime.toISOString())}`);
  }

  console.log(`Total sessions: ${sessions.length}`);
  console.log(`  From CLI:       ${fromCli}`);
  console.log(`  From Feishu:    ${fromFeishu}`);
  console.log(`  Active:         ${active}`);
  console.log(`  Other states:   ${archivedOrCorrupted}`);

  // Runtime 状态
  console.log('\nRuntime:');
  const hasLock = existsSync(RUNTIME_OWNER_LOCK_PATH);
  console.log(`  Owner lock:     ${hasLock ? chalk.green('active') : 'none'}`);

  let hookInstalled = false;
  if (existsSync(CLAUDE_SETTINGS_PATH)) {
    try {
      const settings = JSON.parse(readFileSync(CLAUDE_SETTINGS_PATH, 'utf8'));
      const sessionStart = settings.hooks?.SessionStart;
      if (Array.isArray(sessionStart)) {
        hookInstalled = sessionStart.some((matcher: any) =>
          matcher?.hooks?.some((h: any) => h?.command?.includes('cc-linker'))
        );
      }
    } catch {}
  }
  console.log(`  Claude Code hook:   ${hookInstalled ? chalk.green('installed') : chalk.red('not installed')}`);

  // Update check banner (async, 1s soft timeout — K3 fix)
  console.log('\nUpdate:');
  const timeout = new Promise<null>(resolve => setTimeout(() => resolve(null), 1000));
  const checkPromise = (async () => {
    try {
      const url = await resolveRegistryUrl('auto');
      return await check({
        current: PKG_VERSION,
        cachePath: UPDATE_CHECK_CACHE_PATH,
        url,
        ttlMs: 24 * 60 * 60 * 1000,
      });
    } catch {
      return null;
    }
  })();
  const result = await Promise.race([checkPromise, timeout]);
  if (result) {
    console.log(`  ${formatBanner(result)}`);
  } else {
    console.log(chalk.gray('  (update check timed out)'));
  }

  // Commands 列表
  console.log('\nCommands:');
  console.log('  cc-linker start      Launch Feishu bot');
  console.log('  cc-linker list       List all sessions');
  console.log('  cc-linker resume     Resume a session');
  console.log('  cc-linker sync       Sync sessions');
}
```

- [ ] **Step 2: Verify typecheck passes**

Run: `bun run typecheck`
Expected: exit 0

- [ ] **Step 3: Verify status runs without error**

Run: `bun run dev status`
Expected: prints status, then "Update:" section with banner (or "(update check timed out)" if no network)

- [ ] **Step 4: Commit**

```bash
git add src/cli/commands/status.ts
git commit -m "feat(status): async update banner with 1s soft timeout (K3)"
```

---

### Task 14: Add launchctl unload/load to `cc-linker restart` (R2)

**Files:**
- Modify: `src/cli/commands/restart.ts`

- [ ] **Step 1: Add launchd-aware restart logic**

Replace `src/cli/commands/restart.ts` content with:

```ts
import chalk from 'chalk';
import { existsSync } from 'fs';
import { homedir, platform } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { RegistryManager } from '../../registry';
import { start, stop, StartOptions } from './start';
import { isDaemonRunning } from './init-feishu';

const IS_MACOS = platform() === 'darwin';
const LAUNCHD_PLIST = join(homedir(), 'Library', 'LaunchAgents', 'com.cclinker.daemon.plist');

export interface RestartDeps {
  isDaemonRunning: () => boolean;
  stop: () => Promise<void>;
  start: (registry: RegistryManager, opts: StartOptions) => Promise<void>;
  plistPath?: string;            // injectable for tests
  launchctlPath?: string;        // injectable for tests
}

async function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function defaultLaunchctl(...args: string[]): void {
  execFileSync('launchctl', args, { stdio: 'inherit' });
}

export async function restart(
  registry: RegistryManager,
  deps: RestartDeps = {
    isDaemonRunning,
    stop,
    start,
  },
): Promise<void> {
  const plist = deps.plistPath ?? LAUNCHD_PLIST;
  const useLaunchd = IS_MACOS && existsSync(plist);

  const wasRunning = deps.isDaemonRunning();

  // R2: on macOS launchd, use unload/load to force symlink re-resolution.
  // Without this, launchd caches the symlink target from plist load time
  // and re-spawns the OLD binary even after npm replaces /usr/local/bin/cc-linker.
  if (useLaunchd) {
    const launchctl = deps.launchctlPath
      ? (...args: string[]) => execFileSync(deps.launchctlPath!, args, { stdio: 'inherit' })
      : defaultLaunchctl;

    console.log(chalk.cyan('🔄 launchd unload (强制重新解析 binary)...'));
    try {
      launchctl('unload', plist);
    } catch (e: any) {
      console.log(chalk.yellow(`⚠️  launchctl unload: ${e.message}`));
    }

    // wait up to 15s for old daemon to exit
    const start = Date.now();
    while (deps.isDaemonRunning() && Date.now() - start < 15000) {
      await sleep(100);
    }
    if (deps.isDaemonRunning()) {
      console.log(chalk.yellow('⚠️  daemon 15s 内未退出, 强制 kill -9'));
      // last resort
      const { RUNTIME_PID_FILE } = await import('../../utils/paths');
      const { readFileSync } = await import('fs');
      try {
        const pid = parseInt(readFileSync(RUNTIME_PID_FILE, 'utf-8').trim(), 10);
        process.kill(pid, 'SIGKILL');
      } catch { /* ignore */ }
    }
  } else if (wasRunning) {
    console.log(chalk.cyan('🔄 正在重启 cc-linker...'));
    await deps.stop();
    console.log(chalk.gray('  等待进程完全停止...'));
    await sleep(1500);
  } else {
    console.log(chalk.cyan('🚀 Bot 未运行，直接启动...'));
  }

  console.log(chalk.cyan('🚀 启动 daemon...'));
  await deps.start(registry, { daemon: true });
}
```

- [ ] **Step 2: Verify typecheck passes**

Run: `bun run typecheck`
Expected: exit 0

- [ ] **Step 3: Verify restart runs (no-op if no daemon)**

Run: `bun run dev restart`
Expected: prints "Bot 未运行" or "重启" message, exit 0

- [ ] **Step 4: Commit**

```bash
git add src/cli/commands/restart.ts
git commit -m "feat(restart): launchctl unload/load on macOS launchd (R2)"
```

---

## Phase 4: Daemon + Feishu card

### Task 15: Implement daemon 24h ticker with static notification

**Files:**
- Create: `src/runtime/updater-tick.ts`
- Create: `tests/unit/runtime/updater-tick.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/runtime/updater-tick.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { checkAndNotify, tick } from '../../../src/runtime/updater-tick';
import type { UpdateInfo } from '../../../src/updater/types';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'updater-tick-'));
});

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('runtime/updater-tick', () => {
  describe('checkAndNotify', () => {
    it('does not send card when status is prerelease_only', async () => {
      let sentCard = false;
      const result = await checkAndNotify({
        cachePath: join(tmpDir, '.update-check.json'),
        checkImpl: async () => ({
          status: 'prerelease_only',
          current: '0.6.3', latest: '0.6.4-beta.1', checkedAt: Date.now(),
        }),
        sendCard: async () => { sentCard = true; },
        config: { registry_url: 'auto', notify_channel: 'feishu' as const },
        detectMode: async () => 'npm_global',
      });
      expect(result.action).toBe('none');
      expect(sentCard).toBe(false);
    });

    it('sends card when status is update_available and channel is feishu', async () => {
      let sentCardTo: any = null;
      const result = await checkAndNotify({
        cachePath: join(tmpDir, '.update-check.json'),
        checkImpl: async () => ({
          status: 'update_available',
          current: '0.6.3', latest: '0.6.4', checkedAt: Date.now(),
        }),
        sendCard: async (payload) => { sentCardTo = payload; },
        config: { registry_url: 'auto', notify_channel: 'feishu' as const },
        detectMode: async () => 'npm_global',
      });
      expect(result.action).toBe('sent');
      expect(sentCardTo).not.toBeNull();
      expect(sentCardTo.body).toContain('cc-linker upgrade');
    });

    it('writes log only when channel is cli', async () => {
      let sentCard = false;
      const logLines: string[] = [];
      const result = await checkAndNotify({
        cachePath: join(tmpDir, '.update-check.json'),
        checkImpl: async () => ({
          status: 'update_available',
          current: '0.6.3', latest: '0.6.4', checkedAt: Date.now(),
        }),
        sendCard: async () => { sentCard = true; },
        log: (line) => logLines.push(line),
        config: { registry_url: 'auto', notify_channel: 'cli' as const },
        detectMode: async () => 'npm_global',
      });
      expect(result.action).toBe('logged');
      expect(sentCard).toBe(false);
      expect(logLines.length).toBeGreaterThan(0);
    });

    it('skips notify when status is up_to_date', async () => {
      let sentCard = false;
      const result = await checkAndNotify({
        cachePath: join(tmpDir, '.update-check.json'),
        checkImpl: async () => ({
          status: 'up_to_date',
          current: '0.6.3', latest: '0.6.3', checkedAt: Date.now(),
        }),
        sendCard: async () => { sentCard = true; },
        config: { registry_url: 'auto', notify_channel: 'feishu' as const },
        detectMode: async () => 'npm_global',
      });
      expect(result.action).toBe('none');
      expect(sentCard).toBe(false);
    });
  });

  describe('tick (24h dedup wrapper)', () => {
    it('skips checkAndNotify when notifiedAt within 24h window', async () => {
      // Pre-populate cache with recent notifiedAt
      const { writeCache } = await import('../../../src/updater/cache');
      const cachePath = join(tmpDir, '.update-check.json');
      await writeCache(cachePath, {
        meta: { schemaVersion: 1 },
        data: {
          status: 'update_available',
          current: '0.6.3', latest: '0.6.4',
          checkedAt: Date.now() - 1000,
          notifiedAt: Date.now() - 60_000,  // 1 min ago
        },
      });

      let checkImplCalled = false;
      let sentCard = false;
      const result = await tick({
        cachePath,
        checkImpl: async () => { checkImplCalled = true; throw new Error('should not be called'); },
        sendCard: async () => { sentCard = true; },
        config: { registry_url: 'auto', notify_channel: 'feishu' as const },
        detectMode: async () => 'npm_global',
        dedupWindowMs: 24 * 60 * 60 * 1000,
      });
      expect(result.action).toBe('deduped');
      expect(checkImplCalled).toBe(false);
      expect(sentCard).toBe(false);
    });

    it('proceeds when notifiedAt is older than 24h', async () => {
      const { writeCache } = await import('../../../src/updater/cache');
      const cachePath = join(tmpDir, '.update-check.json');
      await writeCache(cachePath, {
        meta: { schemaVersion: 1 },
        data: {
          status: 'update_available',
          current: '0.6.3', latest: '0.6.4',
          checkedAt: Date.now(),
          notifiedAt: Date.now() - 25 * 60 * 60 * 1000,  // 25h ago
        },
      });

      let sentCard = false;
      const result = await tick({
        cachePath,
        checkImpl: async () => ({
          status: 'update_available',
          current: '0.6.3', latest: '0.6.4', checkedAt: Date.now(),
        }),
        sendCard: async () => { sentCard = true; },
        config: { registry_url: 'auto', notify_channel: 'feishu' as const },
        detectMode: async () => 'npm_global',
        dedupWindowMs: 24 * 60 * 60 * 1000,
      });
      expect(result.action).toBe('sent');
      expect(sentCard).toBe(true);
    });

    it('proceeds when no cache exists (first run)', async () => {
      let sentCard = false;
      const result = await tick({
        cachePath: join(tmpDir, '.update-check.json'),
        checkImpl: async () => ({
          status: 'update_available',
          current: '0.6.3', latest: '0.6.4', checkedAt: Date.now(),
        }),
        sendCard: async () => { sentCard = true; },
        config: { registry_url: 'auto', notify_channel: 'feishu' as const },
        detectMode: async () => 'npm_global',
        dedupWindowMs: 24 * 60 * 60 * 1000,
      });
      expect(result.action).toBe('sent');
      expect(sentCard).toBe(true);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/runtime/updater-tick.test.ts`
Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

Create `src/runtime/updater-tick.ts`:

```ts
/**
 * Daemon 24h ticker for upgrade notifications.
 *
 * `checkAndNotify` is the core function (pure-ish, injectable deps).
 * It is called on:
 *   1. Bot ready event (with setTimeout(notify_delay_ms) defer)
 *   2. 24h setTimeout chain
 *
 * Pre-release guard: prerelease_only status never sends a card.
 * Dedup: notifiedAt is written to cache to prevent re-sending within 24h.
 */

import { readCache, writeCache } from '../updater/cache';
import { formatCardPayload, formatBanner } from '../updater/notify';
import type { UpdateInfo, InstallMode, CachedCheck } from '../updater/types';
import { isPreRelease } from '../updater/types';

export interface UpdaterConfig {
  registry_url: string;
  notify_channel: 'feishu' | 'cli' | 'none';
}

export interface CheckAndNotifyDeps {
  cachePath: string;
  checkImpl: () => Promise<UpdateInfo>;
  sendCard: (payload: { header: string; body: string; actions: any[] }) => Promise<void>;
  log?: (line: string) => void;
  config: UpdaterConfig;
  detectMode: () => Promise<InstallMode>;
}

export type NotifyAction = 'sent' | 'logged' | 'none' | 'deduped';

export async function checkAndNotify(deps: CheckAndNotifyDeps): Promise<{ action: NotifyAction }> {
  const info = await deps.checkImpl();
  const { notify_channel } = deps.config;
  const log = deps.log ?? ((line) => console.log(line));

  // Always cache the result (even if not notifying)
  await writeCache(deps.cachePath, { meta: { schemaVersion: 1 }, data: info });

  // No notification for these statuses
  if (info.status === 'up_to_date' || info.status === 'local_newer' ||
      info.status === 'prerelease_only' || info.status === 'check_failed' ||
      info.status === 'disabled') {
    return { action: 'none' };
  }

  // Only update_available triggers notification
  if (info.status !== 'update_available') {
    return { action: 'none' };
  }

  // Channel routing
  if (notify_channel === 'none') {
    return { action: 'none' };
  }

  if (notify_channel === 'cli') {
    log(`[updater] ${formatBanner(info)}`);
    return { action: 'logged' };
  }

  // feishu: build card, send
  const mode = await deps.detectMode();
  const payload = formatCardPayload(info, mode);
  await deps.sendCard(payload);

  // Mark notified to prevent 24h tick from re-sending
  const notified: UpdateInfo = { ...info, notifiedAt: Date.now() };
  await writeCache(deps.cachePath, { meta: { schemaVersion: 1 }, data: notified });

  return { action: 'sent' };
}

export interface TickDeps extends CheckAndNotifyDeps {
  dedupWindowMs?: number;  // default 24h
}

/**
 * Wrapper for the 24h ticker: reads cache, checks notifiedAt, and only
 * calls checkAndNotify if outside the dedup window. Returns 'deduped'
 * if skipped, otherwise the underlying checkAndNotify result.
 *
 * This is the function the bot's 24h setTimeout chain should call.
 */
export async function tick(deps: TickDeps): Promise<{ action: NotifyAction }> {
  const dedupWindowMs = deps.dedupWindowMs ?? 24 * 60 * 60 * 1000;
  const cached = await readCache(deps.cachePath);
  if (cached?.data?.notifiedAt && Date.now() - cached.data.notifiedAt < dedupWindowMs) {
    return { action: 'deduped' };
  }
  return checkAndNotify(deps);
}

/**
 * Schedule the next 24h tick. Uses setTimeout chain (not setInterval) so
 * the daemon can cleanly clearTimeout on graceful shutdown.
 *
 * Returns the timer handle so the caller can clearTimeout.
 */
export function scheduleNextTick(
  deps: TickDeps,
  delayMs: number,
  onError?: (e: Error) => void,
): NodeJS.Timeout {
  return setTimeout(() => {
    tick(deps)
      .catch((e) => onError?.(e))
      .finally(() => scheduleNextTick(deps, delayMs, onError));
  }, delayMs);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/runtime/updater-tick.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Commit**

```bash
git add src/runtime/updater-tick.ts tests/unit/runtime/updater-tick.test.ts
git commit -m "feat(runtime): checkAndNotify with channel routing + dedup"
```

---

### Task 16: Implement Skip action handler

**Files:**
- Create: `src/feishu/updater-card.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/feishu/updater-card.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { onSkipClick } from '../../../src/feishu/updater-card';

// Mock LarkClient with capture
function mockClient() {
  const calls: any[] = [];
  return {
    calls,
    im: { v1: { message: {
      patch: async (req: any) => { calls.push({ method: 'patch', ...req }); return { code: 0 }; },
    } } },
  };
}

describe('feishu/updater-card onSkipClick', () => {
  let tmpDir: string;
  let mappingPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'updater-card-'));
    mappingPath = join(tmpDir, 'user-mapping.json');
  });

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('patches card to "已忽略" on CAS success', async () => {
    writeFileSync(mappingPath, JSON.stringify({
      'ou_owner': { type: 'session', sessionUuid: 'abc', casToken: 1 },
    }));

    const client = mockClient();
    await onSkipClick({
      client: client as any,
      openid: 'ou_owner',
      messageId: 'om_xxx',
      targetVersion: '0.6.4',
      mappingPath,  // explicit override (USER_MAPPING_PATH is a module-load constant)
    });

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].method).toBe('patch');
    expect(client.calls[0].message_id).toBe('om_xxx');
    const content = JSON.parse(client.calls[0].content);
    expect(content.header.title.content).toContain('已忽略');

    // Verify user-mapping.json was updated
    const after = JSON.parse(readFileSync(mappingPath, 'utf-8'));
    expect(after['ou_owner'].skipped_versions).toHaveLength(1);
    expect(after['ou_owner'].skipped_versions[0].version).toBe('0.6.4');
  });

  it('patches card with error when entry not in session state', async () => {
    writeFileSync(mappingPath, JSON.stringify({
      'ou_owner': { type: 'pending_new_session' },
    }));

    const client = mockClient();
    await onSkipClick({
      client: client as any,
      openid: 'ou_owner',
      messageId: 'om_xxx',
      targetVersion: '0.6.4',
      mappingPath,
    });

    expect(client.calls).toHaveLength(1);
    const content = JSON.parse(client.calls[0].content);
    expect(content.header.title.content).toContain('Skip 失败');
  });

  it('does not throw when card patch API fails', async () => {
    writeFileSync(mappingPath, JSON.stringify({
      'ou_owner': { type: 'session', sessionUuid: 'abc', casToken: 1 },
    }));

    const client = {
      im: { v1: { message: {
        patch: async () => { throw new Error('Feishu API down'); },
      } } },
    };

    // Should not throw
    await onSkipClick({
      client: client as any,
      openid: 'ou_owner',
      messageId: 'om_xxx',
      targetVersion: '0.6.4',
      mappingPath,
    });
    // user-mapping.json should still be updated (CAS succeeded)
    const after = JSON.parse(readFileSync(mappingPath, 'utf-8'));
    expect(after['ou_owner'].skipped_versions).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/feishu/updater-card.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Write implementation**

Create `src/feishu/updater-card.ts`:

```ts
/**
 * Feishu card builder for upgrade notifications.
 *
 * The `Skip` action is the only interactive button. It writes to
 * user-mapping.json via lifecycle.addSkippedVersion (CAS) and patches
 * the original card to confirm.
 *
 * No "Update" button — v1.1 lesson learned.
 */

import type { LarkClient } from '../feishu/client';  // adjust to actual client import
import { addSkippedVersion } from '../updater/lifecycle';
import { USER_MAPPING_PATH } from '../utils/paths';
import { logger } from '../utils/logger';

export interface SkipClickDeps {
  client: LarkClient;
  openid: string;
  messageId: string;
  targetVersion: string;
  /**
   * Path to user-mapping.json. Defaults to USER_MAPPING_PATH but can be
   * overridden for tests (USER_MAPPING_PATH is a module-load constant
   * computed from $HOME, so changing HOME at runtime has no effect).
   */
  mappingPath?: string;
}

export async function onSkipClick(deps: SkipClickDeps): Promise<void> {
  const mappingPath = deps.mappingPath ?? USER_MAPPING_PATH;
  const ok = addSkippedVersion(mappingPath, deps.openid, deps.targetVersion, {
    maxRetries: 2,
  });

  if (!ok) {
    // Patch card with error
    try {
      await deps.client.im.v1.message.patch({
        message_id: deps.messageId,
        content: JSON.stringify({
          config: { wide_screen_mode: true },
          header: { template: 'red', title: { tag: 'plain_text', content: '❌ Skip 失败' } },
          elements: [
            { tag: 'div', text: { tag: 'plain_text', content: '状态冲突, 请重试 (或运行 cc-linker init-feishu)' } },
          ],
        }),
      });
    } catch (e: any) {
      logger.warn(`Skip patch failed: ${e.message}`);
    }
    return;
  }

  // Success: patch card to "已忽略"
  try {
    await deps.client.im.v1.message.patch({
      message_id: deps.messageId,
      content: JSON.stringify({
        config: { wide_screen_mode: true },
        header: { template: 'green', title: { tag: 'plain_text', content: '✅ 已忽略 v' + deps.targetVersion } },
        elements: [
          { tag: 'div', text: { tag: 'plain_text', content: '30 天内不再提醒此版本' } },
        ],
      }),
    });
  } catch (e: any) {
    logger.warn(`Skip success patch failed: ${e.message}`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/feishu/updater-card.test.ts`
Expected: PASS, 3 tests

- [ ] **Step 5: Commit**

```bash
git add src/feishu/updater-card.ts tests/unit/feishu/updater-card.test.ts
git commit -m "feat(feishu): Skip action handler with CAS + card patch + tests"
```

---

### Task 17: Wire daemon ticker into bot init hook

**Files:**
- Modify: `src/feishu/bot.ts` (or wherever bot init lives — find the equivalent)

- [ ] **Step 1: Find the bot init hook**

Search for the place where the daemon is "ready" after WSClient.connect() and registry.sync():

Run: `grep -rn "WSClient.connect\|registry.sync" src/feishu/ src/runtime/ | head -5`

- [ ] **Step 2: Add updater ticker**

After the existing init code, add:

```ts
import { checkAndNotify, tick, scheduleNextTick } from '../runtime/updater-tick';
import { UPDATE_CHECK_CACHE_PATH } from '../utils/paths';
import { PKG_VERSION } from '../version';
import { resolveRegistryUrl } from '../updater/registry';
import { check as runCheck } from '../updater/check';
import { detectInstallMode } from '../updater/detect-install-mode';
import { getConfig } from '../utils/config';

// In bot init, after WSClient connect + registry sync:

// Build shared deps once (reused by initial tick + 24h scheduler)
const updaterConfig = getConfig<'feishu' | 'cli' | 'none'>('updater.notify_channel', 'feishu');
if (updaterConfig !== 'none') {
  const url = await resolveRegistryUrl(getConfig('updater.registry_url', 'auto'));
  const ownerOpenid = getConfig('feishu_bot.owner_open_id', '');
  const targetOpenid = getConfig<boolean>('updater.test_mode', false)
    ? getConfig('updater.test_openid', 'ou_test')
    : ownerOpenid;

  const tickDeps = {
    cachePath: UPDATE_CHECK_CACHE_PATH,
    checkImpl: () => runCheck({
      current: PKG_VERSION,
      cachePath: UPDATE_CHECK_CACHE_PATH,
      url,
      ttlMs: 24 * 60 * 60 * 1000,
    }),
    sendCard: async (payload: { header: string; body: string; actions: any[] }) => {
      if (!targetOpenid) return;
      await feishuClient.im.v1.message.create({
        params: { receive_id_type: 'open_id' },
        data: {
          receive_id: targetOpenid,
          msg_type: 'interactive',
          content: JSON.stringify({
            config: { wide_screen_mode: true },
            header: { template: 'blue', title: { tag: 'plain_text', content: payload.header } },
            elements: [
              { tag: 'div', text: { tag: 'lark_md', content: payload.body } },
              {
                tag: 'action',
                actions: payload.actions.map((a: any) => {
                  if (a.type === 'url') {
                    return { tag: 'button', text: { tag: 'plain_text', content: a.text }, type: 'primary', url: a.url };
                  }
                  return {
                    tag: 'button',
                    text: { tag: 'plain_text', content: a.text },
                    type: 'default',
                    value: a.value,
                  };
                }),
              },
            ],
          }),
        },
      });
    },
    log: (line: string) => logger.info(line),
    config: { registry_url: 'auto', notify_channel: updaterConfig },
    detectMode: async () => detectInstallMode({
      globalNodeModules: '/usr/local/lib/node_modules',  // heuristic; can be improved
      argv1: process.argv[1] ?? '',
    }),
  };

  // First tick after initial delay, then schedule 24h chain
  const initialDelayMs = getConfig<number>('updater.notify_delay_ms', 30000);
  const intervalMs = getConfig<number>('updater.check_interval_hours', 24) * 60 * 60 * 1000;
  const onError = (e: Error) => logger.warn(`updater tick failed: ${e.message}`);

  setTimeout(() => {
    tick(tickDeps).catch(onError);
    // Then schedule the 24h chain (NOT setInterval — setTimeout chain for clean shutdown)
    scheduleNextTick(tickDeps, intervalMs, onError);
  }, initialDelayMs);
}
```

(Adjust import paths and `feishuClient` variable name to match the actual codebase.)

(Adjust import paths to match the actual codebase. The `getConfig` helper is imported at the top of the file.)

- [ ] **Step 3: Verify typecheck passes**

Run: `bun run typecheck`
Expected: exit 0

- [ ] **Step 4: Commit**

```bash
git add src/feishu/bot.ts
git commit -m "feat(feishu): wire 24h upgrade ticker into bot init (with notify_delay_ms defer)"
```

---

### Task 18: Integration test (fake registry end-to-end)

**Files:**
- Create: `tests/integration/upgrade-flow.test.ts`

- [ ] **Step 1: Write the integration test**

Create `tests/integration/upgrade-flow.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { check } from '../../src/updater/check';
import { resolveRegistryUrl } from '../../src/updater/registry';
import { formatBanner } from '../../src/updater/notify';
import { checkAndNotify } from '../../src/runtime/updater-tick';

let tmpDir: string;
let cachePath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'upgrade-integration-'));
  cachePath = join(tmpDir, '.update-check.json');
});

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('integration: upgrade flow', () => {
  it('CLI: stable update → update_available → banner', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ version: '0.6.4' }), {
        status: 200,
        headers: { etag: 'v1' },
      })) as any;

    const info = await check({
      current: '0.6.3',
      cachePath,
      url: 'https://registry.npmjs.org/cc-linker/latest',
      fetchImpl,
      ttlMs: 0,
    });
    expect(info.status).toBe('update_available');
    expect(info.latest).toBe('0.6.4');

    const banner = formatBanner(info);
    expect(banner).toContain('cc-linker upgrade');
  });

  it('CLI: pre-release → prerelease_only → banner explains', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ version: '0.6.4-beta.1' }), {
        status: 200,
      })) as any;

    const info = await check({
      current: '0.6.3',
      cachePath,
      url: 'https://registry.npmjs.org/cc-linker/latest',
      fetchImpl,
      ttlMs: 0,
    });
    expect(info.status).toBe('prerelease_only');
    expect(formatBanner(info)).toContain('pre-release');
  });

  it('Daemon: update_available with feishu channel → card sent', async () => {
    let sentPayload: any = null;
    const result = await checkAndNotify({
      cachePath,
      checkImpl: async () => ({
        status: 'update_available',
        current: '0.6.3', latest: '0.6.4', checkedAt: Date.now(),
      }),
      sendCard: async (payload) => { sentPayload = payload; },
      config: { registry_url: 'auto', notify_channel: 'feishu' },
      detectMode: async () => 'npm_global',
    });
    expect(result.action).toBe('sent');
    expect(sentPayload.body).toContain('cc-linker upgrade');
  });

  it('Daemon: standalone_binary user → card shows download URL', async () => {
    let sentPayload: any = null;
    await checkAndNotify({
      cachePath,
      checkImpl: async () => ({
        status: 'update_available',
        current: '0.6.3', latest: '0.6.4', checkedAt: Date.now(),
      }),
      sendCard: async (payload) => { sentPayload = payload; },
      config: { registry_url: 'auto', notify_channel: 'feishu' },
      detectMode: async () => 'standalone_binary',
    });
    expect(sentPayload.body).toContain('standalone binary');
    expect(sentPayload.body).toContain('github.com/yujuntea/cc-linker/releases/tag/v0.6.4');
  });

  it('Cache TTL: second call within 24h uses cache', async () => {
    let fetchCount = 0;
    const fetchImpl = (async () => {
      fetchCount++;
      return new Response(JSON.stringify({ version: '0.6.4' }), { status: 200 });
    }) as any;

    const first = await check({
      current: '0.6.3', cachePath, url: 'x', fetchImpl, ttlMs: 0,
    });
    expect(first.status).toBe('update_available');
    expect(fetchCount).toBe(1);

    const second = await check({
      current: '0.6.3', cachePath, url: 'x', fetchImpl, ttlMs: 24 * 60 * 60 * 1000,
    });
    expect(second.status).toBe('update_available');
    expect(fetchCount).toBe(1);  // not incremented
  });

  it('Registry mirror: auto mode reads npm config', async () => {
    const url = await resolveRegistryUrl('auto', async () => 'https://registry.npmmirror.com/');
    expect(url).toBe('https://registry.npmmirror.com/cc-linker/latest');
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `bun test tests/integration/upgrade-flow.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 3: Commit**

```bash
git add tests/integration/upgrade-flow.test.ts
git commit -m "test(integration): upgrade flow end-to-end (CLI + daemon + card)"
```

---

### Task 19: Run full test suite + typecheck

**Files:** none (verification only)

- [ ] **Step 1: Run all tests**

Run: `bun test`
Expected: all tests pass (target: 55+ tests across 10 files)

Test count by file (target):
- types: 8
- cache: 5
- registry: 4
- check: 7
- notify: 10
- detect-install-mode: 4
- lifecycle: 7
- upgrade (buildUpgradePlan): 5
- updater-tick (checkAndNotify + tick): 7
- feishu updater-card (Skip): 3
- integration upgrade-flow: 6
**Total: ~66**

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: exit 0

- [ ] **Step 3: Run build**

Run: `bun run build:npm`
Expected: build succeeds, `dist/cli.js` is created

- [ ] **Step 4: Verify CLI commands work**

Run: `bun run dev upgrade --help`
Expected: prints help

Run: `bun run dev upgrade --check`
Expected: prints banner (or "已是最新" / "无法检查")

- [ ] **Step 5: Commit (if any changes)**

```bash
git status
# If any final tweaks, commit them
```

---

### Task 20: Update README + CHANGELOG

**Files:**
- Modify: `README.md` (add Auto-upgrade section)
- Modify: `CHANGELOG.md` (add [Unreleased] entry)

- [ ] **Step 1: Add Auto-upgrade section to README**

In `README.md`, find the section about CLI commands and add (or append a new section "## Auto-upgrade"):

```markdown
## Auto-upgrade

cc-linker can notify you when a new version is available and let you upgrade with one command.

### Configuration

Add to `~/.cc-linker/config.toml`:

```toml
[updater]
enabled = true                  # default: true
notify_channel = "feishu"       # feishu | cli | none
notify_delay_ms = 30000         # delay after bot ready before sending card
check_interval_hours = 24       # 24h ticker
test_mode = false               # set true to send cards to test_openid
test_openid = "ou_test"
```

### Upgrade

```bash
cc-linker upgrade --check       # show update status, exit
cc-linker upgrade --dry-run     # show what would be installed
cc-linker upgrade               # upgrade to latest
cc-linker upgrade --to 0.6.2    # install specific version
cc-linker upgrade --yes         # skip confirmation
```

### What you get in Feishu

When a new stable version is published to npm, the daemon sends a card like:

```
🆕 cc-linker 有新版本
当前 v0.6.3 → v0.6.4

升级命令:
cc-linker upgrade

[View changelog] [Skip 30 天]
```

Click "Skip" to ignore this version for 30 days.

### How it works

- Daemon checks npm every 24h (and on startup) for new versions
- Sends a static notification card (no auto-upgrade)
- Pre-release versions (e.g. `0.6.4-beta.1`) are **never** auto-notified, even if accidentally published to `latest`
- `cc-linker upgrade` calls `npm i -g cc-linker@latest` and then `cc-linker restart` to pick up the new binary
- Standalone binary users get a "download new binary" link instead
```

- [ ] **Step 2: Add CHANGELOG entry**

At the top of `CHANGELOG.md`, add a new section (the existing format uses `## [version] - date`):

```markdown
## [Unreleased]

### Added

- **Auto-upgrade support** (`cc-linker upgrade`)
  - `cc-linker upgrade --check` / `cc-linker upgrade` / `cc-linker upgrade --dry-run` / `cc-linker upgrade --to <version>`
  - Daemon checks npm every 24h and sends static Feishu notification card on new stable version
  - Pre-release versions suppressed automatically
  - `Skip 30 天` button on notification card
  - `cc-linker restart` now uses `launchctl unload/load` on macOS launchd to force binary re-resolution
  - Configuration via `[updater]` section in `~/.cc-linker/config.toml`

- [ ] **Step 3: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: README + CHANGELOG for auto-upgrade v1.2"
```

---

## Done

When all 20 tasks are checked off:

- 5 new modules (`src/updater/`, `src/cli/commands/upgrade.ts`, `src/runtime/updater-tick.ts`, `src/feishu/updater-card.ts`)
- 6 modified files (`src/utils/paths.ts`, `src/utils/config.ts`, `src/index.ts`, `src/cli/commands/status.ts`, `src/cli/commands/restart.ts`, `src/feishu/bot.ts`)
- 1 new dep (`semver@^7.6.0`)
- ~1570 LOC total (incl. tests)
- 66 test cases across 10 files (5 updater core + 2 CLI + 1 Skip handler + 1 integration + 1 status)
- README + CHANGELOG updated

Key invariants enforced by tests:
- Pre-release guard returns `prerelease_only` and never notifies
- 24h dedup window preserved across `cc-linker upgrade` (force-fetch) calls
- `check()` does NOT clear `notifiedAt` (so daemon doesn't re-send cards after CLI upgrade)
- `scheduleNextTick` is wired in bot init (so 24h ticker actually runs)
- `onSkipClick` has `mappingPath` parameter (so tests can pass tmp path)
- `tick` is imported in test file (so typecheck passes)
- README markdown has no broken backslash escapes

Ready for α-stage dogfood (developer self-use + 1-2 internal testers) before γ-stage public rollout.
