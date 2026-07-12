# Wrapper Bypass Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix `cc-linker-proxy` wrapper so it doesn't silently bypass img-proxy when user's shell has `ANTHROPIC_BASE_URL` set to a non-proxy URL (e.g., inherited from parent claude session snapshot).

**Architecture:** Make `resolveProxyByUpstream` idempotent (return input unchanged for loopback URLs). Rewrite wrapper function to call resolve first, distinguish "is proxy URL" (preserve user choice) from "is upstream URL" (rewrite + warn) from "is unknown URL" (fall back to settings.json + warn).

**Tech Stack:** TypeScript (Bun), bash (zsh-compatible), bun:test, Node `node -e` for JSON in test stubs.

**Spec:** `docs/superpowers/specs/2026-07-10-wrapper-bypass-fix-design.md`

## Global Constraints

- Bun runtime only — never Node.js tools
- Bash / zsh only (wrapper target). Fish not supported.
- Test files use `bun:test`. Integration tests use `spawnSync('bash', ...)` + `mkdtempSync`.
- All `$` in JS template literals for shell scripts must be escaped as `\$`
- ASCII `->` in shell warn output (avoid UTF-8 `→` for locale safety)
- All commits in this plan use Conventional Commits format: `feat/fix/refactor/test(scope): message`

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/img-proxy/routes.ts` | Upstream ↔ proxy URL mapping + idempotency | Modify: add `isProxyUrl`, modify `resolveProxyByUpstream` |
| `src/img-proxy/wrapper.ts` | Generate shell wrapper function block | Modify: rewrite `generateWrapperBlock` |
| `tests/unit/img-proxy/routes.test.ts` | Unit tests for routes module | Modify: add `isProxyUrl` + idempotent cases |
| `tests/unit/img-proxy/wrapper.test.ts` | Unit tests for wrapper module | Modify: update assertions for new behavior |
| `tests/integration/wrapper-bash.test.ts` | End-to-end bash + wrapper tests | Create: 6 scenarios with stub binaries |
| `docs/superpowers/plans/2026-07-04-img-proxy-acceptance-tests.md` | Acceptance test doc | Modify: update E7 wording |

---

## Task 1: Add `isProxyUrl` to routes.ts (TDD)

**Files:**
- Modify: `src/img-proxy/routes.ts:79-81` (add `isProxyUrl` export below `resolveProxyByUpstream`)
- Modify: `tests/unit/img-proxy/routes.test.ts:153-158` (add `describe('isProxyUrl')` block)

**Interfaces:**
- Produces: `export function isProxyUrl(url: string): boolean` — true if URL matches loopback form (http/https + 127.0.0.1/localhost/[::1] + optional port + path)

- [ ] **Step 1: Write failing tests for `isProxyUrl`**

First, modify the existing import block at the top of `tests/unit/img-proxy/routes.test.ts` (lines 5-12) to add `isProxyUrl`:

```typescript
import {
  addRoute,
  getUpstreamByAlias,
  resolveProxyByUpstream,
  loadRoutes,
  removeRoute,
  normalizeUrlForCompare,
  isProxyUrl,  // ← add this
} from '../../../src/img-proxy/routes';
```

Then add a new `describe` block (place after the existing `describe('resolveProxyByUpstream 容忍 URL 小差异(Fix I-1)', ...)` block at line 158):

```typescript
describe('isProxyUrl', () => {
  test('http://127.0.0.1:8765/foo 视为 proxy URL', () => {
    expect(isProxyUrl('http://127.0.0.1:8765/foo')).toBe(true);
  });

  test('http://localhost:8765/foo 视为 proxy URL', () => {
    expect(isProxyUrl('http://localhost:8765/foo')).toBe(true);
  });

  test('http://[::1]:8765/foo 视为 proxy URL (IPv6 loopback)', () => {
    expect(isProxyUrl('http://[::1]:8765/foo')).toBe(true);
  });

  test('https://127.0.0.1:8765/foo 视为 proxy URL (HTTPS)', () => {
    expect(isProxyUrl('https://127.0.0.1:8765/foo')).toBe(true);
  });

  test('http://127.0.0.1:9999/foo 视为 proxy URL (任意 port)', () => {
    expect(isProxyUrl('http://127.0.0.1:9999/foo')).toBe(true);
  });

  test('http://127.0.0.1:8765 (无 path) 视为 proxy URL', () => {
    expect(isProxyUrl('http://127.0.0.1:8765')).toBe(true);
  });

  test('http://192.168.1.5:8765/foo 非 proxy URL (机器 IP)', () => {
    expect(isProxyUrl('http://192.168.1.5:8765/foo')).toBe(false);
  });

  test('http://0.0.0.0:8765/foo 非 proxy URL (server bind addr)', () => {
    expect(isProxyUrl('http://0.0.0.0:8765/foo')).toBe(false);
  });

  test('https://api.anthropic.com 非 proxy URL', () => {
    expect(isProxyUrl('https://api.anthropic.com')).toBe(false);
  });

  test('空字符串非 proxy URL', () => {
    expect(isProxyUrl('')).toBe(false);
  });

  test('malformed URL 非 proxy URL', () => {
    expect(isProxyUrl('not a url')).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/img-proxy/routes.test.ts --test-name-pattern="isProxyUrl"`
Expected: FAIL — `isProxyUrl` not exported from `routes.ts` (import error)

- [ ] **Step 3: Implement `isProxyUrl`**

In `src/img-proxy/routes.ts`, after the existing `listRoutes` function (line 153), add:

```typescript
/** Detect "is this URL a local proxy URL?"
 *  Matches http(s)://<loopback>[:<any port>][/...] or just http(s)://<loopback>[:<port>]
 *  loopback 候选: 127.0.0.1 / localhost / [::1]
 *  port 不限定 (user 改过 config port 时 URL 仍能识别, 同一 shell 内的 wrapper heuristic 对齐)
 *
 *  Risk: 同一 loopback 上的别的本地服务也会被识别为 proxy URL.
 *  Mitigation: user 想用别的本地服务应直接 `claude`,不走 cc-linker-proxy.
 */
export function isProxyUrl(url: string): boolean {
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/.test(url);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/img-proxy/routes.test.ts --test-name-pattern="isProxyUrl"`
Expected: PASS — all 11 cases pass

- [ ] **Step 5: Commit**

```bash
git add src/img-proxy/routes.ts tests/unit/img-proxy/routes.test.ts
git commit -m "feat(img-proxy): add isProxyUrl for loopback URL detection"
```

---

## Task 2: Make `resolveProxyByUpstream` idempotent (TDD)

**Files:**
- Modify: `src/img-proxy/routes.ts:137-151` (add idempotent check at top of `resolveProxyByUpstream`)
- Modify: `tests/unit/img-proxy/routes.test.ts:41-63` (add idempotent cases)

**Interfaces:**
- Consumes: `isProxyUrl(url)` from Task 1
- Behavior change: returns input unchanged (instead of null) when `isProxyUrl(input) === true`

- [ ] **Step 1: Write failing tests for idempotent behavior**

In `tests/unit/img-proxy/routes.test.ts`, add to the existing `describe('resolveProxyByUpstream(新函数)')` block (after the `'空 routes 返回 null'` test on line 60):

```typescript
  test('input 已是 proxy URL (127.0.0.1) → 原样返 (idempotent)', () => {
    expect(resolveProxyByUpstream(routesPath, 8765, '127.0.0.1', 'http://127.0.0.1:8765/glm-5.2')).toBe('http://127.0.0.1:8765/glm-5.2');
  });

  test('input 已是 proxy URL (localhost) → 原样返', () => {
    expect(resolveProxyByUpstream(routesPath, 8765, '127.0.0.1', 'http://localhost:8765/kimi')).toBe('http://localhost:8765/kimi');
  });

  test('input 已是 proxy URL ([::1] IPv6) → 原样返', () => {
    expect(resolveProxyByUpstream(routesPath, 8765, '127.0.0.1', 'http://[::1]:8765/foo')).toBe('http://[::1]:8765/foo');
  });

  test('input 是 proxy URL 但 port 与 config 不同 → 仍原样返 (loose match)', () => {
    // config port=8765, 但 input port=9999 — user 改过 port, 尊重其选择
    expect(resolveProxyByUpstream(routesPath, 8765, '127.0.0.1', 'http://127.0.0.1:9999/foo')).toBe('http://127.0.0.1:9999/foo');
  });

  test('input 是 proxy URL 且 alias 同 upstream 有多个 routes → 保留 user 选择, 不重写到默认 alias', () => {
    // 同一 upstream 有两条 routes (glm-5.2 + glm-5.2-back), user 显式选 glm-5.2
    // idempotent 应当保留 glm-5.2, 不重写为 glm-5.2-back
    await addRoute(routesPath, 'glm-5.2', 'https://api.x.com', '/tmp/x.json');
    await addRoute(routesPath, 'glm-5.2-back', 'https://api.x.com', '/tmp/x.json');
    expect(resolveProxyByUpstream(routesPath, 8765, '127.0.0.1', 'http://127.0.0.1:8765/glm-5.2')).toBe('http://127.0.0.1:8765/glm-5.2');
  });

  test('input 是 machine IP 而非 loopback → 不视作 proxy URL, 走 routes 查表', async () => {
    await addRoute(routesPath, 'foo', 'http://192.168.1.5:8765/foo', '/tmp/foo.json');
    expect(resolveProxyByUpstream(routesPath, 8765, '127.0.0.1', 'http://192.168.1.5:8765/foo')).toBe('http://127.0.0.1:8765/foo');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/img-proxy/routes.test.ts --test-name-pattern="idempotent|proxy URL"`
Expected: FAIL — first test fails because `resolveProxyByUpstream` returns null for `http://127.0.0.1:8765/glm-5.2` (no route matches). Other tests fail similarly.

- [ ] **Step 3: Add idempotent check to `resolveProxyByUpstream`**

In `src/img-proxy/routes.ts`, modify the `resolveProxyByUpstream` function (line 137). Replace the function body with:

```typescript
export function resolveProxyByUpstream(
  path: string,
  port: number,
  hostname: string,
  upstream: string
): string | null {
  // Idempotent: 已是 proxy URL (本地 loopback) → 原样返, 保留 user 显式 alias 选择
  // (防止 user 选过的 alias 被 routes 查表重写到 "默认" alias — E7 invariant)
  if (isProxyUrl(upstream)) {
    return upstream;
  }
  // 否则按 upstream URL 查 routes (现有逻辑)
  const table = loadRoutes(path);
  const query = normalizeUrlForCompare(upstream);
  for (const [alias, entry] of Object.entries(table.routes)) {
    if (normalizeUrlForCompare(entry.upstream) === query) {
      return `http://${hostname}:${port}/${alias}`;
    }
  }
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/img-proxy/routes.test.ts --test-name-pattern="resolveProxyByUpstream"`
Expected: PASS — all idempotent cases pass, existing cases still pass

- [ ] **Step 5: Run full test suite to verify no regression**

Run: `bun test tests/unit/img-proxy/`
Expected: PASS — all routes.test.ts tests pass

- [ ] **Step 6: Commit**

```bash
git add src/img-proxy/routes.ts tests/unit/img-proxy/routes.test.ts
git commit -m "feat(img-proxy): make resolveProxyByUpstream idempotent for loopback URLs"
```

---

## Task 3: Integration test harness scaffolding

**Files:**
- Create: `tests/integration/wrapper-bash.test.ts`

**Purpose:** Set up test infrastructure (stub binaries, harness) without test cases yet. Verify it compiles and runs.

- [ ] **Step 1: Create the test file with stubs and harness**

Create `tests/integration/wrapper-bash.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { generateWrapperBlock } from '../../src/img-proxy/wrapper';

let tmpDir: string;
let rcFile: string;
let fakeClaudeLog: string;

// Stub `cc-linker`: handles `img-proxy current-url` + `img-proxy resolve <url>`
// Settings URL is passed via FAKE_SETTINGS_URL env var (pre-computed by test) —
// avoids JSON parsing in shell (no node/jq dependency).
// Stub `claude`: captures ANTHROPIC_BASE_URL + args.
const STUB_CCLINKER = `#!/bin/bash
case "$1 $2" in
  "img-proxy current-url")
    echo "$FAKE_SETTINGS_URL"
    ;;
  "img-proxy resolve")
    url="$3"
    case "$url" in
      # idempotent: already proxy URL -> return unchanged
      http://127.0.0.1:*|http://localhost:*)
        echo "$url"
        ;;
      # mock: this upstream is installed as byte-agent-glm
      https://ark.cn-beijing.volces.com/api/plan)
        echo "http://127.0.0.1:8765/byte-agent-glm"
        ;;
      # mock: not installed -> return empty (triggers fall back)
      https://api.minimaxi.com/anthropic)
        ;;
      *) ;;
    esac
    ;;
esac
`;

const STUB_CLAUDE = `#!/bin/bash
{
  echo "ENV:ANTHROPIC_BASE_URL=$ANTHROPIC_BASE_URL"
  echo "ARGS:$@"
  echo "---"
} >> "$FAKE_CLAUDE_LOG"
`;

function runWrapper(env: Record<string, string>, settingsUrl: string): { stdout: string; stderr: string; exitCode: number; claudeLog: string } {
  const result = spawnSync('bash', ['-c', `source ${rcFile} && cc-linker-proxy --version`], {
    env: {
      ...process.env,
      ...env,
      FAKE_SETTINGS_URL: settingsUrl,
      FAKE_CLAUDE_LOG: fakeClaudeLog,
      PATH: `${tmpDir}:${process.env.PATH}`,
    },
    encoding: 'utf-8',
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? -1,
    claudeLog: readFileSync(fakeClaudeLog, 'utf-8').trim(),
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'wrapper-int-'));
  rcFile = join(tmpDir, '.zshrc');
  fakeClaudeLog = join(tmpDir, 'claude.log');

  writeFileSync(join(tmpDir, 'cc-linker'), STUB_CCLINKER);
  chmodSync(join(tmpDir, 'cc-linker'), 0o755);
  writeFileSync(join(tmpDir, 'claude'), STUB_CLAUDE);
  chmodSync(join(tmpDir, 'claude'), 0o755);

  writeFileSync(rcFile, generateWrapperBlock());
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('cc-linker-proxy integration (scaffolding)', () => {
  test('harness: stubs reachable, wrapper exits cleanly on empty settings', () => {
    // Empty settings URL → wrapper fails fast ("找不到当前 provider URL")
    // exit 1 + stderr contains the message + claude NOT called (log empty)
    const { exitCode, stderr, claudeLog } = runWrapper({}, '');
    expect(exitCode).toBe(1);
    expect(stderr).toContain('找不到当前 provider URL');
    expect(claudeLog).toBe('');
  });
});
```

**Note on stub design**:
- `FAKE_SETTINGS_URL` env var pre-computed by test → stub just `echo` it. No node/jq dependency.
- `FAKE_CLAUDE_LOG` env var points stub `claude`'s log file. No fs path coupling in stub.
- Stub case pattern uses standard `http://host:*` glob (no `[::1]` — bash would interpret `[::1]` as char class, and no IPv6 in test scenarios).
- JS template literal interpolation: only `${...}` triggers JS interpolation. `$identifier` (no braces) is literal. So `$FAKE_SETTINGS_URL` etc. pass through to bash unchanged.

- [ ] **Step 2: Run test to verify harness works**

Run: `bun test tests/integration/wrapper-bash.test.ts`
Expected: PASS — smoke test verifies exit code 1 + stderr message + empty claudeLog. Confirms wrapper invokes stubs, source'ing rcFile works, PATH override finds stubs.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/wrapper-bash.test.ts
git commit -m "test(img-proxy): integration test harness for cc-linker-proxy wrapper"
```

---

## Task 4: BUG FIX integration test + wrapper rewrite (TDD)

**Files:**
- Modify: `tests/integration/wrapper-bash.test.ts` (replace smoke test with bug fix scenario)
- Modify: `src/img-proxy/wrapper.ts:22-48` (rewrite `generateWrapperBlock`)
- Modify: `tests/unit/img-proxy/wrapper.test.ts:41-45` (update "包含递归防护" assertion)

**Goal:** Write failing test that reproduces user's bug (env=stale URL bypasses proxy), then rewrite wrapper to fix.

- [ ] **Step 1: Write failing BUG FIX integration test**

Replace the smoke test in `tests/integration/wrapper-bash.test.ts`:

```typescript
describe('cc-linker-proxy integration: BUG FIX (env=stale non-proxy URL)', () => {
  test('env=https://api.minimaxi.com/anthropic + settings.json=ark → fall back + warn + claude sees proxy URL', () => {
    const { stderr, exitCode, claudeLog } = runWrapper(
      { ANTHROPIC_BASE_URL: 'https://api.minimaxi.com/anthropic' },
      { env: { ANTHROPIC_BASE_URL: 'https://ark.cn-beijing.volces.com/api/plan' } },
    );

    // Exit success (claude called)
    expect(exitCode).toBe(0);

    // Stderr warn mentions fall back
    expect(stderr).toContain('fall back');

    // claude received the proxy URL (NOT the stale minimaxi URL)
    expect(claudeLog).toContain('ENV:ANTHROPIC_BASE_URL=http://127.0.0.1:8765/byte-agent-glm');
    expect(claudeLog).not.toContain('minimaxi');

    // claude called with --version (passed through)
    expect(claudeLog).toContain('ARGS:--version');
  });
});
```

- [ ] **Step 2: Run test to verify it fails (with current wrapper)**

Run: `bun test tests/integration/wrapper-bash.test.ts`
Expected: FAIL — current wrapper's guard fires on any non-empty env, short-circuits to `command claude`, claude sees `https://api.minimaxi.com/anthropic` (NOT proxy URL), no "fall back" in stderr. Test fails on `expect(stderr).toContain('fall back')`.

- [ ] **Step 3: Update unit test assertions for new wrapper behavior**

In `tests/unit/img-proxy/wrapper.test.ts`, replace the test at line 41-45:

```typescript
  test('包含递归防护 (resolve 返同 URL → 直 exec, E7 invariant)', () => {
    const block = generateWrapperBlock();
    expect(block).toMatch(/ANTHROPIC_BASE_URL/);
    expect(block).toContain('command claude');
    // 新版 idempotent guard: 比较 resolve 结果与输入
    expect(block).toMatch(/\$resolved.*=.*\$env_url/);
  });
```

Add new tests in the same `describe('generateWrapperBlock')` block:

```typescript
  test('包含 stderr warn (env override → "改写")', () => {
    const block = generateWrapperBlock();
    expect(block).toContain('改写');
  });

  test('包含 fall back 消息 (env unresolvable)', () => {
    const block = generateWrapperBlock();
    expect(block).toContain('fall back');
  });
```

- [ ] **Step 4: Run wrapper unit tests to verify they fail (current wrapper doesn't match new semantics)**

Run: `bun test tests/unit/img-proxy/wrapper.test.ts --test-name-pattern="递归防护|stderr warn|fall back"`
Expected: FAIL — current wrapper has no "改写" or "fall back" message, no `$resolved = $env_url` pattern.

- [ ] **Step 5: Rewrite `generateWrapperBlock`**

In `src/img-proxy/wrapper.ts`, replace the entire `generateWrapperBlock` function (line 22-48) with:

```typescript
export function generateWrapperBlock(): string {
  return `${WRAPPER_START_MARKER}
cc-linker-proxy() {
  local env_url resolved real_url proxy_url

  env_url="\${ANTHROPIC_BASE_URL:-}"

  # Path 1: env set
  if [ -n "\$env_url" ]; then
    resolved="\$(command cc-linker img-proxy resolve "\$env_url")"
    if [ -n "\$resolved" ] && [ "\$resolved" = "\$env_url" ]; then
      # 已是 proxy URL -> user 显式选过, 直接 exec (E7 invariant: URL 不变)
      command claude "\$@"
      return \$?
    fi
    if [ -n "\$resolved" ]; then
      # env 是 upstream URL 但已装 -> 改写为 proxy URL + warn
      echo "cc-linker-proxy: ANTHROPIC_BASE_URL=\$env_url -> proxy=\$resolved (改写)" >&2
      ANTHROPIC_BASE_URL="\$resolved" command claude "\$@"
      return \$?
    fi
    # env 解析失败 (陌生 URL / stale inherited) -> fall back to settings.json
    echo "cc-linker-proxy: env ANTHROPIC_BASE_URL=\$env_url 解析失败, fall back 到 settings.json" >&2
  fi

  # Path 2: env unset OR fall back -> read settings.json
  real_url="\$(command cc-linker img-proxy current-url)"
  if [ -z "\$real_url" ]; then
    echo "cc-linker-proxy: 找不到当前 provider URL" >&2
    echo "  检查 ~/.claude/settings.json 是否含 env.ANTHROPIC_BASE_URL" >&2
    return 1
  fi

  proxy_url="\$(command cc-linker img-proxy resolve "\$real_url")"
  if [ -z "\$proxy_url" ]; then
    echo "cc-linker-proxy: \$real_url 没在 img-proxy 里" >&2
    echo "  hint: cc-linker img-proxy install" >&2
    return 1
  fi

  ANTHROPIC_BASE_URL="\$proxy_url" command claude "\$@"
}
${WRAPPER_END_MARKER}
`;
}
```

- [ ] **Step 6: Run integration test to verify it passes**

Run: `bun test tests/integration/wrapper-bash.test.ts`
Expected: PASS — BUG FIX test passes. claude gets proxy URL, warn present, no minimaxi.

- [ ] **Step 7: Run wrapper unit tests to verify they pass**

Run: `bun test tests/unit/img-proxy/wrapper.test.ts`
Expected: PASS — all assertions (including new "改写", "fall back", `$resolved = $env_url`) pass.

- [ ] **Step 8: Run full img-proxy test suite to verify no regression**

Run: `bun test tests/unit/img-proxy/ tests/integration/wrapper-bash.test.ts`
Expected: PASS — all routes, wrapper, and integration tests pass

- [ ] **Step 9: Commit**

```bash
git add src/img-proxy/wrapper.ts tests/unit/img-proxy/wrapper.test.ts tests/integration/wrapper-bash.test.ts
git commit -m "fix(img-proxy): wrapper falls back to settings.json on stale/non-proxy env URL"
```

---

## Task 5: E7 + edge case integration tests

**Files:**
- Modify: `tests/integration/wrapper-bash.test.ts` (add 5 more test cases)

**Goal:** Verify wrapper behavior for all documented scenarios. These tests pass with the new wrapper from Task 4 (regression coverage).

- [ ] **Step 1: Add E7 test (env=proxy URL preserved)**

Add to `tests/integration/wrapper-bash.test.ts`:

```typescript
describe('cc-linker-proxy integration: scenarios', () => {
  test('E7: env=proxy URL -> claude sees same URL, no warn', () => {
    const { stderr, exitCode, claudeLog } = runWrapper(
      { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8765/glm-5.2' },
      { env: {} },  // settings.json irrelevant here
    );

    expect(exitCode).toBe(0);
    // No "改写" or "fall back" warn (URL preserved)
    expect(stderr).not.toContain('改写');
    expect(stderr).not.toContain('fall back');
    // claude got the same proxy URL
    expect(claudeLog).toContain('ENV:ANTHROPIC_BASE_URL=http://127.0.0.1:8765/glm-5.2');
  });

  test('scenario 1: env unset + settings.json upstream -> claude sees proxy URL, no warn', () => {
    const { stderr, exitCode, claudeLog } = runWrapper(
      {},
      { env: { ANTHROPIC_BASE_URL: 'https://ark.cn-beijing.volces.com/api/plan' } },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toBe('');  // no warn
    expect(claudeLog).toContain('ENV:ANTHROPIC_BASE_URL=http://127.0.0.1:8765/byte-agent-glm');
  });

  test('scenario 5: env=installed upstream URL -> claude sees proxy URL, warn 改写', () => {
    const { stderr, exitCode, claudeLog } = runWrapper(
      { ANTHROPIC_BASE_URL: 'https://ark.cn-beijing.volces.com/api/plan' },
      { env: {} },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toContain('改写');
    expect(claudeLog).toContain('ENV:ANTHROPIC_BASE_URL=http://127.0.0.1:8765/byte-agent-glm');
    expect(claudeLog).not.toContain('ark.cn-beijing');  // upstream URL not leaked
  });

  test('scenario 4: env=unknown URL + settings.json empty -> wrapper error, claude not called', () => {
    const { stderr, exitCode, claudeLog } = runWrapper(
      { ANTHROPIC_BASE_URL: 'https://api.minimaxi.com/anthropic' },
      { env: {} },  // settings.json has no URL
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain('fall back');  // env unresolvable -> fall back attempted
    expect(stderr).toContain('找不到当前 provider URL');  // settings also empty
    expect(claudeLog).toBe('');  // claude NOT called
  });

  test('scenario 6: env=proxy URL with non-default port -> preserved (loose port match)', () => {
    const { stderr, exitCode, claudeLog } = runWrapper(
      { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9999/glm-5.2' },
      { env: {} },
    );

    expect(exitCode).toBe(0);
    expect(stderr).not.toContain('改写');
    expect(claudeLog).toContain('ENV:ANTHROPIC_BASE_URL=http://127.0.0.1:9999/glm-5.2');
  });

  test('scenario: env=localhost proxy URL -> preserved', () => {
    const { stderr, exitCode, claudeLog } = runWrapper(
      { ANTHROPIC_BASE_URL: 'http://localhost:8765/qwen-deepseek' },
      { env: {} },
    );

    expect(exitCode).toBe(0);
    expect(stderr).not.toContain('改写');
    expect(claudeLog).toContain('ENV:ANTHROPIC_BASE_URL=http://localhost:8765/qwen-deepseek');
  });
});
```

- [ ] **Step 2: Run integration tests**

Run: `bun test tests/integration/wrapper-bash.test.ts`
Expected: PASS — all 6 integration tests pass (5 new + 1 BUG FIX from Task 4)

- [ ] **Step 3: Run full test suite**

Run: `bun test tests/unit/img-proxy/ tests/integration/wrapper-bash.test.ts`
Expected: PASS — all tests pass

- [ ] **Step 4: Commit**

```bash
git add tests/integration/wrapper-bash.test.ts
git commit -m "test(img-proxy): integration tests for wrapper scenarios (E7 + edge cases)"
```

---

## Task 6: Update E7 acceptance test doc

**Files:**
- Modify: `docs/superpowers/plans/2026-07-04-img-proxy-acceptance-tests.md:594-600`

**Goal:** Update E7 wording to reflect new wrapper behavior (resolve IS called, but result is unchanged for proxy URL input).

- [ ] **Step 1: Update E7 test description**

In `docs/superpowers/plans/2026-07-04-img-proxy-acceptance-tests.md`, find `### 10.5 E7:递归 wrapper 防护` (line 594). Replace the section with:

```markdown
### 10.5 E7:wrapper idempotent (env=proxy URL 时 URL 不变)

```bash
# 设 ANTHROPIC_BASE_URL 已设为 proxy URL,跑 wrapper
ANTHROPIC_BASE_URL=http://127.0.0.1:8765/glm-5.2 cc-linker-proxy --version 2>&1 | head -3
# 期望:不报错,resolve 返同 URL,直接 exec claude(ANTHROPIC_BASE_URL 还是 8765)
# 注:resolve 实际被调用,但 result 与 input 相同(走 idempotent 路径),URL 不被改写
```

**Regression 测试**: 此测试在新 wrapper(2026-07-10)前后行为一致 — user 显式选的 proxy URL 永远被尊重。
```

- [ ] **Step 2: Verify no other acceptance tests are affected**

Run: `grep -n "ANTHROPIC_BASE_URL\|wrapper\|resolve" docs/superpowers/plans/2026-07-04-img-proxy-acceptance-tests.md | head -30`

Manually verify no other test description references "不调 resolve" or similar wrapper-internal behavior. Tests C4 (line 260) and E5 (line 584-591) reference wrapper behavior but their invariants (URL set / provider switch) are preserved.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/plans/2026-07-04-img-proxy-acceptance-tests.md
git commit -m "docs(img-proxy): update E7 acceptance test wording for idempotent wrapper"
```

---

## Self-Review

### 1. Spec coverage

| Spec requirement | Task |
|---|---|
| `isProxyUrl` exported, matches loopback forms | Task 1 |
| `resolveProxyByUpstream` idempotent for loopback URLs | Task 2 |
| New wrapper logic: idempotent / override / fall back | Task 4 |
| stderr warn on override | Task 4 |
| stderr warn on fall back | Task 4 |
| Integration tests with real bash + stub binaries | Tasks 3, 4, 5 |
| E7 invariant preserved | Task 5 (regression test) |
| BUG FIX scenario tested | Task 4 (driving test) |
| Edge cases tested | Task 5 (port mismatch, localhost, etc.) |
| E7 acceptance test wording updated | Task 6 |
| ASCII `->` in warn output | Task 4 (in wrapper block) |
| Top-declare `local` in shell function | Task 4 (in wrapper block) |
| Unit tests for `isProxyUrl` | Task 1 |
| Unit tests for `resolveProxyByUpstream` idempotency | Task 2 |
| Unit tests for `generateWrapperBlock` new semantics | Task 4 (updated assertions) |

All spec requirements covered. ✓

### 2. Placeholder scan

No "TBD" / "TODO" / "implement later" / "similar to Task N". Every code step shows actual code. ✓

### 3. Type/signature consistency

- `isProxyUrl(url: string): boolean` — defined Task 1, used in Task 2 (`resolveProxyByUpstream`). Consistent.
- `resolveProxyByUpstream(path, port, hostname, upstream)` — signature unchanged in Task 2. Behavior change documented. ✓
- `generateWrapperBlock(): string` — signature unchanged. Body rewritten in Task 4. ✓
- Integration test helpers `runWrapper`, `STUB_CCLINKER`, `STUB_CLAUDE` — defined Task 3, used Tasks 4 and 5. ✓

### 4. Test ordering / dependency

- Task 1 must complete before Task 2 (Task 2 imports `isProxyUrl`)
- Task 3 must complete before Tasks 4 and 5 (test harness needed)
- Task 4 must complete before Task 5 (Task 5 tests pass only with new wrapper)

Plan order enforces this. ✓

### 5. Commit hygiene

Each task ends with a single commit. Conventional Commits format used. ✓

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-10-wrapper-bypass-fix.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints