# cc-linker img-proxy Wrapper Mode — Spec

> **⛔ SUPERSEDED (2026-07-04):** 本文档已被 [`docs/superpowers/specs/2026-07-04-img-proxy-smart-install-design.md`](../specs/2026-07-04-img-proxy-smart-install-design.md) 取代。
>
> **冲突点**(请勿再参考本文档):
> - **GLM-5 系列分类**:本文档 §13 写 `/^glm-5/i` → multimodal,**错的**;NEW spec 改为 `/^glm-\d+(\.\d+)?$/i` → text-only(GLM-5.1 是文本模型,用户已确认)
> - **resolve 函数命名**:本文档 §5 命名为 `resolveUpstream(routesPath, port, hostname, upstream)`,**会与 `routes.ts` 现有同名函数冲突**;NEW spec 改为重命名旧函数为 `getUpstreamByAlias` + 新加 `resolveProxyByUpstream`
> - **resolve 函数位置**:本文档 §5 放 `src/img-proxy/resolve.ts`,NEW spec 合并到 `routes.ts`(职责内聚)
>
> **保留原因**:历史 commit + §7 wrapper 函数生成细节(NEW spec §7 也覆盖了,但本文档有更详细的 shell 语法说明可参考)
>
> ---
> **Status:** Draft for review · **Branch:** `feat/cli-image-proxy` · **Plan owner:** img-proxy maintainers
>
> **Updated:** Added §13 Model Classification (smart text-only vs multimodal detection) + §14 Shell Alias Discovery (auto-detect existing `cc-*` aliases) + §15 Smart Install flow.

## 1. Goals & Non-Goals

### Goals

- **Support CC Switch users** who run `claude` directly (without our custom aliases). They never read `~/.claude/providers/*.json` — they read `~/.claude/settings.json`.
- **Don't conflict with CC Switch.** CC Switch writes to `~/.claude/settings.json` and `~/.cc-switch/cc-switch.db`. We touch neither.
- **Don't conflict with the existing file-modify mode.** Both modes coexist; users pick based on their workflow.
- **Skip multimodal models.** Don't run image-capable models through proxy (would lose their image-understanding capability). Detect by model name patterns.
- **Auto-discover existing shell aliases.** Detect user's existing `cc-*` aliases in `~/.zshrc` / `~/.bashrc`, map to providers, pre-select for install. No need for user to specify `--providers`.
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

---

## 13. Model Classification (text-only vs multimodal)

### Motivation

If we proxy ALL providers through img-proxy, multimodal models (Claude 3+, GPT-4, etc.) **lose their image understanding** — they get a text path instead of the actual image. That's a regression for users who chose those models for their multimodal capabilities.

**Smart install** classifies each provider by model name and:
- **Multimodal models** (vision-capable): **skip** proxy — keep their image understanding
- **Text-only models**: **proxy** — they need it for image acceptance
- **Unknown models**: default to **proxy** (conservative: prefer false-positive over false-negative)

### Classification is by MODEL name, not provider file name

Important: `~/.claude/providers/minimax-m2.7.json` (provider filename `m2.7`) might use `MiniMax-M3[1m]` model. We classify by `env.ANTHROPIC_MODEL` field, **not** by provider filename.

### Pattern lists (built-in, case-insensitive regex)

**Multimodal (skip proxy):**

```typescript
const MULTIMODAL_PATTERNS = [
  // === Anthropic Claude ===
  /^claude-3/i,                     // claude-3-opus, claude-3-5-sonnet, ...
  /^claude-opus/i,                  // claude-opus-4 (all 4-series have vision)
  /^claude-sonnet/i,                // claude-sonnet-4
  /^claude-haiku/i,                 // claude-haiku-4

  // === OpenAI GPT-4 ===
  /^gpt-4/i,                         // gpt-4, gpt-4o, gpt-4-turbo, gpt-4-vision

  // === Google Gemini ===
  /^gemini-.*vision/i,              // gemini-*-vision*
  /^gemini-1\.5-pro/i,              // gemini-1.5-pro has vision

  // === Alibaba Qwen (通义千问) ===
  /^qwen.*-vl/i,                    // qwen-vl, qwen2-vl, qwen3-vl (all generations)
  /^qwen.*-omni/i,                  // qwen3.5-omni, future omni variants
  /^qwen3\.\d+(\.\d+)?-plus/i,     // qwen3.6-plus, qwen3.7-plus native multimodal

  // === Zhipu GLM (智谱) ===
  /^glm-.*-?v/i,                    // glm-4v, glm-4.5v (42榜单 41 SOTA), glm-4.1v, glm-5v, glm-5.1v
  /^glm-5/i,                        // GLM-5 系列 multimodal(GLM-5.1 首个支持图片的 GLM)

  // === Moonshot Kimi (月之暗面) — all variants multimodal ===
  /^kimi/i,                         // kimi-k2, kimi-k2.5, kimi-k2.6, kimi-for-coding, kimi-vl (MoonViT 视觉编码器)

  // === Xiaomi MiMo (小米) ===
  /^mimo-v\d+(\.\d+)?(?!-pro)/i,   // mimo-v2.5 multimodal(base vision model)
                                   // mimo-v2.5-pro is TEXT (negative lookahead excludes -pro)

  // === MiniMax ===
  /^MiniMax-M3/i,                   // MiniMax-M3[1m] multimodal(per user)

  // === ByteDance Doubao (字节豆包) ===
  /^doubao.*-vision/i,              // doubao-vision-pro
  /^seed.*-vision/i,                // seed-vision

  // === Stepfun (阶跃星辰) ===
  /^step-1v/i,
  /^step.*-vision/i,

  // === Tencent Hunyuan (腾讯混元) ===
  /^hunyuan.*-vision/i,

  // === Baidu ERNIE (文心) ===
  /^ernie-.*-vision/i,

  // === Generic vision markers (fallback for unknown models) ===
  /-vision$/i,                      // ends with -vision
  /-vl-/i,                          // contains -vl-
  /-vlm/i,                          // contains -vlm
];
```

**Text-only (proxy):**

```typescript
const TEXT_ONLY_PATTERNS = [
  // === GLM text-only (NOT 4v/4.5v/5.x — those are multimodal above) ===
  /^glm-\d+(\.\d+)?$/i,            // glm-4.5, glm-4.6 (exact, no v suffix)
  /^glm-4-(air|turbo)/i,           // glm-4-air, glm-4-turbo (text)

  // === DeepSeek (text historically) ===
  /^deepseek/i,                     // deepseek-chat, deepseek-v3, deepseek-v4-pro

  // === Qwen text variants (NOT -plus per research, NOT -vl) ===
  /^qwen-turbo/i,
  /^qwen-max/i,                     // qwen-max, qwen3.5-max (NOT multimodal until confirmed)
  /^qwen-long/i,
  /^qwen-coder/i,
  /^qwen3.*-coder/i,
  /^qwen3\.\d+(\.\d+)?-max/i,      // qwen3.7-max (NOT -plus which is multimodal)

  // === Moonshot legacy (Kimi K-series is multimodal above) ===
  /^moonshot-v1-/i,                 // moonshot-v1-8k/32k/128k (legacy text)

  // === Chinese LLM families (text) ===
  /^baichuan/i,                     // baichuan-4, baichuan-3
  /^yi-/i,                          // yi-34b, yi-1.5

  // === MiniMax M2 (text — M3 is multimodal above) ===
  /^MiniMax-M2/i,                  // MiniMax-M2, M2.1, M2.5 (all text per research)
  /^MiniMax-Text-/i,               // older text models
  /^abab/i,                         // abab5.5s, abab6.5s (legacy text)

  // === Xiaomi MiMo (text variant) ===
  /^mimo-.*-pro/i,                  // mimo-v2.5-pro text (base mimo-v2.5 is multimodal)

  // === OpenAI older ===
  /^(gpt-3|gpt-3\.5)/i,             // gpt-3.5-turbo
];
```

### Suffix-stripping preprocessing (重要!)

Many model names carry a `[suffix]` quantifier — `[1m]` (1M context), `[256k]` (256K context), etc. Real examples from user's setup:

- `glm-5.2[1m]`
- `qwen3.7-plus[1m]`
- `kimi-for-coding[256k]`
- `mimo-v2.5-pro[1m]`
- `MiniMax-M3[1m]`

**The `[suffix]` must be stripped before pattern matching**, otherwise `$`-anchored patterns fail and text-vs-multimodal misclassifications occur.

```typescript
function classifyModel(modelName: string): 'multimodal' | 'text-only' | 'unknown' {
  // Strip trailing [quantifier]: [1m], [256k], [128k], [32k], etc.
  const baseName = modelName.replace(/\[[^\]]*\]\s*$/, '').trim();

  // 1. Check multimodal FIRST
  if (MULTIMODAL_PATTERNS.some(p => p.test(baseName))) return 'multimodal';

  // 2. Check text-only
  if (TEXT_ONLY_PATTERNS.some(p => p.test(baseName))) return 'text-only';

  // 3. Unknown → default to text (proxy)
  return 'unknown';
}
```

**Important:** Stripping order matters. `kimi-for-coding[256k]` → strips to `kimi-for-coding` → matches multimodal `/^kimi/i` → multimodal ✓. Without strip, `kimi-for-coding[256k]` would still match `/^kimi/i` (no `$` anchor), but `$`-anchored patterns like `/^glm-\d+(\.\d+)?$/i` would fail. Always strip.

### Detection order matters

Multimodal patterns are checked **first**. If a model matches multimodal, it's classified multimodal regardless of text-only patterns. So:
- `glm-5.1` → matches multimodal `/^glm-5/i` → multimodal ✓
- `glm-4.5` → no multimodal match → matches text-only `/^glm-\d+(\.\d+)?$/i` → text-only ✓
- `MiniMax-M3` → matches multimodal `/^MiniMax-M3/i` → multimodal ✓
- `MiniMax-M2.5` → no multimodal match → matches text-only `/^MiniMax-M2/i` → text-only ✓

### Config extensibility

Users can extend via `~/.cc-linker/config.toml`:

```toml
[img_proxy]
# 智能模式:跳过已知多模态模型,只 proxy 文本模型
smart_mode = true

# 追加自定义多模态 patterns(也会被跳过)
vision_model_patterns_extra = [
  "my-custom-vision-*",
]

# 追加自定义文本 patterns(也会被 proxy)
text_only_model_patterns_extra = [
  "my-custom-text-*",
]
```

`config.get<string[]>('img_proxy.vision_model_patterns_extra', [])` appended to `MULTIMODAL_PATTERNS` at startup.

### Test plan (verified against user's actual provider files)

| Test | Input model | Expected |
|------|-------------|----------|
| Claude 3 | `claude-3-5-sonnet-20241022` | multimodal |
| Claude 4 opus | `claude-opus-4[1m]` | multimodal |
| GPT-4o | `gpt-4o` | multimodal |
| Gemini vision | `gemini-1.5-pro-vision` | multimodal |
| Qwen VL | `qwen-vl-plus` | multimodal |
| Qwen3 VL | `qwen3-vl-72b-instruct` | multimodal |
| Qwen3.6 plus | `qwen3.6-plus[1m]` | multimodal |
| Qwen3.7 plus | `qwen3.7-plus[1m]` | multimodal |
| Qwen3.7 max | `qwen3.7-max[1m]` | text-only |
| Qwen3.6-35B-A3B | `qwen3.6-35b-a3b` (open source variant) | unknown (defaults to proxy) |
| Qwen3.5-Omni | `qwen3.5-omni[1m]` | multimodal |
| Kimi coding | `kimi-for-coding[256k]` | multimodal |
| Kimi K2.6 | `kimi-k2.6` | multimodal |
| Kimi K2.5 | `kimi-k2.5-thinking` | multimodal |
| GLM 5.2 | `glm-5.2[1m]` | text-only |
| GLM 5.1 | `glm-5.1` | **text-only** (per user correction) |
| GLM 4.5 | `glm-4.5` | text-only |
| GLM 4.5V | `glm-4.5v` | multimodal |
| GLM 4V plus | `glm-4v-plus` | multimodal |
| DeepSeek V4 | `deepseek-v4-pro[1m]` | text-only |
| MiniMax M3 | `MiniMax-M3[1m]` | multimodal |
| MiniMax M2.5 | `MiniMax-M2.5[1m]` | text-only |
| MiMo v2.5 (base) | `mimo-v2.5[1m]` | **multimodal** (per user) |
| MiMo v2.5 Pro | `mimo-v2.5-pro[1m]` | **text-only** (per user) |
| Doubao vision | `doubao-1.5-vision-pro` | multimodal |
| Hunyuan vision | `hunyuan-vision-pro` | multimodal |
| ERNIE vision | `ernie-4.0-vision` | multimodal |
| Step-1V | `step-1v-32k` | multimodal |
| Unknown | `some-new-model[1m]` | unknown (defaults to proxy) |

### Decision algorithm

```typescript
function classifyModel(modelName: string): 'multimodal' | 'text-only' | 'unknown' {
  const name = modelName.trim();

  // 1. Check multimodal FIRST (more specific / safer)
  if (MULTIMODAL_PATTERNS.some(p => p.test(name))) return 'multimodal';

  // 2. Check text-only
  if (TEXT_ONLY_PATTERNS.some(p => p.test(name))) return 'text-only';

  // 3. Unknown — default safe behavior
  return 'unknown';
}
```

**Note**: The full implementation includes suffix-stripping (see §"Suffix-stripping preprocessing" above). This code block shows the pattern-matching logic only.

**Default behavior for unknown**: `install` will proxy them (with a visible hint "unknown model, defaulting to proxy"). User can override per-provider with `--force-multimodal <alias>` flag.

### Config extensibility

In `~/.cc-linker/config.toml`:

```toml
[img_proxy]
# 智能模式:跳过已知多模态模型,只 proxy 文本模型
smart_mode = true

# 追加自定义多模态 patterns(也会被跳过)
vision_model_patterns_extra = [
  "my-custom-vision-*",
]

# 追加自定义文本 patterns(也会被 proxy)
text_only_model_patterns_extra = [
  "my-custom-text-*",
]
```

`config.get<string[]>('img_proxy.vision_model_patterns_extra', [])` appended to `MULTIMODAL_PATTERNS` at startup.

### Test plan

| Test | Input | Expected |
|------|-------|----------|
| Claude 3 | `claude-3-5-sonnet-20241022` | multimodal |
| Claude 4 opus | `claude-opus-4[1m]` | multimodal |
| GPT-4o | `gpt-4o` | multimodal |
| Gemini vision | `gemini-1.5-pro-vision` | multimodal |
| Qwen VL | `qwen-vl-plus` | multimodal |
| Qwen 3.6 plus | `qwen3.6-plus[1m]` | multimodal |
| Qwen 3.7 plus | `qwen3.7-plus[1m]` | multimodal |
| Kimi coding | `kimi-for-coding[256k]` | multimodal |
| MiniMax M3 | `MiniMax-M3[1m]` | multimodal |
| GLM 5.2 | `glm-5.2[1m]` | text-only |
| GLM 4.5 | `glm-4.5` | text-only |
| DeepSeek V4 | `deepseek-v4-pro[1m]` | text-only |
| Qwen 3.7 max | `qwen3.7-max[1m]` | text-only |
| MiniMax M2 | `abab6.5s-chat` | text-only |
| Unknown | `some-new-model[1m]` | unknown (defaults to proxy) |

---

## 14. Shell Alias Discovery

### Motivation

Users with custom `cc-byte-agent` style aliases already have a workflow. `install` should auto-detect these aliases and pre-select the corresponding providers — no need to specify `--providers byte-agent-glm` manually.

### Discovery algorithm

```typescript
function discoverShellAliases(rcFiles?: string[]): DiscoveredAlias[] {
  const files = rcFiles ?? [
    join(HOME, '.zshrc'),
    join(HOME, '.bashrc'),
    join(HOME, '.zprofile'),         // macOS zsh login
    join(HOME, '.bash_profile'),     // bash login
  ].filter(existsSync);

  const aliases: DiscoveredAlias[] = [];
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    for (const line of lines) {
      // Match: alias cc-XYZ='claude --settings /path/to/XYZ.json ...'
      // or:     alias cc-XYZ="claude --settings /path/to/XYZ.json ..."
      const m = line.match(/^alias\s+(cc-[\w-]+)\s*=\s*['"]?([^'"]*?)['"]?\s*$/);
      if (!m) continue;
      const name = m[1]!;                  // "cc-byte-agent"
      const cmd = m[2]!;                  // "claude --settings /path/to/byte-agent-glm.json ..."
      // Extract --settings <file> arg
      const settingsMatch = cmd.match(/--settings\s+(\S+\.json)/);
      const providerPath = settingsMatch ? settingsMatch[1]! : null;
      const providerAlias = providerPath ? basename(providerPath, '.json') : null;
      aliases.push({ name, command: cmd, providerPath, providerAlias });
    }
  }
  return aliases;
}
```

### What we extract

| Alias | Command | Extracted |
|-------|---------|-----------|
| `alias cc-byte-agent='claude --settings ~/.claude/providers/byte-agent-glm.json'` | → | name=cc-byte-agent, providerPath=`.../byte-agent-glm.json`, providerAlias=byte-agent-glm |
| `alias cc-glm='claude --settings ~/.claude/providers/glm-5.2.json'` | → | name=cc-glm, providerAlias=glm-5.2 |
| `alias claude='cc-linker-proxy'` | → | name=claude, providerPath=null (no --settings) |

### What we DON'T do (v1)

- We don't modify user's aliases (e.g., replace `cc-byte-agent` with `cc-linker-proxy`). User can do that manually.
- We don't parse complex shell constructs (functions, conditional aliases, sourced files).
- We only look at top-level `alias` lines in rc files.

### Integration with install

In smart install (next section), discovered aliases are used as hints:
- For each discovered alias with `providerPath`, the corresponding provider is pre-selected in the install list.
- The status output shows: "Discovered 3 cc-* aliases → 3 providers pre-selected"

### Test plan

| Test | Setup | Expected |
|------|-------|----------|
| Empty rc file | `~/.zshrc` empty | `[]` |
| One alias | `alias cc-byte-agent='claude --settings ~/.claude/providers/byte-agent-glm.json'` | `[{name: 'cc-byte-agent', providerAlias: 'byte-agent-glm', ...}]` |
| Double quotes | `alias cc-x="claude --settings /tmp/foo.json"` | parsed correctly |
| No --settings | `alias cc-y='echo hi'` | name=cc-y, providerPath=null |
| Comment line | `# alias cc-z='...'` | ignored |
| Multi-line continuation | `alias cc-w=\` followed by newline | skipped (v1 limitation) |
| Non-cc alias | `alias ls='ls -la'` | ignored |
| Non-existent rc file | `~/.zshrc` missing | `[]` |
| Multiple rc files | both `~/.zshrc` and `~/.bashrc` exist | union of both |

---

## 15. Smart Install Flow

### Goals

- One command (`cc-linker img-proxy install`) does the right thing for all user types.
- Auto-detects user's situation (CC Switch, custom aliases, both, neither).
- Auto-classifies each provider (text-only vs multimodal).
- Pre-selects sensible defaults; user can adjust.

### Algorithm

```
1. Discover all candidate providers from 4 sources:
   a. ~/.claude/providers/*.json           (manual)
   b. ~/.cc-linker/auto-providers/*.json   (CC Switch sync, post P0-1)
   c. ~/.cc-switch/cc-switch.db            (raw CC Switch DB)
   d. ~/.zshrc ~/.bashrc cc-* aliases      (user's existing shortcuts)

2. Merge + dedupe by provider file path or alias:
   - file content is source of truth
   - alias discovery is a hint (user explicitly references this provider)
   - cc-switch DB contributes aliases not yet in file

3. For each provider:
   - Read model name from env.ANTHROPIC_MODEL field
   - Classify: text-only / multimodal / unknown
   - Mark source: 'manual' | 'auto' | 'cc-switch' | 'alias'

4. Smart pre-selection:
   - multimodal → SKIP (don't pre-select)
   - text-only → SELECT
   - unknown → SELECT with hint "(unknown model, will proxy by default; override with --no-smart)"

5. Interactive checkbox (user can adjust):
   - Shows source tag: [alias] glm-5.2[1m]     (from ~/.zshrc cc-glm)
   - Shows classification: ⏭ multimodal or ✅ text-only
   - Default selection per above rules

6. Per selected provider, call installProvider:
   - Reads file (manual or auto-providers)
   - Modifies BASE_URL → proxy URL
   - Writes back atomically (tmp + rename)

7. Auto-install wrapper if CC Switch detected:
   - If any provider source includes 'cc-switch' or 'alias' (custom aliases that may be replaced), call imgProxyWrapperInstall.
   - User gets a one-liner reminder: "Run `source ~/.zshrc` or open a new shell to use cc-linker-proxy"

8. Start daemon (if not already running).

9. Print summary:
   - Installed: N providers
   - Skipped: M multimodal
   - Wrapper: installed / already-installed / skipped
   - Daemon: started / already-running
```

### CLI flags

```bash
cc-linker img-proxy install [flags]

# Smart defaults (no flag = auto-detect everything)
--all                            # install all detected (ignore multimodal classification)
--providers <aliases>            # explicit provider selection (overrides smart detection)
--mode={file|wrapper|both}       # force mode (default: smart detect)
--no-smart                        # don't skip multimodal (proxy everything)
--no-wrapper                      # skip wrapper installation
--dry-run                         # show what would be done, don't modify
```

### Example output

```
$ cc-linker img-proxy install

🔍 发现 16 个 claude providers:
   4 来自 ~/.claude/providers/ (manual)
   12 来自 CC Switch (已同步到 ~/.cc-linker/auto-providers/)

🔍 发现 3 个 cc-* aliases in ~/.zshrc:
   cc-byte-agent → ~/.claude/providers/byte-agent-glm.json
   cc-byte-glm   → ~/.claude/providers/byte-glm.json
   cc-glm        → ~/.claude/providers/glm-5.2.json

🧠 智能分类(已跳过已知多模态):

  来源              alias             model                     状态
  ──────────────────────────────────────────────────────────────────
  [alias]          byte-agent-glm   glm-5.2[1m]                ✅ 文本 → 选
  [alias]          byte-glm         glm-5.2[1m]                ✅ 文本 → 选
  [alias]          glm-5.2          glm-5.2[1m]                ✅ 文本 → 选
  [cc-switch]      qwen3.6-plus     qwen3.6-plus[1m]           ⏭ 多模态 → 跳
  [cc-switch]      qwen3.7-plus     qwen3.7-plus[1m]           ⏭ 多模态 → 跳
  [cc-switch]      kimi-for-coding  kimi-for-coding[256k]      ⏭ 多模态 → 跳
  [cc-switch]      minimax-m2.7     MiniMax-M3[1m]             ⏭ 多模态 → 跳
  [cc-switch]      qwen3.7-max      qwen3.7-max[1m]            ✅ 文本 → 选
  ... (其余 8 个文本模型)

按 space 勾选要装的(已预选 12 个文本模型):

> enter (确认预选)

✅ 已装 12 个,跳过 4 个多模态
✅ 检测到 CC Switch,自动装 wrapper 到 ~/.zshrc
✅ 启动 daemon (PID 19234)

用法:
  cc-linker-proxy "看这个图"    ← 走 proxy(适用于 CC Switch 切到任何已装 provider 时)
  cc-byte-agent "看这个图"      ← 走 proxy(因为 ~/.claude/providers/byte-agent-glm.json 已改)

⚠️ wrapper 改动 ~/.zshrc,运行 source ~/.zshrc 或重开 shell 激活
```

### Test plan

| Test | Setup | Expected |
|------|-------|----------|
| Empty user (no providers, no cc-switch) | clean state | error: "未找到任何 provider 配置" (existing) |
| Manual only | `~/.claude/providers/X.json` only | install via file modification, no wrapper |
| CC Switch only | `~/.cc-switch/cc-switch.db` only | install via auto-providers, wrapper installed |
| Both | manual + cc-switch | install both, wrapper installed |
| With aliases | `~/.zshrc` has `cc-*` aliases | aliases pre-select corresponding providers |
| --all flag | mix of multimodal + text | all selected regardless of classification |
| --no-smart flag | mix | multimodal also selected |
| --dry-run | any | shows what would happen, no modifications |

---

## 16. Updated Implementation Order

(P0/P1 already shipped. P2-x are new tasks added in this revision.)

1. **P2-A: Model Classification** (~1.5h)
   - `src/img-proxy/classify.ts`: regex patterns + classifyModel()
   - Unit tests covering all built-in patterns + config override
2. **P2-B: Shell Alias Discovery** (~1.5h)
   - `src/img-proxy/aliases.ts`: discoverShellAliases() with rc file parsing
   - Unit tests covering zsh/bash syntax, comments, edge cases
3. **P2-1: resolve subcommand** (~30 min)
4. **P2-2: wrapper install/uninstall** (~1h)
5. **P2-3: wrapper generation tests** (~30 min)
6. **P2-C: Smart install flow** (~2h, depends on P2-A + P2-B)
   - Modify `imgProxyInstall` to use 4-source discovery + classification
   - Integrate classifyModel + discoverShellAliases
7. **P2-5: status with wrapper state** (~20 min)
8. **P2-4: docs** (~20 min)
9. **Manual smoke** (~20 min)
10. **Deploy + push** (~10 min)

**Total: ~9 hours** (was 3.5, now expanded for smart install features)

---

## 17. Updated Open Questions

1. **Should wrapper also handle `--settings <file>` arg?** v1: no. (env var wins anyway.)
2. **Should setup wizard auto-create `cc` alias?** v1: ask user during setup ("Want `cc` = `cc-linker-proxy`? Y/n").
3. **Should `install --mode=file` skip multimodal entirely (not even show)?** v1: still show multimodal in UI, just skip by default. User can override with --all.
4. **qwen3.7-max**: user didn't specify multimodal. Conservative: classify as text-only (proxy). User can add `vision_model_patterns_extra` if needed.
5. **mimo-v2.5-pro**: Xiaomi MiMo text variant (per user correction). mimo-v2.5 base is multimodal, mimo-v2.5-pro is text. Implemented via negative lookahead in multimodal pattern.
6. **GLM-5 series**: User confirmed GLM-5.1 is text-only (not multimodal). Removed `/^glm-5/i` from multimodal patterns; only vision variants (`glm-4v`, `glm-4.5v`, etc.) are multimodal.
6. **deepseek-v4-pro**: User didn't specify. Conservative: classify as text-only (proxy). Newer DeepSeek versions may gain vision — user can adjust.