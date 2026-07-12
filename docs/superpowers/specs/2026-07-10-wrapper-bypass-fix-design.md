# Wrapper Bypass Fix — Design

**Date**: 2026-07-10
**Author**: systematic-debugging + brainstorming
**Status**: Proposed

## Problem

`cc-linker-proxy` shell wrapper has a recursion guard that's too coarse:

```sh
cc-linker-proxy() {
  if [ -n "${ANTHROPIC_BASE_URL:-}" ]; then   # ← BUG: any non-empty value
    command claude "$@"
    return $?
  fi
  ...
}
```

When user's shell has `ANTHROPIC_BASE_URL` set to a **non-proxy URL** (typical: inherited from parent claude session snapshot or CC Switch), wrapper silently short-circuits and runs `claude` directly without going through img-proxy. The image is sent to upstream untouched, and the text-only model rejects with `400 Model only support text input`.

### Reproduction (confirmed 2026-07-10)

- User shell env: `ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic` (from parent shell snapshot)
- User's actual settings.json: `ANTHROPIC_BASE_URL=https://ark.cn-beijing.volces.com/api/plan`
- User runs `cc-linker-proxy` → wrapper short-circuits → claude exec'd with stale env → claude reads settings.json internally → bypasses proxy → image → upstream → 400
- img-proxy log shows ZERO recent requests for this session (confirms proxy was bypassed)

## Goals

1. **Fix the bypass**: wrapper must route through proxy when user runs `cc-linker-proxy`, regardless of whether `ANTHROPIC_BASE_URL` is set in shell env
2. **Preserve E7 invariant**: when user explicitly sets `ANTHROPIC_BASE_URL` to a proxy URL, wrapper respects that exact URL (URL unchanged, claude exec'd)
3. **Observable**: when wrapper overrides user's env, print stderr warn so user understands what happened
4. **Testable**: shell-level integration test verifies all branches with real bash + fake `claude`

## Non-Goals

- Don't fix any Claude Code SDK or env var precedence issue (orthogonal)
- Update E7 acceptance test wording to remove "不调 resolve" — new wrapper DOES call resolve (result unchanged for proxy URL input); spirit satisfied but literal text needs refresh
- Don't add port/hostname auto-sync between wrapper and config (resolve reads config at runtime — already authoritative)

## Design

### Component 1: `resolveProxyByUpstream` becomes idempotent

`src/img-proxy/routes.ts`:

```ts
export function resolveProxyByUpstream(
  path: string,
  port: number,
  hostname: string,
  upstream: string
): string | null {
  // Idempotent: 已是 proxy URL (本地 loopback)? 原样返,保留 user 显式 alias 选择
  if (isProxyUrl(upstream)) {
    return upstream;
  }
  // 否则按 upstream 查 routes (现有逻辑)
  const table = loadRoutes(path);
  const query = normalizeUrlForCompare(upstream);
  for (const [alias, entry] of Object.entries(table.routes)) {
    if (normalizeUrlForCompare(entry.upstream) === query) {
      return `http://${hostname}:${port}/${alias}`;
    }
  }
  return null;
}

/** Detect "is this URL a local proxy URL?"
 *  Matches http://<loopback>[:<any port>][/...]
 *  loopback 候选: 127.0.0.1 / localhost / [::1]
 *  port 不限定 (user 改过 config port 时 URL 仍能识别)
 *
 * 风险: 同一 loopback 上的别的本地服务也会被识别为 proxy URL。
 *  Mitigation: user 想用别的本地服务应直接 `claude`,不走 cc-linker-proxy。
 */
export function isProxyUrl(url: string): boolean {
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/.test(url);
}
```

**Behavior change**: `cc-linker img-proxy resolve <url>` now returns the input unchanged if it's a loopback URL (previously: returned null because loopback URLs aren't in routes).

This is a strict superset of previous behavior — callers that expected null for loopback URLs will now get the URL back. Only known caller is the wrapper script.

### Component 2: `generateWrapperBlock` rewrites wrapper function

`src/img-proxy/wrapper.ts`. Top-declare `local`（bash 习惯）：

```sh
cc-linker-proxy() {
  local env_url resolved real_url proxy_url

  env_url="${ANTHROPIC_BASE_URL:-}"

  # Path 1: env set
  if [ -n "$env_url" ]; then
    resolved="$(command cc-linker img-proxy resolve "$env_url")"
    if [ -n "$resolved" ] && [ "$resolved" = "$env_url" ]; then
      # 已是 proxy URL -> user 显式选过, 直接 exec (E7 invariant: URL 不变)
      command claude "$@"
      return $?
    fi
    if [ -n "$resolved" ]; then
      # env 是 upstream URL 但已装 -> 改写为 proxy URL + warn
      echo "cc-linker-proxy: ANTHROPIC_BASE_URL=$env_url -> proxy=$resolved (改写)" >&2
      ANTHROPIC_BASE_URL="$resolved" command claude "$@"
      return $?
    fi
    # env 解析失败 (陌生 URL / stale inherited) -> fall back to settings.json
    echo "cc-linker-proxy: env ANTHROPIC_BASE_URL=$env_url 解析失败, fall back 到 settings.json" >&2
  fi

  # Path 2: env unset OR fall back -> read settings.json
  real_url="$(command cc-linker img-proxy current-url)"
  if [ -z "$real_url" ]; then
    echo "cc-linker-proxy: 找不到当前 provider URL" >&2
    echo "  检查 ~/.claude/settings.json 是否含 env.ANTHROPIC_BASE_URL" >&2
    return 1
  fi

  proxy_url="$(command cc-linker img-proxy resolve "$real_url")"
  if [ -z "$proxy_url" ]; then
    echo "cc-linker-proxy: $real_url 没在 img-proxy 里" >&2
    echo "  hint: cc-linker img-proxy install" >&2
    return 1
  fi

  ANTHROPIC_BASE_URL="$proxy_url" command claude "$@"
}
```

**Template literal escaping**: 所有 `$` 在 JS template literal 里要写成 `\$`（避免被 JS 当作模板插值）。原 wrapper 已遵循该约定，新 wrapper 同样。

**字符选择**: warn 文案用 ASCII `->` 而非 UTF-8 `→`，避免不同 locale 下乱码。

### Component 3: Tests

#### 3a. Unit tests — `tests/unit/img-proxy/routes.test.ts`

Add to `describe('resolveProxyByUpstream')`:

- Test: input is `http://127.0.0.1:8765/glm-5.2` → returns input unchanged (idempotent)
- Test: input is `http://localhost:8765/glm-5.2` → returns input unchanged
- Test: input is `http://[::1]:8765/glm-5.2` → returns input unchanged
- Test: input is `http://127.0.0.1:9999/foo` (non-default port) → returns input unchanged
- Test: input is `http://127.0.0.1:8765` (no trailing slash) → returns input unchanged
- Test: input is `https://github.com/foo` (HTTPS, not loopback) → returns null (existing behavior preserved)
- Test: input is `http://192.168.1.5:8765/foo` (machine IP) → returns null (not in routes)

Add `describe('isProxyUrl')`:

- All loopback forms (127.0.0.1, localhost, [::1]) with various ports and paths → true
- HTTPS variant → true
- Non-loopback URLs → false
- Empty string / malformed → false

#### 3b. Unit tests — `tests/unit/img-proxy/wrapper.test.ts`

Update `describe('generateWrapperBlock')`:

- Existing: contains start/end markers, cc-linker-proxy function, recursion guard semantics
- New: contains `cc-linker img-proxy resolve` call (already exists, kept)
- New: contains stderr warn for env override
- New: contains fall-back to settings.json when env unresolvable
- New: NO longer contains `if [ -n "${ANTHROPIC_BASE_URL:-}" ]` as a hard short-circuit (the new logic uses `if [ -n "$resolved" ] && [ "$resolved" = "$env_url" ]`)

#### 3c. Integration tests — NEW `tests/integration/wrapper-bash.test.ts`

**Approach**: real bash + stub `cc-linker` binary + stub `claude` binary. Both stubs in tmpDir, override via PATH. Hermetic — no real daemon/routes/settings touched.

**Stub `cc-linker`** (handles `img-proxy current-url` + `img-proxy resolve`):

```bash
#!/bin/bash
case "$1 $2" in
  "img-proxy current-url")
    # echo settings.json env.ANTHROPIC_BASE_URL (or empty)
    if [ -n "$FAKE_SETTINGS_PATH" ] && [ -f "$FAKE_SETTINGS_PATH" ]; then
      node -e "const c=require('$FAKE_SETTINGS_PATH'); console.log(c.env?.ANTHROPIC_BASE_URL ?? '')"
    fi
    ;;
  "img-proxy resolve")
    url="$3"
    case "$url" in
      # idempotent: already proxy URL -> return unchanged
      http://127.0.0.1:*|http://localhost:*|'http://[::1]:'*)
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
```

**Stub `claude`** (capture env + args):

```bash
#!/bin/bash
echo "$ANTHROPIC_BASE_URL" >> "${FAKE_CLAUDE_LOG}"
echo "ARGS:$@" >> "${FAKE_CLAUDE_LOG}"
```

**Test harness shape**:

```typescript
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

let tmpDir: string;
let rcFile: string;
let settingsFile: string;
let fakeClaudeLog: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'wrapper-int-'));
  rcFile = join(tmpDir, '.zshrc');
  settingsFile = join(tmpDir, 'settings.json');
  fakeClaudeLog = join(tmpDir, 'claude.log');

  // write stubs
  writeFileSync(join(tmpDir, 'cc-linker'), STUB_CCLINKER_SCRIPT);
  chmodSync(join(tmpDir, 'cc-linker'), 0o755);
  writeFileSync(join(tmpDir, 'claude'), STUB_CLAUDE_SCRIPT);
  chmodSync(join(tmpDir, 'claude'), 0o755);

  // rc file: just the wrapper block
  writeFileSync(rcFile, generateWrapperBlock());
});

afterEach(() => rmSync(tmpDir, { recursive: true }));

function runWrapper(env: Record<string, string>, settingsJson: object) {
  writeFileSync(settingsFile, JSON.stringify(settingsJson));
  const result = spawnSync('bash', ['-c', `source ${rcFile} && cc-linker-proxy --version`], {
    env: {
      ...process.env, ...env,
      FAKE_SETTINGS_PATH: settingsFile,
      FAKE_CLAUDE_LOG: fakeClaudeLog,
      PATH: `${tmpDir}:${process.env.PATH}`,
    },
    encoding: 'utf-8',
  });
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.status ?? -1 };
}
```

**Test cases** (at minimum):

| # | env `ANTHROPIC_BASE_URL` | settings.json upstream | Expected `ANTHROPIC_BASE_URL` claude sees | Expected stderr |
|---|---|---|---|---|
| 1 | (unset) | `https://ark.cn-beijing.volces.com/api/plan` | `http://127.0.0.1:8765/byte-agent-glm` | (silent) |
| 2 | `http://127.0.0.1:8765/glm-5.2` | (any) | `http://127.0.0.1:8765/glm-5.2` (E7) | (silent) |
| 3 | `https://api.minimaxi.com/anthropic` (bug) | `https://ark.cn-beijing.volces.com/api/plan` | `http://127.0.0.1:8765/byte-agent-glm` (BUG FIX) | contains "fall back" |
| 4 | `https://api.minimaxi.com/anthropic` | (unset) | (claude NOT exec'd) | contains "找不到" |
| 5 | `https://ark.cn-beijing.volces.com/api/plan` (installed upstream) | (any) | `http://127.0.0.1:8765/byte-agent-glm` | contains "改写" |
| 6 | `http://127.0.0.1:9999/foo` (proxy URL, non-default port) | (any) | `http://127.0.0.1:9999/foo` (idempotent, loose port match) | (silent) |

**Cost**: ~10-20ms per case (bash subshell + stub fork). Total < 150ms for 6 cases.

## Files Touched

| File | Change |
|---|---|
| `src/img-proxy/routes.ts` | `resolveProxyByUpstream` 加 idempotent 路径;新增 `isProxyUrl` 导出 |
| `src/img-proxy/wrapper.ts` | `generateWrapperBlock` 重写 wrapper 函数 |
| `tests/unit/img-proxy/routes.test.ts` | 加 idempotent + isProxyUrl 测试 |
| `tests/unit/img-proxy/wrapper.test.ts` | 更新 generateWrapperBlock 断言 |
| `tests/integration/wrapper-bash.test.ts` | 新增 bash 集成测试 (4-6 场景) |

## Risks

1. **isProxyUrl 太宽松（loose port match）**: loopback 任意 port 都视作 proxy URL。
   - 同 loopback 上别的本地服务（如 dev server on 8080）会被误认。Mitigation: user 想用别的本地服务应直接 `claude` 不走 wrapper。
   - **stale env URL with wrong port（user 改了 config port 但 env 还指着旧 port）不会被 catch**: 例 config port=9999, env=`http://127.0.0.1:8765/foo` → resolve idempotent 返 env URL → claude 打 8765 失败。Mitigation: 文档说明改 port 后该 `unset ANTHROPIC_BASE_URL`;或后续可加 wrapper heuristic strict 模式（需嵌入 port）。

2. **resolve 行为变化对调用方的影响**: `cc-linker img-proxy resolve` 之前对 loopback URL 返 null,现在返 URL。
   - 已知唯一 caller 是 wrapper。其他 CLI 调用者（无）不受影响。
   - release notes 要提一句，给可能在脚本里 pipe resolve 的用户。

3. **E7 acceptance test 文案**: 旧文案"不调 resolve"字面不成立（实际会调 resolve，只是 result 是 same）。Spirit 满足（URL 不变 + claude exec'd）。
   - Decision: 改文案为 "不报错，URL 不变 (resolve 返同 URL), exec claude"。保留测试 setup 不变。

4. **wrapper.test.ts 现有断言**: `'包含递归防护'` 断言当前用 `expect(block).toMatch(/ANTHROPIC_BASE_URL/)` —— 这个仍通过。但 spirit 断言（"ANTHROPIC_BASE_URL 已设 → 直 exec"）需要重写为新的 idempotent 检测逻辑。

5. **shell 集成测试可移植性**: 测试依赖 bash + 临时 PATH 替换 + node CLI for stub JSON parsing。在 macOS（用户主要平台）工作良好；Linux CI 也 OK。Windows 不支持（wrapper 不支持 windows,无影响）。

6. **stub `cc-linker` 用 `node -e` 解析 JSON**: 依赖 node 在 PATH 中。开发环境 / CI 一般都有 node（Bun runtime 自带）。如果 CI runner 无 node，需要改 stub 为纯 bash + sed/grep 解析 JSON（脆弱但可行）。默认假设 node 可用。

## Open Questions

无。