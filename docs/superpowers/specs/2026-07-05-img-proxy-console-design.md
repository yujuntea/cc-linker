# cc-linker img-proxy Web Console — 设计

> **日期:** 2026-07-05
> **状态:** 等待用户 review
> **分支:** `feat/cli-image-proxy`
> **取代:** 无（这是 Phase 2 控制台的全新 spec）
> **前置 spec:**
> - `2026-07-04-img-proxy-smart-install-design.md`（本次设计的上游依赖：install 流程、routes.json、provider config 等都已 ship）

## 1. 目标 & 非目标

### 1.1 目标

为 `cc-linker img-proxy` daemon 提供一个**单机本地 Web 控制台**，覆盖：

1. **实时监控** —— 实时看 totalRequests / strippedImages / status 分布 / per-alias 指标 / chunks+bytes 总和；定位 "Connection closed mid-response" 是 upstream 慢、上游主动断、还是 client 断开
2. **历史日志查询** —— 倒序读现有 `~/.cc-linker/img-proxy/img-proxy.log`，按 alias / status / stream_status / 时间过滤
3. **运行时配置** —— 改 `console_enabled` / `upstream_timeout_ms` / `stream_idle_timeout_ms`，热 reload，**不重启 daemon**
4. **运行时运维** —— routes 临时 disable / enable、cache 清理、查看 daemon 健康状态

### 1.2 非目标（v1 明确排除）

- **多用户 / 鉴权 / 远程访问**：本 spec 仅 127.0.0.1；任何打开 localhost:8765 的人即视为用户本人
- **复杂图表库**（recharts / chart.js）：内嵌 SVG 自绘足够
- **历史 log 写 SQLite**：直接 parse 现有 append-only log 文件
- **运行时改 routes 的 upstream URL / prompt_template**：disable/enable 已够；改 URL 需要 uninstall+reinstall，走 CLI
- **WebSocket / SSE 推送**：2s polling 足够（用户操作频率低）
- **Dark mode / Theme 切换**：单 theme 起步
- **Mobile responsive**：本地用，桌面浏览器起步

### 1.3 范围预估

**新增文件**：~580 行

| 文件 | 行数估算 | 用途 |
|---|---|---|
| `src/img-proxy/console/html.ts` | 250 | `INDEX_HTML` 模板（HTML + 内嵌 CSS + 内嵌 JS） |
| `src/img-proxy/console/api.ts` | 200 | `/admin/api/*` 路由分发 + handler |
| `src/img-proxy/console/log-parser.ts` | 80 | read-only log 解析（filter / sort / limit / 增量 tail） |
| `src/img-proxy/console/config-reload.ts` | 50 | `config.reload()` + config.toml atomic write |

**改动文件**：~160 行

| 文件 | 改动 |
|---|---|
| `src/img-proxy/server.ts` | stats 字段扩展（byStatus / byAlias / recent ring buffer） + console 路由分发 |
| `src/utils/config.ts` | 加 `reload()` 方法（只覆盖 img_proxy section） |
| `src/img-proxy/routes.ts` | 加 `setRouteDisabled(alias, disabled)` |
| `src/cli/commands/img-proxy.ts` | 启动时 mount console handler（即使 `console_enabled=false`） |

**测试**：~350 行
- 单测 4 个文件 ~200 行
- 集成测 1 个文件 ~150 行

**总：~1090 行**。属于中任务（多文件但边界清晰），不需要 worktree。

## 2. 架构总览

### 2.1 模块划分

```
src/img-proxy/console/
  ├── html.ts        # export const INDEX_HTML: string  (vanilla JS 内嵌)
  ├── api.ts         # 所有 /admin/api/* handler
  ├── log-parser.ts  # parse ~/.cc-linker/img-proxy/img-proxy.log
  └── config-reload.ts # 热 reload config.toml + atomic write

src/img-proxy/
  ├── server.ts      # ← 改:stats 字段扩展 + console 路由分发
  └── routes.ts      # ← 改:setRouteDisabled() 新增

src/utils/
  └── config.ts      # ← 改:reload() 方法新增

src/cli/commands/
  └── img-proxy.ts   # ← 改:启动时永远 mount console handler
```

### 2.2 路由表

| Method + Path | 触发条件 | 处理 |
|---|---|---|
| `GET /` | `console_enabled=true` | 返回 `INDEX_HTML` (Content-Type: text/html) |
| `GET /admin/api/*` | `console_enabled=true` | `api.ts` 路由分发 |
| 其他所有 path | 任何时候 | 现有 image proxy 逻辑（不变） |

### 2.3 现状回顾（已经 ship）

- `server.ts:113-115` 有占位：`if (consoleEnabled && (url.pathname === '/' || url.pathname.startsWith('/admin'))) return 501 'console not implemented (Phase 2)'`
- `config.ts:201` 有 `console_enabled: false` 字段
- `docs/img-proxy.md:873` 明确：要看请求计数只能 `grep stripped ~/.cc-linker/img-proxy/img-proxy.log`
- server.ts stats 字段当前只有 `totalRequests / strippedImages`

### 2.4 改动关键点

**server.ts:114** 现状：

```ts
if (consoleEnabled && (url.pathname === '/' || url.pathname.startsWith('/admin'))) {
  return new Response('console not implemented (Phase 2)', { status: 501 });
}
```

**改为**：

```ts
// 始终接管 console 路由(即使 console_enabled=false),handler 内检查开关
// 这样 console_enabled 热开关生效不需要重启
if (url.pathname === '/' || url.pathname.startsWith('/admin')) {
  return handleConsoleRequest(req, url);
}
```

`handleConsoleRequest` 第一行：

```ts
if (!config.get('img_proxy.console_enabled')) {
  return new Response('Console disabled. Set img_proxy.console_enabled=true in config.toml.', { status: 404 });
}
```

## 3. Stats 扩展（server.ts）

### 3.1 当前 stats 字段

```ts
const stats = { totalRequests: 0, strippedImages: 0 };
```

### 3.2 新 stats 字段

```ts
const stats = {
  totalRequests: 0,
  strippedImages: 0,
  startedAt: Date.now(),
  // per-status 计数 — 让 Dashboard 实时显示状态分布
  byStatus: {
    complete: 0,
    upstream_error: 0,
    client_aborted: 0,
    stalled: 0,
    upstream_unreachable: 0,
    no_body: 0,
  } as Record<string, number>,
  // per-alias 聚合
  byAlias: {} as Record<string, {
    requests: number;
    stripped: number;
    bytes: number;
    chunks: number;
    avgDurationMs: number;
    lastAt: number;
  }>,
  // 最近 200 条请求详情(环形 buffer)— Log tab 表格数据源
  recent: [] as Array<{
    ts: number;
    alias: string;
    status: number;
    stream_status: string;
    chunks: number;
    bytes: number;
    duration_ms: number;
    stripped: number;
  }>,
};
```

### 3.3 写入时机

**两个分支都要写 stats**（不只 piping.finally）：

```ts
// ① fetch 抛错路径(server.ts:197 现有 catch)
} catch (err) {
  const isAbort = err instanceof Error && err.name === 'AbortError';
  const finalStatus: 'client_aborted' | 'upstream_unreachable' =
    isAbort && req.signal.aborted ? 'client_aborted' : 'upstream_unreachable';
  // 既有 appendLog(...) 写 log
  
  // 新增:写 stats
  stats.totalRequests++;
  stats.byStatus[finalStatus] = (stats.byStatus[finalStatus] ?? 0) + 1;
  updateByAlias(stats, alias, { requests: 1, stripped, bytes: 0, chunks: 0, durationMs: Date.now() - startedAt });
  pushRecent(stats, { ts: Date.now(), alias, status: 0, stream_status: finalStatus, chunks: 0, bytes: 0, duration_ms: Date.now() - startedAt, stripped });
  
  // ... 既有 return Response
}

// ② body null 路径(server.ts:223)
if (!upstreamResp.body) {
  // 既有 appendLog
  stats.totalRequests++;
  stats.byStatus.no_body = (stats.byStatus.no_body ?? 0) + 1;
  // ... 同上 stats 写入
}

// ③ piping.finally 路径(server.ts:276)
piping.finally(() => {
  if (idleTimer !== null) clearInterval(idleTimer);
  const duration = Date.now() - startedAt;
  // 既有 appendLog(...)
  stats.totalRequests++;
  stats.byStatus[streamStatus] = (stats.byStatus[streamStatus] ?? 0) + 1;
  updateByAlias(stats, alias, { requests: 1, stripped, bytes, chunks, durationMs: duration });
  pushRecent(stats, { ts: Date.now(), alias, status: upstreamResp.status, stream_status: streamStatus, chunks, bytes, duration_ms: duration, stripped });
});
```

**为什么三个分支都写**：不同 stream_status 走不同分支；丢一个分支会让 stats.byStatus 漏数。

**Ring buffer 上限 200**：够覆盖 2s polling × 几小时窗口；超过自动丢弃最旧。

**辅助函数**（提到 server.ts 顶部或新 helper 文件）：

```ts
function updateByAlias(stats, alias, m: { requests: number; stripped: number; bytes: number; chunks: number; durationMs: number }) {
  const a = stats.byAlias[alias] ??= { requests: 0, stripped: 0, bytes: 0, chunks: 0, avgDurationMs: 0, lastAt: 0 };
  a.requests += m.requests;
  a.stripped += m.stripped;
  a.bytes += m.bytes;
  a.chunks += m.chunks;
  // 增量平均(避免存所有 duration 列表)
  a.avgDurationMs = (a.avgDurationMs * (a.requests - m.requests) + m.durationMs * m.requests) / a.requests;
  a.lastAt = Date.now();
}

function pushRecent(stats, entry) {
  stats.recent.unshift(entry);
  if (stats.recent.length > 200) stats.recent.length = 200;
}
```

### 3.4 为什么保留 log file + 加 stats

- **stats** = O(1) 内存读 → Dashboard 实时刷新 2s polling
- **log file** = 全量 audit + 重启后数据 + filter 查询（Log tab 用）
- 两层不冲突，互不替代

### 3.5 ProxyServer interface 同步

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
    byAlias: Record<string, { requests: number; stripped: number; bytes: number; chunks: number; avgDurationMs: number; lastAt: number }>;
    recent: Array<{ ts: number; alias: string; status: number; stream_status: string; chunks: number; bytes: number; duration_ms: number; stripped: number }>;
  };
}
```

## 4. Log Parser（log-parser.ts）

### 4.1 函数签名

```ts
export interface LogEntry {
  /** Date.parse(ISO timestamp from log line prefix) → ms timestamp */
  ts: number;
  /** 原始行(含 [timestamp] INFO {json} 前缀) */
  raw: string;
  parsed: {
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
  } | null;  // 非 JSON 行(如 ERROR / WARN)为 null
}

export interface ReadRecentOpts {
  logPath: string;
  limit?: number;         // default 100
  alias?: string;
  status?: number;        // upstream_status 过滤
  streamStatus?: string;
  sinceMs?: number;       // Date.parse() 兼容格式; 0 = 不过滤
}

export async function readRecentLogLines(opts: ReadRecentOpts): Promise<LogEntry[]>;
```

**注意**：前端 `?sinceMs=` 用 ms timestamp（Date.now()）—— 后端把 ISO 字符串 parse 后比较整数 ms。

### 4.2 增量 LogTail（避免 polling 时全文件重读）

**必须是 module-level singleton**，否则每次请求 new LogTail → offset 永远是 0 → 每次重读全文件。

```ts
// src/img-proxy/console/log-parser.ts
let _tail: LogTail | null = null;
function getTail(logPath: string): LogTail {
  if (!_tail || _tail.logPath !== logPath) {
    _tail = new LogTail(logPath);
  }
  return _tail;
}

export class LogTail {
  constructor(public readonly logPath: string) {}
  async readNew(): Promise<LogEntry[]>;  // 只读上次 offset 到现在的增量
  get offset(): number;
}
```

**实现思路**：
- 用 `Bun.file(this.logPath).slice(this.offset).text()` 读增量字节
- 维护 lastOffset（持久化到内存即可，daemon 重启重置 OK）
- 按 `\n` split，最后一段可能不完整，留到下次

**单元测试隔离**：测试里需要 `resetLogTail()` helper 调 `_tail = null`。

### 4.3 现有 log 行格式

INFO 行（stream instrumentation 输出的）：

```json
{"time":"2026-07-05T07:32:06.722Z","alias":"glm-5.2","method":"POST","path":"/glm-5.2/v1/messages","stripped":0,"upstream_status":200,"duration_ms":7038,"headers_to_first_chunk_ms":234,"chunks":12,"bytes":12345,"stream_status":"complete","upstream_error_msg":null}
```

前缀：`[2026-07-05T07:32:06.722Z] INFO {...}`。解析用正则 `^\[([^\]]+)\] INFO (.+)$` 提取时间戳 + JSON body。

## 5. 前端结构（vanilla JS 单页应用）

### 5.1 单 HTML 文件（`INDEX_HTML` 常量）

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>cc-linker img-proxy console</title>
  <style>/* ~5KB 内嵌 CSS */</style>
</head>
<body>
  <nav>...5 个 tab 按钮...</nav>
  <main id="view"></main>
  <script>/* ~10KB vanilla JS */</script>
</body>
</html>
```

**所有 JS / CSS inline 进模板字符串**。Bun.serve 直接返回 `Response(INDEX_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } })`。

**零外部资源、零 CDN、零构建步骤**。

### 5.2 5 个 Tab

| Tab | 内容 | API | 刷新策略 |
|---|---|---|---|
| **Dashboard** | 总请求数 / strip 图 / 5min 状态分布 / per-alias 表 / uptime / cache size | `GET /admin/api/stats` + `/admin/api/health` | 2s polling |
| **Log** | 最近 200 条请求表，可按 alias / status / streamStatus / 时间过滤 | `GET /admin/api/log?limit=200&alias=X&status=Y&sinceMs=Z` | 手动"刷新"按钮 |
| **Config** | 当前生效 img_proxy 配置（snapshot） + 表单改 console_enabled / upstream_timeout_ms / stream_idle_timeout_ms | `GET /admin/api/config` + `POST /admin/api/config` | 手动 |
| **Routes** | 当前 routes 表，每行 Enable/Disable 按钮 | `GET /admin/api/routes` + `POST /admin/api/routes/{disable,enable}` | 2s polling（同 Dashboard，共享 setInterval） |
| **Cache** | cache 大小 / 文件数 / 最后清理时间 + "立即清理"按钮 | `GET /admin/api/health` + `POST /admin/api/cache/clear` | 手动 |

### 5.3 Vanilla JS 结构（无 framework）

```js
// 状态
const state = {
  tab: 'dashboard',
  filters: { alias: '', status: '', streamStatus: '', sinceMs: 0 },
  pending: new Set(),
  data: { stats: null, health: null, log: [], config: null, routes: [] },
};

// 5 个 view 函数
const views = {
  dashboard: renderDashboard,
  log: renderLog,
  config: renderConfig,
  routes: renderRoutes,
  cache: renderCache,
};

// router
function setTab(name) { state.tab = name; render(); }

// poll loop
async function pollLoop() {
  if (state.tab === 'dashboard') {
    state.data.stats = await api('GET', '/admin/api/stats');
    state.data.health = await api('GET', '/admin/api/health');
    render();
  } else if (state.tab === 'log') {
    state.data.log = await api('GET', '/admin/api/log?' + qs(state.filters));
    render();
  } else if (state.tab === 'routes') {
    state.data.routes = await api('GET', '/admin/api/routes');
    render();
  }
  // config / cache 是手动刷新
}
setInterval(pollLoop, 2000);

// api wrapper
async function api(method, path, body) {
  const r = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.headers.get('content-type')?.includes('json') ? r.json() : r.text();
}

// 写操作: confirm + POST + reload
async function postJson(path, body, msg) {
  if (!confirm(msg ?? `确认执行 ${path}?`)) return;
  state.pending.add(path);
  render();
  try {
    await api('POST', path, body);
    await pollLoop();
  } catch (e) {
    alert(`失败: ${e.message}`);
  } finally {
    state.pending.delete(path);
    render();
  }
}

// bootstrap
render();
pollLoop();
```

### 5.4 图表实现

- **数字滚动**：直接 `textContent` 替换
- **饼图 / 柱状图**：内嵌 SVG（vanilla JS 动态生成 `<path>`）
- **表格**：`<table>` + 模板字符串

### 5.5 代码量估算

- HTML 模板：~80 行
- CSS：~150 行
- JS：~300 行（5 view + router + poll + api wrapper + 状态）
- **总：~530 行内嵌字符串**

### 5.6 错误处理

- API 失败 → 顶部黄色 banner "无法连接 daemon"+ 5s 重试
- 写操作失败 → `alert()` + 不更新 state（前端 state 总是 fetch 后再更新，不本地乐观写）

## 6. 后端 API surface（api.ts）

### 6.1 路由列表

| Method + Path | Body | Response |
|---|---|---|
| `GET /admin/api/stats` | — | `ProxyServer['stats']` (见 §3.5) |
| `GET /admin/api/log` | query: `limit, alias, status, streamStatus, sinceMs` | `LogEntry[]` |
| `GET /admin/api/config` | — | 当前生效 `img_proxy` snapshot |
| `POST /admin/api/config` | `Partial<{ console_enabled, upstream_timeout_ms, stream_idle_timeout_ms }>` | `{ ok: true, applied: {...} }` |
| `GET /admin/api/routes` | — | `Array<{ alias, upstream, installed_at, disabled }>` |
| `POST /admin/api/routes/disable` | `{ alias }` | `{ ok: true }` |
| `POST /admin/api/routes/enable` | `{ alias }` | `{ ok: true }` |
| `POST /admin/api/cache/clear` | — | `{ ok: true, removed: N }` |
| `GET /admin/api/health` | — | `{ uptimeMs, pid, routeCount, cacheFiles, cacheBytes }` |

### 6.2 错误返回格式

```ts
// 失败统一
{ "error": "human readable message", "code": "E_CONSOLE_*" }

// 4xx: 客户端错误（参数错 / alias 不存在）
// 5xx: 服务器错误（写文件失败 / routes.json 锁失败）
```

具体 error code 列表（写在 `src/img-proxy/console/api.ts` 顶部）：
- `E_CONSOLE_DISABLED` (404, console_enabled=false) — **注意：返 plain text 而非 JSON**（见 §7.3 实现细节）
- `E_CONSOLE_BAD_REQUEST` (400, body 缺字段 / 类型错)
- `E_CONSOLE_UNKNOWN_ALIAS` (404, routes/{disable,enable} 给的 alias 不存在)
- `E_CONSOLE_CONFIG_WRITE_FAILED` (500, atomic write 失败)
- `E_CONSOLE_ROUTES_LOCK_FAILED` (500, proper-lockfile 获取失败)

### 6.3 写操作全部 audit log

每次 POST handler 在写操作前后 appendLog：

```
[2026-07-05T...] INFO {"console_action":"config_update","key":"upstream_timeout_ms","old":0,"new":60000,"trigger":"console"}
[2026-07-05T...] INFO {"console_action":"routes_disable","alias":"glm-5.2","trigger":"console"}
[2026-07-05T...] INFO {"console_action":"cache_clear","removed":42,"trigger":"console"}
```

方便事后回溯谁什么时候改了什么。

## 7. 运行时 Config / Routes 热 Reload

### 7.1 config.ts 加 `reload()`

```ts
reload(): void {
  // 关键:每次 reload 都用 DEFAULTS.img_proxy 作底,而不是 this.data.img_proxy
  // 否则用户从 config.toml 删除某个字段后,旧值仍残留(this.data 已被前次 reload 改过)
  // DEFAULTS 在 config.ts:191 是 const,保证每次 reload 都是"用默认值打底 + 文件覆盖"
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

**import DEFAULTS**：`reload()` 需要 import DEFAULTS。`reload()` 是新加的 public 方法，可以调 const DEFAULTS（同模块）。

### 7.2 POST /admin/api/config 流程

1. 解析 body（`Partial<{console_enabled, upstream_timeout_ms, stream_idle_timeout_ms}>`）
2. 用 `toml` 库（或 node:fs 手写）**只改** img_proxy 这几个字段（保留其他 section 注释 / 顺序）
3. Atomic write：写 `.tmp` → rename
4. 调 `config.reload()`
5. appendLog audit
6. 返 `{ ok: true, applied: {...} }`

**为什么用 toml 库**：config.toml 是带注释的 TOML，手写 parser 容易破坏现有注释。`config.ts:4` 已经 import `@iarna/toml`，复用现成 parse()；写回用 `@iarna/toml.stringify()`（保留 section 顺序，但**注释会丢**——这是已知 trade-off，console 改动前会先读 + 备份原文件，写失败时 rollback）。

**风险**：写 config.toml 失败 → 返 500 + **不 reload**（config 仍是旧值，不会脑裂）。

### 7.3 console_enabled 热开关（无需重启）

**方案 A（采用）**：daemon 启动时**永远** mount console handler（即使 console_enabled=false），handler 第一行读最新 config：

```ts
function handleConsoleRequest(req, url) {
  if (!config.get('img_proxy.console_enabled')) {
    return new Response('Console disabled. Set img_proxy.console_enabled=true in config.toml.', { status: 404 });
  }
  // ...
}
```

每请求读最新值 → console_enabled 改 true 后**下一请求立即生效**，不需要重启 daemon。

**user-facing behavior 变化（accept 这是 desired）**：

| 状态 | 旧行为（当前 server.ts:114） | 新行为（计划改动后） |
|---|---|---|
| console_enabled=false，访问 `/` | fall through 到 image proxy → alias='' → 502 'missing provider alias' | console handler 接 → 404 'Console disabled' |
| console_enabled=false，访问 `/admin/api/stats` | 同上 → 502 | 404 'Console disabled' |
| console_enabled=true | 501 'console not implemented (Phase 2)' | 真实 console 响应 |

**改动**：把 server.ts:114 的 `if (consoleEnabled && ...)` 改成 `if (url.pathname === '/' || url.pathname.startsWith('/admin')) { return handleConsoleRequest(req, url); }`。`consoleEnabled` 局部 const 在新实现里**不再使用**（但保留兼容字段不破坏 ProxyServerOptions signature）。

**cli 那边**：`cli/commands/img-proxy.ts:132` 仍传 `consoleEnabled` 给 `startProxyServer()`，但值仅作为 daemon 启动时**初始化 hint**（目前不影响新行为——新行为总是 mount handler）；保留是为了不破坏 ProxyServerOptions 签名。

### 7.4 Routes 临时 disable / enable

**新增字段**：`routes.json` 每条 route 加可选 `disabled: boolean`。

```json
{
  "version": 1,
  "routes": {
    "glm-5.2": {
      "alias": "glm-5.2",
      "upstream": "http://...",
      "disabled": true,
      "installed_at": "..."
    }
  }
}
```

**改动点**：

1. **改 `getUpstreamByAlias`**（routes.ts:97）让它读 disabled 字段：

   ```ts
   export function getUpstreamByAlias(path: string, alias: string): string | null {
     const entry = loadRoutes(path).routes[alias];
     if (!entry || entry.disabled) return null;
     return entry.upstream ?? null;
   }
   ```

   - disabled route → 返 null → proxy 走 502 'unknown alias'（已有路径）
   - 影响：现有测试 `tests/integration/img-proxy-server.test.ts` 不依赖 disabled（用 mock routes.json，没有 disabled 字段），不需要改测试
   - 但需要加单测覆盖 disabled=true 返 null 的场景

2. **`routes.ts` 加 `setRouteDisabled`**：

   ```ts
   export async function setRouteDisabled(
     path: string, alias: string, disabled: boolean
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

   - 用现有 `withRoutesLock`（proper-lockfile）
   - disable=true → 设字段；disable=false → 删字段（schema 干净）
   - unknown alias → throw（让 console api 返 404 E_CONSOLE_UNKNOWN_ALIAS）

3. **`addRoute` 行为保持不变**（routes.ts:67）：
   - 它 create/overwrite entry 时**不读** disabled 字段
   - **已知 race**：user disable 某 alias 后跑 `img-proxy install --providers <alias>`，addRoute 会覆盖 entry，丢失 disable 状态
   - **缓解**：addRoute 保留旧 entry 的 disabled 字段：

     ```ts
     export async function addRoute(path: string, alias: string, upstream: string, providerPath: string): Promise<void> {
       await withRoutesLock(path, async () => {
         const table = loadRoutes(path);
         const existing = table.routes[alias];
         table.routes[alias] = {
           alias, upstream, provider_path: providerPath,
           original_base_url: upstream,
           installed_at: existing?.installed_at ?? new Date().toISOString(),
           // 保留 disable 标记
           ...(existing?.disabled ? { disabled: true } : {}),
         };
         // ... 既有 atomic write
       });
     }
     ```

**为什么用 disabled 字段而不是直接删**：保留历史 + 恢复时不用重装。

### 7.5 Cache 清理

`POST /admin/api/cache/clear`：

```ts
const removed = cleanupOldCache(cacheDir, 0);  // maxAgeHours=0 = 全部清
appendLog(`INFO {"console_action":"cache_clear","removed":${removed},"trigger":"console"}`, logPath);
return { ok: true, removed };
```

`cleanupOldCache` 已在 server.ts 存在，复用。

### 7.6 风险 + 防御

- **写 config.toml 出错**：atomic write + try/catch；失败返 500 不 reload
- **routes.json 并发写**：proper-lockfile 复用
- **误操作**：前端 `confirm()` + 后端 audit log
- **reload 期间正在跑的请求**：stats 对象字段同步赋值无 race；console_enabled 切换不影响 in-flight 请求（已建立的 response stream 不变）

## 8. 健康检查（GET /admin/api/health）

```ts
{
  uptimeMs: Date.now() - stats.startedAt,
  pid: process.pid,
  routeCount: Object.keys(loadRoutes(routesPath).routes).length,
  cacheFiles: readdirSync(cacheDir).length,
  cacheBytes: sum of statSync(f).size,
}
```

**注意**：`cacheBytes` 计算可能慢（上千文件 → statSync N 次）。**5s 缓存放在 module-level singleton**（同 LogTail）：

```ts
// src/img-proxy/console/api.ts (module level)
let _cacheBytesCache: { value: number; computedAt: 0 } = { value: 0, computedAt: 0 };
const CACHE_TTL_MS = 5000;

function getCacheBytes(cacheDir: string): number {
  if (Date.now() - _cacheBytesCache.computedAt < CACHE_TTL_MS) {
    return _cacheBytesCache.value;
  }
  let total = 0;
  try {
    for (const f of readdirSync(cacheDir)) {
      try { total += statSync(join(cacheDir, f)).size; } catch {}
    }
  } catch {}
  _cacheBytesCache = { value: total, computedAt: Date.now() };
  return total;
}
```

**单测隔离**：`resetHealthCache()` helper 清 `_cacheBytesCache = { value: 0, computedAt: 0 }`。

## 9. 测试策略

### 9.1 单测（`tests/unit/img-proxy/console/`）

| 文件 | 覆盖 |
|---|---|
| `log-parser.test.ts` | 构造 50 行假 log，测 filter / sort / limit / LogTail 增量读 |
| `config-reload.test.ts` | 改 tmp config.toml，调 `config.reload()`，验证 `config.data.img_proxy` 更新；mock 其他 section 不被覆盖 |
| `routes-disable.test.ts` | mock routes.json，测 `setRouteDisabled` 写文件 + lock 正确性 |
| `html.test.ts` | snapshot test `INDEX_HTML` 包含 nav / 5 个 tab / 内嵌 CSS / 内嵌 JS |

### 9.2 集成测（`tests/integration/img-proxy-console.test.ts`）

起 proxy（`console_enabled=true`）+ 起 routes + 写假 log：

- `GET /` 返 HTML 200
- `GET /admin/api/stats` 返 stats JSON（含 `byStatus` / `byAlias` / `recent` 字段）
- `GET /admin/api/log?limit=10` 返 JSON 数组
- `POST /admin/api/config` 改 `console_enabled`，再调 GET 验证生效
- `POST /admin/api/routes/disable` body `{alias:'glm-5.2'}`，再发 proxy 请求应 502
- `POST /admin/api/cache/clear`，验证 cacheDir 清空
- `console_enabled=false` 时 `GET /admin/api/stats` 返 404

### 9.3 端到端（手动）

- `bun run build` 出 binary → `cc-linker img-proxy start --daemon` → 浏览器打开 `http://127.0.0.1:8765/`
- 跑几个 claude 请求观察 Dashboard / Log tab 实时变化
- Config tab 改 `upstream_timeout_ms = 60000`，验证下次请求带 timeout
- Routes tab disable 一个 alias，验证 proxy 502

### 9.4 验证清单

1. `bun test tests/unit/img-proxy/console/` + `tests/integration/img-proxy-console.test.ts` 全过
2. `bun run typecheck` clean
3. `bun run build` 出 binary 体积增加 < 50KB（HTML+CSS+JS 总和）
4. 端到端：5 个 tab 都能正常加载 + 写操作有 audit log

## 10. 相关文件清单

### 新增（5 个）
- `src/img-proxy/console/html.ts`
- `src/img-proxy/console/api.ts`
- `src/img-proxy/console/log-parser.ts`
- `src/img-proxy/console/config-reload.ts`
- `docs/img-proxy.md` ← 改: 新章节 "Web Console" 说明用法

### 改动（4 个）
- `src/img-proxy/server.ts`（stats 扩展 + console 路由分发）
- `src/utils/config.ts`（reload 方法）
- `src/img-proxy/routes.ts`（setRouteDisabled）
- `src/cli/commands/img-proxy.ts`（启动时 mount console handler）

### 测试（5 个新增）
- `tests/unit/img-proxy/console/log-parser.test.ts`
- `tests/unit/img-proxy/console/config-reload.test.ts`
- `tests/unit/img-proxy/console/routes-disable.test.ts`
- `tests/unit/img-proxy/console/html.test.ts`
- `tests/integration/img-proxy-console.test.ts`

## 11. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 写 config.toml 破坏现有格式 | atomic write + try/catch；失败返 500 不 reload |
| routes.json 并发写 | 复用 proper-lockfile |
| 前端误操作 | confirm dialog + 后端 audit log |
| HTML 内嵌巨大膨胀 binary | 严格 < 50KB 限制；snapshot test 守住 |
| 2s polling 在低活跃时浪费 | 没新数据时不重 render（diff 比较） |
| console_enabled=false 时仍 mount handler | 几乎零成本（一个 if 判断）；换来热开关 UX |

**整体回滚**：所有 console 代码集中在 `src/img-proxy/console/` + server.ts 单 if 分支，git revert 单 commit 即可。