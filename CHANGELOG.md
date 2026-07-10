# Changelog

All notable changes to cc-linker are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/), version numbers follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **img-proxy 模型调用 token 统计** — 之前 Dashboard 只有 transport-level
  `bytes` (响应体明文字节数),看不到具体花了多少 model tokens。新加从
  upstream 响应 SSE/JSON 解析 `usage` 字段的逻辑(`applyUsageLine` 在
  `server.ts`),自动识别:
  - **Anthropic 格式**:`message_start` 拿 `input_tokens` +
    `cache_read_input_tokens` + `cache_creation_input_tokens`,
    `message_delta` 拿最终 `output_tokens`
  - **OpenAI-compat 格式**(glm / qwen / deepseek / OpenAI 自身):
    `usage.prompt_tokens` + `usage.completion_tokens`
  - 同时支持流式(SSE 多 event)与非流式(单 JSON body)— 整 body
    无换行时由 `piping.finally` flush 残留的 sseBuf
  累加语义 max-of:同一请求内重复声明同一字段取最大值,防 message_start
  里的 `output_tokens=1` 被 message_delta 后的旧值回退。

  累计到 per-alias 聚合(`AliasStats`) + per-request 环形 buffer
  (`RecentEntry`) + log JSON 行(Log tab 可用)。Dashboard Per Alias 表
  新增 4 列:In Tokens / Out Tokens / Cache Read / Cache Create;
  Log 表 4 列同位置。

- **img-proxy daemon install 后健康检查** — `cc-linker img-proxy daemon
  install` 之前在 `launchctl load/start` 之后只 print 成功,没有真正验证
  launchd 是否进入 running + 8765 端口是否可访问。`src/utils/daemon-health.ts`
  新模块把检查抽象成可注入的 `HealthCheck` 列表(`retryHealthCheck` +
  `runPostInstallHealthChecks`),生产代码传 launchctl / curl 实测,测试
  可传 stub 避免副作用。失败时显式 exit 1 + 打印失败项,不再"静默成功"。
  配套:`executable.ts` 新增 `getLaunchdExecutablePath()`,launchd 对
  daemon 不走用户 shell 的 PATH,之前写裸 `cc-linker` → `EX_CONFIG (78)`,
  KeepAlive 永远重启失败;plist 改写绝对路径修掉。

### Fixed

- **img-proxy daemon 开机自启在 setup wizard 里被跳过** —
  `imgProxyStart` 之前在 parent spawn 完 child 后直接 `process.exit(0)`,
  这个 exit 顺带把正在跑的 `setup` wizard 进程也杀了,导致 wizard
  后续的 macOS launchd 配置步骤(`setup.ts:316` "是否配置开机自启?")
  永远到不了。结果:plist 文件正确写出来了,但 launchctl 没 load,
  重启后 img-proxy 不会自动起来。
  修法:`imgProxyStart` 改 library 化,失败 throw、成功或"已在运行"
  return,不再调 process.exit。CLI binding (`src/index.ts`) 在
  await 之后自己 process.exit。wizard 的 try/catch 现在能真正
  接到 throw,继续往 launchd 步骤走。Signal handler 内部
  (SIGTERM/SIGINT) 的 process.exit(0) 保留 — 那是 OS 信号
  触发的清理路径,只在真正作为 daemon 跑的 child 里跑。

- **img-proxy launchd child 启完秒死 + launchd throttle 死锁** —
  上条 fix 引入的二级 bug:CLI binding 写成 `await imgProxyStart(opts);
  process.exit(0)`,**没区分** parent 分支(应 exit)和 child /
  foreground 分支(应让 server 保活)。launchd 启的 child 走
  `cc-linker img-proxy start`(无 --daemon flag,带
  CC_LINKER_IMG_PROXY_DAEMON=1)→ child 分支,server 监听
  8765 写 "img-proxy listening" 后 CLI binding 无脑 process.exit(0)
  把进程杀了。launchd KeepAlive 立刻重启 → 同样的 5 秒内死循环
  → 5+ 次失败后 launchd 内部 throttle(`state = spawn scheduled` +
  `active count = 0`),daemon 永远起不来。修法:加 helper
  `shouldExitAfterImgProxyStart(opts)` 显式表达"该不该 exit",
  CLI binding 改成 `if (shouldExitAfterImgProxyStart(opts)) process.exit(0)`。
  parent 分支(daemon=true)exit;child / foreground 分支(daemon 缺省
  或 false)让 server 保活,不再自杀。新 e2e 测试
  (`tests/unit/cli/img-proxy-start-library.test.ts`) 跑真实
  binary 2 秒验子进程不被自杀。

- **img-proxy daemon install 失败时 process.exit 杀 wizard(同类 bug)** —
  `imgProxyDaemonInstall` 在 setup wizard 里被 try/catch 包
  (`setup.ts:327`) 期望它 throw,但函数用了 3 处 `process.exit(1)`
  (非 darwin / launchctl load 失败 / 健康检查失败)。`process.exit`
  不可 catch,直接杀 wizard 进程 — 同 imgProxyStart 上一条 fix 的
  同一类反模式。修法:3 处全改 `throw new Error(...)`,
  `index.ts:242` 的 CLI binding 加 try/catch 维持 CLI 行为。
  新增 spy-on-process.exit 测试验证(`img-proxy-daemon-install-library.test.ts`)。

- **piping.finally 回调无 try/catch,unhandled rejection 自杀** —
  `src/img-proxy/server.ts` 的 `piping.finally(() => { ... })` 回调里
  `applyUsageLine / appendLog / updateByAlias / pushRecent` 任一处
  throw 都会变成 unhandled promise rejection → Bun 默认让 process
  exit with non-zero → launchd KeepAlive 把 child 当成失败 →
  反复重启 + 5+ 次后 throttle。和上一条 launchd child 自杀是同源
  问题(都是 process 自杀 → launchd 反复重启 → throttle)。
  修法:整个 finally 回调包 try/catch,任何错误 log + swallow,
  保证 finally 永远 resolve,daemon 不会因埋点 bug 自杀。

- **cache dedup 命中后 mtime 不刷,热图被 7 天 TTL 误清** —
  `transform.ts` 的 dedup 命中分支 `if (!existsSync)` skip write,
  文件 mtime 永远停在第一次写入。`cleanupOldCache` 用 mtime 判 7
  天 TTL → 用户每天粘同一张图,第 8 天被误清 → 模型下次看到
  同一图要重新 download + prompt cache 失效,既烧 token 又慢。
  修法:dedup 命中时 `utimesSync` 刷 mtime(无 IO,只 touch),
  让 cleanupOldCache 知道这是热图。

### Added

- **img-proxy install 完后引导配置 launchd 开机自启** —
  之前 `cc-linker img-proxy install` 装完 providers 就结束,不问
  launchd。用户跑这个命令后 daemon 不会开机自启(只有 setup wizard
  才引导)。修法:install 完后(macOS only、TTY 必备)问一句"是否
  配置开机自启",Yes 调 `imgProxyDaemonInstall`。
  - 失败 log + 不 throw(providers 已装好,launchd 失败不回滚)
  - 非 darwin 平台跳过,无 TTY 自动跳过(脚本友好)
  - `--yes` flag 默认 Yes(脚本场景),无 flag 默认 No(交互,保守)
  - 抽出 `promptLaunchdAutoStart()` 独立函数方便单测
  - return type 加 `autoStart: boolean` 字段

- **img-proxy cache 重复落盘 + 诱导 Read 循环** — `stripImagesToPaths` 的
  `saveImage` 改为对 base64 算 sha256 取前 32 hex 作文件名,`existsSync` 命中
  即跳过写。修掉两个相关问题:
  1. 磁盘:Read 工具读图后 Claude Code 把图塞回 `tool_result.content`,
     proxy 递归 strip 每次都生成新文件名(`Date.now()-<random>`),同一张图
     在多次 Read 反馈循环里被反复落盘。**实测 11 张唯一图涨到 1483 份
     (183 MB),sha256 去重后只需 11 份 (<1 MB),浪费率 99.5%**。
  2. Token:每次新文件名被模型视为"未访问过的文件",模型会反复调 Read
     看同一张图,每轮多花的 tool call + tool_result 文案 token 是真钱。
     改用 content-hash 文件名后,模型两轮看到的是同一 path,Read 循环
     自然终止。`cleanupOldCache` 的 7 天 mtime TTL 行为保留(Bun.write
     覆盖会刷新 mtime → 热图自然留住)。

## [0.8.0] - 2026-07-09

### Added

- **CLI Image Proxy (`cc-linker img-proxy`)** — 让纯文本模型(glm-5.2、
  qwen3-max、deepseek、mimo-pro 等)在 Claude Code 里也能接收粘贴的图片。本地
  反向代理 `127.0.0.1:8765`,拦截出站请求里的 inline `image` content block,
  落盘到 `~/.cc-linker/img-proxy/cache/`,替换成"图片本地路径 + 引导调 Read /
  图片识别 MCP / 本地 CLI"的 text block,再转发给真实上游。**多模态模型
  (Claude/Kimi/GPT-4v 等)完全不受影响**(不经 proxy)。
  - 路由键 = **provider 文件名 stem**(`byte-agent-glm.json` → `/byte-agent-glm`),
    不用 `ProviderManager.generateShortAlias`(它会截断/冲突)。
  - `src/img-proxy/server.ts` — `Bun.serve` 反向代理,SSE 流式透传。
    POST `/v1/messages` 禁 `idleTimeout`(Bun 默认 10s 在长 thinking/tool
    调用会断连),请求/响应头 `content-encoding`/`accept-encoding` 收口
    (避免上游 gzip 响应被客户端二次解压崩),启动+每小时清过期缓存。
  - `src/img-proxy/transform.ts` — `stripImagesToPaths` 递归处理
    `tool_result.content` 嵌套 image block(Read 工具读 PNG 后 Claude Code
    会嵌套塞进 tool_result),`{path}` 模板缺失时回退默认文案。
  - `src/img-proxy/provider-config.ts` — `installProvider` 3 态机(真幂等
    / 跨 port/hostname 重装 / 首次),`.bak` 生命周期(原始 upstream 永远
    从 `.bak` 读)。`isAnyProxyUrl` 宽松匹配识别"我们装过的代理 URL"。
  - `src/img-proxy/routes.ts` — `routes.json` 用 `proper-lockfile` + sentinel
    互斥写,`disabled` 标志支持 console 软禁用。
  - `cc-linker img-proxy install [--yes|--providers|--all] / uninstall / start
    [--daemon] / stop / status / daemon install|uninstall`。Daemon 三分支
    (parent/child/前台),launchd 用 `CC_LINKER_IMG_PROXY_DAEMON=1` env 注入
    避免双重 fork,parent poll PID + `isPidAlive` 双重判定避免 EADDRINUSE
    假阳性。

- **Smart install with multimodal classification** — `img-proxy install`
  默认 smart 模式: 4 路发现(manual / CC Switch auto / shell alias hint /
  provider-scan)+ 内置分类(Claude/GPT/Gemini/Qwen/GLM/Kimi/MiniMax/MiMo
  /Doubao/Stepfun 等),自动跳过 multimodal,只装 text-only + unknown。
  可通过 `[img_proxy] smart_mode` 关闭,通过
  `vision_model_patterns_extra` / `text_only_model_patterns_extra` 自定义
  patterns。`--providers` 显式指定 multimodal 会抛 `E_IMG_PROXY_MULTIMODAL_PROVIDER`
  而不是静默装。

- **Shell wrapper (`cc-linker-proxy`)** — `img-proxy wrapper install` 写
  shell 函数到 `~/.zshrc` / `~/.bashrc`。给 CC Switch 用户用(他们没自定义
  `cc-X` alias,直接 `claude` 读 `~/.claude/settings.json`):wrapper 自动
  从 settings.json 读当前 provider,查 routes.json,设
  `ANTHROPIC_BASE_URL=http://127.0.0.1:8765/<alias>` 后 exec claude。递归
  防护(已设 BASE_URL 直接 exec,不走 resolve)。`wrapper install` 期间
  写备份到 `wrapper-backups/`。

- **Web Console (Phase 2)** — `http://127.0.0.1:8765/`(`console_enabled = true`),
  5 个 Tab:
  - **Dashboard** — 实时 totalRequests / strippedImages / uptime / cache
    文件数+大小,5min 状态分布,per-alias 聚合
    (requests / stripped / chunks / bytes / avgDuration / lastAt)
  - **Log** — 最近 200 条请求表格,按 alias / status / streamStatus /
    时间过滤,可手动刷新
  - **Config** — 改 `console_enabled` / `upstream_timeout_ms` /
    `stream_idle_timeout_ms`(`console_enabled` 热开关,其它需重启)
  - **Routes** — 每行 Enable / Disable 按钮(写 `disabled` 软禁用)
  - **Cache** — 概览 + "立即清理" 按钮(调用 `cleanupOldCache(0)`)
  - 所有写操作 audit log 到 `img-proxy.log`(`console_action` + `trigger: console`)
  - CLI: `cc-linker img-proxy console enable|disable|status`

- **New config keys** (`[img_proxy]` in `~/.cc-linker/config.toml`):
  - `console_enabled` (default `false`) — Web Console 开关
  - `upstream_timeout_ms` (default `0`) — upstream fetch 整体超时
  - `stream_idle_timeout_ms` (default `0`) — 距最后 chunk 超过 N ms 判 stalled
  - `smart_mode` (default `true`) — 跳过 multimodal
  - `cache_max_age_hours` (default `168`) — 缓存保留 7 天
  - 对应 env vars: `CC_LINKER_IMG_PROXY_UPSTREAM_TIMEOUT_MS` /
    `CC_LINKER_IMG_PROXY_STREAM_IDLE_TIMEOUT_MS` / etc.

- **README + 详细文档** — `README.md` 和 `README_en.md` 新增 img-proxy 核心
  特性行、6 个 CLI 命令、新章节"纯文本模型也能接收图片 (img-proxy)"、详细
  文档表链接。`docs/img-proxy.md` 全量覆盖:架构、4 路发现、模型分类、3 态
  install、CC Switch / 自定义 alias / cold-start 场景、Web Console、11 个
  踩坑点 + 修法。

### Fixed

- **handleAttach guard 只做精确匹配** (`src/agent-view/manager.ts:580-586`) —
  v2.2.15 commit 注释声称"守卫同时认 short 和 full",但实现只精确匹配
  `s.sessionId === sessionId`。当 card 传 short hash,snapshot 只有 full
  UUID 时,守卫误报"会话已不存在",entry 写不下去。改为:先精确匹配,
  失败但 sessionId 是 8-hex short → 找 snapshot 中 36-char full 且以它
  开头,命中则把 sessionId 替换成 full(后续 CAS 写 full,SDK 不拒)。
- **POST `/v1/messages` SSE 长静默期断连** — Bun.serve 默认
  `idleTimeout=10s` 在 extended thinking / tool execution / 长 token
  生成期间会关 client TCP → 客户端 `Connection closed mid-response`。
  进入 fetch 前 `server.timeout(req, 0)` 禁该请求 idleTimeout。
- **`content-encoding` 双解压导致客户端崩** — Bun.fetch 自动解压但保留
  `content-encoding` + 过期 `content-length`,客户端对已被解压的明文
  再 gunzip → 流解析崩 → pipeTo reject undefined。`sanitizeProxyResponseHeaders`
  剥 content-encoding / content-length,`sanitizeProxyRequestHeaders` 把
  `accept-encoding` 收口到 `gzip, deflate, br`。
- **`tool_result.content` 嵌套 image 块不剥** — Claude Code 让 Read 工具
  读 PNG 后塞进 `tool_result.content` 数组,老 strip 只扫顶层漏掉,纯文本
  模型 4xx。`stripImagesToPaths` 抽 `processBlocks(blocks)` 命名函数递归。
- **MiMo 正则老 lookahead bug** — 老 `/mimo-v\d+(?!-pro)/` backtrack 跳掉
  pro 前缀,把 `mimo-v2.5-pro` 误判 multimodal。改为锚定
  `/^mimo-v\d+(\.\d+)?$/` + 显式 `/^mimo-.*-pro/` 拦截 Pro 变体。
- **launchd daemon install 留旧 PID 占 :8765** — 重装时 KeepAlive 在新
  child 起来前把 port 给旧 child,新 child EADDRINUSE crash。daemon install
  进入前先 `launchctl stop` + 轮询 SIGKILL 兜底 + `unload` + 清 PID 文件。
- **parent spawn child 后 PID 文件"碰巧留下"假阳性** — 老 parent 盲目等
  1200ms 后报"成功",child 可能 EADDRINUSE crash 后 PID 文件刚好留着。
  改为 poll `PID_FILE === child.pid && isPidAlive(childPid)` 5s。
- **CC Switch 同步 mtime 陷阱** — 老用 `auto-providers/` 目录 mtime,目录
  mtime 在文件删除时跳到 NOW → 误判已同步。改为目录下**最新文件** mtime。
- **`DEFAULT_PROMPT_TEMPLATE` 硬编码特定 MCP** — 改为工具无关,指引
  Read / 任何图片 MCP / `mmx-cli`,用户可改 `prompt_template` 调。

## [Unreleased]

## [0.7.5] - 2026-07-02

### Fixed

- **Agent View /agents 在 29 sessions 时只显示 fallback 文本** —
  v2.7.4 给所有 status 加 Reply 按钮后,每 session 多 1 button →
  配合未限制的 busy/waiting/idle,29 sessions 必超飞书 25KB 卡上限
  → `sendOrFallback` 触发 → 用户看到 `"📋 Agent View · 29 sessions ·
  /agents to refresh"` 这条 fallback 文本,而不是真正的 list 卡(含
  Peek/Reply/Stop 按钮)。
  - `src/agent-view/manager.ts:33-44` — `buildCappedCard` 新增
    `MAX_ACTIVE_ITEMS = 7` (busy/waiting 各上限)、`MAX_IDLE_ITEMS = 4`,
    溢出进 `hasMore`。
  - `src/agent-view/card.ts:166-173` — `truncateCwd` 加 40 字符绝对上限
    (保留尾段 project 名),降低单 session 体积,留出 4-20KB 余量给
    long-cwd 场景。
  - 实测: 1 busy + 28 idle (用户场景) 30.8KB → 5.3KB (有 19.7KB 余量);
    50 sessions 极端 24.2KB → 18.1KB。
- **deploy-local.js 读 818MB log 撞 V8 string 限制崩溃** —
  `verifyNewVersion` 用 `readFileSync(LOG_FILE, 'utf8')` 把 818MB log
  整文件读进内存,V8 单 string 限制 0x1fffffe8 (~512MB) → 抛
  `"Cannot create a string longer than 0x1fffffe8 characters"` →
  整个 deploy 误判失败 → 触发 rollback no-op(脚本 bug 报"已恢复
  backup"但 backup 已不存在)。
  - `scripts/deploy-local.js:273-299` — 改用 `grep -E` 流式读 banner,
    7s on 780MB log(可接受)。**不用** `readFileSync`。
- **deploy-local.js banner 选取逻辑错** — daemon logger 非 append-only
  (重启时新内容写到文件头),`grep ... | tail -1` 拿的是行号最大的
  banner,可能是文件中段的某条历史 broken banner(缺 timestamp),
  regex `\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]` 不匹配 → 误报
  "没找到 banner"。
  - `scripts/deploy-local.js:289-296` — 改为 grep 全文件,过滤出带
    合法 timestamp 前缀的 banner,按 timestamp 字符串字典序(YYYY-MM-DD
    HH:MM:SS 排序等价于时间序)取最新。

### Tests

- 新增 `tests/unit/agent-view/manager.test.ts` regression test —
  v2.7.5: 29 mixed sessions (用户场景) → 渲染不超 25KB,无 fallback。
  模拟用户实际分布 (7 busy + 5 waiting + 6 idle + 11 completed) + 长
  cwd,断言 `cardReplyFn` 收到卡(不是 fallback text)、卡大小 < 25KB、
  hasMore 非 0、各 status group 至少展示 1 个 session。
- 更新 `v2.3.2: active 优先 — busy 全进,completed 限额 5` 测试 —
  25 busy 现 cap 到 7 rows + hasMore=18(原契约 25 全进已不成立)。
- 更新 `exceeds 25KB triggers text fallback` 测试 — 用 30 sessions ×
  5KB name 仍能触发 fallback(原 10 × 3KB 测试在 v2.7.5 后只渲染 7
  sessions = 21KB < 25KB,不再触发 fallback)。

## [0.7.3] - 2026-07-02

### Added

- **多平台 IM 抽象层**（wecom 集成 PR 1）— 新增 `src/platform/` 子目录,
  抽出与具体 IM 平台解耦的 4 个模块,飞书之外的平台（企微/钉钉/Slack 等）
  可以基于这套接口实现 adapter,不需改 bot 主流程:
  - `src/platform/types.ts` (`PlatformAdapter` / `PlatformMessage` /
    `PlatformUser` / `PlatformStreamUpdater` 接口) — 统一消息模型,
    `userId` + `platform` 字段一起做 serialKey。
  - `src/platform/command-handler.ts` — `isCommandMessage()` /
    `extractCommand()` 静态 helper,把"是否命令"判定从飞书专属逻辑
    中抽出来,任何平台都可复用。
  - `src/platform/stream-updater.ts` — `PlatformStreamUpdater` 抽象类,
    封装 throttled 卡片更新 + 状态机 (processing → streaming → complete
    /error)。
  - `src/platform/user-state.ts` — 平台无关的 `PendingReply` 描述,
    `userId + platform` 取代纯 `openId` 作为 user-mapping key。
- **`src/feishu/stream-updater.ts`** — 从 `src/feishu/bot.ts` 抽出
  `FeishuStreamUpdater` (继承 `PlatformStreamUpdater`),保持原有
  CardUpdater 行为不变,bot 主流程代码减少约 20 行。

### Changed

- **`src/feishu/bot.ts`** — `handleChatStreaming` 改用新抽象的
  `PlatformStreamUpdater`,原先在 bot.ts 里的 stream 卡片更新逻辑
  下沉到 `FeishuStreamUpdater`。bot.ts 净减约 20 行。
- **`src/feishu/mapping.ts`** — UserManager key 拼接 `userId` 和
  `platform`,为后续多平台并存做准备;旧的纯 `openId` key 仍兼容
  读取。

### Fixed

- **legacy spool 文件 userId/platform 字段缺失** (`src/queue/spool.ts`) —
  v0.7.x 之前的 spool 消息没有 `userId` / `platform` 字段,worker
  pool claim 时会因找不到 key 而无法分发。现在 enqueue 时自动
  backfill 默认值 (`userId = openId`, `platform = 'feishu'`),
  旧 spool 文件可正常 drain。
- **`[STREAM-5]` / `[STREAM-7]` plan spec args index 拼写错误** —
  plan 文档把 `args[index]` 写成了 `args[0]`,plan reviewer 之前漏检。
  修复后对齐真实实现 (`args[3]` / `args[5]`)。

### Refactored

- **`src/feishu/bot.ts` 复用 `platform/command-handler`** — 删掉
  本地的 `isCommandMessage` 实现,改为 `import { isCommandMessage }
  from '../platform/command-handler'`。与新抽象层对齐。

### Tests

- 新增 `tests/unit/platform/types.test.ts` (104 行) — PlatformAdapter /
  PlatformMessage 等接口的 contract 测试。
- 新增 `tests/unit/platform/user-state.test.ts` (44 行)。
- 新增 `tests/unit/platform/command-handler.test.ts` (55 行)。
- 新增 `tests/unit/platform/stream-updater.test.ts` (44 行)。
- 新增 `tests/unit/feishu/stream-updater.test.ts` (71 行) — 验证抽
  出后的 FeishuStreamUpdater 行为与原 inline 实现一致。
- 新增 `tests/unit/feishu/bot-stream-updater.test.ts` (58 行)。

## [0.7.1] - 2026-06-17

### Added

- **setup 向导新增 Step 2 权限模式选择** (`src/cli/commands/setup.ts`) —
  `cc-linker setup` 流程中新增 Claude Code `permission_mode` 交互式选择
  (6 个合法值: `acceptEdits` / `bypassPermissions` / `auto` / `default`
  / `dontAsk` / `plan`),默认 `acceptEdits`。背景说明: 飞书端无法完成
  终端式交互确认,推荐自动接受文件编辑。结果同步写入 `[claude].permission_mode`
  和 `[sdk].permission_mode` 两段,`[sdk].enabled` 字段不被改动,
  其它自定义字段(`allowed_tools` / `claude_executable` 等)完整保留。
- **`savePermissionMode(mode, configPath?)` 导出函数** (`src/cli/commands/setup.ts`) —
  把权限模式同步写入 `~/.cc-linker/config.toml` 的 helper。接受可选
  `configPath` 参数,便于单元测试写 tmp 目录。

### Changed

- **setup 向导 step 编号重排** (`src/cli/commands/setup.ts`) — 现有
  步骤 1/2/3 重排为 1/2/3/4 (新增的权限模式是 Step 2,hook 变 Step 3,
  飞书变 Step 4)。`totalSteps` 同步调整为 `opts.skipFeishu ? 3 : 4`。
- **printSummary 飞书端可用命令列表更新** (`src/cli/commands/setup.ts`) —
  从 5 个命令升级为 6 个高频命令 (`/list` / `/listDir` / `/new` / `/model`
  / `/stop` / `/agents`),并新增 `/help` 引导和"飞书后台 → 机器人 →
  自定义菜单"轻量推荐(把 `/list` `/new` `/agents` `/help` 绑到菜单,
  手机端点选更方便)。`bot.ts` 的 `helpText` 保持 12 个唯一命令,
  未受影响。

### Fixed

- **`saveConfig` section 输出顺序** (`src/cli/commands/init-feishu.ts`) —
  之前 `[claude]` / `[sdk]` 段会落到"剩余 sections"块底部,跟
  `[feishu_bot]` 视觉上分开。现在固定顺序包含 `claude` / `sdk` 在
  `feishu_bot` 之后、`queue` 之前,与 `config.ts` DEFAULTS 的相对
  位置一致。

### Refactored

- **`loadExistingConfig` / `saveConfig` 接受可选 `configPath` 参数**
  (`src/cli/commands/init-feishu.ts`) — 两个 helper 末尾新增可选参数,
  默认仍走 `CONFIG_PATH` 全局常量。production 代码调用点全部不传
  `configPath` (行为不变),测试通过显式 `configPath` 写 tmp 目录,
  绕开 `bun:test` 模块缓存问题,**避免使用 `mock.module`** (代码库
  在 `tests/unit/feishu/bot-runsdk.test.ts:7` 明确警告 `mock.module`
  跨文件不可撤销)。

### Tests

- 新增 `tests/unit/cli/setup.test.ts` — 4 个用例覆盖 `savePermissionMode`:
  空配置创建、字段同步 + 其它字段保留、`[sdk].enabled` 不被改、空
  配置文件新增 `[claude]`/`[sdk]` 不影响 `[feishu_bot]`。
- `tests/unit/cli/init-feishu.test.ts` 新增 2 个用例 — `saveConfig` section
  顺序 + `[sdk].enabled` 保留。section-bounded regex (`/\[sdk\][\s\S]*?(?=\n\[|$)/`)
  防御 greedy 误匹配。

## [0.7.0] - 2026-06-15

### Added

- **claude 二进制优先级链解析器** (`src/proxy/claude-executable.ts`) —
  飞书机器人 SDK 路径在 `optional-dep` 二进制缺失时
  (`--omit=optional` / `NODE_ENV=production` / `bun build --compile` standalone
  binary),原本会抛 `Native CLI binary for {platform}-{arch} not found` →
  含糊的 "Claude SDK 执行失败"。新增 `resolveClaudeExecutable(configLike, options)`
  纯函数,4 级优先级链: `1) sdk.claude_executable → 2) SDK bundled → 3) general.claude_bin
  → 4) throw E_SDK_NO_CLAUDE`,返回 `{ path, source, fallback }` 让运维可观测。
  `sendSDKMessage` (`src/proxy/session.ts`) 接入后,**总是**给 SDK 传
  `pathToClaudeCodeExecutable` (不再条件性省略),所有 4 级都产出可用路径。
- **fallback one-shot WARN de-noise** — 模块级 `fallbackWarned` 标志,首次
  降级打 WARN (含 3 种可操作修法),后续降级降为 INFO,避免 24/7 bot 每请求
  一行 WARN。
- **E_SDK_NO_CLAUDE 错误码** (`src/utils/errors.ts:32`) — 列入 `handleError`
  suggestions 表,消息含 3 种修法 (`npm install -g cc-linker@latest
  --include=optional` / `npm install -g @anthropic-ai/claude-code` /
  `[sdk] claude_executable = "..."`),CLI 用户也能看到。
- **postinstall 版本检查** (`scripts/postinstall.js`) — `npm install -g
  cc-linker@latest` 后自动跑 `claude --version`,若 < 2.1.139 打 WARN
  提示用户升级(Agent View 数据源 `~/.claude/jobs/<short>/state.json` 需要
  2.1.139+)。**非阻塞**: 缺失 / 乱码 / 当前版本都静默退出。

### Fixed

- **bot 错误卡渲染:resume 路径** (`src/feishu/bot.ts:2385`) — 之前
  `sendSDKMessage` 在 E_SDK_NO_CLAUDE 时无条件走 `cardUpdater.complete()` →
  resume 用户看到绿色 "✅ 处理完成" 卡含错误文本(最差的 UX)。新增
  `result.sessionStatus === 'degraded'` 检查,先打红色错误卡。I-1 修复。
- **daemon console.warn/debug 路由** (`src/cli/commands/start.ts:605-606`) —
  之前只重写 `console.log` (→INFO) 和 `console.error` (→ERROR),WARN / DEBUG
  走默认 stderr,从未进 `cc-linker.log`。补全 2 行,首次 fallback WARN
  现在对运维可见。
- **WARN follow-up 消息文案** (`src/proxy/claude-executable.ts:155`) —
  之前说"首次警告见 bot 启动早期日志"(实际 WARN 在首次 `sendSDKMessage`
  时发出),改成"首次警告见上方日志",运维能 grep 找到。
- **setup 脚本描述精确化** (`src/cli/commands/setup.ts`) —
  "事件订阅 → 配置订阅方式" 太笼统,改成两个 section 各自明确
  "→ 订阅方式: 选择「使用 长连接 接收事件/回调」（推荐）",
  "必需配置" 那行也明确"事件订阅 + 回调配置 两个 tab 都要选「长连接」"。
  避免用户只在一个 tab 选长连接导致静默 broken。
- **关键提示高亮** (`src/cli/commands/setup.ts:375-376`) — "配置完成后必须
  在版本管理与发布中创建并上线新版本,否则权限不生效" 从 `chalk.gray` 升级
  到 `chalk.yellow.bold` + ⚠️ emoji,该 tip 是 silent-failure 的高发点。
- **测试文件路径 import** (`tests/unit/proxy/claude-executable.test.ts`) —
  `@/` 别名在项目里没配置(无 `bunfig.toml` / `package.json imports` /
  `tsconfig paths`),改成相对路径,Task 1 实现后测试才能 load。

### Test Coverage

- 13 个 resolver 单元测试覆盖所有优先级分支、平台注入、错误消息内容、
  one-shot de-noise 状态机。`bun test` 956/956 pass。

## [0.6.1] - 2026-06-13

### Fixed

- **scanner: stub session `last_active` fallback 误用扫描时刻**
  (`src/scanner/jsonl.ts:parseFull`) — 当 JSONL 文件只有 marker 行
  (`ai-title` / `agent-name` / `last-prompt` / `mode` / `permission-mode`),
  没有任何 `user` / `assistant` 消息时, `last_active` 与 `created_at` 的
  fallback 之前是 `new Date().toISOString()`, 即 scanner 扫描当前时间,导致
  飞书 `/list` 卡片上 stub session 全部显示 "X 分钟前"(X 是 scanner 启动
  那一秒, 不是 session 真实活跃时间)。修复后 fallback 改用 JSONL 文件本身
  的 `mtime` (statSync), 反映 stub session 文件何时被创建/更新。
- 用户报告的现场: 飞书 `/list` 第 4-10 个 session 全部显示 "19 分钟前" +
  0 条消息, 实际文件 mtime 是 2 天前, 从未真实活跃过。

## [0.6.0] - 2026-06-13

Agent View 在这个版本完成两次大改造:

1. **数据源切到 `~/.claude/jobs/<short>/state.json`**(v2.3 系列): CLI 的 background
   session 状态机由 `state.json` 落盘, `/agents` 列表、Peek、状态名都从这里读;
   `claude agents --json` 在 v2.1.163 起 `status` 始终为 `idle`, 仅保留为
   smoke test。
2. **Rendezvous Reply GA**(v2.4): 飞书侧给 background waiting session 回复时,
   不再 spawn 新 `claude` 进程, 而是通过 JSON-RPC 直接把 reply 喂回正在等待
   的 daemon, 完整流式 reply 实时 patch 到分层 Feishu 卡片。
   `[agent_view].rendezvous_enabled` 默认开启。

### Added

#### Agent View — state.json 数据源 (v2.3)

- **`job-state.ts`** — 新模块, 包含 `readJobState` / `readAllJobStates` /
  `jobStateToSession` 三个主入口, 把 `~/.claude/jobs/<short>/state.json` envelope
  映射为 `AgentSession`(waiting / busy / idle / completed, 🛑 / ✅ 前缀)。
- **`CLAUDE_JOBS_DIR`** 路径常量(`src/utils/paths.ts`)。
- **`snapshot-fetcher` 流水线**: VersionGuard → DaemonProbe → `claude agents --json`
  smoke test(返回值丢弃) → `readAllJobStates()` 为主数据源 → `roster.json` +
  `daemon.log` 兜底 `dispatch.source` → `deriveNameFromJsonl` 仅做 cold-path
  fallback。
- **Card v2.3** — `buildListCard` 改为 waiting-first 排序, detail 行作为副标题,
  footer 注明 "data: state.json"。
- **Peek 优先用 `state.json.linkScanPath`**(Tier 1a), 比 JSONL index 更准。

#### Agent View — Rendezvous Reply (v2.4)

- **`RendezvousClient`**(`src/agent-view/rendezvous-client.ts`): JSON-RPC over UDS,
  发 `reply` 给 daemon, 拉 state patch 流, 把流式 chunk 透传给 CardUpdater。
- **`readLastAssistantTurn`**: 从 JSONL 抽取上一轮 assistant 输出, 灌入
  Reply 卡片的 "AI 最近输出" 区。
- **`checkRendezvousEligibility`**: 判断当前 session 是否满足 rendezvous reply
  前置条件(bg waiting / daemon alive / linkScanPath 可达)。
- **`runChatSDK` 改造**: rendezvous-first 路径, 不命中再 fall back 到 spawn
  `claude -p`; reply 路径补 `markSent` (M1) + `messageId` 透传 + 空文本防御 (M7)
  + 条件化完成消息。
- **`[agent_view].rendezvous_enabled` 配置项**(默认 `true`) + `timeout_ms`
  (默认 30000)。
- **流式 reply 分层卡片** — header(状态 / 名称) + 流式 body(thinking + text) +
  分组 action(Refresh / Reply / Stop / Cancel), CardUpdater 按 `stream.throttle_ms`
  节流 patch。
- **`/cancel` 命令** — 撤回当前 pending reply slot, 区分 `/stop` (杀 session)。

### Changed

- **Agent View 状态名优先级**: `state.json.name` > JSONL derive (cold fallback);
  `name-cache.ts` 已退役。
- **Completed session 限额 5 条**(v2.3.2), 老 settle session 不再塞满 list。
- **`jobStateToSession` 状态合并**: `running` / `working` 且有 `needs` →
  waiting, 简化前端分组。
- **Reply UX**(v2.3.4 - v2.3.13):
  - 独立 reply 消息 + 持续 reply, 不再原地改 list 卡;
  - 抛弃自动持续 reply, 让 `expectedReply` 自然走 5min timeout;
  - Reply prompt 升级到交互卡, 内嵌 AI 最近输出;
  - Reply 智能 CAS 放宽 — 仅 `pending_new_session_claimed` 才拒, 自动清 transient entry;
  - Reply 路径自动 stop bg, 用 pre-step 模式而不是递归 SDK。
- **`handleChat` reply 路径**补 `markReplied` + `markDone` 释放 spool 锁(v2.3.11),
  防 worker 卡死。
- **`bot.handleChat` busy 路径**(v0.5.0 起): 检测到 bg worker 时升级发 3 按钮
  bg-conflict 卡。
- **README**(`README.md` + `README_en.md`): 用户视角重写, 把 "rendezvous" /
  "spool" 等内部术语外翻为 "回到正在等待的 session" / "消息队列"。

### Fixed

- **state.json torn write 抢读**: 文件原子写中途读到不完整 JSON → 自动 retry,
  日志 warn 但不抛(v2.3.1)。
- **Reply 智能 CAS race**: user-mapping 残留 transient entry 不再 throw,
  允许同 session 转换(v2.3.3 + v2.3.3 修订)。
- **handleReply markSent + messageId 透传**(M1): rendezvous 流式 reply 启动后
  立刻 mark sent, 防 watcher 重复发卡。
- **rendezvous 空文本防御**(M7): assistant 输出空 chunk 不触发 patch。
- **Code review round 1 — 6 issues**(commit `f25e53d`): 鉴权日志 / 错误码统一 /
  patch 失败兜底 / linkScanPath 校验 / config default / 状态名 fallback。
- **Code review round 2 — JSDoc drift + wait only on success**(commit `71fa35f`):
  注释和实现同步, rendezvous 流只在 daemon 真返回 success 时 await。
- **handleReplyRequest 文案与 v2.3.9 一致化**(v2.3.10)。

### Tests

- **15 real + 3 negative state.json fixtures**(`tests/fixtures/agent-view/job-states/`)。
- **Job-state hooks**: `_jobStateHooks.daemonLogReader` / `daemonProbe` 改为可变
  hook, 避免跨文件 mock 污染。
- **Integration canary**: waiting → Reply button 的端到端用例。
- **Rendezvous regression**: 接入不影响 `/agents` 既有路径(`890b67c`)。
- **QA E2E v2.4 rendezvous 6 场景**(`docs/qa/`)。

### Docs

- `CLAUDE.md`: Agent View 数据源段落改写为 "state.json 主, `agents --json`
  smoke, `daemon.log` 兜底, JSONL 仅 cold fallback"。
- `docs/spec/` + `docs/plan/`: rendezvous reply 完整 spec + plan + 两轮 review
  修复(共 25 处 review 落地)。
- `/cancel` 命令文档补完, 明确和 `/stop` 的区别。
- v2.4 GA 状态描述同步: state emoji 顺序 / 名称来源 / 溢出折叠。

## [0.5.1] - 2026-06-09

### Fix: Completed session 的 Peek/Attach 按钮报"未知操作"

`/agents` 列表里已 settle 的 background session(`daemon.log` 兜底渲染,
非 `claude agents --json` 实时输出)点击 Peek / Attach 都会收到
"未知操作: agent_view_peek/attach"。

#### Root cause

`snapshot-fetcher.ts:enrichCompletedSessions` 给 completed session 写死
`cwd: ''`,导致 `card.ts:46-71` 渲染的按钮 value 缺 `cwd` 字段,
`agent-view/action.ts:isAgentViewValue` guard 要求 `str('cwd')` 非空
→ guard 拒 → dispatcher 落 `bot.ts:639` legacy switch default
报"未知操作"。

#### Fix

从 JSONL 路径反推 cwd。CLI 编码规则:`cwd.split('/').join('-')`,
例 `/Users/wuyujun` → `-Users-wuyujun`。`~/.claude/projects/<encoded>/<uuid>.jsonl`
的 `<encoded>` 段反向 decode(naive `-` → `/`)拿回 best-effort cwd,
Peek 按钮 value 完整,guard 通过。Peek 内容读取走 `JsonlIndex.lookup(shortId)`
不依赖 cwd,所以即使 decode 有损(原路径含 hyphen 时丢 hyphen)也不影响 Peek 功能。

#### Changed
- `src/agent-view/snapshot-fetcher.ts`:加 `_jsonlIndexHooks.lookupPath` 测试 hook
  + `decodeCwdFromJsonlPath()` 工具 + `enrichCompletedSessions` 在造 session 时
  调用二者把 cwd 补上

#### Tests
- `tests/unit/agent-view/snapshot-fetcher.test.ts`:3 个新 case
  - single-segment decode(`/Users/wuyujun`)
  - multi-segment lossy decode(`/Git/cc-linker` → `/Git/cc/linker`)
  - JSONL 缺失时 cwd 仍为 `''`(graceful fallback)

## [0.5.0] - 2026-06-09

### 飞书 Attach 后自动刷新内容卡 (Agent View 增强)

Attach 成功后,飞书侧紧跟一条可交互内容卡,每 10s 自动 patch 该 session
的 status + recentOutput,user 不用切回 CLI 就能"挂着看"。

#### Added
- **`buildAttachedCard`** 渲染器(`src/agent-view/card.ts`):reuse `buildPeekCard` 骨架,
  header title `📡 Watching · \`name\``(蓝色),按钮组
  `[Refresh] [Stop Watching] [Reply] [Stop session]`
- **25KB 智能截断**(`truncateRecentForCard`):recentOutput 优先 2048 → 1024 → 512 → 256
  字符,任一档 build 后 ≤25KB 即用,全超则降级为 warning 文字。watch 永不停
- **`AttachedCardWatcher`** 类(`src/agent-view/attached-card-watcher.ts`):
  setInterval / inFlightTick mutex / patchFailureCount / maxTicks 镜像
  `LiveProgressWatcher` 设计
- **`AttachedWatchers`** 管理器:per openId 单 watch,supersede 静默 stop
  旧 watcher 并清 map
- **5 个 stop reasons** (per-reason header title):
  `idle_settled` → ✅ 已结束 / `user_chat` → 🔌 Watch stopped · 收到新消息 /
  `user_stop` → 🔌 Watch stopped / `max_ticks` → ⏱ Watch stopped (timeout) /
  `session_gone` → ❌ Session 已结束 / `superseded` → 🔄 Watch replaced
- **`agentView.handleStopWatching`**:[Stop Watching] 按钮 handler
- **busy 路径升级**:`bot.handleChat` busy 路径(`bot.ts:988`)先 check `roster.workers`
  有无 bg worker,有则升级发 3 按钮 bg-conflict 卡,无则维持原 1 按钮 busy 卡
- **`handleChat` 入口 hook**:user 发任何文本立即 fire-and-forget 停 watch
  (reason='user_chat'),不阻碍 chat 路由
- **`handleCardAction` 新 case** `agent_view_stop_watching`:派发到
  `handleStopWatching`
- **`FeishuBot.shutdown` 集成** `attachedWatchers.stopAll()`:SIGTERM 干净收尾

#### Fixed (since 0.4.2)
- **C3**:final patch 失败时 watcher 也要 stop(防无限重试到 max_ticks=2.2h)
- **B1**:max_ticks 触发时也要 patch final 卡(header `⏱ Watch stopped (timeout)`)
- **B2**:per-reason header title 通过 `FINAL_HEADER_TITLES` map + `patchFinalCard` helper
- **修 3**:**AttachedWatchers 缓存 no-op patchFn 引用 bug**(用户报"卡片没刷新"根因)
  `start.ts:234` 初始化 `let patchFn = async () => null` no-op stub,后续 `line 417`
  才赋真值;`AttachedWatchers` 构造时缓存了 no-op 引用,后续替换看不到。修:用 getter
  `() => deps.patchFn` 每次取最新
- **patchFn 默认 1200ms 延迟**:`patch.ts:56` 旧值 `delayMs=1200`,跟 JSDoc
  + `start.ts:408` 注释说"默认 0"不一致。改 0ms,attach 后 patch 立刻发出
- **superseded 静默 stop UX bug**:用户 re-attach 时老卡没指示,容易被误以为
  "没刷新"。修:supersede 时 PATCH 老卡显示 `🔄 Watch replaced`
- **bg-conflict 路径不标 degraded**:`runChatSDK:1495` 之前硬标
  `sessionStatus: 'degraded'`,触发 `/switch` 阻断 + "自动修复"误导。改 `'active'`,
  清掉 `error` 字段(避免 `last_error: 'bg_worker_conflict'` 误导信号)
- **`_doStopAndSend` 等 1s → 3s**:治 stop bg 后新 worker 太快 respawn 触发
  `runChatSDK` 又检测到 bg worker 又弹冲突卡的 race
- **AgentSnapshotFetcher.fetch mock 泄漏**:`mock.module` 不能跨文件撤销,
  改 `(AgentSnapshotFetcher as any).fetch = mock(...)` + `afterEach` 恢复 pattern
- **handleStopAndSend 错误恢复**:`_doStopAndSend` 内 `claude stop` 报"No job matching"
  视为成功(worker 已自然 settle),不冒泡
- **sessionUuid 短 hash 展开**:`runChatSDK` 防御性 short→full 转换 + CAS 回写
  UserManager(防 SDK 拒短 hash)
- **JSDoc 过期引用**:`renderAttachedCardJson` JSDoc 删过时 "Task 3" 引用
- **test name 笔误**:"shows 4 buttons" → "shows 3 buttons"

#### Tests
- 16 new tests covering buildAttachedCard rendering (10), 25KB truncation cascade (3),
  AttachedCardWatcher lifecycle (3), tick behavior (9:happy/snapshot-fail/session-gone/
  idle+completed/active-idle/JSONL-miss/1-fail/3-fail/max_ticks), AttachedWatchers manager
  (6:start/super-sede/stop/missing-openId/identity-check/inFlightTick-mutex),
  manager integration (4:start-watch/super-sede/stop/no-op), bot cardAction dispatch (1),
  bot handleChat hook (3:has-watch/no-watch/with-cancel), AgentSnapshotFetcher mock fix (6)
- **789 pass / 0 fail / 11844 expect() calls / 74 files**

#### Deploys Since 0.4.2
- 5 deploys covering the full feature rollout + 4 critical bug fixes
- PID updates: 19013 → 75481 → 47808 → 85665 → 86163 → 82603 → 58849 → 59177 → (current)

## [0.4.2] - 2026-06-08

### Background

Patch release of 0.4.1 — bumped version to push 0.4.1 changes through deploy.

## [0.4.1] - 2026-06-08

### 飞书 /list 过滤 Task tool 派生的 subagent sessions

飞书 `/list` 命令之前会展示 Task tool 派生的 subagent sessions,跟 Agent View
已经做的 `source='spare'` 过滤不一致。这一波让两边行为对齐。

#### Added
- **scanner 检测 subagent**:扫 JSONL 时检查任何条目 `isSidechain === true`(Claude
  内部约定:Task tool 派生的 subagent 所有对话条目都标这个),命中就设
  `is_subagent: true` 到 SessionEntry
- **`is_subagent` 字段**:SessionEntrySchema 加可选 `is_subagent: z.boolean().optional()`。
  z.object 默认 non-strict,老 entry 自动通过验证,无需 schema version bump
- **/list 过滤**:`doCardList` 加 `.filter(([_, e]) => e.is_subagent !== true)`,
  === true 才过滤(=== false / undefined 保留,跟 Agent View 的 `source !== 'spare'`
  模式对齐)

#### Why isSidechain, not roster
- `dispatch.source` 只在 `roster.json` 里跟踪活跃 bg worker,settled 后 roster
  可能就清掉了,没法用于历史 sessions
- `isSidechain` 是 claude 自己写到 JSONL 每个 user/assistant 条目的字段,
  Task tool 派生的 subagent 全部 `true`,顶层 session 始终 `false`/缺失。
  这是 claude 内部约定,**最可靠**
- 扫一次 JSONL 就够,不依赖外部状态

#### Tests
- +2 v0.4.1 case:有 / 无 `isSidechain:true` 条目时的 is_subagent 设置
- 720 pass / 0 fail

## [0.4.0] - 2026-06-08

### 飞书 Agent View — 完整稳定

0.3.4 之后这个 feature 几乎没法用,这一波 22 个 commit 把飞书端 Agent View
修到能稳定托管活跃/已结束 bg session。

#### Changed
- 飞书列表卡显示的 session 名称之前会被错填(JSONL 没内容时退化到 short hash,看着就是
  `d78c8339` 这种),现在一律展示原始 user prompt(`Print date every five seconds`)或
  parent session 派发的任务描述
- 飞书列表 / 详情 / Attach 按钮发出来的 sessionId 统一升级到 full UUID,SDK 调用不再被
  claude 拒(`Provided value ... is not a UUID`)
- 飞书活跃 session 列表新增 bg-conflict 预警:Attach 时如果探测到 daemon worker 仍在跑,会
  显式提示"直接发消息会被阻拦"
- 飞书侧 Agent View 整体与终端 TUI 行为对齐
- `bot.deps.replyFn` 在 daemon 启动时被正确同步到 AgentViewManager(之前是 stub,
  导致 Attach / Stop / Reply 卡回调全部静默失效)

#### Fixed
- **`bgJsonlHasConversation` 误判**:v2.2.12 早期版本对"bg session 是否有对话"做检测,
  但实际 post-stop resume 即使 JSONL 有内容也可能报 "No conversation found"
- **name-cache 污染**:snapshot-fetcher 的 name 缓存被错误条目污染后无法自我修复,
  v2.2.16/v2.2.17 让 JSONL 派生优先于缓存,污染条目下次 fetch 即覆盖
- **sessionId 短 hash bug**:旧 snapshot-fetcher 路径上,`sessionId` 字段可能存 8 字符
  short,导致 `claude -p --resume <short>` 失败,handleAttach 与 runChatSDK 都有
  short→full 兜底展开
- **bg worker 并发覆盖风险**:用户从飞书 Attach 到活跃 bg session 后发消息,
  bot 之前默默 swap 到 parent JSONL 继续跑,**filesystem 副作用不隔离**,
  bg worker 和飞书 SDK 同时改 cwd 文件会互相覆盖
- **拒绝卡 fire-and-forget**:`handleStopAndSend` 之前 `return await` 整个 stop+wait+SDK 链,
  飞书 card action callback 3s 超时 → 报"目标回调服务超时未响应",改为立刻 ack + 后台实际工作
- **handleAttach guard short↔full 兼容**:card 发 short、snapshot 存 full(或反之)
  的边界情况下不再误报"会话已不存在"
- **handleList live-guard 误伤**:之前在 bg worker 仍跑时,snapshot 会带上 worker
  持有的 session 同时也带上 daemon.log 中的 completed 副本,导致同 session 出现两次;
  activeShorts 去重 + readCompletedSessions merge 后列表干净
- **completed session 源推断**:`roster.workers[short]` 查不到时 fallback 读
  `~/.claude/daemon.log` 中的 `bg claimed-spare` 事件,补出 source(spare/slash/fleet),
  避免把 spare 子 agent 误展示
- **Peek raw 终端 buffer 渲染 tofu**:之前 Peek 把 `claude logs` 的屏幕 buffer
  塞 code-block,box-drawing 字符在飞书 monospace 字体里渲染成 □;v2.2.8 改读 JSONL
  倒序找最后一条 assistant 文本直接 markdown 渲染,与 TUI 视觉对齐
- **completed session name fallback**:v2.2.7 起,对没有 JSONL 内容、只有 metadata 的
  completed bg session 也能给出 user prompt 作为 name(从 `claude agents --json` 的
  `dispatch.seed.name` 派生)

#### Added
- **bg-conflict 拒绝卡**(`buildBgConflictCard`):飞书侧活跃 bg session 直接发消息时,
  bot 默认拒绝并发并弹卡询问 [🛑 停 bg 后继续发送] / [🌿 开新会话发送] / [❌ 取消],
  三个一键恢复路径,safe-by-default
- **stop-and-send parent fallback**:点 🛑 后,bot 跑 `claude stop <short>` 释放 worker,
  然后**总是 fallback 到 parent session**(从 `roster.launch.sessionId` pre-compute + stashed
  到 button value 避免 race)继续发消息,放弃继承 worker 内存里跑出来的增量
- **live bg worker 警示文案**:`handleAttach` 在 attach 到活跃 bg session 时追加
  "该 session 仍有 bg worker 在跑" 提示,让用户对接下来要发生的拒绝卡有预期
- **v2.2.16 起的 name-cache 自我修复**:`deriveNameFromJsonl` 总是从 JSONL 派生
  full UUID,即使缓存命中也会重新写回,污染条目下次 fetch 即覆盖
- **runChatSDK `bgConflictHooks` 注入点**:为测试方便把 roster / lookupResumeFromPath
  抽到 `_bgConflictHooks` mutable 对象,绕开 bun `mock.module` 跨文件不可撤销
- **runChatSDK `bg-conflict` 拒绝分支**:sessionUuid 在 roster.workers 中时
  short-circuit 拒绝 + 弹拒绝卡,不让 SDK 直发
- **Peek / Run 工具集**:`jsonl-peek.ts`(assistant 文本倒序扫描 + 段落截断)、
  `jsonl-name.ts`(first user prompt 提取 + name-cache)、
  `bg-conflict card`、`bg-conflict cancel` handler

#### Security
- 拒绝让用户从飞书直接接管活跃 bg worker 后立即发消息:这是这一波最关键的安全修复。
  之前 v2.2.10 silent swap-to-parent 看起来"work"但实际上让两个 claude 进程共享同一个
  cwd,改文件可能互相覆盖,导致工作丢失。这一波改"先弹卡让用户选"——安全 > 便利。

### Deployment
- 22 个 commit 从 `84192c2`(v0.3.4 部署)到 `fe82566`(v2.2.18 fire-and-forget)
- 全量测试 718 pass / 0 fail,`bun run typecheck` 干净
- 实际端到端实测:飞书侧 Attach / Peek / 拒绝卡 / 🛑 恢复 / 🌿 新会话 / 文本消息 6 个
  核心交互全部跑通,跟 TUI 视觉/行为对齐

### Known Limitations (deferred to 0.4.1+)
- interactive TUI sessions 在飞书侧**不展示**(`kind !== 'background'` 过滤掉);
  设计上仅托管 bg session,跟"看所有 session 历史"诉求冲突,等用户决策后做
- 空 JSONL 的 bg session(parent 派发后 worker 没用户输入,例如 print-date 一次性任务)
  仍显示 short hash 作为 name;要 fallback 到 parent JSONL 找原始 `/background` 命令文本
  需要 v2.2.18+ 的"parent 派生"逻辑
- Reply(等待中 bg session 输入):飞书 SDK 走 `claude -p --resume` 不能投递到活的
  worker(daemon IPC 不暴露),改路径需要 TUI `claude attach <short>`

## [0.3.4] - 2026-06-01
飞书 Agent View 早期接入(v0.3.0)的部分功能首次 ship:`/agents` 列表、`Peek`、基础
`Attach`、等待中 session 的 `Reply`。但很多边界没处理好,0.4.0 才开始真正可用。

[0.3.3] - 2026-05-31
[0.3.2] - 2026-05-31
[0.3.1] - 2026-05-31
[0.3.0] - 2026-05-29
[0.2.2] - 2026-05-29
[0.2.1] - 2026-05-24
[0.2.0] - 2026-05-24
[0.1.0] - 2026-05-24
[0.0.4] - 2026-05-24
