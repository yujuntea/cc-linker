# Web IDE for cc-linker Review — Design Spec

**Date:** 2026-07-12
**Status:** Approved (pending written review)
**Author:** cc-linker
**Brainstormed from:** "Web IDE 怎么做" thread (2026-07-12)

## 1. Purpose & motivation

cc-linker's Multi-Model Review Engine today is **CLI-only** — every interaction
(start / status / cancel / abort / report / doctor / profiles) requires the user to
open a terminal, type a `cc-linker review <subcmd>` command, and read ANSI output.

This makes the review workflow feel like a 1990s CLI app: every step requires a
new shell, every piece of state lives in a different `~/.cc-linker/...` JSON file,
and there's no way to **monitor a long-running review without keeping a terminal
window open** for hours.

This spec introduces a **single-page Web IDE** that replaces all `cc-linker review`
CLI commands behind a browser surface. The goal is: **the user never needs to open
a terminal to operate the review engine** — pick a project, type a task with
@-mentions, click Start, watch progress live, cancel / abort / open report from
the same tab.

This is **not** a Monaco-in-browser code editor or a full web-based IDE. It is a
**review workflow control surface** — closer in spirit to GitHub PR review UI
than to vscode.dev.

## 2. Scope (v1)

### 2.1 In scope

Replace these `cc-linker review <subcmd>` commands with a browser UI:

| CLI command | Replaced by (Web IDE tab) |
|-------------|--------------------------|
| `cc-linker review run <task>` | **Run tab** — input form with project picker, task textarea (with @-mentions), profile/phase selectors, Start button |
| `cc-linker review status <id> --follow` | **Status tab** — live state machine view, panes, history timeline, SSE auto-updating |
| `cc-linker review cancel <id>` | Status tab `[ Cancel ]` button |
| `cc-linker review abort <id>` | Status tab `[ Abort ]` button |
| `cc-linker review report <id>` | **Report tab** — server-rendered HTML (markdown → HTML) or raw markdown |
| `cc-linker review doctor` | **Doctor tab** — one-button run, output displayed inline |
| `cc-linker review profiles` | **Profiles tab** — list installed profiles, click to view raw TOML |
| (no CLI equivalent) | **@-mention autocomplete** — type `@` in task textarea, get file-tree dropdown |

### 2.2 Out of scope (explicit YAGNI for v1)

- **Past pipelines dashboard / search / filter** — v1 only sees the live pipeline(s) plus the one whose ID the user typed. Persistent history is a separate spec.
- **Git diff viewer (file-tree + syntax-highlighted diff)** — covered by reading the report.md, which references commits. A real diff viewer is a Phase 3 thing.
- **Engine log streaming** (live tail of stdout/stderr from spawned engine child) — `~/.cc-linker/logs/` already exists for manual tail. v2.
- **Multi-user / auth / cross-machine** — v1 is single-user localhost only. SSH tunneling is the user's responsibility.
- **Auto-spawn with `cc-linker start`** — explicit invocation `cc-linker serve` only.
- **WebSocket / Service worker / offline support** — SSE suffices; service worker over-engineering for v1.
- **Monaco editor / file browser / embedded terminal** — full web IDE is a much larger Phase 3 effort.

### 2.3 Success criteria

v1 is "done" when:

1. `cc-linker serve --port 8000` starts a Bun.serve on the user's machine.
2. Opening `http://localhost:8000/` in a browser shows 5 tabs: Run / Status / Report / Doctor / Profiles.
3. From Run tab: pick cwd (manual entry or Browse), pick profile, type task with `@docs/foo.md`, click Start → engine child spawns → pipeline.json appears in `~/.cc-linker/review-pipelines/running/<id>/`.
4. From Status tab: enter pipelineId, see live state machine + panes + history timeline, auto-updating via SSE within 1s of pipeline.json mtime change.
5. From Status tab: `[ Cancel ]` kills engine child + writes ABORTED state, observable in same tab within 1s.
6. From Report tab: enter pipelineId, see rendered HTML of the report (server-side md→html). Toggle to raw markdown works.
7. From Doctor tab: enter cwd, click Run Doctor, see output inline.
8. From Profiles tab: see list of installed profiles, click one to view raw TOML.
9. Server restart during a live pipeline: server re-scans `running/`, re-attaches to alive engines, leaves orphaned engines alone (user can `review resume` to recover).

## 3. Architecture

### 3.1 Topology

```
┌─────────────┐      HTTP+SSE       ┌──────────────────┐
│  Browser    │◄──────────────────► │ cc-linker serve  │
│  (any tab)  │   /api/...          │  (Bun.serve)     │
└─────────────┘                     └────────┬─────────┘
                                              │ forkEngine(id) (per pipeline)
                                              ▼
                                     ┌──────────────────┐
                                     │ cc-linker review │
                                     │    _engine-loop  │
                                     │  (per pipelineId)│
                                     └──────────────────┘
                                              │
                                              ▼
                                  ~/.cc-linker/review-pipelines/
                                  running/<id>/pipeline.json  ← truth
```

`cc-linker serve` is a long-lived process supervisor. Each pipeline is a
`forkEngine(id)` invocation (existing in `src/review/engine-process.ts`),
which under the hood `Bun.spawn`s `bun run src/index.ts review _engine-loop <id>`
with `CC_LINKER_REVIEW_ENGINE_CHILD=1`. Server tracks `{pid, pipelineId}` in
memory for cancel/abort and to re-attach on restart.

**Single source of truth for state**: `~/.cc-linker/review-pipelines/<bucket>/<id>/pipeline.json`.
Server reads/writes these — no new state file, no daemon-to-daemon IPC.

### 3.2 Process supervision

| Scenario | Behavior |
|----------|----------|
| Server start, no orphans | Read `running/`, find alive engine children (PID file or in-memory Map), re-attach SSE listeners |
| Server start, orphan found (pipeline.json exists in `running/` but no alive child) | Leave pipeline in `running/`. User can `review resume <id>` to fork new engine |
| Two `cc-linker serve` instances | First binds port; second fails with EADDRINUSE; user sees clear error message |
| Server SIGKILL during live pipeline | Engine children survive; on next `cc-linker serve`, re-scan finds them, re-attaches |
| Cancel from web | Server calls `killEngine(id)` (existing helper) which `process.kill(pid, SIGTERM)` → wait 3s → `SIGKILL` if still alive; then runs existing `cancelOrAbort(id, 'user_cancelled')` to write ABORTED state |
| Abort from web | Same as cancel but with `'user_aborted'` reason |
| In-memory `Map<pipelineId, EngineChild>` | Cleared when pipeline reaches terminal state (DONE / FAILED / ABORTED). On server restart, re-built from `running/` scan |

### 3.3 What the server does NOT do

- Doesn't render reports client-side (server-side only, returns HTML string)
- Doesn't touch `~/.cc-linker/registry.json` (review-pipelines is self-contained)
- Doesn't replace the Feishu bot or any other CLI command — only ADDS a web surface
- Doesn't auto-start with `cc-linker start` — explicit invocation only
- Doesn't run a daemon coordinator (no `owner.lock`); port conflict detection only

## 4. API surface

All routes prefixed `/api/` and `/` for HTML.

### 4.1 HTML (server-rendered)

| Method+Path | Purpose |
|------|---------|
| `GET /` | Single-page shell (vanilla HTML + inline JS + inline CSS) — tabs: Run / Status / Report / Doctor / Profiles |
| `GET /static/*` | None (all inlined in `/`) |

### 4.2 Read APIs (JSON)

| Method+Path | Returns |
|------|---------|
| `GET /api/health` | `{ok: true, version, started_at}` |
| `GET /api/profiles` | `["default", "code-only", ...]` from `~/.cc-linker/review-profiles/*.toml` |
| `GET /api/profiles/:name` | raw TOML text |
| `GET /api/pipelines/running` | `["01HX...", ...]` pipeline IDs in `running/` |
| `GET /api/pipelines/queued` | `["01HZ..."]` |
| `GET /api/pipelines/done` | recent N (default 20) |
| `GET /api/pipelines/aborted` | recent N (default 20) |
| `GET /api/pipelines/failed` | recent N (default 20) |
| `GET /api/pipelines/:id` | full `PipelineRecord` JSON |
| `GET /api/pipelines/:id/report?format=md\|html` | report markdown OR rendered HTML |
| `GET /api/pipelines/:id/log?tail=100` | best-effort tail of engine log (returns `null` if log missing) |
| `GET /api/fs/list?path=X&depth=3` | JSON tree for @-autocomplete (excludes node_modules, .git, dist) |
| `GET /api/doctor?cwd=X` | doctor output text |

### 4.3 Write APIs

| Method+Path | Body | Action | Returns |
|------|-------|--------|---------|
| `POST /api/run` | `{cwd, task, phase?, profile?, max_rounds?}` | Create pipeline.json via `PipelineStore.create`; if targetBucket = `running`, call `forkEngine(id)` | `{pipelineId, targetBucket: 'running' \| 'queued'}` |
| `POST /api/cancel/:id` | (none) | Kill engine child + write ABORTED | `{ok: true}` |
| `POST /api/abort/:id` | (none) | Same as cancel but with `user_aborted` reason | `{ok: true}` |
| `POST /api/resume/:id` | (none) | If `running/` and engine dead → fork engine | `{ok: true}` |

### 4.4 SSE streams

| Method+Path | Pushes |
|------|---------|
| `GET /api/pipelines/:id/events` | On `pipeline.json` mtime change → push full JSON. Pushes `done` event on terminal state. Auto-close after 5min idle. Server tracks subscribers per pipelineId; cleared on terminal or disconnect. |

Server SSE implementation uses `Bun.serve` streaming response
(`new Response(stream, { headers: { 'content-type': 'text/event-stream' } })`).
File watcher: `fs.watch(pipelineJsonPath, ...)` per active subscription.

### 4.5 Process tracking (in-memory only)

```typescript
type EngineChild = {
  pid: number;
  spawnedAt: number;
  cwd: string;
};
const engineChildren = new Map<pipelineId, EngineChild>();
```

Cleared on terminal state. Server restart → empty Map → re-scan `running/`
finds alive engines → re-attach.

## 5. UI tabs (single-page, vanilla HTML+JS)

### 5.1 Run tab

```
Project (cwd)         [ manual input / Browse button ]
Profile               [ dropdown: default ▼ ]
Phase                 [ auto / spec / plan / code ]  (default = auto)
Max rounds            [ 3 ]  (default from profile)
Task                  [ textarea: "按照 @docs/spec.md 完成..."  + @-autocomplete ]

[ Start Review ]

─── Live status (after start) ───
Pipeline: 01HX...     State: EXTERNAL_REVIEW  R3
Work pane:   qwen3.7     (running 1m 02s)
Review pane: minimax-m3  (idle, waiting)
History: PRODUCING → R1 → R2 → EXTERNAL_REVIEW
[ Cancel ] [ Abort ] [ View Report ]
```

@-mention autocomplete: type `@` → popup lists files from `/api/fs/list?path=cwd&depth=3`,
fuzzy filter on substring. Click inserts `@<relative-path>`. ~50 LOC inline JS.

### 5.2 Status tab

```
Pipeline ID   [ 01HX... ]   [ SSE auto-stream (default on) ]

State: PRODUCING (round 2)
Started: 2026-07-12T14:23  Elapsed: 4m 12s

Panes:
 • work    qwen3.7    bg=01HX...  (running 1m 02s)
 • review  minimax-m3 bg=01HX...  (idle, waiting)

History timeline:
 14:23:01  PRODUCING → SELF_REVIEW_R1   work
 14:25:14  SELF_REVIEW_R1 → FIXING       work   (3 P2)
 14:25:14  FIXING → SELF_REVIEW_R2       work
 14:28:02  SELF_REVIEW_R2 → EXTERNAL_REVIEW

[ Cancel ] [ Abort ] [ Resume ] [ Open Report ]
```

### 5.3 Report tab

```
Pipeline ID   [ 01HX... ]   [ Load ]
Format:        (•) HTML  ( ) Markdown

╔══ rendered report ════════════════════════════════╗
║ # Pipeline Report                                 ║
║ ## Summary                                        ║
║ ... rendered markdown ...                          ║
╚═══════════════════════════════════════════════════╝
```

### 5.4 Doctor tab

```
CWD: [ /Users/.../Git/cc-linker ]   [ Run Doctor ]

╔══ doctor output ═════════════════════════════════╗
║ ✓ CLI version 2.5.x                              ║
║ ✓ daemon not running                              ║
║ ✓ profile 'default' loadable                      ║
║ ✓ working tree clean                              ║
╚═══════════════════════════════════════════════════╝
```

Server shells out to `bun run src/index.ts review doctor --cwd X`,
captures stdout, displays inline.

### 5.5 Profiles tab

```
Installed profiles (from ~/.cc-linker/review-profiles/)
 • default
 • code-only
 • spec-only

Click to view:
┌── default.toml ──────────────────────────────────┐
│ [meta]                                           │
│ name = "default"                                 │
│ ... raw TOML ...                                 │
└──────────────────────────────────────────────────┘
```

## 6. Cross-cutting behaviors

- **No auth**: localhost-only; user responsible for SSH tunneling if exposing
- **No multi-user**: single-user single-machine
- **CORS**: open `*` (browsers on same machine only)
- **Static caching**: `GET /` is `Cache-Control: no-cache` (UI changes often during dev)
- **Errors**: server returns JSON `{error: "...", code: "..."}` with appropriate HTTP status (4xx for client errors, 5xx for server errors); UI surfaces via toast / inline error block
- **Phase default in Run tab**: auto-detect from task via existing `detect()` with override dropdown — match CLI behavior
- **Resume button on Status tab**: include `[ Resume ]` for `running/` pipelines whose engine died (cheap, surfaces recovery path)

## 7. File layout

```
src/review/
  serve.ts              ~280 LOC  Bun.serve entrypoint + route handlers + process supervisor
  serve-pages.ts        ~250 LOC  HTML/CSS/JS templates (exported string-returning functions)
  markdown.ts           ~50  LOC  Regex-based md→html renderer
  serve-utils.ts        ~70  LOC  File tree walker, log tail helper, error envelope

src/cli/commands/
  review.ts             +30  LOC  Add `review serve [--port N]` subcommand

tests/unit/review/
  serve.test.ts         ~150 LOC  Route + handler tests (with tmp PipelineStore)
  markdown.test.ts      ~50  LOC  Snapshot-style tests for md renderer
  serve-utils.test.ts   ~50  LOC  File tree exclusion tests

docs/superpowers/specs/
  2026-07-12-web-ide-design.md   ← this file
```

**Total new code**: ~880 LOC production + ~250 LOC tests.

**No new dependencies** in `package.json`. **No new build steps**.

## 8. Module dependencies

```
serve.ts
  ├─► PipelineStore (existing)         read/write pipeline.json
  ├─► loadProfile (existing)           for /api/profiles
  ├─► runDoctor (existing)             for /api/doctor
  ├─► renderReport (existing)          for /api/pipelines/:id/report?format=md
  ├─► forkEngine / killEngine / isEngineAlive (existing engine-process.ts)
  ├─► serve-pages.ts                   for /
  ├─► markdown.ts                      for HTML format
  └─► serve-utils.ts                   for fs list, log tail

serve-pages.ts    (no deps; pure string templates)
markdown.ts       (no deps; pure function)
serve-utils.ts    (no deps; pure functions)
```

## 9. Implementation plan (T1–T10)

| Task | Description | LOC | Verification |
|------|-------------|-----|--------------|
| T1 | `markdown.ts` + `markdown.test.ts` | 50+50 | `bun test markdown` passes |
| T2 | `serve-utils.ts` + tests | 70+50 | `bun test serve-utils` passes |
| T3 | `serve-pages.ts` (5 tab HTML strings) | 250 | visual smoke: `GET /` returns 200 with all 5 tab IDs |
| T4 | `serve.ts` skeleton + `/api/health` + `/` route | 80 | `curl http://localhost:8000/api/health` works |
| T5 | Read APIs (5 endpoints) + tests | 100 | `curl /api/profiles` returns list |
| T6 | `POST /api/run` + spawn + supervisor | 60 | `curl -X POST` starts real pipeline |
| T7 | Cancel/Abort/Resume + tests | 50 | `curl` kills engine, writes ABORTED |
| T8 | SSE stream + tests | 50 | EventSource client receives push on pipeline.json mtime change |
| T9 | `review serve` CLI subcommand + rebuild `dist/cc-linker` | 30 | `cc-linker review serve --port 8000` works |
| T10 | E2E: full flow in browser (manual smoke) | — | screenshot + walkthrough |

## 10. Testing strategy

### 10.1 Unit tests (`bun test`)

`markdown.test.ts`:
- headings (`#`, `##`, `###`)
- bullet lists (`-`)
- bold (`**x**`)
- inline code (`` `x` ``)
- code fences (` ``` `)
- links `[text](url)`
- HTML escape (no XSS): `<script>alert(1)</script>` → `&lt;script&gt;...`

`serve-utils.test.ts`:
- `listFiles('/tmp', 2)` excludes `node_modules`, `.git`, `dist`
- `tailLog(path, 100)` returns last N lines; handles missing file → `null`

`serve.test.ts` (with tmp `PipelineStore`):
- `GET /api/health` → 200 JSON `{ok: true}`
- `GET /api/profiles` → array of names from test fixture profiles dir
- `GET /api/pipelines/:id` → 404 if missing, full JSON if present
- `POST /api/run` → spawns child, returns `{pipelineId, targetBucket}`
- `POST /api/cancel/:id` → kills child, writes ABORTED
- `GET /api/pipelines/:id/events` (SSE) → opens stream, receives push on file change

### 10.2 Manual smoke (out of CI)

1. `bun run src/index.ts review serve --port 8000`
2. Open `http://localhost:8000/` in browser
3. Walk through all 5 tabs: Run → Status → Report → Doctor → Profiles
4. Start a real review (use `/tmp/review-smoke` like acceptance testing)
5. Verify live SSE updates stream to Status tab
6. Cancel from web → verify ABORTED state written within 1s
7. Open report → verify HTML rendering looks reasonable

### 10.3 Verification gate (per CLAUDE.md Change Delivery Gate)

Before claiming v1 done:
1. All unit tests pass — actual `bun test` output shown, not "should pass"
2. `bun run typecheck` clean
3. Manual smoke walkthrough all 5 tabs (screenshot evidence in PR description)
4. Real `cc-linker review run` started from web, reaches terminal state, report renders in browser
5. `dist/cc-linker` rebuilt with `bun build src/index.ts --outfile dist/cc-linker --target bun --external bun`
6. No new `console.log` in library code; `console.error` / `logger.*` allowed

## 11. Risk & mitigation

| Risk | Mitigation |
|------|-----------|
| **Port conflict with other local servers** | Default port 8000; `--port` flag. EADDRINUSE → clear error: "port 8000 in use; try --port 8001" |
| **Spawned engine child survives server crash** | On next `cc-linker serve` startup, re-scan `running/`, find alive engines, re-attach to their PIDs. Orphaned engines (PID dead but pipeline in `running/`) left alone — user can `review resume` |
| **XSS via malicious markdown** | `markdown.ts` HTML-escapes ALL user input before injecting tags. Code fence content escaped, never `eval`'d. Test includes `<script>` injection case |
| **SSE connection leaks** | Server sets `Connection: close`. Client `EventSource` auto-reconnects with backoff. Server logs connection count; subscribers cleared on terminal or disconnect |
| **In-memory Map grows unbounded** | Cleared on terminal state (DONE / FAILED / ABORTED). Verified by `pipeline.json` read showing terminal kind |
| **Markdown renderer drift** | Renderer covers only the report.md subset (headings, bullets, bold, code, fences, links). No extensions. If report.md format evolves beyond subset, fail loudly with `unsupported markdown syntax` error rather than silently mis-rendering |
| **Browser cache holds stale UI** | `GET /` sends `Cache-Control: no-cache`. API responses are JSON (no caching by default) |

## 12. Out-of-scope (deferred)

Each of these is a separate spec when the need arises:

- **Past pipelines dashboard / search** — would need persistent UI history + filter UI + click-to-view
- **Git diff viewer (Monaco DiffEditor or similar)** — needs file-tree walker + syntax-highlighting + side-by-side layout
- **Engine log streaming** — would need file-tail SSE on engine log path
- **Multi-user / auth** — would need login flow + per-user state separation
- **Auto-spawn with `cc-linker start`** — would need orchestration coordination between two daemon types
- **WebSocket** — SSE suffices; no need for bi-directional channel
- **Service worker / offline** — over-engineering for v1
- **Phase 3 full Web IDE** — Monaco editor, file browser, embedded terminal — much larger scope

## 13. Acceptance criteria summary

A reviewer can independently verify v1 by:

1. Running `bun run src/index.ts review serve --port 8000`.
2. Opening `http://localhost:8000/` and confirming 5 tabs render.
3. From Run tab: typing a task referencing `@docs/...`, clicking Start.
4. Watching Status tab auto-update via SSE.
5. Clicking Cancel → pipeline transitions to ABORTED within 1s.
6. From Report tab: loading pipelineId → seeing rendered HTML.
7. From Doctor tab: running against `/tmp/review-smoke` → seeing green checks.
8. From Profiles tab: clicking `default` → seeing raw TOML.
9. Restarting server while pipeline is running → pipeline re-attaches (or stays in `running/` if engine died during the gap).

If all 9 pass, v1 ships.