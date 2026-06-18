# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Tech Stack

This is a **Bun** project. Do not use Node.js tools.

- `bun <file>` — run TypeScript directly
- `bun test` — run tests (uses `bun:test`)
- `bun test --coverage` — with coverage
- `bun run typecheck` — `tsc --noEmit`
- `bun run build` — compile to `dist/cc-linker` standalone binary
- `bun run dev <cmd>` — run a CLI command in dev mode, e.g. `bun run dev list`

Bun loads `.env` automatically — do not use `dotenv`.

## Project Overview

cc-linker bridges Feishu (Lark) IM and Claude Code CLI sessions. It maintains a unified session registry so users can start a conversation in Feishu and continue it in the terminal (or vice versa).

**Two runtime modes:**

1. **CLI commands** (`cc-linker <cmd>`) — registry management, session resume, sync, export
2. **Feishu Bot** (`cc-linker start`) — WebSocket bot that receives Feishu messages and proxies them to Claude Code CLI

## High-Level Architecture

### Session Registry

The single source of truth is `~/.cc-linker/registry.json` (v2 schema), managed by `RegistryManager` (`src/registry/`).

- **File locking**: All writes go through `proper-lockfile` (`src/utils/lock.ts`). Reads use read locks.
- **Backups**: Every write creates a rotated backup (max 3) in `~/.cc-linker/backups/`.
- **Migrations**: `migrateV1toV2` in `src/registry/registry.ts`. Bump version and add migration when changing schema.
- **SessionEntry fields**: `origin` (`'cli'` | `'feishu'`), `cwd`, `jsonl_path`, `project_name`, `status`, `title`, `message_count`, plus Feishu-specific fields.

### Scanner & Sync

`syncBeforeCommand()` (`src/scanner/index.ts`) runs before most CLI commands to keep the registry fresh:

1. `JSONLScanner` scans `~/.claude/projects/*/*.jsonl` for Claude Code sessions
2. Reads incremental cache from `~/.cc-linker/scan_cache.json` to skip unchanged files
3. Updates registry entries with latest `last_active`, `message_count`, `title`
4. Single flush + backup write at the end

Use `--no-sync` to skip (some commands support this). Use `--force` to clear cache and do full rescan.

### Feishu Bot Architecture

The bot (`src/feishu/bot.ts`) is NOT a simple request handler. It uses a **durable file-based queue** for message processing:

```
Feishu WSClient → onMessage() → SpoolQueue.enqueue()
                                     ↓
                              dispatch() worker pool
                                     ↓
                           handleClaimed()
                              /bridge cmd → handleCommand()
                              chat msg    → handleChat() → ClaudeSessionManager
```

**Key design points:**

- `SpoolQueue` (`src/queue/spool.ts`) persists messages as JSON files across directories: `pending/` → `processing/` → `replied/`/`done/`/`failed/`. This survives process restarts.
- `serialKey` groups messages by session UUID (or `new:${openId}`), ensuring messages for the same session are processed serially.
- Worker concurrency is controlled by `queue.worker_concurrency` (default 5).
- On startup, `startupReconcile()` (`src/runtime/reconciler.ts`) recovers any `processing` messages back to `pending`.

### Slash Command Passthrough (v2.5)

cc-linker 命令 (`/list /switch /help /resume /model /status /agents /stop /cancel /listdir /new /whoami`) 优先处理；其他 `/xxx` 作为 prompt 文本透传给当前会话的 Claude，由 model 自行识别（model 已训练识别 /init /review /cost 等内置命令）。无活跃会话时与普通聊天文本一致：提示需要先 `/new`。自定义命令 `~/.claude/commands/*.md` 不展开（与 `claude -p` 模式对齐）。Known limitation: 两次 `/xxx` 到同 session 不互锁（serialKey 不同），靠 busy check + force-send 显式确认兜底。

### Session Proxy & Streaming

`ClaudeSessionManager` (`src/proxy/session.ts`) spawns Claude CLI processes:

```typescript
// Non-streaming
const args = ['claude', '-p', text, '--output-format', 'json'];
if (sessionId && !isNew) args.push('--resume', sessionId);

// Streaming
const args = ['claude', '-p', text, '--output-format', 'stream-json'];
```

**Streaming flow** (`handleChatStreaming` in bot.ts):

1. Spawn Claude with `--output-format stream-json`
2. `StreamParser` (`src/proxy/stream-parser.ts`) parses each stdout line as JSON:
   - `type: "assistant"` + `content[].type: "thinking"` → thinking text
   - `type: "assistant"` + `content[].type: "text"` → response text
   - `type: "result"` → final result with cost, session_id, etc.
3. `CardUpdater` (`src/feishu/card-updater.ts`) sends interactive cards to Feishu, throttled by `stream.throttle_ms` (default 1500ms).
4. Cards transition: `processing` → `streaming` → `complete`/`error`.

**Process cleanup**: `terminateProcessTree()` sends SIGTERM to the process group, then SIGKILL after 3s. `cleanupOrphanProcesses()` kills stray `claude -p` processes on bot startup.

### User State & CAS

`UserManager` (`src/feishu/mapping.ts`) manages per-openId state in `~/.cc-linker/user-mapping.json`:

- `type: 'session'` — user has an active session
- `type: 'pending_new_session'` — user ran `/bridge new` without a prompt, waiting for next message
- `type: 'pending_new_session_claimed'` — message claimed, Claude process spawning

All updates use **compare-and-swap (CAS)** with `casToken` to prevent race conditions between concurrent workers. The `entriesMatch()` function compares `type`, `sessionUuid`, `cwd`, and `casToken` — it does NOT compare `defaultProvider`.

### State Coordination

`StateCoordinator` (`src/runtime/state-coordinator.ts`) uses an `owner.lock` file to ensure only one bot process runs at a time:

- `tryAcquire()` — creates lock with PID; fails if another live process holds it
- `isLocked()` — checks if bot is running (used by CLI commands)
- `assertNotRunning()` — throws E013 if bot is running; CLI write commands use this to prevent conflicts

### CLI Command Structure

Commands are in `src/cli/commands/`. Most follow this pattern:

```typescript
// 1. Sync registry
await syncBeforeCommand(registry);
// 2. Do work
// 3. RegistryManager auto-flushes on modify
```

The `withSync()` helper in `src/index.ts` wraps this. Some commands skip sync with `--no-sync`.

### Agent View (Remote Session Takeover)

`src/agent-view/` lets users from Feishu inspect and steer any background `claude` session running on the terminal. **Primary data source is `~/.claude/jobs/<short>/state.json`** (the Claude CLI's authoritative state machine — covers `running` / `working` / `blocked` / `done` / `stopped`). The CLI's `claude agents --json` is kept only as a smoke test; in v2.1.163 it returns `status: "idle"` for every background session and is no longer trustworthy as a status source. `claude logs <shortId>` is the Tier-3 Peek fallback; `claude stop <shortId>` is still the per-session stop primitive.

- `AgentSnapshotFetcher.fetch()` (`snapshot-fetcher.ts`) version-guards via `VersionGuard`, daemon-presence-checks via `DaemonProbe`, runs `claude agents --json` as a smoke test (return value discarded), then reads `~/.claude/jobs/*/state.json` via `readAllJobStates()` (`job-state.ts`), maps each envelope to `AgentSession[]` via `jobStateToSession()` (waiting/busy/idle/completed with 🛑 / ✅ prefixes), attaches `dispatch.source` from `roster.json` + `daemon.log` `bg claimed-spare` tail, and falls back to `deriveNameFromJsonl` only when `state.json.name` is null (cold path).
- `AgentViewManager` (`manager.ts`) owns the user-facing flow: `handleList` → `handlePeek` → `handleReplyRequest` (Step A) → `handleReply` (Step B, re-runs status guard) → `handleStop` (with `handleStopConfirm` two-step) → `handleAttach`. Step B re-fetches the snapshot before proxying the user's reply text through `runChatSDK` to defend against a status flip between the click and the text.
- `ExpectedReplyState` (`expected-reply-state.ts`) persists `pending_agent_reply` in `user-mapping.json` with CAS, sets a 5-minute timeout, and restores on bot startup.
- Card builders (`card.ts`) emit Feishu interactive cards; `Refresh` actions are debounced by 2s and the original `messageId` is verified before patching to avoid stomping on an already-overwritten card.
- All knobs (debounce, peek tail, reply timeout, min Claude version, etc.) live in `[agent_view]` in `config.toml` with env var overrides (see `src/utils/config.ts`).

## Key Patterns

**Error handling**: Use `CCLinkerError(code, message)` from `src/utils/errors.ts`. Error codes have user-facing suggestions in `handleError()`.

**Path expansion**: `expandPath()` handles `~` → `$HOME`. Always use it for user-provided paths.

**Config**: `config.toml` at `~/.cc-linker/config.toml`. Access via `config.get<string>('section.key', defaultValue)`. Many keys have env var overrides (see `src/utils/config.ts`).

**Logging**: Use `logger.info/warn/error/debug()` from `src/utils/logger.ts`. Never `console.log` in library code; CLI commands may use `console.log` for user output.

**Zod validation**: Registry uses Zod schemas (`src/registry/types.ts`). Always validate external data.

**File I/O**: Prefer `Bun.file()` and `Bun.write()` over `node:fs` where possible. Use atomic writes (write to `.tmp` then `renameSync`) for critical files.

## Important Files

| File | Purpose |
|------|---------|
| `src/index.ts` | CLI entry (Commander), command registration |
| `src/feishu/bot.ts` | FeishuBot — message routing, command handling, chat proxy |
| `src/proxy/session.ts` | ClaudeSessionManager — spawn Claude CLI, handle stdout/stderr |
| `src/proxy/stream-parser.ts` | Parse Claude's `stream-json` output |
| `src/feishu/card-updater.ts` | Update interactive cards during streaming |
| `src/queue/spool.ts` | Durable file-based message queue |
| `src/registry/registry.ts` | Registry read/write with locking and backups |
| `src/feishu/mapping.ts` | User state with CAS updates |
| `src/runtime/state-coordinator.ts` | Single-process lock |
| `src/scanner/index.ts` | Pre-command sync orchestration |
| `src/agent-view/manager.ts` | AgentViewManager — `/agents` list / Peek / Reply / Stop / Attach flow |
| `src/agent-view/snapshot-fetcher.ts` | Pipeline orchestrator — VersionGuard / DaemonProbe / smoke-test → readAllJobStates → mapping → source attribution |
| `src/agent-view/job-state.ts` | `readJobState` / `readAllJobStates` / `jobStateToSession` — `~/.claude/jobs/<short>/state.json` primary reader (v2.3) |
| `src/agent-view/expected-reply-state.ts` | Per-user `pending_agent_reply` slot (CAS-protected) |
| `src/agent-view/card.ts` | Feishu interactive card builders (list / peek / waiting / stop-confirm / error / empty) |
| `src/utils/config.ts` | Config manager with env overrides |
| `src/utils/paths.ts` | All path constants |

## Testing

```bash
bun test                           # all tests
bun test tests/unit/scanner/       # specific directory
bun test --test-name-pattern="scan" # by name
bun test --coverage
```

Tests use `bun:test`. Fixtures are in `tests/fixtures/`.

## Running the Bot Locally

```bash
# Foreground (dev)
bun run dev start

# Background daemon
bun run dev start --daemon

# Check status
bun run dev daemon status

# Stop
bun run dev stop
```

The bot requires `feishu_bot.app_id` and `feishu_bot.app_secret` in `config.toml`. Use `cc-linker init-feishu` for interactive setup.
