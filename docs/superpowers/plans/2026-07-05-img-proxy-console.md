# cc-linker img-proxy Web Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 `cc-linker img-proxy` daemon 提供单机本机 Web Console（5 个 Tab：Dashboard / Log / Config / Routes / Cache），覆盖实时监控、历史日志查询、运行时配置、运行时运维。

**Architecture:** 在 Bun.serve 同进程追加 console 路由分发（`/` + `/admin/api/*`），daemon 启动时总是 mount handler，handler 内读最新 config 决定是否启用 console。所有 HTML/CSS/JS 内嵌进 `INDEX_HTML` 常量（零依赖零构建）。Stats 用内存聚合（byStatus / byAlias / 200 条 recent 环形），历史 log 直接 parse 现有 `~/.cc-linker/img-proxy/img-proxy.log`。

**Tech Stack:** Bun (runtime + test + bundler), TypeScript strict mode, `@iarna/toml` (已用), `proper-lockfile` (已用), vanilla JS (内嵌进 HTML 字符串).

**Spec:** `docs/superpowers/specs/2026-07-05-img-proxy-console-design.md`（commit `131197b`）

## Global Constraints

- Bun runtime — 用 `bun test`, `bun run typecheck`, `bun run build`；不用 Node.js 工具
- TypeScript strict mode —— 所有新文件 `.ts`；不要 `any` 除非明确需要
- 不要引入新依赖（vanilla JS + 内嵌 + @iarna/toml + proper-lockfile 已够）
- 所有 console 代码集中在 `src/img-proxy/console/` 目录，方便回滚
- 后端写操作必须 audit log（`appendLog('INFO {json}', logPath)`）
- 写文件用 atomic write（write to `.tmp` + `renameSync`），失败要 rollback
- 写 routes.json 用现有 `withRoutesLock`（proper-lockfile）
- 错误返回统一格式：`{ error: string, code: 'E_CONSOLE_*' }`
- 每 task 末尾独立 commit（conventional commits `feat(img-proxy-console):` / `test(img-proxy-console):` / `docs(img-proxy-console):`）
- 验证：`bun test tests/unit/img-proxy/console/ tests/integration/img-proxy-console.test.ts` + `bun run typecheck` 必须全过

---

## File Structure

### 新增（10 个）

```
src/img-proxy/console/
  ├── types.ts             # 共享类型:LogEntry / ParsedLogEntry / AliasStats / RecentEntry / HealthStats / RouteListEntry / ReadRecentOpts (~80 行) — Task 1
  ├── stats-helpers.ts     # updateByAlias + pushRecent (~40 行) — Task 1
  ├── log-parser.ts        # LogEntry 解析 + readRecentLogLines + LogTail singleton (~100 行) — Task 4
  ├── api.ts               # handleConsoleRequest + 9 endpoint + getCacheBytes (~280 行) — Task 5+6
  └── html.ts              # INDEX_HTML 常量(~250 行:HTML + 内嵌 CSS + 内嵌 JS) — Task 7

tests/unit/img-proxy/console/
  ├── stats-helpers.test.ts   # Task 1
  ├── log-parser.test.ts      # Task 4
  ├── health.test.ts          # Task 5
  └── html.test.ts            # Task 7

tests/unit/img-proxy/
  └── routes-disable.test.ts  # Task 3

tests/unit/utils/
  └── config-reload.test.ts   # Task 2

tests/integration/img-proxy-console.test.ts  # Task 6 + Task 8
```

### 改动（4 个）

```
src/img-proxy/server.ts       # stats 字段扩展 + console 路由分发 + handleConsoleRequest — Task 8
src/utils/config.ts           # 加 reload() public 方法 — Task 2
src/img-proxy/routes.ts       # 改 getUpstreamByAlias + 加 setRouteDisabled + 改 addRoute — Task 3
src/cli/commands/img-proxy.ts # 接线新参数 + 传 expandPath(CONFIG_PATH) — Task 9
```

### 改动 docs（1 个）

```
docs/img-proxy.md             # 替换 line 873 "Phase 2 未实现" 段为 Web Console 章节 — Task 10
```

**总：~1300 行**（包含测试）

---

## Task 依赖图

```
T1 (types + stats helpers, no deps)
T2 (config reload, no deps)
T3 (routes disable, no deps)
T4 (log-parser, no deps) ──────────────────┐
T5 (cacheBytes, no deps) ──────────────────┤
T7 (html template, no deps) ───────────────┤
                                          ├─→ T6 (console api endpoints, depends T1+T2+T3+T4+T5)
T8 (server.ts mount handler, depends T6+T1)│
T9 (cli 接线, depends T8)                  │
T10 (docs 更新, depends T8+T9)             │
T11 (最终验证, depends T1-T10)             │
```

> **注**：原 plan 提到 T7 (config-reload writer)，合并到 T6 `handlePostConfig` 里。T7 现指 html template。

---

## Task 1: console/types.ts + stats helpers

**Files:**
- Create: `src/img-proxy/console/types.ts`（共享类型：LogEntry / ParsedLogEntry / AliasStats / RecentEntry / HealthStats / RouteListEntry / ReadRecentOpts）
- Create: `src/img-proxy/console/stats-helpers.ts`（`updateByAlias` / `pushRecent` 函数,从 types.ts 导入类型）
- Test: `tests/unit/img-proxy/console/stats-helpers.test.ts`

**Interfaces:**
- Produces:
  - `console/types.ts` 导出所有共享类型（这是后续 task 4/6/8 都 import 的源）
  - `console/stats-helpers.ts` 导出 `updateByAlias` / `pushRecent`
- Consumes: 无（基础任务）

> **为什么这个 task 是 Task 1**：所有 console 模块共用 types.ts;stats-helpers 的类型也在 types.ts;Task 4/6/8 都依赖它,放最前面避免循环依赖。

### Steps

- [ ] **Step 1: 写 failing 测试**

```ts
// tests/unit/img-proxy/console/stats-helpers.test.ts
import { describe, it, expect } from 'bun:test';
import { updateByAlias, pushRecent } from '../../../../src/img-proxy/console/stats-helpers';
import type { AliasStats, RecentEntry } from '../../../../src/img-proxy/console/types';

describe('stats helpers', () => {
  it('updateByAlias: 增量更新 byAlias 聚合', () => {
    const stats = { byAlias: {} as Record<string, AliasStats> };
    updateByAlias(stats, 'glm-5.2', { requests: 1, stripped: 2, bytes: 100, chunks: 3, durationMs: 200 });
    updateByAlias(stats, 'glm-5.2', { requests: 1, stripped: 0, bytes: 200, chunks: 5, durationMs: 400 });
    expect(stats.byAlias['glm-5.2']).toEqual({
      requests: 2, stripped: 2, bytes: 300, chunks: 8, avgDurationMs: 300, lastAt: expect.any(Number),
    });
  });

  it('updateByAlias: 首次 alias 创建 entry', () => {
    const stats = { byAlias: {} as Record<string, AliasStats> };
    updateByAlias(stats, 'byte-agent', { requests: 1, stripped: 0, bytes: 50, chunks: 1, durationMs: 100 });
    expect(stats.byAlias['byte-agent']).toBeDefined();
    expect(stats.byAlias['byte-agent']!.requests).toBe(1);
  });

  it('pushRecent: unshift + 200 cap', () => {
    const stats: { recent: RecentEntry[] } = { recent: [] };
    for (let i = 0; i < 250; i++) pushRecent(stats, { ts: i, alias: 'x', status: 200, stream_status: 'complete', chunks: 0, bytes: 0, duration_ms: 0, stripped: 0 });
    expect(stats.recent.length).toBe(200);
    expect(stats.recent[0]!.ts).toBe(249); // 最新在头部
    expect(stats.recent[199]!.ts).toBe(50); // 最旧在尾部
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/unit/img-proxy/console/stats-helpers.test.ts`
Expected: FAIL "Cannot find module"

- [ ] **Step 3a: 实现 types.ts**

```ts
// src/img-proxy/console/types.ts

/** Per-alias 聚合(stats.byAlias[k] 的值类型) */
export interface AliasStats {
  requests: number;
  stripped: number;
  bytes: number;
  chunks: number;
  avgDurationMs: number;
  lastAt: number;
}

/** 环形 buffer 元素(stats.recent[] 元素类型) */
export interface RecentEntry {
  ts: number;
  alias: string;
  status: number;
  stream_status: string;
  chunks: number;
  bytes: number;
  duration_ms: number;
  stripped: number;
}

/** Log 文件解析后条目(Task 4 用) */
export interface ParsedLogEntry {
  alias: string;
  method: string;
  path: string;
  stripped: number;
  upstream_status: number;
  duration_ms: number;
  headers_to_first_chunk_ms?: number;
  chunks?: number;
  bytes?: number;
  stream_status: string;
  upstream_error_msg?: string | null;
}

export interface LogEntry {
  /** Date.parse(ISO timestamp from log line prefix) → ms timestamp */
  ts: number;
  /** 原始行 */
  raw: string;
  parsed: ParsedLogEntry | null;
}

export interface ReadRecentOpts {
  logPath: string;
  limit?: number;
  alias?: string;
  status?: number;
  streamStatus?: string;
  sinceMs?: number;
}

/** GET /admin/api/health 响应(Task 6 用) */
export interface HealthStats {
  uptimeMs: number;
  pid: number;
  routeCount: number;
  cacheFiles: number;
  cacheBytes: number;
}

/** GET /admin/api/routes 响应(Task 6 用) */
export interface RouteListEntry {
  alias: string;
  upstream: string;
  installed_at: string;
  disabled: boolean;
}
```

- [ ] **Step 3b: 实现 stats-helpers.ts**

```ts
// src/img-proxy/console/stats-helpers.ts
import type { AliasStats, RecentEntry } from './types';

export function updateByAlias(
  stats: { byAlias: Record<string, AliasStats> },
  alias: string,
  m: { requests: number; stripped: number; bytes: number; chunks: number; durationMs: number }
): void {
  const a = stats.byAlias[alias] ??= { requests: 0, stripped: 0, bytes: 0, chunks: 0, avgDurationMs: 0, lastAt: 0 };
  const prevRequests = a.requests;
  a.requests += m.requests;
  a.stripped += m.stripped;
  a.bytes += m.bytes;
  a.chunks += m.chunks;
  // 增量平均:(旧avg × 旧n + 新duration × 新n) / 新n
  a.avgDurationMs = (a.avgDurationMs * prevRequests + m.durationMs * m.requests) / a.requests;
  a.lastAt = Date.now();
}

export function pushRecent(
  stats: { recent: RecentEntry[] },
  entry: RecentEntry
): void {
  stats.recent.unshift(entry);
  if (stats.recent.length > 200) stats.recent.length = 200;
}
```

- [ ] **Step 4: 跑测试确认 pass**

Run: `bun test tests/unit/img-proxy/console/stats-helpers.test.ts`
Expected: PASS 3 tests

- [ ] **Step 5: Commit**

```bash
git add src/img-proxy/console/types.ts src/img-proxy/console/stats-helpers.ts tests/unit/img-proxy/console/stats-helpers.test.ts
git commit -m "feat(img-proxy-console): shared types + stats helpers (byAlias + recent ring buffer)"
```

---

## Task 2: config.ts reload() public 方法

**Files:**
- Modify: `src/utils/config.ts` (加 reload() 方法 + 暴露 DEFAULTS)
- Test: `tests/unit/utils/config-reload.test.ts`

**Interfaces:**
- Produces:
  - `config.reload(): void` — 重新读 config.toml，覆盖 `data.img_proxy`，用 `DEFAULTS.img_proxy` 作底
- Consumes: `parse` from `@iarna/toml`（已 import）, `DEFAULTS` (config.ts:113 const)

### Steps

- [ ] **Step 1: 写 failing 测试**

```ts
// tests/unit/utils/config-reload.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('config.reload()', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cfg-reload-'));
    configPath = join(tmpDir, 'config.toml');
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it('reload 后 img_proxy section 更新', async () => {
    writeFileSync(configPath, `
[img_proxy]
console_enabled = true
upstream_timeout_ms = 60000
`);
    const { ConfigManager } = await import('../../../src/utils/config');
    const cfg = new ConfigManager(configPath);
    // Constructor reads + merges file,so console_enabled 已经是 true
    expect(cfg.get('img_proxy.console_enabled')).toBe(true);
    expect(cfg.get('img_proxy.upstream_timeout_ms')).toBe(60000);
    cfg.reload();
    // reload 之后仍然 true(同文件内容)
    expect(cfg.get('img_proxy.console_enabled')).toBe(true);
    expect(cfg.get('img_proxy.upstream_timeout_ms')).toBe(60000);
  });

  it('reload 用 DEFAULTS 作底：用户删字段后 reset', async () => {
    writeFileSync(configPath, `
[img_proxy]
console_enabled = true
`);
    const { ConfigManager } = await import('../../../src/utils/config');
    const cfg = new ConfigManager(configPath);
    cfg.reload();
    expect(cfg.get('img_proxy.console_enabled')).toBe(true);

    // 改文件:删 console_enabled,加 upstream_timeout_ms
    writeFileSync(configPath, `
[img_proxy]
upstream_timeout_ms = 30000
`);
    cfg.reload();
    expect(cfg.get('img_proxy.console_enabled')).toBe(false); // 删了 → DEFAULTS
    expect(cfg.get('img_proxy.upstream_timeout_ms')).toBe(30000);
  });

  it('reload 不重置其他 section（如 feishu_bot）', async () => {
    writeFileSync(configPath, `
[img_proxy]
console_enabled = true

[feishu_bot]
app_id = "test-app-id"
`);
    const { ConfigManager } = await import('../../../src/utils/config');
    const cfg = new ConfigManager(configPath);
    expect(cfg.get('feishu_bot.app_id')).toBe('test-app-id');
    cfg.reload();
    expect(cfg.get('feishu_bot.app_id')).toBe('test-app-id'); // 不变
    expect(cfg.get('img_proxy.console_enabled')).toBe(true); // 改了
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/unit/utils/config-reload.test.ts`
Expected: FAIL "cfg.reload is not a function"

- [ ] **Step 3: 实现 reload()**

在 `src/utils/config.ts` 的 `ConfigManager` class 内（line 245 后），加 public 方法：

```ts
  /** 重读 ~/.cc-linker/config.toml,覆盖 img_proxy section。
   *  用 DEFAULTS.img_proxy 作底,这样用户删字段后会 reset 到默认值(不会保留 stale 值)。
   *  其他 section 不动(可能是 CLI 启动时 set 的)。 */
  reload(): void {
    if (!existsSync(this.configPath)) {
      this.data.img_proxy = { ...DEFAULTS.img_proxy };
      return;
    }
    try {
      // parse() 返回 @iarna/toml 的 JsonMap interface,strict mode 下 spread 触发 TS2698。
      // 显式 cast 到 Partial<ConfigData['img_proxy']> 修复,行为不变。
      const fileData = parse(readFileSync(this.configPath, 'utf8')) as Record<string, any> | undefined;
      const fileImgProxy = (fileData?.img_proxy ?? {}) as Partial<ConfigData['img_proxy']>;
      this.data.img_proxy = {
        ...DEFAULTS.img_proxy,
        ...fileImgProxy,
      };
      // 重新应用 env 覆盖(用户可能改了 env var)
      this.loadEnv();
    } catch (err) {
      throw new Error(`config reload failed: ${err}`);
    }
  }
```

确认 `DEFAULTS` 在 config.ts 是 module-level export（line 113）。如果只 `const`，加 `export` 关键字。

- [ ] **Step 4: 跑测试确认 pass**

Run: `bun test tests/unit/utils/config-reload.test.ts`
Expected: PASS 3 tests

- [ ] **Step 5: Commit**

```bash
git add src/utils/config.ts tests/unit/utils/config-reload.test.ts
git commit -m "feat(img-proxy-console): config.reload() hot-reloads img_proxy section from config.toml"
```

---

## Task 3: routes.ts disable/enable + getUpstreamByAlias 读 disabled

**Files:**
- Modify: `src/img-proxy/routes.ts:67-94` (`addRoute` 保留 disabled), `:83-94` (`removeRoute` 不变), `:97-99` (`getUpstreamByAlias` 读 disabled)
- Modify: `src/img-proxy/types.ts` — `RouteEntry` 加 `disabled?: boolean`(spec §7.4 JSON shape 必填)
- Create: `src/img-proxy/routes.ts:setRouteDisabled()` 新函数（line 95 后）
- Test: `tests/unit/img-proxy/routes-disable.test.ts`

**Interfaces:**
- Produces:
  - `getUpstreamByAlias(path, alias): string | null` — disabled entry 返 null
  - `setRouteDisabled(path, alias, disabled): Promise<void>` — throw on unknown alias
- Consumes: 现有 `withRoutesLock` / `loadRoutes`

### Steps

- [ ] **Step 1: 写 failing 测试**

```ts
// tests/unit/img-proxy/routes-disable.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  saveRoutes, loadRoutes, getUpstreamByAlias, setRouteDisabled, addRoute,
} from '../../../src/img-proxy/routes';

describe('routes disable/enable', () => {
  let tmpDir: string, routesPath: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'routes-disable-'));
    routesPath = join(tmpDir, 'routes.json');
    await saveRoutes(routesPath, {
      version: 1,
      routes: {
        'glm-5.2': { alias: 'glm-5.2', upstream: 'http://upstream-1', provider_path: '/fake.json', original_base_url: 'http://upstream-1', installed_at: '2026-07-05T00:00:00Z' },
      },
    });
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it('getUpstreamByAlias 返 null 当 disabled=true', async () => {
    expect(getUpstreamByAlias(routesPath, 'glm-5.2')).toBe('http://upstream-1');
    await setRouteDisabled(routesPath, 'glm-5.2', true);
    expect(getUpstreamByAlias(routesPath, 'glm-5.2')).toBeNull();
  });

  it('setRouteDisabled(false) 恢复 disabled 字段', async () => {
    await setRouteDisabled(routesPath, 'glm-5.2', true);
    await setRouteDisabled(routesPath, 'glm-5.2', false);
    expect(getUpstreamByAlias(routesPath, 'glm-5.2')).toBe('http://upstream-1');
    // routes.json 里不应残留 disabled 字段
    const table = loadRoutes(routesPath);
    expect(table.routes['glm-5.2']?.disabled).toBeUndefined();
  });

  it('setRouteDisabled 未知 alias 抛错', async () => {
    await expect(setRouteDisabled(routesPath, 'nope', true)).rejects.toThrow(/unknown alias: nope/);
  });

  it('addRoute 保留已有 disabled 字段(避免 race 丢 disable)', async () => {
    await setRouteDisabled(routesPath, 'glm-5.2', true);
    await addRoute(routesPath, 'glm-5.2', 'http://upstream-2', '/fake.json');
    // disable 应该保留
    expect(getUpstreamByAlias(routesPath, 'glm-5.2')).toBeNull();
    // 但 upstream 应该更新到新值
    const table = loadRoutes(routesPath);
    expect(table.routes['glm-5.2']?.upstream).toBe('http://upstream-2');
    expect(table.routes['glm-5.2']?.disabled).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/unit/img-proxy/routes-disable.test.ts`
Expected: FAIL "setRouteDisabled is not a function"

- [ ] **Step 3: 实现**

修改 `src/img-proxy/routes.ts`：

**a) 改 `getUpstreamByAlias`（line 97-99）**：

```ts
export function getUpstreamByAlias(path: string, alias: string): string | null {
  const entry = loadRoutes(path).routes[alias];
  if (!entry || entry.disabled) return null;
  return entry.upstream ?? null;
}
```

**b) 改 `addRoute`（line 67-81）保留 disabled 字段**：

```ts
export async function addRoute(path: string, alias: string, upstream: string, providerPath: string): Promise<void> {
  await withRoutesLock(path, async () => {
    const table = loadRoutes(path);
    const existing = table.routes[alias];
    table.routes[alias] = {
      alias, upstream, provider_path: providerPath,
      original_base_url: upstream,
      installed_at: existing?.installed_at ?? new Date().toISOString(),
      // 保留 disable 标记(避免重跑 install 时丢状态)
      ...(existing?.disabled ? { disabled: true } : {}),
    };
    mkdirSync(dirname(path), { recursive: true });
    const tmp = path + '.tmp';
    writeFileSync(tmp, JSON.stringify(table, null, 2), { mode: 0o600 });
    renameSync(tmp, path);
  });
}
```

**c) 加 `setRouteDisabled`（插在 `removeRoute`（line 94 结束）后、`// 重命名` 注释（line 96）前）**：

```ts
export async function setRouteDisabled(
  path: string, alias: string, disabled: boolean,
): Promise<void> {
  await withRoutesLock(path, async () => {
    const table = loadRoutes(path);
    const entry = table.routes[alias];
    if (!entry) throw new Error(`unknown alias: ${alias}`);
    if (disabled) entry.disabled = true;
    else delete entry.disabled;
    const tmp = path + '.tmp';
    writeFileSync(tmp, JSON.stringify(table, null, 2), { mode: 0o600 });
    renameSync(tmp, path);
  });
}
```

- [ ] **Step 4: 跑测试确认 pass**

Run: `bun test tests/unit/img-proxy/routes-disable.test.ts`
Expected: PASS 4 tests

确认现有测试不破：`bun test tests/integration/img-proxy-server.test.ts`（应仍 9 pass）

- [ ] **Step 5: Commit**

```bash
git add src/img-proxy/routes.ts tests/unit/img-proxy/routes-disable.test.ts
git commit -m "feat(img-proxy-console): routes disable/enable with addRoute race preservation"
```

---

## Task 4: log-parser（LogEntry + readRecentLogLines + LogTail）

**Files:**
- Create: `src/img-proxy/console/log-parser.ts`
- Test: `tests/unit/img-proxy/console/log-parser.test.ts`

**注意**：types.ts（LogEntry / ParsedLogEntry / ReadRecentOpts）已在 Task 1 创建并 commit，Task 4 只 import 用，不重复创建。

**Interfaces:**
- Produces:
  - `readRecentLogLines(opts: ReadRecentOpts): Promise<LogEntry[]>` — 全量倒序读 + filter + limit
  - `class LogTail { logPath, readNew(): Promise<LogEntry[]>, offset: number }` — 增量读
  - `getTail(logPath): LogTail` — module-level singleton
  - `resetLogTail(): void` — 测试隔离
- Consumes: `node:fs` (readFileSync, statSync), `fs/promises` (open), `console/types.ts` (LogEntry / ParsedLogEntry / ReadRecentOpts)

### Steps

- [ ] **Step 1: 写 failing 测试**

```ts
// tests/unit/img-proxy/console/log-parser.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  readRecentLogLines, getTail, resetLogTail,
} from '../../../../src/img-proxy/console/log-parser';

const SAMPLE = `[2026-07-05T07:32:06.722Z] INFO {"alias":"glm-5.2","method":"POST","path":"/glm-5.2/v1/messages","stripped":0,"upstream_status":200,"duration_ms":7038,"headers_to_first_chunk_ms":234,"chunks":12,"bytes":12345,"stream_status":"complete","upstream_error_msg":null}
[2026-07-05T07:33:00.000Z] INFO {"alias":"byte-agent","method":"POST","path":"/byte-agent/v1/messages","stripped":1,"upstream_status":200,"duration_ms":120,"chunks":2,"bytes":50,"stream_status":"complete","upstream_error_msg":null}
[2026-07-05T07:34:00.000Z] INFO {"alias":"glm-5.2","method":"POST","path":"/glm-5.2/v1/messages","stripped":0,"upstream_status":429,"duration_ms":50,"chunks":0,"bytes":0,"stream_status":"upstream_unreachable","upstream_error_msg":"429"}
[2026-07-05T07:35:00.000Z] WARN alias=whoever path=/whoever/v1/messages unresolved`;

describe('log-parser', () => {
  let tmpDir: string, logPath: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'log-parser-'));
    logPath = join(tmpDir, 'img-proxy.log');
    writeFileSync(logPath, SAMPLE);
    resetLogTail();  // 测试隔离
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it('readRecentLogLines 倒序读最近 100 条', async () => {
    const entries = await readRecentLogLines({ logPath, limit: 10 });
    expect(entries.length).toBe(4);
    // 最新在前
    expect(entries[0]!.parsed?.alias).toBe('whoever');  // WARN 行 parsed=null
    expect(entries[0]!.parsed).toBeNull();
    expect(entries[1]!.parsed?.alias).toBe('glm-5.2');
    expect(entries[1]!.parsed?.stream_status).toBe('upstream_unreachable');
  });

  it('按 alias 过滤', async () => {
    const entries = await readRecentLogLines({ logPath, alias: 'glm-5.2' });
    expect(entries.length).toBe(2);
    expect(entries.every(e => e.parsed?.alias === 'glm-5.2')).toBe(true);
  });

  it('按 streamStatus 过滤', async () => {
    const entries = await readRecentLogLines({ logPath, streamStatus: 'complete' });
    expect(entries.length).toBe(2);
  });

  it('按 sinceMs 过滤', async () => {
    const sinceMs = new Date('2026-07-05T07:34:00.000Z').getTime();
    const entries = await readRecentLogLines({ logPath, sinceMs });
    expect(entries.length).toBe(2); // 07:34 + 07:35
  });

  it('LogTail 增量读(append 新行)', async () => {
    const tail = getTail(logPath);
    const first = await tail.readNew();
    expect(first.length).toBe(4);

    appendFileSync(logPath,
      `\n[2026-07-05T07:36:00.000Z] INFO {"alias":"new","method":"POST","path":"/new/v1/messages","stripped":0,"upstream_status":200,"duration_ms":10,"chunks":1,"bytes":5,"stream_status":"complete","upstream_error_msg":null}\n`,
    );
    const second = await tail.readNew();
    expect(second.length).toBe(1);
    expect(second[0]!.parsed?.alias).toBe('new');
  });

  it('LogTail singleton 跨调用共享 offset', async () => {
    const t1 = getTail(logPath);
    await t1.readNew();
    const t2 = getTail(logPath);
    expect(t2.offset).toBe(t1.offset);  // 同一个 instance
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/unit/img-proxy/console/log-parser.test.ts`
Expected: FAIL "Cannot find module"

- [ ] **Step 3: 实现 log-parser.ts**

（types.ts 已在 Task 1 创建并 commit,这里只 import 用）

```ts
// src/img-proxy/console/log-parser.ts
import { readFileSync, statSync } from 'fs';
import { open } from 'fs/promises';
import type { LogEntry, ParsedLogEntry, ReadRecentOpts } from './types';

const LINE_RE = /^\[([^\]]+)\] (?:INFO|WARN|ERROR) (.+)$/;

function parseLine(raw: string): LogEntry | null {
  const m = raw.match(LINE_RE);
  if (!m) return null;
  const ts = Date.parse(m[1]!);
  if (Number.isNaN(ts)) return null;
  let parsed: ParsedLogEntry | null = null;
  try {
    const body = JSON.parse(m[2]!);
    if (body && typeof body === 'object' && body.alias) {
      parsed = body as ParsedLogEntry;
    }
  } catch {
    // WARN/ERROR 等非 JSON 行,parsed 留 null
  }
  return { ts, raw, parsed };
}

export async function readRecentLogLines(opts: ReadRecentOpts): Promise<LogEntry[]> {
  const { logPath, limit = 100, alias, status, streamStatus, sinceMs } = opts;
  let content: string;
  try {
    content = readFileSync(logPath, 'utf8');
  } catch {
    return [];  // 文件不存在/不可读
  }
  const lines = content.split('\n').filter(Boolean);
  const all: LogEntry[] = [];
  for (const line of lines) {
    const entry = parseLine(line);
    if (!entry) continue;
    if (alias && entry.parsed?.alias !== alias) continue;
    if (status !== undefined && entry.parsed?.upstream_status !== status) continue;
    if (streamStatus && entry.parsed?.stream_status !== streamStatus) continue;
    if (sinceMs !== undefined && entry.ts < sinceMs) continue;
    all.push(entry);
  }
  // 倒序(最新在前)+ limit
  return all.reverse().slice(0, limit);
}

// === LogTail singleton ===

export class LogTail {
  public offset = 0;
  constructor(public readonly logPath: string) {}

  async readNew(): Promise<LogEntry[]> {
    let fileSize: number;
    try {
      fileSize = statSync(this.logPath).size;
    } catch {
      return [];
    }
    // 文件被 truncate,reset offset
    if (fileSize < this.offset) this.offset = 0;
    if (fileSize === this.offset) return [];

    const fh = await open(this.logPath, 'r');
    try {
      const len = fileSize - this.offset;
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, this.offset);
      this.offset = fileSize;
      const text = buf.toString('utf8');
      const lines = text.split('\n');
      // 最后一段可能不完整(\n 没结尾),丢弃;下次会重读
      if (lines.length > 0 && !text.endsWith('\n')) lines.pop();
      const entries: LogEntry[] = [];
      for (const line of lines) {
        if (!line) continue;
        const entry = parseLine(line);
        if (entry) entries.push(entry);
      }
      return entries;
    } finally {
      await fh.close();
    }
  }
}

let _tail: LogTail | null = null;
export function getTail(logPath: string): LogTail {
  if (!_tail || _tail.logPath !== logPath) _tail = new LogTail(logPath);
  return _tail;
}

/** 测试隔离用 */
export function resetLogTail(): void {
  _tail = null;
}
```

- [ ] **Step 5: 跑测试确认 pass**

Run: `bun test tests/unit/img-proxy/console/log-parser.test.ts`
Expected: PASS 6 tests

- [ ] **Step 6: Commit**

```bash
git add src/img-proxy/console/log-parser.ts tests/unit/img-proxy/console/log-parser.test.ts
git commit -m "feat(img-proxy-console): log-parser with filter + LogTail singleton for incremental reads"
```

> types.ts 不再 add —— 已在 Task 1 commit。

---

## Task 5: cacheBytes helper (5s TTL module singleton)

**Files:**
- Create: 放在 `src/img-proxy/console/api.ts` 顶部（task 6 会创建整个文件；这里只先 stub helper）
- Test: `tests/unit/img-proxy/console/health.test.ts`

**Interfaces:**
- Produces:
  - `getCacheBytes(cacheDir: string): number` — 5s TTL module-level cache
  - `resetHealthCache(): void` — 测试隔离
- Consumes: `node:fs` (readdirSync, statSync)

### Steps

- [ ] **Step 1: 写 failing 测试**

```ts
// tests/unit/img-proxy/console/health.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getCacheBytes, resetHealthCache } from '../../../../src/img-proxy/console/api';

describe('getCacheBytes', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'health-cache-'));
    resetHealthCache();
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it('空目录返 0', () => {
    expect(getCacheBytes(tmpDir)).toBe(0);
  });

  it('计算所有文件 size 之和', () => {
    writeFileSync(join(tmpDir, 'a.png'), Buffer.alloc(100));
    writeFileSync(join(tmpDir, 'b.png'), Buffer.alloc(200));
    expect(getCacheBytes(tmpDir)).toBe(300);
  });

  it('5s 内复用 cache（修改文件不影响 cache）', () => {
    writeFileSync(join(tmpDir, 'a.png'), Buffer.alloc(100));
    expect(getCacheBytes(tmpDir)).toBe(100);
    writeFileSync(join(tmpDir, 'b.png'), Buffer.alloc(200));
    expect(getCacheBytes(tmpDir)).toBe(100);  // 还在 TTL 内
    resetHealthCache();
    expect(getCacheBytes(tmpDir)).toBe(300);  // reset 后重算
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/unit/img-proxy/console/health.test.ts`
Expected: FAIL "Cannot find module"

- [ ] **Step 3: 实现 (在 task 6 的 api.ts 里 stub)**

在 task 6 的 `src/img-proxy/console/api.ts` 顶部加：

```ts
// src/img-proxy/console/api.ts 顶部
import { existsSync, readdirSync, statSync, appendFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { IMG_PROXY_LOG_FILE } from '../../utils/paths';

// === health cache ===
const CACHE_TTL_MS = 5000;
let _cacheBytesCache: { value: number; computedAt: number } = { value: 0, computedAt: 0 };

export function getCacheBytes(cacheDir: string): number {
  if (Date.now() - _cacheBytesCache.computedAt < CACHE_TTL_MS) {
    return _cacheBytesCache.value;
  }
  let total = 0;
  if (existsSync(cacheDir)) {
    for (const f of readdirSync(cacheDir)) {
      try { total += statSync(join(cacheDir, f)).size; } catch {}
    }
  }
  _cacheBytesCache = { value: total, computedAt: Date.now() };
  return total;
}

export function resetHealthCache(): void {
  _cacheBytesCache = { value: 0, computedAt: 0 };
}

// ... rest of api.ts (task 6 will add handleConsoleRequest + endpoints)
```

- [ ] **Step 4: 跑测试确认 pass**

Run: `bun test tests/unit/img-proxy/console/health.test.ts`
Expected: PASS 3 tests

- [ ] **Step 5: Commit**

```bash
git add src/img-proxy/console/api.ts tests/unit/img-proxy/console/health.test.ts
git commit -m "feat(img-proxy-console): getCacheBytes with 5s TTL module-level cache"
```

---

## Task 6: console api endpoints（9 个 handler + 路由分发）

**Files:**
- Modify: `src/img-proxy/console/api.ts`（加 9 个 handler + handleConsoleRequest 主入口）
- Test: `tests/unit/img-proxy/console/api-handlers.test.ts`（独立测试每个 handler）
- Test: `tests/integration/img-proxy-console.test.ts`（端到端集成）

**Interfaces:**
- Produces:
  - `handleConsoleRequest(req, ctx): Promise<Response>` — 主入口，console_enabled false 返 404
  - `ConsoleContext { configPath, routesPath, cacheDir, logPath, stats: ProxyServer['stats'] }`
  - 9 个 endpoint（见 spec §6.1）
- Consumes:
  - `config` from `../../utils/config`（reload 方法 task 2）
  - `setRouteDisabled` from `../routes`（task 3）
  - `getUpstreamByAlias`, `loadRoutes`, `listRoutes` from `../routes`
  - `cleanupOldCache` from `../server`
  - `readRecentLogLines`, `getTail`, `resetLogTail` from `./log-parser`（task 4）
  - `getCacheBytes`, `resetHealthCache`（task 5）

### Steps

- [ ] **Step 1: 写 failing 集成测试**

```ts
// tests/integration/img-proxy-console.test.ts
//
// 注意:每个 it 用独立的 tmpProxy + tmpDir(避免 routes/config 状态污染下一个 test,
// 也避免 console_enabled=false test 反复启停)。所有临时目录都用 mkdtempSync。
// configPath 必须传 workDir 下的临时 config.toml,绝对不能写到 ~/.cc-linker/config.toml
// (readFileSync 不识 '~',且会污染用户配置)。
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { startProxyServer } from '../../src/img-proxy/server';
import { saveRoutes } from '../../src/img-proxy/routes';

/** 起一个独立的临时 proxy(每个 it 调一次),返回 baseUrl + cleanup */
async function makeTmpProxy(opts: { consoleEnabled: boolean; withRoutes?: boolean } = { consoleEnabled: true, withRoutes: true }) {
  const workDir = mkdtempSync(join(tmpdir(), 'console-int-'));
  const cacheDir = join(workDir, 'cache');
  const routesPath = join(workDir, 'routes.json');
  const logPath = join(workDir, 'img-proxy.log');
  const configPath = join(workDir, 'config.toml');
  // 起一个最小 upstream mock
  const upstreamServer = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    async fetch(_req) {
      return new Response('event: ok\ndata: {}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    },
  });
  if (opts.withRoutes) {
    await saveRoutes(routesPath, {
      version: 1, routes: {
        'glm-5.2': {
          alias: 'glm-5.2',
          upstream: `http://127.0.0.1:${upstreamServer.port}`,
          provider_path: '/fake.json',
          original_base_url: `http://127.0.0.1:${upstreamServer.port}`,
          installed_at: '2026-07-05T00:00:00Z',
        },
      },
    });
  }
  const proxy = await startProxyServer({
    port: 0, hostname: '127.0.0.1', cacheDir, routesPath,
    promptTemplate: '[img: {path}]', consoleEnabled: opts.consoleEnabled, cacheMaxAgeHours: 24,
    logPath, configPath,  // 关键:传 workDir 下临时 configPath,不污染用户配置
  });
  return {
    baseUrl: `http://127.0.0.1:${proxy.port}`,
    cacheDir, routesPath, logPath, configPath, workDir,
    cleanup: () => {
      proxy.stop(true);
      upstreamServer.stop(true);
      rmSync(workDir, { recursive: true, force: true });
    },
  };
}

describe('img-proxy console integration', () => {
  // beforeAll/afterAll 现在不需要了 — 每个 test 自带 setup/teardown

  it('GET / 返 HTML 200', async () => {
    const ctx = await makeTmpProxy();
    try {
      const r = await fetch(`${ctx.baseUrl}/`);
      expect(r.status).toBe(200);
      expect(await r.text()).toContain('cc-linker img-proxy console');
    } finally { ctx.cleanup(); }
  });

  it('GET /admin/api/stats 返 stats JSON', async () => {
    const ctx = await makeTmpProxy();
    try {
      const r = await fetch(`${ctx.baseUrl}/admin/api/stats`);
      expect(r.status).toBe(200);
      const stats = await r.json();
      expect(stats).toHaveProperty('totalRequests');
      expect(stats).toHaveProperty('byStatus');
      expect(stats).toHaveProperty('byAlias');
      expect(stats).toHaveProperty('recent');
    } finally { ctx.cleanup(); }
  });

  it('POST /admin/api/routes/disable 让 proxy 请求 502 + enable 恢复', async () => {
    const ctx = await makeTmpProxy();
    try {
      const r = await fetch(`${ctx.baseUrl}/admin/api/routes/disable`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ alias: 'glm-5.2' }),
      });
      expect(r.status).toBe(200);
      const proxyResp = await fetch(`${ctx.baseUrl}/glm-5.2/v1/messages`, {
        method: 'POST', body: '{}',
      });
      expect(proxyResp.status).toBe(502);

      // 恢复 enable,验证 enable 也 work
      const en = await fetch(`${ctx.baseUrl}/admin/api/routes/enable`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ alias: 'glm-5.2' }),
      });
      expect(en.status).toBe(200);
      const proxyResp2 = await fetch(`${ctx.baseUrl}/glm-5.2/v1/messages`, {
        method: 'POST', body: '{}',
      });
      expect(proxyResp2.status).toBe(200);  // 恢复后 200
    } finally { ctx.cleanup(); }
  });

  it('GET /admin/api/health 返 health info', async () => {
    const ctx = await makeTmpProxy();
    try {
      const r = await fetch(`${ctx.baseUrl}/admin/api/health`);
      expect(r.status).toBe(200);
      const h = await r.json();
      expect(h).toHaveProperty('uptimeMs');
      expect(h).toHaveProperty('pid');
      expect(h).toHaveProperty('routeCount', 1);
    } finally { ctx.cleanup(); }
  });

  it('POST /admin/api/cache/clear 返 ok + removed', async () => {
    const ctx = await makeTmpProxy();
    try {
      writeFileSync(join(ctx.cacheDir, 'test.png'), Buffer.alloc(10));
      const r = await fetch(`${ctx.baseUrl}/admin/api/cache/clear`, { method: 'POST' });
      expect(r.status).toBe(200);
      const body = await r.json();
      expect(body).toHaveProperty('ok', true);
      expect(body).toHaveProperty('removed', 1);  // 1 个文件被清掉
    } finally { ctx.cleanup(); }
  });

  it('POST /admin/api/routes/disable 未知 alias 返 404 E_CONSOLE_UNKNOWN_ALIAS', async () => {
    const ctx = await makeTmpProxy();
    try {
      const r = await fetch(`${ctx.baseUrl}/admin/api/routes/disable`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ alias: 'nope-not-installed' }),
      });
      expect(r.status).toBe(404);
      const body = await r.json();
      expect(body).toHaveProperty('code', 'E_CONSOLE_UNKNOWN_ALIAS');
    } finally { ctx.cleanup(); }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/integration/img-proxy-console.test.ts`
Expected: FAIL "console not implemented (Phase 2)" 返 501

- [ ] **Step 3: 实现 api.ts**

完整文件 `src/img-proxy/console/api.ts`：

```ts
// src/img-proxy/console/api.ts
import { existsSync, readdirSync, statSync, writeFileSync, renameSync, readFileSync } from 'fs';
import { join } from 'path';
import { parse, stringify } from '@iarna/toml';
import { config } from '../../utils/config';
import {
  loadRoutes, listRoutes, setRouteDisabled,
} from '../routes';
import { cleanupOldCache } from '../server';
import { readRecentLogLines } from './log-parser';
import type { HealthStats, RouteListEntry } from './types';

// === health cache ===
const CACHE_TTL_MS = 5000;
let _cacheBytesCache: { value: number; computedAt: number } = { value: 0, computedAt: 0 };

export function getCacheBytes(cacheDir: string): number {
  if (Date.now() - _cacheBytesCache.computedAt < CACHE_TTL_MS) {
    return _cacheBytesCache.value;
  }
  let total = 0;
  if (existsSync(cacheDir)) {
    for (const f of readdirSync(cacheDir)) {
      try { total += statSync(join(cacheDir, f)).size; } catch {}
    }
  }
  _cacheBytesCache = { value: total, computedAt: Date.now() };
  return total;
}

export function resetHealthCache(): void {
  _cacheBytesCache = { value: 0, computedAt: 0 };
}

// === audit log helper ===
function audit(action: string, data: Record<string, unknown>, logPath: string): void {
  try {
    const line = JSON.stringify({ time: new Date().toISOString(), console_action: action, ...data, trigger: 'console' });
    writeFileSync(logPath, `[${new Date().toISOString()}] INFO ${line}\n`, { flag: 'a' });
  } catch {}
}

function jsonError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: message, code }), {
    status, headers: { 'content-type': 'application/json' },
  });
}

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
}

// === endpoint handlers ===

async function handleStats(stats: any): Promise<Response> {
  return jsonOk(stats);
}

async function handleLog(url: URL, logPath: string): Promise<Response> {
  const opts = {
    logPath,
    limit: Number(url.searchParams.get('limit')) || 100,
    alias: url.searchParams.get('alias') ?? undefined,
    status: url.searchParams.get('status') ? Number(url.searchParams.get('status')) : undefined,
    streamStatus: url.searchParams.get('streamStatus') ?? undefined,
    sinceMs: url.searchParams.get('sinceMs') ? Number(url.searchParams.get('sinceMs')) : undefined,
  };
  const entries = await readRecentLogLines(opts);
  return jsonOk(entries);
}

async function handleGetConfig(): Promise<Response> {
  return jsonOk({
    console_enabled: config.get('img_proxy.console_enabled'),
    upstream_timeout_ms: config.get('img_proxy.upstream_timeout_ms'),
    stream_idle_timeout_ms: config.get('img_proxy.stream_idle_timeout_ms'),
  });
}

async function handlePostConfig(req: Request, ctx: ConsoleContext): Promise<Response> {
  let body: any;
  try { body = await req.json(); } catch { return jsonError(400, 'E_CONSOLE_BAD_REQUEST', 'body 必须是 JSON'); }

  const allowed = ['console_enabled', 'upstream_timeout_ms', 'stream_idle_timeout_ms'] as const;
  const updates: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in body) updates[key] = body[key];
  }
  if (Object.keys(updates).length === 0) return jsonError(400, 'E_CONSOLE_BAD_REQUEST', 'no valid keys');

  // 写回 config.toml(atomic)
  // 注意:ctx.configPath 必须是已 expandPath 的绝对路径(cli 接线时展开),
  // 因为 readFileSync 不识别 '~'。
  let current: any = {};
  try {
    current = parse(readFileSync(ctx.configPath, 'utf8'));
  } catch (err) {
    return jsonError(500, 'E_CONSOLE_CONFIG_WRITE_FAILED', `读 config.toml 失败: ${err}`);
  }
  current.img_proxy = { ...(current.img_proxy ?? {}), ...updates };

  try {
    const tmp = ctx.configPath + '.tmp';
    writeFileSync(tmp, stringify(current), { mode: 0o600 });
    renameSync(tmp, ctx.configPath);
  } catch (err) {
    return jsonError(500, 'E_CONSOLE_CONFIG_WRITE_FAILED', `写 config.toml 失败: ${err}`);
  }

  // 热 reload
  try {
    config.reload();
  } catch (err) {
    return jsonError(500, 'E_CONSOLE_CONFIG_WRITE_FAILED', `reload 失败: ${err}`);
  }

  audit('config_update', { applied: updates }, ctx.logPath);
  return jsonOk({ ok: true, applied: updates });
}

async function handleGetRoutes(): Promise<Response> {
  const routes = listRoutes().map((r): RouteListEntry => ({
    alias: r.alias,
    upstream: r.upstream,
    installed_at: r.installed_at,
    disabled: !!r.disabled,
  }));
  return jsonOk(routes);
}

async function handlePostDisable(req: Request, ctx: ConsoleContext): Promise<Response> {
  let body: any;
  try { body = await req.json(); } catch { return jsonError(400, 'E_CONSOLE_BAD_REQUEST', 'body 必须是 JSON'); }
  const alias = body?.alias;
  if (typeof alias !== 'string') return jsonError(400, 'E_CONSOLE_BAD_REQUEST', 'alias 必填');

  try {
    await setRouteDisabled(ctx.routesPath, alias, true);
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.startsWith('unknown alias')) return jsonError(404, 'E_CONSOLE_UNKNOWN_ALIAS', msg);
    return jsonError(500, 'E_CONSOLE_ROUTES_LOCK_FAILED', msg);
  }
  audit('routes_disable', { alias }, ctx.logPath);
  return jsonOk({ ok: true });
}

async function handlePostEnable(req: Request, ctx: ConsoleContext): Promise<Response> {
  let body: any;
  try { body = await req.json(); } catch { return jsonError(400, 'E_CONSOLE_BAD_REQUEST', 'body 必须是 JSON'); }
  const alias = body?.alias;
  if (typeof alias !== 'string') return jsonError(400, 'E_CONSOLE_BAD_REQUEST', 'alias 必填');

  try {
    await setRouteDisabled(ctx.routesPath, alias, false);
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.startsWith('unknown alias')) return jsonError(404, 'E_CONSOLE_UNKNOWN_ALIAS', msg);
    return jsonError(500, 'E_CONSOLE_ROUTES_LOCK_FAILED', msg);
  }
  audit('routes_enable', { alias }, ctx.logPath);
  return jsonOk({ ok: true });
}

async function handlePostCacheClear(ctx: ConsoleContext): Promise<Response> {
  const removed = cleanupOldCache(ctx.cacheDir, 0);
  resetHealthCache();  // 让下次 /health 重算 cacheBytes
  audit('cache_clear', { removed }, ctx.logPath);
  return jsonOk({ ok: true, removed });
}

async function handleHealth(stats: any, ctx: ConsoleContext): Promise<Response> {
  const h: HealthStats = {
    uptimeMs: Date.now() - stats.startedAt,
    pid: process.pid,
    routeCount: Object.keys(loadRoutes(ctx.routesPath).routes).length,
    cacheFiles: existsSync(ctx.cacheDir) ? readdirSync(ctx.cacheDir).length : 0,
    cacheBytes: getCacheBytes(ctx.cacheDir),
  };
  return jsonOk(h);
}

// === 主入口 ===

export interface ConsoleContext {
  /** 已 expandPath 的绝对路径(如 ~/... → /Users/you/...) */
  configPath: string;
  routesPath: string;
  cacheDir: string;
  logPath: string;
  stats: any;  // ProxyServer['stats']
}

export async function handleConsoleRequest(req: Request, url: URL, ctx: ConsoleContext): Promise<Response> {
  // console_enabled gate
  if (!config.get('img_proxy.console_enabled')) {
    return new Response('Console disabled. Set img_proxy.console_enabled=true in config.toml.', { status: 404 });
  }

  const path = url.pathname;
  const method = req.method;

  try {
    if (path === '/admin/api/stats' && method === 'GET') return await handleStats(ctx.stats);
    if (path === '/admin/api/log' && method === 'GET') return await handleLog(url, ctx.logPath);
    if (path === '/admin/api/config' && method === 'GET') return await handleGetConfig();
    if (path === '/admin/api/config' && method === 'POST') return await handlePostConfig(req, ctx);
    if (path === '/admin/api/routes' && method === 'GET') return await handleGetRoutes();
    if (path === '/admin/api/routes/disable' && method === 'POST') return await handlePostDisable(req, ctx);
    if (path === '/admin/api/routes/enable' && method === 'POST') return await handlePostEnable(req, ctx);
    if (path === '/admin/api/cache/clear' && method === 'POST') return await handlePostCacheClear(ctx);
    if (path === '/admin/api/health' && method === 'GET') return await handleHealth(ctx.stats, ctx);
    return jsonError(404, 'E_CONSOLE_NOT_FOUND', `unknown endpoint: ${method} ${path}`);
  } catch (err) {
    return jsonError(500, 'E_CONSOLE_INTERNAL', (err as Error).message);
  }
}
```

- [ ] **Step 4: 跑测试确认 pass**

Run: `bun test tests/integration/img-proxy-console.test.ts`
Expected: PASS 6 tests

- [ ] **Step 5: 跑全套确认不破**

Run: `bun test`
Expected: 现有 1206 + 新 6 = 1212 pass, 0 fail

- [ ] **Step 6: Commit**

```bash
git add src/img-proxy/console/api.ts tests/integration/img-proxy-console.test.ts
git commit -m "feat(img-proxy-console): 9 api endpoints (stats/log/config/routes/cache/health) + audit log"
```

---

## Task 7: html template (INDEX_HTML)

**Files:**
- Create: `src/img-proxy/console/html.ts` (INDEX_HTML 常量)
- Test: `tests/unit/img-proxy/console/html.test.ts` (snapshot test)

**Interfaces:**
- Produces:
  - `INDEX_HTML: string` — 完整 HTML 文档(HTML + 内嵌 CSS + 内嵌 JS)
- Consumes: 无（独立）

### Steps

- [ ] **Step 1: 写 failing 测试**

```ts
// tests/unit/img-proxy/console/html.test.ts
import { describe, it, expect } from 'bun:test';
import { INDEX_HTML } from '../../../../src/img-proxy/console/html';

describe('INDEX_HTML', () => {
  it('包含 doctype + html 标签', () => {
    expect(INDEX_HTML).toMatch(/^<!DOCTYPE html>/);
    expect(INDEX_HTML).toContain('<html lang="zh-CN">');
    expect(INDEX_HTML).toContain('</html>');
  });

  it('title 是 cc-linker img-proxy console', () => {
    expect(INDEX_HTML).toContain('<title>cc-linker img-proxy console</title>');
  });

  it('包含 5 个 tab nav', () => {
    expect(INDEX_HTML).toContain('data-tab="dashboard"');
    expect(INDEX_HTML).toContain('data-tab="log"');
    expect(INDEX_HTML).toContain('data-tab="config"');
    expect(INDEX_HTML).toContain('data-tab="routes"');
    expect(INDEX_HTML).toContain('data-tab="cache"');
  });

  it('内嵌 <style> 块', () => {
    expect(INDEX_HTML).toMatch(/<style>[\s\S]+<\/style>/);
  });

  it('内嵌 <script> 块(无外部 src)', () => {
    expect(INDEX_HTML).toMatch(/<script>[\s\S]+<\/script>/);
    // 不应该有外部 script src
    expect(INDEX_HTML).not.toMatch(/<script\s+src=/);
  });

  it('JS 包含 state 管理 + 5 个 view 函数 + poll', () => {
    expect(INDEX_HTML).toContain('renderDashboard');
    expect(INDEX_HTML).toContain('renderLog');
    expect(INDEX_HTML).toContain('renderConfig');
    expect(INDEX_HTML).toContain('renderRoutes');
    expect(INDEX_HTML).toContain('renderCache');
    expect(INDEX_HTML).toContain('setInterval(pollLoop');
  });

  it('JS 包含 confirm() 守卫写操作', () => {
    expect(INDEX_HTML).toContain('confirm(');
    expect(INDEX_HTML).toContain('postJson');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/unit/img-proxy/console/html.test.ts`
Expected: FAIL "Cannot find module"

- [ ] **Step 3: 实现 html.ts**

完整文件 `src/img-proxy/console/html.ts`（template literal 字符串）：

```ts
// src/img-proxy/console/html.ts
export const INDEX_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>cc-linker img-proxy console</title>
<style>
* { box-sizing: border-box; }
body { font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif; margin: 0; padding: 0; background: #f7f7f8; color: #222; }
nav { display: flex; gap: 4px; background: #1f2937; color: #fff; padding: 0 16px; }
nav button { background: transparent; color: #ccc; border: none; padding: 12px 16px; cursor: pointer; font-size: 13px; }
nav button.active { background: #374151; color: #fff; }
nav button:hover { background: #374151; }
main { padding: 16px; max-width: 1400px; margin: 0 auto; }
.banner { background: #fef3c7; color: #92400e; padding: 8px 12px; border-radius: 4px; margin-bottom: 16px; }
.stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 16px; }
.stat-card { background: #fff; border: 1px solid #e5e7eb; border-radius: 6px; padding: 12px; }
.stat-card .label { font-size: 11px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px; }
.stat-card .value { font-size: 22px; font-weight: 600; margin-top: 4px; }
table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #e5e7eb; border-radius: 6px; overflow: hidden; }
th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #f3f4f6; }
th { background: #f9fafb; font-weight: 600; font-size: 11px; text-transform: uppercase; color: #6b7280; }
tr:last-child td { border-bottom: none; }
tr.disabled { color: #9ca3af; }
.form-row { margin-bottom: 12px; }
.form-row label { display: block; font-size: 12px; color: #6b7280; margin-bottom: 4px; }
.form-row input, .form-row select { padding: 6px 10px; border: 1px solid #d1d5db; border-radius: 4px; font-size: 13px; }
button.action { background: #2563eb; color: #fff; border: none; padding: 6px 14px; border-radius: 4px; cursor: pointer; font-size: 12px; }
button.action:hover { background: #1d4ed8; }
button.action:disabled { background: #9ca3af; cursor: not-allowed; }
button.danger { background: #dc2626; color: #fff; border: none; padding: 6px 14px; border-radius: 4px; cursor: pointer; font-size: 12px; }
button.danger:hover { background: #b91c1c; }
.filters { display: flex; gap: 8px; margin-bottom: 12px; }
.filters input, .filters select { padding: 4px 8px; border: 1px solid #d1d5db; border-radius: 4px; font-size: 12px; }
.status-complete { color: #059669; }
.status-upstream_error, .status-upstream_unreachable { color: #dc2626; }
.status-client_aborted { color: #6b7280; }
.status-stalled { color: #d97706; }
.status-no_body { color: #6366f1; }
</style>
</head>
<body>
<nav>
  <button data-tab="dashboard" class="active">Dashboard</button>
  <button data-tab="log">Log</button>
  <button data-tab="config">Config</button>
  <button data-tab="routes">Routes</button>
  <button data-tab="cache">Cache</button>
</nav>
<main>
  <div id="banner" class="banner" style="display:none"></div>
  <div id="view"></div>
</main>
<script>
const state = { tab: 'dashboard', filters: { alias: '', status: '', streamStatus: '', sinceMs: 0 }, pending: new Set(), data: { stats: null, health: null, log: [], config: null, routes: [], cache: null } };

async function api(method, path, body) {
  const r = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    const text = await r.text().catch(() => r.statusText);
    throw new Error(\`\${method} \${path} → \${r.status} \${text}\`);
  }
  const ct = r.headers.get('content-type') || '';
  return ct.includes('json') ? r.json() : r.text();
}

function showBanner(msg, type) {
  const el = document.getElementById('banner');
  el.textContent = msg;
  el.style.display = 'block';
  el.style.background = type === 'error' ? '#fee2e2' : '#fef3c7';
}

function hideBanner() {
  document.getElementById('banner').style.display = 'none';
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function formatDuration(ms) {
  if (ms == null) return '-';
  if (ms < 1000) return ms + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(2) + 's';
  return (ms / 60000).toFixed(2) + 'm';
}

function renderDashboard() {
  const v = state.data;
  if (!v.stats) return '<p>加载中...</p>';
  const s = v.stats, h = v.health;
  const bs = s.byStatus || {};
  const totalStatus = Object.values(bs).reduce((a, b) => a + b, 0);
  let html = '<div class="stats-grid">';
  html += \`<div class="stat-card"><div class="label">Total Requests</div><div class="value">\${s.totalRequests || 0}</div></div>\`;
  html += \`<div class="stat-card"><div class="label">Stripped Images</div><div class="value">\${s.strippedImages || 0}</div></div>\`;
  html += \`<div class="stat-card"><div class="label">Uptime</div><div class="value">\${formatDuration(h && h.uptimeMs)}</div></div>\`;
  html += \`<div class="stat-card"><div class="label">Routes</div><div class="value">\${h ? h.routeCount : '-'}</div></div>\`;
  html += \`<div class="stat-card"><div class="label">Cache Files</div><div class="value">\${h ? h.cacheFiles : '-'}</div></div>\`;
  html += \`<div class="stat-card"><div class="label">Cache Size</div><div class="value">\${h ? (h.cacheBytes / 1024).toFixed(1) + ' KB' : '-'}</div></div>\`;
  html += '</div>';
  html += '<h3>Status Distribution</h3><table><tr><th>Status</th><th>Count</th><th>%</th></tr>';
  for (const [k, n] of Object.entries(bs)) {
    const pct = totalStatus ? (n / totalStatus * 100).toFixed(1) : '0';
    html += \`<tr><td class="status-\${esc(k)}">\${esc(k)}</td><td>\${n}</td><td>\${pct}%</td></tr>\`;
  }
  html += '</table>';
  html += '<h3 style="margin-top:24px">Per Alias</h3><table><tr><th>Alias</th><th>Requests</th><th>Stripped</th><th>Chunks</th><th>Bytes</th><th>Avg Duration</th><th>Last</th></tr>';
  const ba = s.byAlias || {};
  for (const [alias, a] of Object.entries(ba)) {
    html += \`<tr><td>\${esc(alias)}</td><td>\${a.requests}</td><td>\${a.stripped}</td><td>\${a.chunks}</td><td>\${a.bytes}</td><td>\${formatDuration(a.avgDurationMs)}</td><td>\${new Date(a.lastAt).toLocaleTimeString()}</td></tr>\`;
  }
  html += '</table>';
  return html;
}

function renderLog() {
  const v = state.data;
  let html = '<div class="filters">';
  html += '<input placeholder="alias" value="' + esc(state.filters.alias) + '" oninput="state.filters.alias=this.value">';
  html += '<input placeholder="status code" value="' + esc(state.filters.status) + '" oninput="state.filters.status=this.value">';
  html += '<select onchange="state.filters.streamStatus=this.value"><option value="">streamStatus (any)</option>';
  for (const ss of ['complete','upstream_error','upstream_unreachable','client_aborted','stalled','no_body']) {
    html += \`<option \${state.filters.streamStatus===ss?'selected':''} value="\${ss}">\${ss}</option>\`;
  }
  html += '</select>';
  html += '<button class="action" onclick="state.filters.sinceMs=Date.now()-3600000;pollLoop()">Last 1h</button>';
  html += '<button class="action" onclick="pollLoop()">Refresh</button>';
  html += '</div>';
  html += '<table><tr><th>Time</th><th>Alias</th><th>Method</th><th>Status</th><th>Stream Status</th><th>Chunks</th><th>Bytes</th><th>Duration</th><th>Stripped</th></tr>';
  for (const e of v.log) {
    const p = e.parsed || {};
    html += \`<tr><td>\${new Date(e.ts).toLocaleTimeString()}</td><td>\${esc(p.alias || '-')}</td><td>\${esc(p.method || '-')}</td><td>\${p.upstream_status || '-'}</td><td class="status-\${esc(p.stream_status || '-')}">\${esc(p.stream_status || '-')}</td><td>\${p.chunks ?? '-'}</td><td>\${p.bytes ?? '-'}</td><td>\${formatDuration(p.duration_ms)}</td><td>\${p.stripped ?? '-'}</td></tr>\`;
  }
  html += '</table>';
  return html;
}

function renderConfig() {
  const c = state.data.config || {};
  return \`<form onsubmit="event.preventDefault();postJson('/admin/api/config',{console_enabled:this.console_enabled.checked,upstream_timeout_ms:Number(this.upstream_timeout_ms.value),stream_idle_timeout_ms:Number(this.stream_idle_timeout_ms.value)},'确认修改 img_proxy 配置?')">
    <div class="form-row"><label><input type="checkbox" name="console_enabled" \${c.console_enabled?'checked':''}> console_enabled</label></div>
    <div class="form-row"><label>upstream_timeout_ms (0=不超时)</label><input name="upstream_timeout_ms" type="number" value="\${c.upstream_timeout_ms ?? 0}"></div>
    <div class="form-row"><label>stream_idle_timeout_ms (0=不检测)</label><input name="stream_idle_timeout_ms" type="number" value="\${c.stream_idle_timeout_ms ?? 0}"></div>
    <button class="action" type="submit">保存</button>
  </form>\`;
}

function renderRoutes() {
  let html = '<table><tr><th>Alias</th><th>Upstream</th><th>Installed At</th><th>Status</th><th>Action</th></tr>';
  for (const r of state.data.routes) {
    html += \`<tr class="\${r.disabled?'disabled':''}"><td>\${esc(r.alias)}</td><td>\${esc(r.upstream)}</td><td>\${esc(r.installed_at)}</td><td>\${r.disabled?'disabled':'enabled'}</td><td><button class="\${r.disabled?'action':'danger'}" onclick="postJson('/admin/api/routes/\${r.disabled?'enable':'disable'}',{alias:r.alias},\${r.disabled?'确认启用':'确认禁用'} + ' alias ' + r.alias + '?')" data-alias="\${esc(r.alias)}">\${r.disabled?'Enable':'Disable'}</button></td></tr>\`;
  }
  html += '</table>';
  return html;
}

function renderCache() {
  const h = state.data.health;
  if (!h) return '<p>加载中...</p>';
  return \`<div class="stats-grid">
    <div class="stat-card"><div class="label">Cache Files</div><div class="value">\${h.cacheFiles}</div></div>
    <div class="stat-card"><div class="label">Cache Size</div><div class="value">\${(h.cacheBytes/1024).toFixed(1)} KB</div></div>
  </div>
  <button class="danger" onclick="postJson('/admin/api/cache/clear',{},'确认清空所有缓存?')">立即清理所有缓存</button>\`;
}

const views = { dashboard: renderDashboard, log: renderLog, config: renderConfig, routes: renderRoutes, cache: renderCache };

function render() {
  const view = views[state.tab] || views.dashboard;
  document.getElementById('view').innerHTML = view();
}

function setTab(name) {
  state.tab = name;
  for (const btn of document.querySelectorAll('nav button')) {
    btn.classList.toggle('active', btn.dataset.tab === name);
  }
  render();
  pollLoop();
}

async function pollLoop() {
  hideBanner();
  try {
    if (state.tab === 'dashboard') {
      state.data.stats = await api('GET', '/admin/api/stats');
      state.data.health = await api('GET', '/admin/api/health');
    } else if (state.tab === 'log') {
      const qs = new URLSearchParams();
      if (state.filters.alias) qs.set('alias', state.filters.alias);
      if (state.filters.status) qs.set('status', state.filters.status);
      if (state.filters.streamStatus) qs.set('streamStatus', state.filters.streamStatus);
      if (state.filters.sinceMs) qs.set('sinceMs', String(state.filters.sinceMs));
      state.data.log = await api('GET', '/admin/api/log?' + qs);
    } else if (state.tab === 'routes') {
      state.data.routes = await api('GET', '/admin/api/routes');
    } else if (state.tab === 'config') {
      state.data.config = await api('GET', '/admin/api/config');
    } else if (state.tab === 'cache') {
      state.data.health = await api('GET', '/admin/api/health');
    }
    render();
  } catch (err) {
    showBanner('无法连接 daemon: ' + err.message, 'error');
  }
}

async function postJson(path, body, msg) {
  if (!confirm(msg || '确认执行 ' + path + '?')) return;
  state.pending.add(path);
  try {
    await api('POST', path, body);
    await pollLoop();
  } catch (err) {
    alert('失败: ' + err.message);
  } finally {
    state.pending.delete(path);
  }
}

document.querySelectorAll('nav button').forEach(btn => btn.addEventListener('click', () => setTab(btn.dataset.tab)));
render();
pollLoop();
setInterval(pollLoop, 2000);
</script>
</body>
</html>`;
```

- [ ] **Step 4: 跑测试确认 pass**

Run: `bun test tests/unit/img-proxy/console/html.test.ts`
Expected: PASS 7 tests

- [ ] **Step 5: Commit**

```bash
git add src/img-proxy/console/html.ts tests/unit/img-proxy/console/html.test.ts
git commit -m "feat(img-proxy-console): INDEX_HTML template with 5 tabs + vanilla JS SPA"
```

---

## Task 8: server.ts mount console handler

**Files:**
- Modify: `src/img-proxy/server.ts:108-116` (改 fetch handler console 分支)
- Modify: `src/img-proxy/server.ts:96` (扩展 stats 字段)
- Modify: `src/img-proxy/server.ts:153/220/276` (3 个分支写 stats)
- Test: 已有 integration test（Task 6）+ 扩展

**Interfaces:**
- Produces:
  - `handleConsoleRequest(req, url, ctx)` 调用点
  - `ProxyServer.stats` 扩展字段
- Consumes: `handleConsoleRequest` from `./console/api`

### Steps

- [ ] **Step 1: 写 failing 测试**

在 `tests/integration/img-proxy-console.test.ts` 已有 5 个测试基础上，加一个：

```ts
it('console_enabled=false 时 GET / 返 404', async () => {
  // 起新 proxy with consoleEnabled=false
  const tmpProxy = await startProxyServer({
    port: 0, hostname: '127.0.0.1', cacheDir, routesPath,
    promptTemplate: '[img: {path}]', consoleEnabled: false, cacheMaxAgeHours: 24,
    logPath,
  });
  try {
    const r = await fetch(`http://127.0.0.1:${tmpProxy.port}/`);
    expect(r.status).toBe(404);
    expect(await r.text()).toContain('Console disabled');
    const r2 = await fetch(`http://127.0.0.1:${tmpProxy.port}/admin/api/stats`);
    expect(r2.status).toBe(404);
  } finally {
    tmpProxy.stop(true);
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/integration/img-proxy-console.test.ts`
Expected: FAIL（console_enabled=false 时当前 server.ts:114 占位走 501，不是 404）

- [ ] **Step 3: 改 server.ts**

**a) 顶部 import**：

```ts
import { handleConsoleRequest } from './console/api';
```

**b) 扩展 stats 字段（line 96）**：

```ts
const stats = {
  totalRequests: 0,
  strippedImages: 0,
  startedAt: Date.now(),
  byStatus: {} as Record<string, number>,
  byAlias: {} as Record<string, AliasStats>,
  recent: [] as RecentEntry[],
};
```

`AliasStats` 和 `RecentEntry` 从 `./console/types` import。

**c) 改 fetch handler console 分支（line 113-116）**：

```ts
// 总是接管 console 路由(即使 console_enabled=false),handler 内检查开关
if (url.pathname === '/' || url.pathname.startsWith('/admin')) {
  return handleConsoleRequest(req, url, {
    // configPath 必须是已 expandPath 的绝对路径(readFileSync 不识 '~')。
    // cli 接线时已 expand,test 里直接传绝对路径;兜底用 CONFIG_PATH(也是绝对路径)。
    configPath: expandPath(configPath ?? CONFIG_PATH),
    routesPath,
    cacheDir,
    logPath,
    stats,
  });
}
```

> **为什么 server.ts 内再 expand 一次**：cli 传的 `configPath` 已经展开,但 server.ts 拿到时不去校验;
> 万一上游 caller 传了 '~...' 或相对路径,兜底一次保证 readFileSync 不会踩 ENOENT。
> `CONFIG_PATH` 来自 `utils/paths.ts`,已是绝对路径。

**d) 改 startProxyServer 加 configPath 参数**：

在 `ProxyServerOptions` 加 `configPath?: string`：

```ts
export interface ProxyServerOptions {
  // ... 现有字段 ...
  configPath?: string;
}
```

`configPath` 传给 console handler 让它写回 config.toml。
**顶部 import 加**：`import { CONFIG_PATH, expandPath } from '../utils/paths';`

**e) 在 3 个分支写 stats**（对应 server.ts 实际行号）：

- **line 197 旁（fetch catch 分支）**：在 catch 块内既有的 `appendLog(...)` 之后加：
  ```ts
  stats.totalRequests++;
  stats.byStatus[finalStatus] = (stats.byStatus[finalStatus] ?? 0) + 1;
  updateByAlias(stats, alias, { requests: 1, stripped, bytes: 0, chunks: 0, durationMs: Date.now() - startedAt });
  pushRecent(stats, { ts: Date.now(), alias, status: 0, stream_status: finalStatus, chunks: 0, bytes: 0, duration_ms: Date.now() - startedAt, stripped });
  ```

- **line 223 旁（upstreamResp.body null 分支）**：在既有的 `appendLog(...)` 之后加：
  ```ts
  stats.totalRequests++;
  stats.byStatus.no_body = (stats.byStatus.no_body ?? 0) + 1;
  updateByAlias(stats, alias, { requests: 1, stripped, bytes: 0, chunks: 0, durationMs: headersToFirstChunk });
  pushRecent(stats, { ts: Date.now(), alias, status: upstreamResp.status, stream_status: 'no_body', chunks: 0, bytes: 0, duration_ms: headersToFirstChunk, stripped });
  ```

- **line 276 旁（piping.finally 块内）**：在既有的 `appendLog(...)` 之后加：
  ```ts
  stats.totalRequests++;
  stats.byStatus[streamStatus] = (stats.byStatus[streamStatus] ?? 0) + 1;
  updateByAlias(stats, alias, { requests: 1, stripped, bytes, chunks, durationMs: duration });
  pushRecent(stats, { ts: Date.now(), alias, status: upstreamResp.status, stream_status: streamStatus, chunks, bytes, duration_ms: duration, stripped });
  ```

> **关键**：`stats.totalRequests++` 在现有 server.ts:220 已有，但只对成功 fetch 后计数。本 task 在 catch / no_body 两个分支也加 `stats.totalRequests++`，让 totalRequests = 真实总请求数（成功 + 失败 + no_body）。

**f) 扩展 ProxyServer interface**（line 48-53）：

```ts
export interface ProxyServer {
  port: number;
  hostname: string;
  stop: (force?: boolean) => void;
  stats: {
    totalRequests: number;
    strippedImages: number;
    startedAt: number;
    byStatus: Record<string, number>;
    byAlias: Record<string, AliasStats>;
    recent: RecentEntry[];
  };
}
```

- [ ] **Step 4: 跑测试确认 pass**

Run: `bun test tests/integration/img-proxy-console.test.ts`
Expected: PASS 6 tests（含新加的 console_enabled=false 测试）

- [ ] **Step 5: 跑全套确认不破**

Run: `bun test`
Expected: 现有 + 新 1 = 1212 pass, 0 fail

- [ ] **Step 6: Commit**

```bash
git add src/img-proxy/server.ts tests/integration/img-proxy-console.test.ts
git commit -m "feat(img-proxy-console): server.ts mounts console handler + 3-branch stats writes"
```

---

## Task 9: cli/commands/img-proxy.ts 接线

**Files:**
- Modify: `src/cli/commands/img-proxy.ts:127-134` (`startProxyServer` 调用)

**Interfaces:**
- Produces: 改动
- Consumes: `startProxyServer` 现有 + 新 configPath 参数

### Steps

- [ ] **Step 1: 改动**

修改 `src/cli/commands/img-proxy.ts` line 127-134：

```ts
import { CONFIG_PATH, expandPath } from '../../utils/paths';
// ... 既有 import ...

let server;
try {
  server = await startProxyServer({
    port, hostname,
    cacheDir: IMG_PROXY_CACHE_DIR,
    routesPath: IMG_PROXY_ROUTES_PATH,
    promptTemplate: config.get<string>('img_proxy.prompt_template', DEFAULT_PROMPT_TEMPLATE),
    consoleEnabled: config.get<boolean>('img_proxy.console_enabled', false),
    cacheMaxAgeHours: config.get<number>('img_proxy.cache_max_age_hours', 168),
    logPath: IMG_PROXY_LOG_FILE,
    upstreamTimeoutMs: config.get<number>('img_proxy.upstream_timeout_ms', 0),
    streamIdleTimeoutMs: config.get<number>('img_proxy.stream_idle_timeout_ms', 0),
    // 新增:把 CONFIG_PATH 展开成绝对路径,让 console 能 readFileSync 直接用
    // (readFileSync 不识别 '~')
    configPath: expandPath(CONFIG_PATH),
  });
} catch (err) {
  // ... 既有错误处理
}
```

**为什么保留 consoleEnabled 参数**：保留 ProxyServerOptions 签名兼容性。server.ts 现在总是 mount console handler，consoleEnabled 参数实际不影响新行为（仅作为 init hint）。

**CONFIG_PATH 来源**：`src/utils/paths.ts:15` 已 export：

```ts
export const CONFIG_PATH = process.env.CC_LINKER_CONFIG_PATH ?? join(CC_LINKER_DIR, 'config.toml');
```

所以 `expandPath(CONFIG_PATH)` 已经把 env var 和 `~` 都处理掉,返回真实绝对路径。

- [ ] **Step 2: 跑 typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/cli/commands/img-proxy.ts
git commit -m "feat(img-proxy-console): cli passes configPath to startProxyServer"
```

---

## Task 10: docs/img-proxy.md 新章节 "Web Console"

**Files:**
- Modify: `docs/img-proxy.md` line 873（替换 "Phase 2 未实现" 段为新章节）

**Interfaces:**
- Produces: 用户文档
- Consumes: 无

### Steps

- [ ] **Step 1: 替换 line 873 的 "Phase 2 未实现" 段**

`docs/img-proxy.md` 当前 line 873 是 "Phase 2 Web 控制台...未实现"。**替换它**为：

```markdown
### Phase 2 Web Console（已实现）

开启 `console_enabled = true` 后,访问 `http://127.0.0.1:8765/` 即可使用。

#### 启用步骤

```toml
# ~/.cc-linker/config.toml
[img_proxy]
console_enabled = true
```

无需重启 daemon —— 下次请求自动生效。

#### 5 个 Tab

| Tab | 功能 |
|---|---|
| **Dashboard** | 实时 totalRequests / strippedImages / uptime / cache 文件数+大小；5min 状态分布；per-alias 聚合（requests / stripped / chunks / bytes / avgDuration / lastAt） |
| **Log** | 最近 200 条请求表格，可按 alias / status / streamStatus / 时间过滤；可手动刷新或选 "Last 1h" |
| **Config** | 修改 console_enabled / upstream_timeout_ms / stream_idle_timeout_ms，保存后热 reload |
| **Routes** | 当前 routes 列表，每行 Enable/Disable 按钮 |
| **Cache** | cache 概览 + "立即清理" 按钮 |

#### 安全

- 仅监听 127.0.0.1（需改 hostname 才能远程访问,本版本不支持）
- 写操作前端 confirm() 二次确认
- 所有写操作 audit log 到 `~/.cc-linker/img-proxy/img-proxy.log`，包含 `console_action` / `trigger: console` / 旧值新值

#### 已知限制

- 2s polling（不支持 SSE / WebSocket 推送）
- Dark mode 暂未提供
- Mobile responsive 暂未优化
```

- [ ] **Step 2: 验证 docs 结构**

Run: `grep -n "Web Console" docs/img-proxy.md`
Expected: 至少 1 行匹配

- [ ] **Step 3: Commit**

```bash
git add docs/img-proxy.md
git commit -m "docs(img-proxy-console): add Web Console user-facing section"
```

---

## Task 11: 最终验证 + build

**Files:**
- 无（验证步骤）

### Steps

- [ ] **Step 1: 跑全套测试**

Run: `bun test`
Expected: 0 fail

- [ ] **Step 2: 跑 typecheck**

Run: `bun run typecheck`
Expected: clean (no output)

- [ ] **Step 3: build binary**

Run: `bun run build`
Expected: `dist/cc-linker` 存在,binary 体积增加 < 50KB（HTML 模板约 12-15KB）

- [ ] **Step 4: 端到端 smoke test**

```bash
# 启动 daemon
cc-linker img-proxy install --providers glm-5.2  # 确保 routes 有
cc-linker img-proxy start --daemon

# 浏览器打开 http://127.0.0.1:8765/
# 跑几个 claude 请求 → Dashboard 数字应滚动
# 进 Log tab 看新条目
# 进 Config tab 改 console_enabled (skip, 不破坏)
# 进 Routes tab disable glm-5.2 → 验证 proxy 请求 502
# 进 Cache tab 点 "立即清理" → 验证 cache 清空

# 关停
cc-linker img-proxy stop
```

- [ ] **Step 5: 最终 commit（如有 changes）**

```bash
git status
# 如果有改动:
git add -A
git commit -m "chore(img-proxy-console): final smoke test verification"
```

---

## Self-Review

### Spec coverage

| Spec 节 | 实现 task |
|---|---|
| §1.1 目标 4 项 | Task 6 (api) + Task 7 (html) + Task 8 (mount) |
| §1.2 非目标 | 不实现（明确排除） |
| §2.1 模块划分 | Task 6 (api) + Task 4 (log-parser) + Task 7 (html) |
| §2.2 路由表 | Task 8 (mount handler) |
| §2.4 改动 server.ts | Task 8 |
| §3 stats 字段 | Task 1 (helpers) + Task 8 (server.ts 写入) |
| §4 log-parser | Task 4 |
| §5 前端结构 | Task 7 (html template) |
| §6 api endpoints | Task 6 |
| §7.1 config.reload() | Task 2 |
| §7.2 atomic write | Task 6 (handlePostConfig) |
| §7.3 console_enabled 热开关 | Task 8 (改 server.ts:114) |
| §7.4 routes disable | Task 3 |
| §7.5 cache clear | Task 6 (handlePostCacheClear) |
| §8 health check | Task 6 (handleHealth) + Task 5 (getCacheBytes) |
| §9 测试策略 | Task 1-8 各 task 含测试 |
| §10 docs 更新 | Task 10 |

✅ Spec 全覆盖。

### Placeholder scan

搜索关键词：`TODO`, `TBD`, `FIXME`, `XXX`, `待定`, `implement later`, `similar to Task`, `fill in`.

无 placeholder。

### Type consistency

- `AliasStats / RecentEntry` — Task 1 types.ts 定义，Task 1 stats-helpers.ts + Task 8 server.ts 共享
- `LogEntry / ParsedLogEntry / ReadRecentOpts` — Task 1 types.ts 定义，Task 4 log-parser.ts + Task 6 api.ts 共享
- `HealthStats / RouteListEntry` — Task 1 types.ts 定义，Task 6 api.ts 使用
- `ConsoleContext.configPath` — Task 6 定义（已 expandPath 绝对路径），Task 8 传入 + Task 9 cli 用 `expandPath(CONFIG_PATH)` 提供
- `config.reload()` — Task 2 定义，Task 6 handlePostConfig 调用
- `setRouteDisabled(path, alias, disabled)` — Task 3 定义，Task 6 handlePostDisable/handlePostEnable 调用
- `getCacheBytes / resetHealthCache` — Task 5 定义，Task 6 handleHealth / handlePostCacheClear 使用

✅ 类型 / 函数名一致。

---

## 完成

11 个 task 全部 commit + push 后,spec 的 Web Console 功能 ship-ready。下一个 session 可以按本 plan 顺序执行（或选 subagent-driven 并行）。

Plan 文件：`docs/superpowers/plans/2026-07-05-img-proxy-console.md`
Spec 文件：`docs/superpowers/specs/2026-07-05-img-proxy-console-design.md`