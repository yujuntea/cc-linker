# `cc-linker img-proxy` 使用说明

让**纯文本模型**(glm-5.2、qwen3-max、deepseek、mimo-pro 等)在 Claude Code 里也能"接收"你粘贴的图片。

> **重要心智模型**:`img-proxy` 不让模型直接"看见"图片——它把图片**保存成本地文件**,然后给模型发一段**文本**(图片路径 + 选择工具的提示)。模型按其现有能力挑选合适的工具:`Read` 工具(若支持图片)、已注册的任何图片识别 MCP(如 `mcp__MiniMax__understand_image` 之类),或 `Bash` 调用本地图片识别 CLI(如 `mmx-cli`)。这是绕开纯文本模型 4xx 的核心设计。

---

## 目录

- [它解决了什么问题](#它解决了什么问题)
- [30 秒上手](#30-秒上手)
- [系统架构](#系统架构)
  - [请求生命周期](#请求生命周期)
  - [数据流图](#数据流图)
- [数据存储与路由映射](#数据存储与路由映射)
  - [磁盘布局](#磁盘布局)
  - [`routes.json` 路由表](#routesjson-路由表)
  - [路由解析逻辑](#路由解析逻辑)
- [智能安装(smart_mode)](#智能安装smart_mode)
  - [4 路候选发现](#4-路候选发现)
  - [模型分类规则](#模型分类规则)
  - [模式行为矩阵](#模式行为矩阵)
- [Shell wrapper 模式](#shell-wrapper-模式)
- [用户场景指南](#用户场景指南)
  - [场景 A:纯 CC Switch 用户](#场景-a纯-cc-switch-用户)
  - [场景 B:自定义 alias 用户](#场景-b自定义-alias-用户)
  - [场景 C:混合用户](#场景-c混合用户)
  - [场景 D:cold-start 新用户](#场景-dcold-start-新用户)
  - [场景 E:官方 API 直连](#场景-e官方-api-直连)
- [`cc-linker setup` 一键向导](#cc-linker-setup-一键向导)
- [命令参考](#命令参考)
- [配置文件](#配置文件)
- [Web Console 监控后台](#web-console-监控后台)
- [故障排除](#故障排除)
- [卸载](#卸载)
- [升级 / 迁移](#升级--迁移)
- [已知限制 / 容易踩的坑](#已知限制--容易踩的坑)

---

## 它解决了什么问题

Claude Code 客户端把截图粘贴进去时,会发送这样的 `messages` 请求:

```json
{ "messages": [{ "role": "user", "content": [
  { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "iVBOR..." } },
  { "type": "text", "text": "看这个图" }
]}]}
```

**支持图片的多模态模型**(Claude 3+、GPT-4、kimi、glm-4v、qwen-vl 等)能正常处理。

**纯文本模型**(glm-5.2、qwen3-max、deepseek 等)直接 4xx:`Model only support text input`。
这不是 Anthropic 协议问题——是上游模型自己拒收图片。

**img-proxy 的办法**:
1. 在客户端和上游之间劫持请求,识别 image block
2. 把图片落盘到 `~/.cc-linker/img-proxy/cache/`
3. 把 image block **替换**为一段文本(图片路径 + 提示模型自选识别工具:Read / 图片识别 MCP / 本地 CLI)
4. 上游收到纯文本请求,正常处理

**前置依赖**:你的纯文本模型必须具备某种图片识别能力(`Read` 工具 / 图片识别 MCP / 本地 CLI 如 `mmx-cli` 之一即可)。

---

## 30 秒上手

```bash
# 1. 一键智能安装(自动分类 + 自动发现 CC Switch / alias)
cc-linker img-proxy install --yes

# 2. 后台启动代理
cc-linker img-proxy start --daemon

# 3. macOS 开机自启(可选)
cc-linker img-proxy daemon install

# 或者干脆一步到位:
cc-linker setup              # 自动走完注册表 + 飞书 + img-proxy
```

跑完后:

- 纯文本模型(如 glm-5.2)粘贴图片,会收到这样的文本:
  ```
  [用户粘贴的图片已保存到本地文件: /Users/you/.cc-linker/img-proxy/cache/1783143359780-o07orl.png]
  当前模型为纯文本模型,请用以下方式之一查看该图片内容:
  1. 调用 Read 工具读取该本地路径(若 Read 支持图片)
  2. 调用你已注册的任何图片识别 MCP 工具(参数名视工具而定,常见如 image_source/image_url/image_path)
  3. 用 Bash 调用本地图片识别 CLI(如 mmx-cli 等,具体命令与参数名以工具文档为准)
  ```
- 模型调用 MCP 工具后能正常回答你的问题
- 多模态模型(Claude/Kimi 等)完全不受影响——它们不经 proxy,直连原 upstream

---

## 系统架构

### 请求生命周期

```
┌──────────────────┐                                    ┌──────────────────┐
│  Claude Code CLI │                                    │  上游 LLM API    │
│  (本机进程)       │                                    │  (Ark/GLM/Qwen…) │
└──────────────────┘                                    └──────────────────┘
         │ ① ANTHROPIC_BASE_URL=http://127.0.0.1:8765/<alias>           │
         ▼                                                            ▲
┌──────────────────────────── img-proxy(Bun.serve)────────────────────┴─────┐
│                                                                           │
│  ② 解析 url.pathname → 提取第一段作 alias (parseAliasFromPath)            │
│  ③ console 路径('/'、'/admin'、'/admin/...') 走 console handler            │
│       (总是 mount;console_enabled 由 handler 内每次读 config,             │
│        这样热开关不需要重启 daemon)                                        │
│  ④ 查 routes.json → 真实上游 URL;alias 不在表里 → 502 提示 install          │
│  ⑤ 仅 POST /<alias>/v1/messages:                                          │
│       buffer body → JSON.parse → stripImagesToPaths()                    │
│         - 递归进入 tool_result.content(Read tool 读 PNG 后会嵌套)         │
│         - base64 image → 落盘到 cache/                                   │
│         - 替换成 text block(模板含 {path};不含则回退到默认)               │
│       同时:server.timeout(req, 0) 禁 idleTimeout                          │
│  ⑥ 请求头清理:sanitizeProxyRequestHeaders                                 │
│       - 删 host / content-length / hop-by-hop                            │
│       - accept-encoding 收口到 gzip, deflate, br                         │
│  ⑦ fetch(realUpstream + rest + search, 转发 req.signal)                  │
│  ⑧ TransformStream 包 upstream body 统计 chunk/byte + lastChunkAt        │
│  ⑨ pipeTo().catch 区分 client_aborted / upstream_error                   │
│  ⑩ 响应头清理:sanitizeProxyResponseHeaders                                │
│       - 删 content-encoding / content-length(都被 Bun 解压过,过期了)     │
│       - 删 hop-by-hop                                                     │
│  ⑪ 流式透传 + pipeTo.finally 写 stats + log                              │
│       (alias, method, path, stripped, upstream_status, duration_ms,      │
│        chunks, bytes, headers_to_first_chunk_ms, stream_status, ...)     │
│                                                                           │
└───────────────────────────────────────────────────────────────────────────┘
```

关键点:

- **POST `/v1/messages` 才会改 body**。GET/HEAD 直接透传;其他方法 streaming 透传(不消费)。
- **POST `/v1/messages` 必走 `server.timeout(req, 0)`** —— Bun.serve 默认 idleTimeout=10s,LLM SSE 在 extended thinking / tool execution / 长 token 生成期间很容易超 10s 静默期, 不禁 idleTimeout 客户端会看到 "Connection closed mid-response"。其他请求保持 10s 保护(502 / console / HEAD 健康检查)。
- **改 body 不抛错**:JSON.parse 失败 → 用原始 bytes 透传。图片块异常 → 块原样保留。绝不阻塞。
- **路由表是唯一 gate**:路径第一段若不在 `routes.json` → 直接 502 提示用户 install(不做 hardcoded reserved-prefix denylist, 像 `v1.json`/`api.json` 这类文件名用户起 provider 用得到, 只要 install 过就能路由)。
- **`disabled` 路由**:routes.json 里的 `disabled: true` 让 `getUpstreamByAlias` 返 null, proxy 直接 502 而不是 passthrough 到原 upstream(避免误路由到别的 alias)。
- **流式响应**:不解析 SSE 内容,直接 pipe。`req.signal` 转发给 upstream, 客户端断开时自动 cancel upstream, 不浪费 token。

### 数据流图

```
                  install / uninstall
                  ──────────────────►
   ~/.claude/providers/*.json            ~/.cc-linker/
        │                                  │
        │  (ProviderFileInfo:               │
        │   alias=文件名stem,               │
        │   baseUrl=ANTHROPIC_BASE_URL)     │
        ▼                                  ▼
  ┌──────────┐  install改写  ┌────────────────────┐
  │ provider │ ──────────────►│ provider 文件       │
  │ 文件     │                │  ANTHROPIC_BASE_URL │
  │ (mm:600) │                │  = http://127.0.0.1:8765/<alias>
  └──────────┘                └────────────────────┘
                              ┌────────────────────┐
                              │ provider.json.bak  │ 原始上游 URL
                              └────────────────────┘
                              ┌────────────────────┐
                              │ ~/.cc-linker/      │
                              │  img-proxy/        │
                              │  routes.json       │ alias → upstream 真上游
                              │  (m0:600)          │
                              └────────────────────┘
                                       │
                                       │ 运行时(req 来时)
                                       ▼
                              ┌────────────────────┐
                              │ img-proxy daemon   │
                              │ 127.0.0.1:8765     │
                              │  - parseAlias      │
                              │  - stripImages      │
                              │  - forward          │
                              └────────────────────┘
                                       │
                                       │ 落盘
                                       ▼
                              ┌────────────────────┐
                              │ ~/.cc-linker/      │
                              │  img-proxy/        │
                              │  cache/*.png       │ 文件 0600
                              │  (7 天后清)        │
                              └────────────────────┘
                                       │
                                       │ 替换成 text block:
                                       ▼
                              "[图片已保存到本地文件: {path}]
                                提示模型用以下方式之一识别:
                                1. Read 工具
                                2. 任意图片识别 MCP
                                3. 本地 CLI(如 mmx-cli)"
```

---

## 数据存储与路由映射

### 磁盘布局

| 路径 | 用途 | 权限 | 生命周期 |
|------|------|------|----------|
| `~/.cc-linker/img-proxy/routes.json` | 路由表(核心) | `0600` | 装/卸时增删,原子写 |
| `~/.cc-linker/img-proxy/img-proxy.pid` | daemon PID | `0600` | 启动写,停清 |
| `~/.cc-linker/img-proxy/img-proxy.log` | 请求日志(append) | 跟随日志 | append-only,人工 |
| `~/.cc-linker/img-proxy/cache/` | 落盘图片 | 文件 `0600` | 启动 + 每小时清过期(>7 天) |
| `~/.cc-linker/img-proxy/wrapper-backups/` | wrapper 卸前后 rc 文件备份 | `0644` | 装/卸 wrapper 时各一份 |
| `~/.claude/providers/<alias>.json` | user-managed 原始 provider 配置 | user | install 改写 ANTHROPIC_BASE_URL |
| `~/.claude/providers/<alias>.json.bak` | 改写前备份(含原始 BASE_URL) | user | uninstall 后删,uninstall 前保留 |
| `~/.cc-linker/auto-providers/<alias>.json` | CC Switch 同步过来的 provider | `0600` | syncCcSwitchToAutoProviders |
| `~/.zshrc` / `~/.bashrc` | shell wrapper 函数块 | `0644` | wrapper install 追加,uninstall 移除 |
| `~/Library/LaunchAgents/com.cclinker.img-proxy.plist` | macOS launchd 配置 | `0644` | daemon install 写,uninstall 删 |

### `routes.json` 路由表

```typescript
interface RouteEntry {
  alias: string;              // 文件名 stem(glm-5.2、byte-agent-glm…)
  upstream: string;           // 真实上游 base URL(如 https://open.bigmodel.cn/api/anthropic)
  provider_path: string;      // provider 文件绝对路径(为卸载 / 状态展示)
  original_base_url: string;  // 改写前的 BASE_URL(展示/审计;卸载还原时读 .bak)
  installed_at: string;       // ISO 时间戳
  disabled?: boolean;         // console Routes tab 临时禁用(setRouteDisabled(true))
                              //   启用时 delete 掉;proxy 看到 disabled=true 返 502
}

interface RouteTable {
  version: 1;
  routes: Record<string, RouteEntry>;  // key = alias
}
```

**关键设计**:`upstream` 字段存的是**真实上游 URL**,不是 proxy URL。这样:

1. wrapper 知道"我要替哪个上游做剥离"
2. uninstall 时能正确还原(从 .bak 读)
3. routes.json 是"逻辑映射表",不依赖端口

**写入语义**:用 `proper-lockfile` 互斥 + `tmp + rename` 原子写。并发 install 不会写坏。

### 路由解析逻辑

**正向(daemon 收到请求时)**:
```
GET/POST /<alias>/<rest>
  ↓ parseAliasFromPath(pathname)
  alias = 第一段非空段
  ↓ getUpstreamByAlias(routes.json, alias)
  upstream = routes[alias]?.upstream ?? null
  ↓ 拼接
  targetUrl = ${upstream}/<rest>${search}   ← upstream 末尾斜杠会被剥
```

**反向(wrapper 调 cc-linker 时)**:
```
cc-linker img-proxy resolve <realUpstream>
  ↓ resolveProxyByUpstream(routes.json, port, hostname, realUpstream)
  遍历 routes 找 upstream(经 normalizeUrlForCompare:小写 host + 剥末尾斜杠)匹配
  ↓ 命中
  proxyUrl = http://${hostname}:${port}/${alias}
```

`normalizeUrlForCompare` 是**反向解析的关键**——CC Switch 写 `https://x.com/api`,wrapper 读 settings.json 拿到 `https://x.com/api/`,差一个末尾斜杠也能匹配。

---

## 智能安装(smart_mode)

v2 默认行为。`install` 不再是"装哪个"的手动挑选,而是:

1. **自动发现候选**(4 路:manual / auto-synced cc-switch / alias 提示的文件存在性)
2. **按模型名分类**(multimodal / text-only / unknown)
3. **multimodal 自动跳过**(避免破坏图片能力)
4. **text-only + unknown 默认预选**
5. **检测到 CC Switch 时问要不要装 wrapper**

### 4 路候选发现

`discoverCandidates()` 合并 + 去重(manual 优先):

| 来源 | 路径 | `source` 标签 |
|------|------|---------------|
| **manual** | `~/.claude/providers/*.json`(你手写或 install 改过的) | `[manual]` |
| **auto** | `~/.cc-linker/auto-providers/*.json`(CC Switch 同步) | `[auto]` |
| **alias hint** | 从 `~/.zshrc`/`~/.bashrc` 扫 `alias cc-X='claude --settings ...'` 推出来的 provider | `[alias]` |

CC Switch 同步(`syncCcSwitchToAutoProviders`)只在每次 install 调用时执行,**带 mtime 检查**:

- CC Switch DB 的 mtime > auto-providers 目录任一文件的 mtime → 重新同步
- 否则跳过(幂等)
- 同步时**清理 stale entries**(CC Switch 已删的 provider 也从 auto-providers 删)

**手动改 token 后再 install**:`.bak` 不动,token 保留;`isProviderInstalled()` 检测到 BASE_URL 仍是当前 config 的 proxy URL → 真幂等,不重复写。

### 模型分类规则

`classifyModel()` 流程:

1. 剥尾部 bracket(`glm-5.2[1m]` → `glm-5.2`)
2. 跑 multimodal patterns(命中 → multimodal)
3. 跑 text-only patterns(命中 → text-only)
4. 都未命中 → unknown

**内置 multimodal patterns**(跳过):

| 厂商 | 匹配 |
|------|------|
| Anthropic | `claude-3*`、`claude-opus/sonnet/haiku` |
| OpenAI | `gpt-4*` |
| Google | `gemini-*-vision`、`gemini-1.5-pro` |
| 阿里 Qwen | `qwen*-vl`、`qwen*-omni`、`qwen3.*-plus` |
| 智谱 GLM | `glm-*-?v`(4v/4.5v/5v) |
| Moonshot Kimi | `kimi*` |
| MiniMax | `MiniMax-M3` |
| 小米 MiMo | `mimo-v\d+(\.\d+)?` 锚定(不带 `-pro`) |
| 字节 Doubao | `doubao*-vision`、`seed*-vision` |
| Stepfun/Hunyuan/ERNIE | `step-1v`、`*-vision`、`*-vlm` |
| 通用 | `-vision`、`-vl-`、`-vlm` |

**内置 text-only patterns**(装):

| 厂商 | 匹配 |
|------|------|
| 智谱 GLM | `glm-\d+(\.\d+)?`、`glm-4-air/turbo` |
| DeepSeek | `deepseek*` |
| 阿里 Qwen | `qwen-turbo/max/long/coder`、`qwen3.*-max`、`qwen3.*-coder` |
| Moonshot legacy | `moonshot-v1-*` |
| MiniMax | `MiniMax-M2`、`MiniMax-Text-*`、`abab*` |
| 小米 MiMo | `mimo-*-pro` |
| OpenAI 老版 | `gpt-3`、`gpt-3.5` |
| 国内 | `baichuan*`、`yi-*` |

**自定义 extras**(写在 `config.toml`,正则,大小写不敏感):

```toml
[img_proxy]
# 追加 multimodal(也会被跳过)
vision_model_patterns_extra = ["my-custom-vl-*"]

# 追加 text-only(也会被 proxy)
text_only_model_patterns_extra = ["my-custom-text-*"]
```

### 模式行为矩阵

| 命令 | 模式 | 行为 |
|------|------|------|
| `install` | smart | 4 路发现 + 分类 + 预选 text-only + unknown + 交互 |
| `install --yes` | smart | 同上但不交互(用默认预选) |
| `install --providers X,Y` | **dumb** | 只装 X,Y, 不过滤 multimodal(在全集 candidates 里查找, 不在 smart-filtered 子集里) |
| `install --all` | **dumb** | 全装, 不过滤 |
| `install --mode dumb` | dumb | 同 `--all`,但显式标 mode |
| `install --mode smart` | smart | 显式 smart(默认就是) |

`smart_mode = false` 可在 config 里关闭(回到 dumb 但用 `install` → 仍会走 4 路发现)。

**Edge case — `--providers` 显式指定 multimodal**:
- smart 模式下如果 `candidates.filter(...).length === 0` 且 `multimodalWanted.length > 0`, 抛 `E_IMG_PROXY_MULTIMODAL_PROVIDER`: "<alias> 是 multimodal 模型, smart 模式会跳过。改用 --mode dumb 或 --all"
- 这是显式引导而不是"装 + 警告", 避免 smart 默认误装 multimodal

### installProvider 3 态机

`installProvider` 不是简单的"备份 + 改写 + 加路由", 而是根据当前 BASE_URL 状态分支:

| 状态 | 触发 | 行为 |
|------|------|------|
| **真幂等** | currentUrl 已是当前 config 的 proxy URL (`http://${hostname}:${port}/...`) | 不动文件;只确保路由存在(轮换过的 token / 其它字段保留) |
| **跨 port/hostname 重装** | currentUrl 是任一历史 proxy URL 但不是当前 config 的 | 更新 BASE_URL 到当前 config 的 proxy URL;`.bak` 不动(保留原始 upstream);其它字段保留 |
| **首次 install** | currentUrl 既不是当前也不是历史的 proxy URL | 备份到 `.bak`(不覆盖已有);改写 BASE_URL;加路由 |

`.bak` 丢失时 跨 port 重装会抛 `<alias>: .bak 丢失,无法恢复 upstream。请先 cc-linker img-proxy uninstall --providers <alias> 再 install`, 防止 self-loop URL 写入 routes(否则 routes.upstream = proxy URL, 客户端断网时 proxy → proxy 死循环)。

`uninstallProvider` 用 **宽松匹配**(`isAnyProxyUrl`)识别"我们装过的代理 URL": 必须是 `http://` + path 以 `/<alias>(/...)` 开头或就 `/<alias>`, 才视为"我们装的"。这样:
- 用户手动改到别的服务器(URL 不含 `/<alias>/` 段)不会被覆盖
- 跨 port 卸也能从 `.bak` 还原

---

## Shell wrapper 模式

**适用人群**:用 CC Switch 直接 `claude`(没自定义 `cc-X` alias)。`~/.claude/settings.json` 是 CC Switch 写的——改 provider 文件无效,因为 Claude Code 直接读 settings.json。

### 它怎么工作

```bash
$ cc-linker-proxy "看这个图"
  ↓
shell 函数 cc-linker-proxy() (在 ~/.zshrc)
  ① env 已设且 resolve 返同 URL → 直 exec claude(E7 invariant:proxy URL 保留)
  ② env 已设且 resolve 返不同 URL → stderr warn "改写",exec claude (env=proxy)
  ③ env 已设但 resolve 返空       → stderr warn "fall back",走 settings.json 路径
  ④ env 未设                       → settings.json → resolve → exec claude (env=proxy)
```

### 3 步启用

```bash
# 1. 先装好(从 CC Switch 同步的所有 text-only provider 自动 route 进 routes.json)
cc-linker img-proxy install --yes

# 2. 装 wrapper
cc-linker img-proxy wrapper install
# → 写入 ~/.zshrc(检测 ZSH_VERSION / $SHELL)或 ~/.bashrc

# 3. 重载 shell
source ~/.zshrc

# 验证
cc-linker-proxy "echo test"   # 走 proxy
claude "echo test"             # 直连(不受影响)
```

`install --yes` 检测到 CC Switch 且未装 wrapper 时**会自动问一次**(默认 y)。

### 关键行为

- **递归防护(幂等)**:`ANTHROPIC_BASE_URL` 已设为 proxy URL(resolve 返同 URL)就直 exec,不走 resolve——保留用户显式选的 URL(E7 invariant)。设的是已装的 upstream URL 会改写为 proxy URL + stderr warn;陌生 / stale inherited URL 走 settings.json fall back + stderr warn。
- **幂等**:重复 `wrapper install` 不重复写。
- **备份**:修改前 `~/.cc-linker/img-proxy/wrapper-backups/wrapper-backup-<ts>-<uuid>`。
- **shell 检测**:`ZSH_VERSION` / `BASH_VERSION` / `$SHELL` 末段(zsh/bash)→ 写对应 rc。
- **marker 区块**:`# >>> cc-linker img-proxy wrapper (do not edit this block) >>>` 到 `# <<<` 之间,可以手动编辑中间内容,但 marker 不能改(改了 uninstall 找不到)。

### 子命令

| 命令 | 作用 |
|------|------|
| `wrapper install` | 装 wrapper 到 shell rc |
| `wrapper uninstall` | 移除 wrapper(原文件备份到 wrapper-backups/) |
| `wrapper status` | 检测是否已装 + rc 文件路径 |
| `current-url` | 读 settings.json 的 `ANTHROPIC_BASE_URL`(stdout 输出,空 = 没装) |
| `resolve <upstream>` | 按真实 upstream 查 proxy URL(stdout 输出,空 = 没在 routes 里) |

---

## 用户场景指南

### 场景 A:纯 CC Switch 用户

**前置**:`~/.claude/providers/` 为空(或者根本没这目录),CC Switch 已装且有若干 provider。

```bash
$ cc-linker img-proxy install --yes

🔍 发现 N 个 claude providers(来自 CC Switch):
  ❯ ◯ [auto]  glm-5.2           ✅ text-only        glm-5.2[1m]
    ◯ [auto]  kimi-for-coding   ⏭ multimodal-skip  kimi-for-coding[256k]
    ◯ [auto]  qwen3.6-plus      ⏭ multimodal-skip  qwen3.6-plus[1m]
    ◯ [auto]  minimax-m2.7      ✅ text-only        MiniMax-M3[1m]
    ... (N more)

ℹ  Smart 模式:跳过 M 个 multimodal provider

✅ 已装 K 个(smart 模式)
   glm-5.2    ✅ text-only
   minimax-m2.7 ✅ text-only

✅ 检测到 CC Switch,装 wrapper 到 ~/.zshrc? (Y/n)
> y

✅ wrapper 已装到 ~/.zshrc
   运行 source ~/.zshrc 或重开 shell 激活 cc-linker-proxy

完成: cc-linker img-proxy start --daemon
```

**日常**:

```bash
$ cc-switch use glm-5.2
$ cc-linker-proxy "看这个图"
# wrapper 自动找 glm-5.2 对应的 proxy URL,设置 ANTHROPIC_BASE_URL 后 exec claude

$ cc-switch use kimi-for-coding
$ cc-linker-proxy "看图"
# 报错:"kimi-for-coding 没在 img-proxy 里,hint: cc-linker img-proxy install"
# 这是预期行为 —— kimi 是 multimodal,image 走它没问题
```

**管理员不会 break**:`cc-linker-proxy` 只在 routes 里有 upstream 匹配时才替换 BASE_URL,否则 exit 1。手动 `claude "看图"` 完全不变。

### 场景 B:自定义 alias 用户

**前置**:`~/.claude/providers/byte-agent-glm.json` + `~/.zshrc`:

```bash
alias cc-byte-agent='claude --settings ~/.claude/providers/byte-agent-glm.json'
```

```bash
$ cc-linker img-proxy install --yes

🔍 发现 1 个 provider(来自 manual + alias):
  ❯ ◯ [alias]  byte-agent-glm   ✅ text-only        glm-5.2[1m]

✅ 已装 1 个(smart 模式)
# 注意:没问 wrapper(没 CC Switch)
# 继续用 cc-byte-agent alias,无需 wrapper

完成
```

**日常**(继续用 alias):

```bash
$ cc-byte-agent "看这个图"
# alias 把 --settings 指向已改写 BASE_URL 的 byte-agent-glm.json
# Claude Code 直连 http://127.0.0.1:8765/byte-agent-glm → proxy 剥图 → 转发
```

### 场景 C:混合用户

**前置**:`~/.claude/providers/` 4 文件 + CC Switch 12 provider + 3 个 shell alias。

```bash
$ cc-linker img-proxy install --yes

🔍 发现 16 个 candidate(去重后):
  ❯ ◯ [manual]  byte-agent-glm  ✅ text-only        glm-5.2[1m]
    ◯ [manual]  byte-glm        ✅ text-only        glm-5.2[1m]
    ◯ [auto]    kimi-for-coding ⏭ multimodal-skip  kimi-for-coding[256k]
    ◯ [auto]    qwen3.6-plus    ⏭ multimodal-skip  qwen3.6-plus[1m]
    ... 

# 同 alias 多源时:manual 赢(但只显示一个 entry)
✅ 已装 6 个
✅ wrapper 已装(CC Switch 检测到)
```

### 场景 D:cold-start 新用户

**前置**:`~/.claude/providers/` 不存在 + CC Switch 未装。

```bash
$ cc-linker img-proxy install

❌ 未找到任何可用的 provider 配置

  已扫描的位置:
    • ~/.claude/providers/ (manual - 不存在)
    • ~/.cc-linker/auto-providers/ (auto - 不存在)
    • ~/.cc-switch/cc-switch.db (未安装)

  解决方案(任选其一):
    1. 装 CC Switch (https://github.com/farion1231/cc-switch)
       — GUI 管理 provider,装好后 Claude Code 自动可用,img-proxy 也会自动识别
    2. 手动创建 provider 文件:
       ~/.claude/providers/my-provider.json
       (内容见下)

错误 [E_IMG_PROXY_NO_PROVIDERS]
```

**手工 provider 文件模板**:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://your-provider.example/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "sk-...",
    "ANTHROPIC_MODEL": "your-model-name"
  }
}
```

`ANTHROPIC_BASE_URL` 是必需字段,`ANTHROPIC_MODEL` 可选(只是展示用)。AUTH_TOKEN 看你上游要求。

### 场景 E:官方 API 直连

**前置**:`~/.claude/settings.json` 指 `https://api.anthropic.com`,无 CC Switch。

同场景 D(没 manual 没 auto)报错。但如果你装了 CC Switch 选了任意 provider:

```bash
$ cc-linker-proxy "echo test"
# settings.json 是 https://ark.cn-beijing.volces.com/api/plan(CC Switch 刚切了)
# routes.json 里 ark 这个 alias 的 upstream 是 https://ark.cn-beijing.volces.com/api/plan
# wrapper resolve 命中 → 走 proxy → OK
```

CC Switch 是 img-proxy 的**事实标准入口**。

---

## `cc-linker setup` 一键向导

`cc-linker setup` 会把注册表初始化 + Claude Code 权限 + 自动注册钩子 + 飞书 Bot + img-proxy 全部走一遍。**img-proxy 是默认最后一步**(`--skip-img-proxy` 可跳过)。

### 默认步骤

```
1. 初始化会话注册表
2. 选择 Claude Code 权限模式
3. 安装 Claude Code 自动注册钩子
4. 配置飞书 Bot(App ID + App Secret + 开机自启)— 除非 --skip-feishu
5. 启用图片代理 (img-proxy)— 除非 --skip-img-proxy
```

### img-proxy 那一步具体干啥

```bash
$ cc-linker setup
...
── Step 5/5 ── 启用图片代理 (img-proxy)

ℹ  img-proxy 让纯文本模型(glm-5.2/qwen/deepseek 等)也能在 Claude Code
   里接收粘贴的图片...

# (1) 探活(空 → 给出明确指引;有 → 列前 8 个)
⚠️ 未扫描到任何 provider 配置
   装 CC Switch 或手写 ~/.claude/providers/*.json 后再跑 setup
# 或者:
  检测到 N 个可用 provider(manual + cc-switch)
    • glm-5.2      https://open.bigmodel.cn/api/anthropic
    • kimi-for-coding https://api.moonshot.cn/anthropic
    ...

# (2) 询问是否启用
? 是否启用图片代理(选要启用的 provider → 启动 daemon)? (Y/n)
> y

# (3) 调用 imgProxyInstall({})—— smart install 全自动:
#     4 路发现 → 分类 → 预选 → interactive(setup 走的也是交互版,不是 --yes)
? 选择要启用图片代理的 provider (空格勾选,回车确认):
  ❯ ◯ [auto]  glm-5.2     ✅ text-only     glm-5.2[1m]
    ◯ [auto]  kimi-for-coding ⏭ skip       kimi-for-coding[256k]
    ...

# (4) 装完:检测到 CC Switch 时问 wrapper
? 检测到 CC Switch。是否装 wrapper(...)? (Y/n)
> y

# (5) 询问是否启动 daemon
? 是否现在启动 img-proxy daemon? (Y/n)
> y

# (6) macOS 询问开机自启
? 是否配置开机自启(launchd)? (Y/n)
> y

✅ img-proxy 已启动
✅ img-proxy 开机自启已配置

# Summary 里增加 wrapper 状态:
  图片代理:           ✅ 已启用 (5 个 provider)
  img-proxy 状态:     ✅ 运行中
  开机自启:           ✅ launchd 已配置
  img-proxy wrapper:  ✅ 已装 (用 cc-linker-proxy 替代 claude)
```

### 跳过指定步骤

```bash
cc-linker setup --skip-feishu --skip-img-proxy    # 只要本机
cc-linker setup --skip-hook --skip-img-proxy     # 飞书 + 钩子
```

### setup 里 img-proxy 出错不会阻断

```typescript
try {
  imgProxyResult = await runImgProxyWizard();
} catch (err) {
  console.log(chalk.yellow(`  ⚠️ img-proxy 配置失败: ${err}`));
  console.log(chalk.gray('  提示: 可稍后手动执行 cc-linker img-proxy install/start'));
}
```

失败给提示,继续跑完飞书 / Summary。

---

## 命令参考

### 主命令

| 命令 | 做什么 |
|------|--------|
| `cc-linker img-proxy install` | 交互式选 provider(smart 模式默认) |
| `cc-linker img-proxy install --yes` | smart + 不交互(用默认预选) |
| `cc-linker img-proxy install --providers X,Y` | dumb + 指定 provider(逗号分隔) |
| `cc-linker img-proxy install --all` | dumb + 所有(全装,不过滤) |
| `cc-linker img-proxy install --mode smart` | 显式 smart |
| `cc-linker img-proxy install --mode dumb` | 显式 dumb |
| `cc-linker img-proxy uninstall` | 交互式卸 |
| `cc-linker img-proxy uninstall --providers X,Y` | 指定卸 |
| `cc-linker img-proxy uninstall --all` | 卸所有(已装 wrapper 会问是否一并卸; Web Console 启用时也问是否禁用) |
| `cc-linker img-proxy start` | 前台启动 |
| `cc-linker img-proxy start --daemon` | 后台启动(parent spawn child, 带 CC_LINKER_IMG_PROXY_DAEMON=1 env) |
| `cc-linker img-proxy stop` | 停后台 daemon(SIGTERM → SIGKILL,3 秒超时;同时 stop launchd) |
| `cc-linker img-proxy status` | 看 daemon / 已装 / 未装 / wrapper / Web Console / launchd |

### 子命令

| 命令 | 作用 |
|------|------|
| `cc-linker img-proxy wrapper install` | 装 shell wrapper 到 `~/.zshrc` / `~/.bashrc` |
| `cc-linker img-proxy wrapper uninstall` | 移除 wrapper |
| `cc-linker img-proxy wrapper status` | 看 wrapper 状态 + rc 文件路径 |
| `cc-linker img-proxy current-url` | 读 `~/.claude/settings.json` 的 `env.ANTHROPIC_BASE_URL` |
| `cc-linker img-proxy resolve <upstream>` | 按 upstream URL 查 proxy URL(空 = 没在 routes 里) |
| `cc-linker img-proxy console enable` | 改 `console_enabled = true`(需 `stop && start` 生效) |
| `cc-linker img-proxy console disable` | 改 `console_enabled = false`(需 `stop && start` 生效) |
| `cc-linker img-proxy console status` | 看 console 是否启用 + 访问 URL + daemon 状态 |
| `cc-linker img-proxy daemon install` | macOS launchd 开机自启(KeepAlive, 先 stop+unload 旧 plist 避免 EADDRINUSE) |
| `cc-linker img-proxy daemon uninstall` | 卸载 launchd |

> **install 流程的额外步骤**: smart install 检测到 CC Switch 且未装 wrapper 时默认询问;询问"是否启用 Web Console 监控后台"; 这些在 `--yes` 下自动 yes。

---

## 配置文件

`~/.cc-linker/config.toml` 的 `[img_proxy]` section(全部可选):

```toml
[img_proxy]
enabled = true                                  # 总开关(false 时 start 立刻退出)
port = 8765                                     # 监听端口
hostname = "127.0.0.1"                          # loopback,不暴露
cache_max_age_hours = 168                       # 缓存保留 7 天,启动 + 每小时清过期
prompt_template = "..."                         # 给模型的文本(见下文 DEFAULT_PROMPT_TEMPLATE)
console_enabled = false                         # Web Console 开关(handler 内每次读 config,热开关)
smart_mode = true                               # v2: 跳过 multimodal 模型
vision_model_patterns_extra = []                # 追加 multimodal patterns
text_only_model_patterns_extra = []             # 追加 text-only patterns
upstream_timeout_ms = 0                         # upstream fetch 整体超时(ms);0 = 不超时(默认)
stream_idle_timeout_ms = 0                      # 距最后 chunk 超过 N ms 判 stalled(ms);0 = 不检测
```

**配置生效时机**:

| 字段 | 是否需要重启 daemon |
|------|-------------------|
| `console_enabled` | ❌ 不需要(handler 每次从 config 读最新值, 支持热开关) |
| `upstream_timeout_ms` / `stream_idle_timeout_ms` | ✅ 需要(server 启动时一次性 snapshot 到内存) |
| `port` / `hostname` / `cache_max_age_hours` / `prompt_template` / `enabled` | ✅ 需要 |
| 改任何字段(`console_enabled` 除外) | `cc-linker img-proxy stop && cc-linker img-proxy start --daemon` |

### 环境变量覆盖

| Env var | 覆盖 |
|---------|------|
| `CC_LINKER_IMG_PROXY_ENABLED` | `enabled` |
| `CC_LINKER_IMG_PROXY_PORT` | `port` |
| `CC_LINKER_IMG_PROXY_HOSTNAME` | `hostname` |
| `CC_LINKER_IMG_PROXY_CACHE_HOURS` | `cache_max_age_hours` |
| `CC_LINKER_IMG_PROXY_PROMPT_TEMPLATE` | `prompt_template` |
| `CC_LINKER_IMG_PROXY_SMART_MODE` | `smart_mode` |
| `CC_LINKER_IMG_PROXY_UPSTREAM_TIMEOUT_MS` | `upstream_timeout_ms` |
| `CC_LINKER_IMG_PROXY_STREAM_IDLE_TIMEOUT_MS` | `stream_idle_timeout_ms` |
| `CC_LINKER_IMG_PROXY_VISION_PATTERNS_EXTRA` | `vision_model_patterns_extra`(逗号分隔) |
| `CC_LINKER_IMG_PROXY_TEXT_ONLY_PATTERNS_EXTRA` | `text_only_model_patterns_extra`(逗号分隔) |

### 自定义 prompt template

默认 `DEFAULT_PROMPT_TEMPLATE`(`src/img-proxy/transform.ts`)是工具无关的:

```
[用户粘贴的图片已保存到本地文件: {path}]
当前模型为纯文本模型,请用以下方式之一查看该图片内容:
1. 调用 Read 工具读取该本地路径(若 Read 支持图片)
2. 调用你已注册的任何图片识别 MCP 工具(参数名视工具而定,常见如 image_source/image_url/image_path)
3. 用 Bash 调用本地图片识别 CLI(如 mmx-cli 等,具体命令与参数名以工具文档为准)
```

如果你想自定义(覆盖默认 3 路径建议),改 template:

```toml
[img_proxy]
prompt_template = "[用户粘贴的图片已保存到本地: {path}] 请用你的图片识别工具(image_source 传这个路径)来查看。"
```

模板**必须含 `{path}` 占位符**——代理会替换成实际的图片缓存路径。不含 `{path}` 时,代理**回退到默认文案**(避免空 text block 触发上游 4xx)。

> 默认 `prompt_template` 已不绑特定 MCP,通常无需自定义。仅当你模型对"图片识别 MCP"措辞不响应时再改。

---

## Web Console 监控后台

开启 `console_enabled = true` 后,访问 `http://127.0.0.1:8765/` 即可使用 —— 看实时请求 / 日志 / 改 config / 临时禁用 routes / 手动清缓存。

### 启用步骤

**方式 A —— 改 config.toml**:

```toml
# ~/.cc-linker/config.toml
[img_proxy]
console_enabled = true
```

**方式 B —— CLI**:

```bash
cc-linker img-proxy console enable
# 然后:
cc-linker img-proxy stop && cc-linker img-proxy start --daemon
```

`console_enabled` 是**唯一一个不需要重启 daemon 的字段** —— server 永远 mount console handler, 每次请求时再从 config 读最新值(见 server.ts `handleConsoleRequest` 第一行)。其他 `port` / `hostname` / `cache_max_age_hours` / `prompt_template` / `upstream_timeout_ms` / `stream_idle_timeout_ms` 都是 server 启动时一次性 snapshot, 改了必须 `stop && start`。

### 5 个 Tab

| Tab | 功能 |
|---|---|
| **Dashboard** | 实时 totalRequests / strippedImages / uptime / cache 文件数 + 大小;5min 状态分布;per-alias 聚合(requests / stripped / chunks / bytes / avgDuration / lastAt) |
| **Log** | 最近 200 条请求表格, 可按 alias / status / streamStatus / 时间过滤;可手动刷新或选 "Last 1h" |
| **Config** | 修改 `console_enabled` / `upstream_timeout_ms` / `stream_idle_timeout_ms`, 保存后通过 `config.reload()` 热 reload(`console_enabled` 立即生效, 其他两个 daemon 启动时已 snapshot 进内存, 仍需重启) |
| **Routes** | 当前 routes 列表, 每行 Enable / Disable 按钮;写 `disabled` 标志(不卸载文件, proxy 看到 disabled=true 返 502) |
| **Cache** | cache 概览 + "立即清理" 按钮;调用 `cleanupOldCache(0)` 全清 + 5s TTL 模块缓存 `resetHealthCache()` |

### 写操作 audit log

所有 console 的 POST 写操作(config_update / routes_disable / routes_enable / cache_clear)都写一行 INFO 到 `~/.cc-linker/img-proxy/img-proxy.log`, 格式:

```
[<ISO timestamp>] INFO {"time":"...","console_action":"routes_disable","alias":"glm-5.2","trigger":"console"}
```

事后查"谁在 console 上点了什么"靠这一行。注意: audit log 走 img-proxy 自己的 writer(ISO timestamp + JSON body), 不走 `src/utils/logger.ts` —— 两者格式不同, 混用会让 Log tab 的 filter/alerts 漏判。

### 安全

- 仅监听 127.0.0.1(需改 hostname 才能远程访问, 本版本不支持)
- 写操作前端 `confirm()` 二次确认
- 所有写操作 audit log 到 img-proxy.log(见上)

### 已知限制

- 2s polling(不支持 SSE / WebSocket 推送)
- Dark mode 暂未提供
- Mobile responsive 暂未优化
- cacheBytes 是 5s TTL 模块缓存, 主动 Clear 才会立即重算

---

## 故障排除

### 装完不工作

按顺序检查:

```bash
cc-linker img-proxy status              # daemon / port / routes / wrapper 状态
tail -30 ~/.cc-linker/img-proxy/img-proxy.log
curl http://127.0.0.1:8765/<alias>/v1/models  # 401 = OK(代理转发,鉴权失败符合预期)
```

### 状态码速查

| upstream_status | 含义 | 怎么办 |
|----|------|-------|
| 401 / 403 | 上游鉴权失败 | token 过期。重装:`cc-linker img-proxy install --providers <alias>`(保留 `.bak`,token 不丢) |
| 404 | upstream URL 错(路径被裁) | 检查 routes.json 里 alias 的 upstream 字段是否完整 |
| 502 + "未知 provider alias" | 路由表没这个 provider | `cc-linker img-proxy install --providers <alias>` |
| 502 + "上游不可达" | upstream 本身挂了 | 检查网络,curl 测一下 |

### "已在运行" 但端口没监听

```bash
lsof -nP -iTCP:8765                 # 看实际监听者
ps -p $(cat ~/.cc-linker/img-proxy/img-proxy.pid 2>/dev/null)  # 看 PID 是否活
cc-linker img-proxy stop && cc-linker img-proxy start --daemon
```

启动逻辑含 stale PID 检查 + `isPidAlive()`,正常不会出现这种情况。但 `kill -9` 后留下 stale 会被自动清理。

### 模型说"我看不到图片"

不是 proxy 的问题——是模型没调图片识别 MCP:

- 确认你的 `~/.claude.json` `mcpServers`(或 `.mcp.json`)启用了图片识别能力 / 装了 `mmx-cli` 等 CLI
- 默认 prompt 已指引三种路径(`Read` / MCP / CLI),看模型 response 选了哪条
- 全没响应:调整 `prompt_template` 用更明确的措辞告诉你的模型该调哪个工具

### `cc-linker-proxy` 报 "找不到当前 provider URL"

`~/.claude/settings.json` 没 `env.ANTHROPIC_BASE_URL` 字段:

- CC Switch 用户:在 CC Switch GUI 里选个 provider 激活(会自动写 settings.json)
- 其他用户:手动加 `"env": { "ANTHROPIC_BASE_URL": "..." }`

### `cc-linker-proxy` 报 "X 没在 img-proxy 里"

当前 CC Switch 激活的 provider 没被你 install 到 img-proxy 里:

- `cc-linker img-proxy install --providers <alias>` 装上
- 或 `install --yes` 让 smart mode 自动挑(但要 multimodal 才会被忽略)

### 大量 `cleanup removed N cached images` 日志

正常——每小时清过期图片的 INFO 日志。

---

## 卸载

```bash
# 1. 卸所有已 install 的 provider (--all 时已装 wrapper 会问是否一并卸,默认 N)
cc-linker img-proxy uninstall --all

# 2. 卸 wrapper(如果上面没卸)
cc-linker img-proxy wrapper uninstall

# 3. 停 daemon
cc-linker img-proxy stop

# 4. (如果装了 launchd)卸开机自启
cc-linker img-proxy daemon uninstall

# 5. 清缓存(可选,7 天后会自己清)
rm -rf ~/.cc-linker/img-proxy/cache
```

`uninstall` 会:
- 把 provider 文件的 `ANTHROPIC_BASE_URL` 还原(严格说:任何历史 port 的 proxy URL 都还原,从 `.bak` 读)
- 清 `routes.json` 里的 entry
- 删 `.bak`(防止过期备份累积)

**手动改过 `BASE_URL` 不会被覆盖**(只对历史 proxy URL 做还原)。

---

## 升级 / 迁移

### 从 v1(dumb install)升 v2(smart install)

**轻量迁移**(已装 multimodal 不会被自动卸):

```bash
cc-linker img-proxy install --yes
# smart 模式会跳过 multimodal,可能装 wrapper,加新路由
# 已装的不会被动
```

**严格迁移**(完全重置后重做):

```bash
cc-linker img-proxy uninstall --all      # 还原所有 + 清 routes + 问卸 wrapper
cc-linker img-proxy install              # smart 模式重新挑选
```

**回滚**(如果新行为不适合你):

```bash
cc-linker img-proxy uninstall --all
cc-linker img-proxy install --all        # dumb 模式:所有都装(旧行为)
```

### 改了 config 里的 port

不需要 `uninstall`。直接 `install --providers <alias>` 即可:

- BASE_URL 更新到新端口
- `.bak` 原 upstream 保留
- `routes.json` 的 upstream 仍是真上游(URL 规范化在 resolve 时生效)

### 手动改了 `BASE_URL`(迁移到别的服务器)

`uninstall` **不会丢**——你手动改的不包含 `/<alias>` 段(我们的 proxy URL pattern),`isAnyProxyUrl()` 检测 false,不还原。routes 和 `.bak` 仍按正常流程清。

---

## 已知限制 / 容易踩的坑

> 下面按"踩坑 → 触发场景 → 现象 → 修法 / 预防"展开。近期 fix 都已合到代码,这里讲的是**为什么不能忽略这些细节**以及怎么在日常使用中避开。

### ⚠️ Gotcha: shell alias vs provider 文件名

如果你有多个文件名相近的 provider,**shell alias 用的是哪个文件决定图片会不会被剥离**:

```bash
# ~/.zshrc:
alias cc-byte-glm='claude --settings ~/.claude/providers/byte-glm.json'      # ← 没装(只装了 byte-agent-glm)
alias cc-byte-agent='claude --settings ~/.claude/providers/byte-agent-glm.json'  # ← 装了
```

跑 `cc-byte-glm "看图"` 还是直连原 upstream,proxy 完全没被 hit。看 `~/.cc-linker/img-proxy/img-proxy.log` 会发现**没有该 alias 的请求记录**。

**修复**:

```bash
cc-linker img-proxy install --providers byte-glm,byte-agent-glm
# 或直接:
cc-linker img-proxy install --all
```

**预防**:安装前先 `cc-linker img-proxy status` 看"未纳入代理的 provider"列表。

### ⚠️ Gotcha: POST `/v1/messages` 在长 thinking / tool 调用时静默断连

**症状**:模型在 extended thinking / tool execution / 长 token 生成超过 10s 没新数据时, 客户端 `Claude Code` 报 `Connection closed mid-response`, proxy log 出现一长串 `stream_status=upstream_error` 但 `upstream_error_msg=undefined`。

**根因**: Bun.serve 默认 `idleTimeout = 10s` —— 响应流超过 10s 没数据发送就关 client TCP 连接。LLM SSE 在上述场景很容易超 10s。

**修法**(已合): `POST /<alias>/v1/messages` 进入 fetch 前调 `server.timeout(req, 0)` 禁用 idleTimeout。其他请求(502 / console / HEAD 健康检查)保持默认 10s 保护。

**怎么验证已生效**: 看 log 里 `stream_status` 分布——如果你看到大量 `client_aborted` 而不是 `upstream_error`, 那说明 idleTimeout 关了, 中断是 client 主动断。

### ⚠️ Gotcha: `content-encoding` 双解压 → 客户端崩 → proxy 误报 upstream_error

**症状**: glm-5.2 等上游对大响应会 gzip;proxy log 里 `stream_status=upstream_error` 但 `upstream_error_msg=undefined`, `upstream_status=200`, 传了 11KB–253KB 后中段失败。卸载代理直连正常。

**根因**: Bun.fetch 自动解压 gzip/deflate/br, 但**不会**从 `upstreamResp.headers` 里移除 `content-encoding`(以及非流式响应的 `content-length` —— 那是压缩后大小)。原样转发这两个头 → 客户端看到 `content-encoding: gzip` 后对已被 Bun 解压的明文再 gunzip → 流解析器崩 → 断开连接 → proxy 的 pipeTo 以 undefined reject, 被误分类为 `upstream_error`。

**修法**(已合): `sanitizeProxyResponseHeaders` 剥掉 `content-encoding` / `content-length` / 全部 hop-by-hop 头。 `sanitizeProxyRequestHeaders` 把 `accept-encoding` 收口到 `gzip, deflate, br` —— 客户端可能带 `zstd`, 但 Bun 不解压, 上游若真回了 zstd 反而会让响应侧剥头逻辑误伤, 统一限定到 Bun 已知能解压的集合。

**怎么识别**: log 里 `upstream_error_msg=undefined` + `stream_status=upstream_error` 是这条 bug 的典型签名。

### ⚠️ Gotcha: `tool_result.content` 里嵌套的 image 块不剥 → 纯文本模型 4xx

**症状**: Claude Code 让 Read 工具读 PNG 后, 会把图塞进 `tool_result.content` 嵌套 content 数组传给上游。纯文本模型对这条消息 400 (`Model only support text input`)。 看 proxy log 里 `stripped=0` 但请求通过。

**根因**: 老版本 strip 只扫顶层 `msg.content`, 嵌套层漏。

**修法**(已合): `stripImagesToPaths` 抽 `processBlocks(blocks)` 命名函数递归处理 `block.type === 'tool_result'` 的 `content` 数组。

**怎么验证**: 让 Claude Code 读一张本地图片, log 里 `stripped >= 1` + 替换的 text block 含 `[用户粘贴的图片已保存到本地文件: ...]` 标志, 才是真的递归进去。

### ⚠️ Gotcha: 改了 `config.toml` 但 daemon 没重启

**症状**: 改了 `port` / `prompt_template` / `upstream_timeout_ms` 等, 行为没变。

**根因**: 大部分字段是 server 启动时一次性 snapshot 到内存(`opts.port` / `opts.upstreamTimeoutMs` 等)。只有 `console_enabled` 是热开关(handler 内每次从 config 读)。

**修法**:

```bash
cc-linker img-proxy stop && cc-linker img-proxy start --daemon
```

### ⚠️ Gotcha: 改了 `port` / `hostname` 后, 已 install 的 provider 仍能用

**症状**: 把 `port` 从 8765 改成 9000 后, `cc-linker img-proxy status` 显示已装 provider, 但 BASE_URL 还指 8765。

**实际行为**(`installProvider` 3 态机的"跨 port/hostname 重装"): 重新 `cc-linker img-proxy install --providers <alias>` 即可:
- 检测到 currentUrl 是历史 proxy URL(任意 port/hostname) → 改 BASE_URL 到当前 config 的 proxy URL
- `.bak` 不动(仍是原始 upstream)
- 其它字段(轮换过的 token)保留

不需要先 `uninstall`。

### ⚠️ Gotcha: smart install 显式指定 multimodal provider

**症状**: `cc-linker img-proxy install --providers kimi` 报 `E_IMG_PROXY_MULTIMODAL_PROVIDER: kimi 是 multimodal 模型, smart 模式会跳过。改用 --mode dumb 或 --all`。

**为什么这是 explicit fail 而不是 warn + 装**: smart 模式默认是"multimodal 跳过", 用户显式指定 multimodal 时本意多半是配错了——抛错比"装了但不工作"更安全。要强装就加 `--all` 或 `--mode dumb`。

### ⚠️ Gotcha: MiMo 正则老版本会把 `mimo-v2.5-pro` 误判 multimodal

**症状**(已修): 老 `mimo-v\d+(?!-pro)` 负向 lookahead 会被 backtrack 跳掉 pro 前缀, 让 `mimo-v2.5-pro` 反而命中 multimodal 跳过。

**修法**(已合): 改成 `/^mimo-v\d+(\.\d+)?$/i` 锚定 + 显式 `/^mimo-.*-pro/i` 拦截 Pro 变体。如果你的 `mimo-*-pro` 走 img-proxy 行为奇怪, 检查代码版本(commit `69c0acf` 之前的版本可能仍有此 bug)。

### ⚠️ Gotcha: launchd 重装时 KeepAlive 触发旧 PID 残留

**症状**: `cc-linker img-proxy daemon install` 第二次跑后, 看 log 发现 daemon 没起来 / `127.0.0.1:8765` 仍被旧 PID 占用。

**根因**: 旧 plist 还在, launchd KeepAlive 在新 child 起来之前已经把 :8765 给旧 child 用着, 新 child EADDRINUSE crash。

**修法**(已合): `daemon install` 进入前先 `launchctl stop com.cclinker.img-proxy` + 等旧 child 死(轮询 SIGKILL 兜底)+ `launchctl unload` + 清理 PID 文件, 然后才写新 plist + load + start。

### ⚠️ Gotcha: parent spawn child 后 PID 文件"碰巧留下"的假阳性

**症状**(已修): 老版 parent 盲目等 1200ms 后就 console.log "已启动", 但 child 可能 EADDRINUSE crash 后 PID 文件刚好留着——用户看到 "成功" 但 8765 没监听。

**修法**(已合): parent poll `IMG_PROXY_PID_FILE === child.pid && isPidAlive(childPid)` 双重判定, 最多 5s(50 × 100ms)。

### ⚠️ Gotcha: CC Switch 同步 mtime 检查

**症状**: CC Switch 删了一个 provider, 但 `cc-linker img-proxy install` 没察觉, "未纳入代理的 provider" 列表里没反映。

**根因**(已修): 老版 mtime 检查用的是 `auto-providers` **目录**的 mtime。但目录 mtime 会在文件被删除时跳到 NOW → 错误地认为刚同步过 → 跳过 sync。

**修法**(已合): 改成取 `auto-providers` 下**最新文件**的 mtime 与 CC Switch DB 的 mtime 比较(见 `provider-scan.ts:syncCcSwitchToAutoProviders`)。

### ⚠️ Gotcha: console 写操作 routes disable 不是 uninstall

**症状**: Web Console Routes tab 点 Disable 后, Claude Code 跑 `cc-byte-glm` 看到 502 "未知 provider alias"。

**实际行为**: console 的 routes_disable 是**软禁用**——写 `routes[alias].disabled = true`, proxy 看到就 502(alias gate 是 routes.json 的"uninstall 或 disabled"两种状态, 都不认)。provider 文件 + `.bak` + 路由表 entry 都还在; 想恢复去 console Routes tab 点 Enable, 或 `cc-linker img-proxy install --providers <alias>` 重新走 install 流程(会自动清 disabled 标志)。

**为什么不是 uninstall**: console 是临时调试工具, 软禁用让用户能快速 "关掉某个 alias 看看不剥图的话 upstream 是不是对的", 不希望误删 `.bak` / 改写 BASE_URL。

### 其他限制

1. **URL 形式 image block** (`source.type === 'url'`)不处理。Claude Code 通常把 URL 转 base64, 但如果是纯 URL, 代理原样转发, 模型能不能 fetch 看上游。
2. **清理是定时**的(启动 + 每小时), 不会立刻清。磁盘敏感手动 `rm`。
3. **默认 `prompt_template` 已不再硬编码具体 MCP**——它指引模型自选工具(`Read` / 任何图片 MCP / `mmx-cli` 等本地 CLI)。若你模型没回应该提示, 手动改 `prompt_template` 指定你想用的工具名。
4. **fish / sh / ksh 不支持 wrapper**。Fish 用 `alias cc-X cmd`(无等号)语法不同, 未实现。可手写函数。
5. **login shells**(ssh 登录、macOS 开机)不 source `.zshrc`, wrapper 不会自动加载——只对交互式终端有效。
6. **不在 PATH 时** wrapper 调用会报 "command not found"——确保 `cc-linker` binary 已装到 `/usr/local/bin` 或类似位置。
7. **console Routes tab 显示的 `disabled` 字段**——是 console 软禁用; 和"已 install 但 BASE_URL 没指 proxy URL"(手动改)是两码事, 后者 `isProviderInstalled()` 返 false, 但 routes.json 仍有 entry。
8. **`.bak` 丢失后跨 port/hostname 重装会抛错**——`installProvider` 不会 fallback 到 currentUrl(那是代理地址, 会让 routes 自指循环)。此时需先 `cc-linker img-proxy uninstall --providers <alias>` 再 install。

### 容易踩的坑

1. **第一次安装前先 `status`** 看看哪些 provider 是"未纳入代理",这就是你能启用的范围。
2. **`enabled = false` 跟 daemon `start --daemon` 混用**——enabled=false 时 daemon 启了会立刻退出。
3. **改 `config.toml` 后 daemon 不自动 reload**——需要 `stop && start --daemon`。
4. **cache 文件 mode 0o600**,有敏感截图别 chmod 放开。
5. **`cc-linker-proxy` 必须从装了 wrapper 的 shell 跑**(`source ~/.zshrc` 后)。IDE 集成终端有时不 source,需要重启 IDE 或手动 source。
6. **同一个 provider 别手动 `~/.claude/providers/` + CC Switch 同时管**——manual 优先,auto 的写入会被覆盖,容易分散。

---

## 相关源码

| 文件 | 用途 |
|------|------|
| `src/img-proxy/server.ts` | Bun.serve 反向代理主体 + idleTimeout 关闭 + 头清理 + TransformStream 埋点 + console 路由 mount |
| `src/img-proxy/transform.ts` | 剥 image block(含递归 tool_result.content)+ 落盘 + `DEFAULT_PROMPT_TEMPLATE` |
| `src/img-proxy/routes.ts` | 路由表读写 + 加锁(proper-lockfile + sentinel)+ 双向解析 + `disabled` 标志 |
| `src/img-proxy/provider-scan.ts` | 扫描 + CC Switch 同步(mtime 用最新文件非目录 mtime)+ stale cleanup |
| `src/img-proxy/provider-config.ts` | install/uninstall 3 态机 + `isAnyProxyUrl` 宽松匹配 |
| `src/img-proxy/classify.ts` | 模型分类(builtin + extras, 锚定 MiMo 正则) |
| `src/img-proxy/aliases.ts` | shell alias 扫描 + 引号感知 comment strip |
| `src/img-proxy/discover.ts` | 4 路合并 + dedup + baseUrl 过滤 + 触发 CC Switch 同步 |
| `src/img-proxy/wrapper.ts` | shell wrapper 函数生成 + marker 检测 + shell 探测 |
| `src/img-proxy/resolve.ts` | 读 settings.json(给 wrapper 调用) |
| `src/img-proxy/types.ts` | `RouteEntry` / `RouteTable` / `TransformResult` / `ProviderFileInfo` |
| `src/img-proxy/console/api.ts` | Web Console 9 个 endpoint + `handleConsoleRequest` 主入口 + audit log |
| `src/img-proxy/console/html.ts` | INDEX_HTML(SPA 5-tab 模板, vanilla JS) |
| `src/img-proxy/console/config-writer.ts` | `console_enabled` atomic write(CLI 和 console 共用) |
| `src/img-proxy/console/stats-helpers.ts` | `updateByAlias` 增量平均 + `pushRecent` 环形 buffer |
| `src/img-proxy/console/log-parser.ts` | img-proxy.log 解析(filter by alias/status/streamStatus) |
| `src/img-proxy/console/types.ts` | `AliasStats` / `RecentEntry` / `ParsedLogEntry` / `HealthStats` |
| `src/cli/commands/img-proxy.ts` | 所有 `cc-linker img-proxy <cmd>` 实现(含 console enable/disable/status 子命令) |
| `src/cli/commands/setup.ts` | `cc-linker setup` 一键向导(集成 img-proxy) |
| `src/utils/paths.ts` | 所有路径常量(含 `IMG_PROXY_*` 前缀 + `AUTO_PROVIDERS_DIR`) |
| `src/utils/config.ts` | `[img_proxy]` 默认值 + env 覆盖(含 `upstream_timeout_ms` / `stream_idle_timeout_ms`) |
