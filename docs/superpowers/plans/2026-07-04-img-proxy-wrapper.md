# cc-linker img-proxy Wrapper Mode — Spec

> **Status:** Draft for review · **Branch:** `feat/cli-image-proxy` · **Plan owner:** img-proxy maintainers

## 1. Goals & Non-Goals

### Goals

- **Support CC Switch users** who run `claude` directly (without our custom aliases). They never read `~/.claude/providers/*.json` — they read `~/.claude/settings.json`.
- **Don't conflict with CC Switch.** CC Switch writes to `~/.claude/settings.json` and `~/.cc-switch/cc-switch.db`. We touch neither.
- **Don't conflict with the existing file-modify mode.** Both modes coexist; users pick based on their workflow.
- **Zero external dependencies.** No `jq`, no Node inline scripts in the shell wrapper — all logic goes through `cc-linker` subcommands.
- **Idempotent + safe.** `wrapper-install` can run multiple times without duplicating; backs up the rc file before modification.

### Non-Goals (v1)

- fish shell support (different function syntax; v2)
- Detecting `--settings <file>` flag in argv (shell parsing complexity; v2)
- Auto-detecting shell alias invocations like `cc-byte-glm` (would require shell trace hooks; v2)
- Web control panel for wrapper state (Phase 2)

## 2. Architecture

```
┌─────────────────────────────────────────────────────────┐
│  User runs: cc-linker-proxy "看这个图"                    │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│  cc-linker-proxy()  [shell function in ~/.zshrc]         │
│                                                         │
│  1. local real_url="${ANTHROPIC_BASE_URL:-$(              │
│        cc-linker img-proxy current-url                    │
│     )}"                                                 │
│  2. [ -z "$real_url" ] → 报错 return 1                    │
│  3. local proxy_url="$(cc-linker img-proxy resolve ...)"  │
│  4. [ -z "$proxy_url" ] → 报错 return 1                  │
│  5. ANTHROPIC_BASE_URL="$proxy_url" command claude "$@"  │
└─────────────────────────────────────────────────────────┘
                          │
            ┌─────────────┴──────────────┐
            ▼                            ▼
   cc-linker img-proxy              cc-linker img-proxy
       current-url                      resolve
            │                            │
            ▼                            ▼
   ┌──────────────────┐         ┌────────────────────┐
   │ Read             │         │ Read                │
   │ ~/.claude/       │         │ ~/.cc-linker/img-   │
   │   settings.json  │         │   proxy/routes.json │
   │                  │         │                     │
   │ Output env.      │         │ Output              │
   │   ANTHROPIC_     │         │   http://127.0.0.1: │
   │   BASE_URL       │         │   <port>/<alias>    │
   │ (stdout)         │         │ (stdout)            │
   └──────────────────┘         └────────────────────┘
```

### Files touched

| File | Action | Purpose |
|------|--------|---------|
| `src/img-proxy/resolve.ts` | create | Pure functions: `resolveUpstream`, `readCurrentUpstreamFromSettings` |
| `src/img-proxy/wrapper.ts` | create | `generateWrapperFunction`, marker constants, rc-file helpers |
| `src/cli/commands/img-proxy.ts` | modify | Add 4 new exported handlers: `imgProxyResolve`, `imgProxyCurrentUrl`, `imgProxyWrapperInstall`, `imgProxyWrapperUninstall`, `imgProxyWrapperStatus` |
| `src/index.ts` | modify | Register new subcommands under `img-proxy` |
| `tests/unit/img-proxy/resolve.test.ts` | create | Unit tests for resolve + current-url |
| `tests/unit/img-proxy/wrapper.test.ts` | create | Unit tests for wrapper generation + rc manipulation |
| `docs/img-proxy.md` | modify | New section: "CC Switch 用户怎么用 (wrapper mode)" |
| `~/.zshrc` or `~/.bashrc` | modified at runtime | Append `cc-linker-proxy()` function (managed by `wrapper-install`) |

### Files NOT touched (intentional)

- `~/.claude/providers/*.json` — only modified by existing `install` mode, not by wrapper
- `~/.claude/settings.json` — only CC Switch writes here
- `~/.cc-switch/cc-switch.db` — only CC Switch writes here

## 3. CLI Commands (full spec)

### `cc-linker img-proxy resolve <upstream>`

Look up proxy URL by real upstream URL.

```
$ cc-linker img-proxy resolve https://ark.cn-beijing.volces.com/api/coding
http://127.0.0.1:8765/byte-glm
# exit 0, stdout has URL

$ cc-linker img-proxy resolve https://unknown.example.com
# exit 0, stdout empty (not installed)

$ cc-linker img-proxy resolve https://malformed
# exit 1, stderr has error message
```

**Implementation:**

```typescript
function resolveUpstream(routesPath: string, port: number, hostname: string, upstream: string): string | null
```

1. Load routes.json
2. Iterate routes; find entry where `entry.upstream === upstream`
3. Return `http://${hostname}:${port}/${alias}` on match, `null` on miss
4. Read port/hostname from `img_proxy` config

**Edge cases:**
- routes.json missing → empty stdout, exit 0 (no providers installed yet)
- routes.json malformed → stderr error, exit 1
- Empty upstream arg → stderr "upstream required", exit 1

### `cc-linker img-proxy current-url`

Read current CC Switch active provider URL.

```
$ cc-linker img-proxy current-url
https://ark.cn-beijing.volces.com/api/coding
# exit 0, stdout has URL

$ cc-linker img-proxy current-url
# exit 0, stdout empty (settings.json missing or no env.ANTHROPIC_BASE_URL)
```

**Implementation:**

```typescript
function readCurrentUpstreamFromSettings(settingsPath: string): string | null
```

1. Read `~/.claude/settings.json`
2. If missing → return null
3. Parse JSON; if malformed → stderr error, exit 1
4. Return `settings.env?.ANTHROPIC_BASE_URL` or null

**Edge cases:**
- File missing → exit 0, empty stdout (treats as "no current provider")
- File present but JSON malformed → exit 1, stderr error
- env.ANTHROPIC_BASE_URL missing → exit 0, empty stdout
- env.ANTHROPIC_BASE_URL is empty string → exit 0, empty stdout

### `cc-linker img-proxy wrapper-install`

Install the `cc-linker-proxy` shell function.

```
$ cc-linker img-proxy wrapper-install
✅ 检测到 shell: zsh
✅ 备份: /Users/x/.zshrc → /Users/x/.cc-linker/img-proxy/wrapper-backup-1717489200
✅ 已写入 /Users/x/.zshrc
   - cc-linker-proxy() 函数定义

用法: source ~/.zshrc 或重开 shell 后跑 cc-linker-proxy "..."

$ cc-linker img-proxy wrapper-install
✅ wrapper 已装(zsh, ~/.zshrc)
# idempotent: no-op
```

**Behavior:**
1. Detect shell: `$ZSH_VERSION` → zsh, `$BASH_VERSION` → bash, else error
2. Find rc file: `~/.zshrc` for zsh, `~/.bashrc` for bash
3. If rc file doesn't exist, create it (mode 0o644)
4. Check marker (`# >>> cc-linker img-proxy wrapper >>>`) in rc file:
   - Present → print "already installed", exit 0
   - Absent → proceed
5. Backup rc file to `~/.cc-linker/img-proxy/wrapper-backup-<unix-ts>`
6. Append wrapper function block (with start/end markers) to rc file
7. Print success message with reload hint

**Wrapper function code (zsh/bash compatible):**

```bash
# >>> cc-linker img-proxy wrapper (do not edit this block) >>>
cc-linker-proxy() {
  local real_url="${ANTHROPIC_BASE_URL:-$(command cc-linker img-proxy current-url)}"
  if [ -z "$real_url" ]; then
    echo "cc-linker-proxy: 找不到当前 provider URL" >&2
    echo "  检查 ~/.claude/settings.json 是否含 env.ANTHROPIC_BASE_URL" >&2
    return 1
  fi
  local proxy_url
  proxy_url="$(command cc-linker img-proxy resolve "$real_url")"
  if [ -z "$proxy_url" ]; then
    echo "cc-linker-proxy: $real_url 没在 img-proxy 里" >&2
    echo "  hint: cc-linker img-proxy install --providers <alias>" >&2
    return 1
  fi
  ANTHROPIC_BASE_URL="$proxy_url" command claude "$@"
}
# <<< cc-linker img-proxy wrapper <<<
```

Note: `command claude` (not bare `claude`) to bypass any shell alias for `claude`. `command cc-linker` similarly bypasses any potential cc-linker shell function (defensive).

### `cc-linker img-proxy wrapper-uninstall`

Remove the wrapper function from rc file.

```
$ cc-linker img-proxy wrapper-uninstall
✅ 已从 /Users/x/.zshrc 移除 cc-linker-proxy 函数
   备份保留在: /Users/x/.cc-linker/img-proxy/wrapper-backup-1717489200

$ cc-linker img-proxy wrapper-uninstall
⚠️ wrapper 未装(无 marker)
# exit 0, idempotent
```

**Behavior:**
1. Find rc file (same detection as install)
2. Search for marker `# >>> cc-linker img-proxy wrapper`
3. If not found → print "not installed", exit 0
4. Find end marker `# <<< cc-linker img-proxy wrapper`
5. Remove lines between markers (inclusive)
6. Backup rc file before modification (just like install)
7. Print success

### `cc-linker img-proxy wrapper-status` (or merged into `status`)

Check if wrapper is installed.

```
$ cc-linker img-proxy wrapper-status
✅ wrapper 已装
   shell: zsh
   rc: /Users/x/.zshrc

$ cc-linker img-proxy wrapper-status
⚠️ wrapper 未装
   hint: cc-linker img-proxy wrapper-install
```

**Behavior:** Grep rc file for marker, report.

Also merged into `cc-linker img-proxy status` panel as additional section.

## 4. Wrapper Function Design (deep dive)

### Why `cc-linker-proxy` (not `cc-proxy`)

- `cc-proxy` is too generic, likely to collide with other tools (CC Switch proxy, C++ compiler cache proxies, etc.)
- `cc-linker-proxy` is namespaced, namespaced with cc-linker, ~0% collision risk
- 14 chars, similar to existing `cc-linker-img-proxy` subcommand (14 chars)

### Why env var, not file modification

- File modification is fragile: any tool that regenerates the file (CC Switch, manual edits) overwrites
- Env var is process-scoped: only affects the spawned `claude` invocation, doesn't leak to user's shell
- Env var takes precedence over `--settings <file>` values in Claude Code (verified)

### Why `command claude` (not bare `claude`)

- `command` is a shell builtin that bypasses functions and aliases
- User may have `claude` aliased to something different (e.g., a wrapper that sets env vars we don't want)
- Defensive: ensure we exec the actual `claude` binary

### Why check ANTHROPIC_BASE_URL first (防递归)

- If wrapper calls itself (e.g., via alias chain), env var is already set
- Detecting `http://127.0.0.1:<port>/` prefix → skip resolve, just exec claude
- Avoids infinite loops and unnecessary subcommand calls

### Why stderr for errors

- stdout reserved for the answer (URL or empty)
- Wrapper uses `[ -z "$(cmd)" ]` for detection; mixing error text into stdout would break detection
- Error messages to stderr are visible to user but don't pollute command substitution

## 5. Internal API (TypeScript)

### `src/img-proxy/resolve.ts`

```typescript
/**
 * Look up proxy URL for a given real upstream.
 * Returns `http://${hostname}:${port}/${alias}` if found, null otherwise.
 */
export function resolveUpstream(
  routesPath: string,
  port: number,
  hostname: string,
  upstream: string
): string | null;

/**
 * Read ~/.claude/settings.json and return its env.ANTHROPIC_BASE_URL.
 * Returns null if file missing, malformed, or field missing/empty.
 * Throws on JSON parse error (caller handles exit code).
 */
export function readCurrentUpstreamFromSettings(
  settingsPath: string
): { url: string | null; parseError: Error | null };
```

### `src/img-proxy/wrapper.ts`

```typescript
export type Shell = 'zsh' | 'bash';

/** Detect user's shell from environment. Returns null if unsupported. */
export function detectShell(): Shell | null;

/** Get rc file path for a given shell. */
export function getRcFilePath(shell: Shell): string;

/** Generate the wrapper function block (with markers) for shell rc. */
export function generateWrapperBlock(): string;

/** Markers (exposed for tests + uninstall). */
export const WRAPPER_START_MARKER = '# >>> cc-linker img-proxy wrapper (do not edit this block) >>>';
export const WRAPPER_END_MARKER = '# <<< cc-linker img-proxy wrapper <<<';

/**
 * Install wrapper into rc file. Idempotent.
 * Returns { installed: true, rcFile, backupPath } on success,
 *         { installed: false, reason } if already installed or unsupported shell.
 */
export function installWrapper(
  shell: Shell,
  rcFile: string,
  backupDir: string
): { installed: boolean; reason?: string; rcFile: string; backupPath?: string };

/** Remove wrapper from rc file. Idempotent. */
export function uninstallWrapper(rcFile: string): { removed: boolean; rcFile: string };

/** Check if wrapper is installed (markers present). */
export function isWrapperInstalled(rcFile: string): boolean;
```

## 6. Tests

### Unit tests (no shell, no fs write outside temp dirs)

| Test | Purpose |
|------|---------|
| `resolveUpstream` finds matching alias | Happy path |
| `resolveUpstream` returns null on miss | Negative case |
| `resolveUpstream` returns null on empty routes file | Edge case |
| `resolveUpstream` returns null on malformed routes JSON | Edge case |
| `readCurrentUpstreamFromSettings` with valid env | Happy path |
| `readCurrentUpstreamFromSettings` missing file | Returns null url |
| `readCurrentUpstreamFromSettings` malformed JSON | Returns parseError |
| `readCurrentUpstreamFromSettings` no env field | Returns null url |
| `generateWrapperBlock` produces shell-compatible code | Syntax check |
| `installWrapper` appends to empty rc file | New file creation |
| `installWrapper` is idempotent (second call no-ops) | Idempotency |
| `installWrapper` backs up before modifying | Safety |
| `installWrapper` with unsupported shell returns installed:false | Failure mode |
| `uninstallWrapper` removes wrapper block | Happy path |
| `uninstallWrapper` no-op when marker missing | Idempotency |
| `isWrapperInstalled` detects markers | Quick check |
| `detectShell` returns correct shell from env | Mock env vars |

### Manual smoke (post-merge)

```bash
# Setup:
cc-linker img-proxy wrapper-install
source ~/.zshrc

# Test:
cc-linker-proxy "echo test"     # should set ANTHROPIC_BASE_URL and exec claude
cc-linker img-proxy wrapper-status
cc-linker img-proxy wrapper-uninstall
```

## 7. Edge Cases & Error Scenarios

| Scenario | Behavior |
|----------|----------|
| `~/.claude/settings.json` doesn't exist | `current-url` returns empty; wrapper errors with helpful msg |
| `~/.claude/settings.json` malformed JSON | `current-url` writes error to stderr, exits 1; wrapper propagates |
| `routes.json` doesn't exist | `resolve` returns empty; wrapper errors |
| Provider in CC Switch not in img-proxy routes | `resolve` returns empty; wrapper suggests `install --providers` |
| Both env var and settings.json have URLs | env var wins (priority) |
| Wrapper function called recursively | Already-set ANTHROPIC_BASE_URL detected, skip resolve |
| `cc-linker` binary not in PATH | Wrapper errors "command not found" (shell-level) |
| `claude` binary not in PATH | Wrapper errors "command not found" (shell-level) |
| rc file is read-only | `wrapper-install` fails with permission error |
| User runs `wrapper-install` twice quickly | Second call no-ops (idempotent) |
| User removes wrapper manually then runs `wrapper-status` | Reports "not installed" |
| User switches shell between zsh and bash (rare) | Both rc files have wrapper; both work |
| `--settings <file>` arg in claude invocation | v1: ignored (env var wins); v2: detect in argv |
| User on fish shell | `wrapper-install` errors "fish not supported, use bash/zsh" |

## 8. Backwards Compatibility

- `install` (file-modify mode): unchanged, still works
- `wrapper-install`: new, additive
- Users with custom aliases: continue using file mode (unchanged)
- Users on CC Switch: new option to use wrapper mode
- Mixed users: both can coexist (no conflict)

## 9. Documentation Updates

### `docs/img-proxy.md` — new section

Add after the existing "冷启动 / CC Switch 用户" section:

```markdown
## CC Switch 用户怎么用 (wrapper 模式)

如果你用 CC Switch 直接跑 `claude`(没走 cc-linker 的自定义 alias),改文件没用 —— Claude Code 读的是 CC Switch 写的 `~/.claude/settings.json`。

这种情况下用 wrapper 模式:

\`\`\`bash
# 1. 装所有想走 proxy 的 provider(CC Switch 里的)
cc-linker img-proxy install --all

# 2. 装 wrapper 到 ~/.zshrc
cc-linker img-proxy wrapper-install
source ~/.zshrc   # 或重开 shell

# 3. 用 cc-linker-proxy 替代 claude
cc-linker-proxy "看这个图"   # 走 proxy
claude "看这个图"             # 直连(行为不变)
\`\`\`

工作原理:
1. wrapper 读 `~/.claude/settings.json` 拿当前真实的 upstream URL
2. 查 img-proxy 的 routes 表,找到对应的 proxy URL
3. 注入 `ANTHROPIC_BASE_URL` 环境变量,跑 `claude`

跟现有 install(改文件)模式的区别:

| 模式 | 用户场景 | 安装方式 |
|------|---------|---------|
| install (改文件) | 自定义 alias (`cc-byte-glm`) | `cc-linker img-proxy install` |
| wrapper-install | CC Switch / 直接跑 `claude` | `cc-linker img-proxy wrapper-install` |

两条路径**独立**,互不影响。可以二选一,也可以两个都装(冗余但无害)。
```

### Update Q&A section

Add:
- Q: 我装了 wrapper 但 proxy 没生效? A: 检查 wrapper 是否已 source、img-proxy daemon 是否在跑、当前 provider 是否已 install
- Q: 想删 wrapper? A: `cc-linker img-proxy wrapper-uninstall`

## 10. Setup Wizard Integration

In `cc-linker setup`, after Step 5 (img-proxy install):

```
Step 6 (optional): 检测用户是否用 CC Switch,推荐 wrapper-install

→ 看到 ~/.cc-switch/cc-switch.db:
  问:"是否也装 wrapper 模式(让 cc-linker-proxy 命令也能用)?"
  推荐 Y

→ 没看到:
  跳过(只走 install 模式)
```

## 11. Implementation Order

1. **`src/img-proxy/resolve.ts`** + unit tests (~30 min)
2. **`src/img-proxy/wrapper.ts`** + unit tests (~1 hour)
3. **`src/cli/commands/img-proxy.ts`** — add 4 new handlers + register in `src/index.ts` (~30 min)
4. **`src/cli/commands/img-proxy.ts`** — extend `imgProxyStatus` with wrapper section (~15 min)
5. **`docs/img-proxy.md`** — new section (~20 min)
6. **Manual smoke** with real `cc-linker-proxy` invocation (~20 min)
7. **Deploy + push** (~10 min)

**Total: ~3.5 hours**

## 12. Open Questions

1. **Should wrapper also handle `--settings <file>` arg?** Currently v1 ignores it (env var wins). Could add shell-side argv parsing for v2.
2. **Should `wrapper-install` offer to detect `--settings` aliases and replace them?** Out of scope for v1.
3. **Should `wrapper-status` be a separate subcommand or merged into `status`?** v1: merged (less command surface).
4. **What about bash completion?** Out of scope; zsh has good completion out of the box.
5. **Should we expose a `proxy` alias as a setup wizard option?** E.g., `cc-linker setup --proxy-mode=wrapper`. v1: detect-and-ask during setup wizard.