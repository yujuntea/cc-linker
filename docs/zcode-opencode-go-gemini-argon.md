# ZCode 接入 OpenCode Go 的 Gemini 4 Argon —— 完整实操方案

> 适用：ZCode 桌面端 3.17.1 + OpenCode Go（`opencode.ai/zen/go`）+ Gemini 4 Argon。
> 文中所有"实测"数据来自 2026-10-30 的逐项对照实验（每条都有对照组），证据可复现。
>
> **不需要 cc-linker**：§4.1 给的是一份零依赖的独立代理（Python 标准库）+ 安装/验证脚本，
> 拷贝即用；cc-linker 只是我们内部的一种实现选择，见 §4.2。

---

## 0. 结论速览

| 问题 | 结论 |
|---|---|
| 能不能直连 `https://opencode.ai/zen/go/v1`？ | **不能**。ZCode 3.17.1 的自定义 api-key provider 永远拿不到网关强制的 `x-opencode-session` 头 → 400 → 退避重试 → **会话卡死**（证据见 §3） |
| 需要什么？ | 一个**本地代理**（补头 + 改字段 + 长流不断），ZCode 的 Base URL 指向它。独立脚本见 §4.1，**不依赖 cc-linker** |
| 用 ZCode 内置模板 provider（`opencode-go-chat`）行不行？ | **不行**。模板由后端下发，本机 `api` 为 `null`、客户端无定义、日志零调用（§3 障碍⑤） |
| Gemini 4 Argon 的 ZCode 配置怎么填？ | 1M 上下文 / 65,536 输出上限 / 思考档位 low·medium·high / 图+视频输入 / 结构化输出（官方规格逐项对齐，见 §1） |
| 最容易踩的坑 | ① 直连卡死 ② 输出上限设太小被思考 token 吃光 ③ 字段方言导致 503 ④ 12-01 价格翻倍 ⑤ 悬空模型规则导致同名模型多条 |

---

## 1. Gemini 4 Argon 模型规格（官方）与 ZCode 字段对照

### 1.1 官方规格要点

来源：Google 官方文档《What's new in Gemini 4 Argon》（ai.google.dev/gemini-api/docs/latest-model）、Vertex AI 模型页（cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/4-argon）、OpenCode 官方模型目录（`GET /inference/go/v1/models`）。2026-10-30 采集。

| 项 | 值 |
|---|---|
| 模型 ID | `gemini-4-argon`（canonical `google/gemini-4-argon`） |
| 发布时间 / 知识截止 | 2026-10-13 / 2026-03 |
| 上下文窗口 | **统一 1,048,576 token**——输入 + 思考 + 输出**共享同一个窗口**（不是"输入 1M + 输出另算"） |
| 单请求输出上限 | **流式 65,536**；**非流式 32,768**（较 Gemini 3.x 的非流式上限下调） |
| 长解码（long decode） | 可突破单请求上限直至"1M − 输入"，需 `background`/`continuation_token` 机制；**仅 v1beta1 generateContent 支持**，OpenAI 兼容接口不暴露 |
| 思考等级 | `low` / `medium`（**官方默认**）/ `high`；`thinking_budget`、`thinking_level="MINIMAL"` → HTTP 400 |
| 采样参数 | **`temperature` / `top_p` / `top_k` 的自定义值一律被忽略**（官方明示，无需也不必配） |
| 缓存 | **仅隐式缓存**，最小前缀 4,096 token，durable caching 默认开启；**不支持显式缓存** |
| 输入模态 | text / image(png,jpeg,webp,heic,heif) / video / audio / PDF(document) |
| 输出模态 | **仅 text**（无图像/音频生成、无 Live API） |
| 能力 | function calling ✓、structured output ✓、search grounding ✓、URL context ✓、code execution ✓、agentic video understanding ✓ |
| 定价（至 2026-11-30） | 输入 **$2**/1M、输出 **$10**/1M、缓存读 **$0.10**/1M（Batch 约 -50%） |
| 定价（2026-12-01 起） | 输入 **$4**/1M、输出 **$20**/1M、缓存读 **$0.20**/1M（**×2**） |

> ⚠️ **思考 token 计入 `max_output_tokens`**。官方原文："Thinking tokens count toward max_output_tokens"——输出预算被思考吃满时，模型会返回空文本 + `finish_reason: MAX_TOKENS`，**这不是代理故障**。

### 1.2 ZCode 模型规则配置（实测可用）

ZCode 的模型级配置写在 `provider_config.json` 的 `modelConfigRules.providerModelRules[]`：

```jsonc
{
  "modelId": "gemini-4-argon",
  "providerId": "<你的 providerId>",
  "config": {
    "enabled": true,
    "properties": {
      "contextWindow": 1048576,          // ← 官方统一窗口 1,048,576
      "inputFormat": { "supportsImage": true, "supportsVideo": true },
      "supportsJsonSchemaOutput": true  // ← 官方 structured output ✓
    },
    "optionSpecs": {
      "reasoningLevel": { "values": ["low", "medium", "high"] },  // ← 官方 thinking_level 三档
      "maxOutputTokens": { "max": 65536 }                          // ← 官方流式单请求上限
    }
  }
}
```

取值理由（逐项对齐官方）：

| ZCode 字段 | 取值 | 官方依据 | 配错的后果 |
|---|---|---|---|
| `contextWindow` | `1048576` | 统一 1M 窗口 | 配成 128K 会让长上下文会话提前截断；配成 1,000,000（K 数）会低估 4.8% |
| `maxOutputTokens.max` | `65536` | 流式上限 65,536（非流式 32,768） | 配 256000 **超过官方流式上限**；配太小则思考吃光预算 → 空回复 |
| `reasoningLevel.values` | `low/medium/high` | 官方三档（medium 为默认） | 出现 `max`/`xhigh` 等非官方档位 → 网关按最高档处理，行为不可控且费 token |
| `supportsImage` / `supportsVideo` | `true` | 输入模态含 image/video | 配 `false` 则 ZCode 不允许上传图片/视频（多模态能力被废） |
| `supportsJsonSchemaOutput` | `true` | 官方支持 | 配 `false` 则结构化输出场景降级为文本解析 |

**不要配的**：`temperature` / `top_p` / `top_k`——官方明示忽略，配了只会误导。

---

## 2. 终态架构

```
┌──────────────────────────────┐
│ ZCode 3.17.1                 │
│ provider: OpenCode-OpenApi   │
│ api: openai-chat-completions │
│ baseUrl: http://127.0.0.1:   │
│         <端口>/v1             │  ← 指向本地代理，不是 opencode.ai
└──────────┬───────────────────┘
           │ POST /v1/chat/completions
           │ （带 ai-sdk 方言字段 max_completion_tokens + thinking 等）
┌──────────▼───────────────────┐
│ 本地代理（任选其一）          │
│  ① 独立脚本 examples/zcode-  │  ← §4.1（零依赖，拷贝即用）
│     opencode-go/              │
│  ② cc-linker img-proxy（可选）│  ← §4.2（我们内部在用）
│  职责：                      │
│   - 注入 x-opencode-session   │
│   - 归一化字段方言            │
│   - SSE 逐块透传、不设空闲超时│
└──────────┬───────────────────┘
           ▼
   https://opencode.ai/zen/go  →  Gemini 4 Argon
```

---

## 3. 为什么直连必死——三个结构性障碍（全部有证据）

### 障碍 ①：网关强制 `x-opencode-session`，ZCode 自定义 provider 永远带不上

**网关侧**（实测）：

| 请求 | 结果 |
|---|---|
| `POST /zen/go/v1/chat/completions` 不带 `x-opencode-session` | **400** `{"type":"error","error":{"type":"MissingSessionID",…}}` |
| 同上带该头 | **200** |
| `GET /zen/go/v1/models` 不带该头 | 200（**模型列表接口不查**，别用它判断连通性） |

**ZCode 侧**（`zcode.cjs` 反查 + 运行日志实证）：

- 注头逻辑存在：`isOpenCodeGoBaseUrl()` 判定 hostname=`opencode.ai` 且 path 精确=`/zen/go/v1` 时，在构造请求头时加入 `"x-opencode-session"`。
- **但它挂在 "provider runtime headers" 机制上**——该机制是**账号凭证刷新通道**，CLI 只会为 `account:` 开头的订阅型 provider 去 host 申请运行时请求头。
- 当天日志实证：**runtime-headers 交换 1768 次（当日快照计数，随会话持续增长；commit 时已 1782），providerId 全部是 `account:bigmodel-individual-coding-plan`，自定义 provider 0 次**。

结论：即便你把 baseUrl 写成完全正确的 `https://opencode.ai/zen/go/v1`，**自定义 api-key provider 也拿不到这个头**。

**症状（务必记住）**：面板/会话里发消息后转圈不止，按停止按钮才停；日志特征是
`ttft.phase attempt(≈1s) → ttft.phase retry_wait(1.2–9.0s) → attempt …` 的**退避重试循环**，且**全程无 HTTP 错误日志**（因为 400 被 SDK 吞成重试）。
当天三次直连尝试（17:42 / 17:45 / 17:58）全部 `outcome=cancelled`（用户手动停止），切到本地代理后同模型请求 `outcome=success`。

> 📌 排查口诀：**"卡死 + 无错误日志 + 有退避重试" = 缺 session 头**，不是网络慢。

### 障碍 ②：字段方言——网关只认 `max_tokens`

ZCode 用 Vercel AI SDK（provider-utils 4.0.x）发请求，字段名与 OpenAI 规范不同：**用 `max_completion_tokens`**（而非标准的 `max_tokens`）。
> 溯源：代理审计行 `dialect_changed` 的统计——**ZCode 形态请求（含 `drop thinking`）全部为 `max_completion_tokens->max_tokens`**（统计截至 2026-10-30 22:37，共 70+ 条并随使用增长）；`max_output_tokens` 只出现在 ai-sdk 的另一变体与手工复现请求里。归一化器对两种别名都无条件剥除，所以接入结论不受影响。

实测矩阵（同一 body，只改一个字段，其余不变）：

| 请求体差异 | 网关响应 |
|---|---|
| `"max_tokens": 1`（标准） | **200** |
| `"max_output_tokens": 1` | **503** `{"error":{"type":"server_error","message":"Upstream request failed: Endpoint is unavailable."}}` |
| `"max_completion_tokens": 1` | **503**（同上） |
| 标准 `max_tokens` + `"max_output_tokens"` **同时**在场 | 503（别名本身就是触发器，必须剥掉） |

### 障碍 ③：思考参数方言——三个字段各是一个独立的雷

ZCode 实发 body **四方言齐发**（下面这份是**代理改写后**的形态，`max_tokens` 已归一化；改写前的原始捕获为 321 字节，日志按 100 字符截断，尾部字段名以审计行为准）：

```json
{"model":"gemini-4-argon","messages":[…],"stream":true,"stream_options":{"include_usage":true},
 "thinking":{"type":"enabled"},      // Anthropic 方言
 "enable_thinking":true,             // vLLM / Qwen 方言
 "reasoning_effort":"low",           // OpenAI 标准 ✅ 唯一合法
 "reasoning":{"effort":"low"},       // 又一种对象方言
 "max_tokens":1}                     // ← 改写前此处是 max_completion_tokens（审计行证据）
```

> 审计行样例（代理日志）：`"dialect_changed":"max_completion_tokens->max_tokens,drop thinking,drop enable_thinking,drop reasoning"` —— 一行同时证明"ZCode 发了什么"与"代理做了什么"。

逐项隔离实测（每个字段单独加到基线 body 上）：

| 追加字段 | 结果 |
|---|---|
| `thinking:{"type":"enabled"}` | **503** |
| `enable_thinking:true` | **503** |
| `reasoning:{"effort":"low"}` | **503** |
| `reasoning_effort:"low"` | **200** ✅ |
| 三毒齐发 | **503** |

### 障碍 ④（附加）：长思考期的流式静默

Gemini 4 Argon 冷会话/深思考期**首字节实测最长 ~50s**（响应头与首个内容事件一起迟发；独立代理实测 20.5s）。
Bun.serve 默认 `idleTimeout=10s`、多数 HTTP 客户端默认 10 秒空闲即断连——长思考会话会被截断。

### 障碍 ⑤：ZCode 内置模板 provider 不可用

`opencode-go-chat`（providerName「OpenCode Go (Chat)」）看起来是官方模板，实测不可用：

- `provider_config.json` 中其 `api` 字段为 **null**（模板由后端下发，客户端本地无定义：`zcode.cjs` 与 `app.asar` 检索 `opencode-go` 零命中）；
- 当天日志中该 providerId 的真实请求记录 **0 条**；
- 其 `personalModelIds` 里虽然出现了 `gemini-4-argon`（ZCode 自动刷新），但请求不会由它发出。

> ⚠️ 陷阱：把 agent 的 model 行写成 `opencode-go-chat/gemini-4-argon` **不会明确报错**，可能静默回落到会话默认模型，让你误以为"模板能用"。

---

## 4. 本地代理方案

代理必须做三件事，正好对应 §3 的三个障碍：

| # | 职责 | 为什么 |
|---|---|---|
| A | 注入 `x-opencode-session` | ZCode 配置**没有**自定义 header 的字段（`customHeaders`/`extraHeaders` 在 `zcode.cjs` 中零命中），运行时也不允许自定义 provider 走 runtime-headers 通道 → 代理是唯一能补头的位置 |
| B | 归一化请求体字段方言 | 消除 503；且**只动顶层标量字段**，`messages`（含多模态图片 parts）必须原样透传 |
| C | SSE 逐块 flush + 不设空闲超时 | 深思考首字节 20–50s 不能被掐断 |

### 4.1 方案 A：独立脚本（推荐，不依赖 cc-linker）

完整套件在 **`examples/zcode-opencode-go/`**：

| 文件 | 用途 |
|---|---|
| `opencode_relay.py` | 代理本体（Python 3.8+，**零第三方依赖**） |
| `install-macos.sh` | macOS 安装：复制脚本 + 写 LaunchAgent（开机自启、崩溃拉起）+ 自检 |
| `uninstall-macos.sh` | 卸载（`--purge` 连文件与日志一起删） |
| `verify.sh` | 五项链路自检（每项带对照） |
| `README.md` | 该套件自己的说明（面向使用者） |

**三步安装**：

```bash
# 1) 安装（默认端口 8787；可传端口参数）
cd examples/zcode-opencode-go
bash install-macos.sh

# 2) 验证（需要你的 OpenCode Go key）
OPENCODE_API_KEY=<你的 key> bash verify.sh
#    期望 5 项全 PASS

# 3) ZCode 里改 Base URL → http://127.0.0.1:8787/v1（见 §5）
```

**Linux**：用 systemd unit（`ExecStart` 指向脚本、`Restart=always`）或 `nohup python3 opencode_relay.py --port 8787 &`。
**Windows**：`py -3 opencode_relay.py --port 8787`（需自行常驻或用 nssm 注册服务）。

代理参数：

```
--port 8787                 监听端口（仅 127.0.0.1）
--session <id>              x-opencode-session 的值（默认按主机名派生；固定值利于服务端 prompt 缓存）
--upstream-host opencode.ai
--upstream-prefix /zen/go
--timeout 600               上游读超时秒数（别调小：深思考首字节可达 50s）
--log-file <path>           额外落盘日志
```

**已实测（2026-10-30，独立脚本实例）**：

| 项 | 结果 |
|---|---|
| `GET /healthz` | 200 `{"status":"ok",…}` |
| `GET /v1`（裸路径，避免上游 404 HTML 干扰可达性判断） | 200 JSON |
| `GET /v1/models` | 200，28 个模型，含 `gemini-4-argon` |
| ZCode 四方言 body（`max_completion_tokens` + 三思考方言） | **200** |
| 标准 body（对照组） | 200 且内容正确 |
| 缺 `Authorization` | **401**（证明凭证确实透传给网关） |
| 深思考（`reasoning_effort=high`） | 首字节 20.5s、61 个 SSE 事件、思考内容可见、**未被掐断** |
| 工具调用 | 200，`tool_calls=[get_weather({"city":"Beijing"})]` |
| 多模态（1×1 红像素） | 200，模型答 `"Red"` |
| 8 路并发 | 8/8 全 200 且回显正确 |
| `install-macos.sh` → LaunchAgent → `verify.sh` | 5/5 PASS |
| `uninstall-macos.sh` | 正常停止并移除开机自启 |

### 4.2 方案 B：cc-linker img-proxy（可选，我们内部在用）

如果你已经在用 cc-linker，同等能力由它的"路由级能力"提供（本仓库 commit `30ec748`），要点：

1. **路由级 `inject_headers`**（`src/img-proxy/types.ts` / `routes.ts` / `server.ts`）：在请求头清理**之后**注入，同名头以路由表为准（客户端不可覆盖）；`host`/`content-length`/hop-by-hop 为禁入项（跳过并 WARN）；非法头值 try/catch（否则裸抛 500）。
2. **方言归一化器**（`src/img-proxy/openai-dialect.ts`）：与 §4.3 同一套规则，挂在 `request_transform: "openai-dialect-normalizer"`，只作用于 POST `…/chat/completions`，改写清单记入 INFO 日志的 `dialect_changed` 字段。
3. **idleTimeout 豁免面扩展**：`/\/(v1\/)?(messages|chat\/completions|responses)(\/|$|\?)/`（`v1/` 前缀可选，务必与改写分支口径一致）。

手工路由注册（`addRoute` 带锁写 `routes.json`）：

```ts
await addRoute(IMG_PROXY_ROUTES_PATH, 'opencode', 'https://opencode.ai/zen/go', '/manual/opencode', {
  inject_headers: { 'x-opencode-session': 'zcode-relay-<固定会话标识>' },
  request_transform: 'openai-dialect-normalizer',
});
```

此时 ZCode 的 baseUrl 为 `http://127.0.0.1:8765/opencode/v1`（**多一段 alias**，与独立脚本不同）。
细节见 `docs/img-proxy.md` 的"路由级能力"一节。

### 4.3 自建代理的等价最小实现（不抄脚本也能写）

任何本地代理（Python/Node/Go 均可）只要做到以下 4 条即可，**约 80 行代码**：

1. 监听回环地址，把 `/v1/*` 转发到 `https://opencode.ai/zen/go/v1/*`；
2. **注入** `x-opencode-session: <固定值>`（会话标识稳定，便于服务端路由与 prompt 缓存）；
3. 对 `POST …/chat/completions` 的 JSON body 做下面的字段归一化（解析失败则原样转发）；
4. **流式响应逐块 flush**（不要缓冲），且**不设置**响应空闲超时（长思考首字节可达 50s）。

**字段归一化的五条边界**（每条都是实战踩出来的，漏一条就 503 或吞参数）：

| 边界 | 原因 |
|---|---|
| 别名（`max_output_tokens`/`max_completion_tokens`）**无条件删除**，不只是"搬走" | 别名单独存在即 503；与标准字段并存也 503 |
| 值搬运**只做一次**且**不覆盖**标准字段 | 双别名场景第二个残留出体仍 503 |
| `max_tokens:null` 剔除**必须在搬运之前** | 否则 null"在场"阻断有效值搬运，`{"max_tokens":null,"max_completion_tokens":128}` 会把 128 吞掉 |
| 只动**顶层标量字段**，绝不碰 `messages` | 多模态 `image_url` parts 必须原样透传 |
| **fail-open** + **幂等** | 非 JSON / 数组 / 标量原字节透传；已是标准形态则不重序列化（字节级不变） |

---

## 5. ZCode 侧配置

### 5.1 配置文件与双写规则

| 文件 | 角色 | 注意 |
|---|---|---|
| `~/.zcode/v2/provider_config.json` | **权威**（后端 runtime 直接读，改完即时生效，含老会话） | 主改这里 |
| `~/.zcode/v2/config.json` | 镜像 / 回退层（app 内多处解析） | **保持双写**，镜像失败仅 WARN |

Provider 条目（`provider_config.json` → `config.providerConfigRules.providerRules[]`）：

```jsonc
{
  "providerId": "<你的 providerId>",
  "providerName": "OpenCode-OpenApi",
  "config": {
    "group": "standard-personal",
    "access": { "type": "api-key", "apiKey": "<OpenCode Go API Key>" },
    "api": {
      "type": "openai-chat-completions",
      "baseUrl": "http://127.0.0.1:8787/v1"   // ← 独立脚本；用 cc-linker 则为 http://127.0.0.1:8765/opencode/v1
    },
    "personalModelIds": ["gemini-4-argon"],
    "modelOrder": ["gemini-4-argon"]
  }
}
```

要点：
- `api.type` 必须是 `openai-chat-completions`（网关的 OpenAI 兼容端点）。
- 用 cc-linker 时 `baseUrl` 的**路径必须包含 alias 段**（`/opencode/v1`），否则代理的路由表匹配不到 alias → 502 "未知 provider alias"。
- 模型条目（§1.2）挂在**同一个 providerId** 下。
- 改前先备份：`provider_config.json.bak-<时间戳>`。

面板党也可以直接在"设置 → 模型供应商"里新建（接口类型选 OpenAI 兼容、Base URL 填代理地址、填 key、添加模型）。

### 5.2 agent 引用

```
model: "<providerId>/gemini-4-argon"
```

UUID 型 providerId 直接写（`custom:` 通道的 `%3A` 编码只针对 `builtin:`/`account:` 类 providerId）。

### 5.3 清理悬空规则（重要）

provider 被删除后，其**模型规则**可能残留（`providerModelRules` 里指向不存在的 providerId）。悬空规则会让模型选择器出现重复条目（同名模型出现在多个 provider 下，各带不同参数），排查时极易误判。

清理逻辑（按 provider 是否存在过滤）：

```python
live = {r['providerId'] for r in pc['config']['providerConfigRules']['providerRules']}
pc['config']['modelConfigRules']['providerModelRules'] = [
    m for m in pc['config']['modelConfigRules']['providerModelRules'] if m['providerId'] in live
]
```

---

## 6. 验证与验收清单

用独立脚本的话直接跑 `bash verify.sh`（5 项）；用 cc-linker 或手写代理则按下面的顺序做，**每步都要看到期望输出再进下一步**：

| # | 验证项 | 命令 / 操作 | 期望 |
|---|---|---|---|
| 1 | 代理存活 | `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/healthz` | `200` |
| 2 | 上游可达 + 头正确 | `curl -s -H "Authorization: Bearer $KEY" http://127.0.0.1:8787/v1/models` | `200`，28 个模型，含 `gemini-4-argon` |
| 3 | 代理确实补了头 | 同上加 `-H "x-opencode-session: whatever"` | 仍 `200`（说明代理注入的头生效，未被客户端覆盖） |
| 4 | 方言归一化生效 | 见下方可复制命令（四方言 body） | `200`（修复前必 `503`）——**必须带 `Authorization`**，否则网关回 401 `Go requires a credential` |
| 5 | 归一化审计 | `tail -3 ~/.zcode/opencode-relay/relay.log`（cc-linker：`~/.cc-linker/img-proxy/img-proxy.log`） | 独立脚本看 `REWRITE … changed=…`；cc-linker 看 `dialect_changed`；剥除清单齐全（`drop thinking`、`drop enable_thinking`、`drop reasoning`）；**别名前缀两形态任一皆可**（`max_output_tokens->max_tokens` 或 `max_completion_tokens->max_tokens`）——取决于 ZCode 侧 AI SDK 版本 |
| 6 | 端到端（面板） | ZCode 面板里对该模型点「测试」/ 发一句话 | 绿；代理日志 `UPSTREAM … -> 200` |
| 7 | 多模态 | 发一张图，问颜色 | 模型能描述图片内容（`image_url` parts 未被剥） |

**步骤 4 的可复制命令**（四方言 body，最易复现 503 的姿势）：

```bash
KEY="<OpenCode Go API Key>"
curl -sS -m 90 http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"gemini-4-argon","max_completion_tokens":50,"max_output_tokens":50,
       "thinking":{"type":"enabled"},"enable_thinking":true,
       "reasoning_effort":"low","reasoning":{"effort":"low"},
       "messages":[{"role":"user","content":"Reply with exactly: OK"}]}' \
  -w '\nHTTP %{http_code}\n'
# 期望：HTTP 200；修复前必 503
```

**判据的严谨性**（避免假绿）：

- 不要用"子代理回复了预期字符串"当连通性证据——**提示词里含期望串时，任何模型（含回落的默认模型）都会照抄**。可靠判据是 **代理日志里出现该请求且 `UPSTREAM … -> 200`**，或 ZCode 侧 `ttft` 记录里 `provider`/`model` 字段正确。
- 不要用 `GET /models` 的成功判断连通性——该接口**不校验** session 头。

---

## 7. 防踩坑清单（症状 → 根因 → 处置）

| 症状 | 根因 | 处置 |
|---|---|---|
| 会话发消息一直转圈，按停止才停；日志有 `retry_wait` 循环但无 HTTP 错误 | **缺 `x-opencode-session`**（直连 opencode.ai） | baseUrl 改指本地代理；见 §4 |
| 面板测试报"连接失败"，代理日志 `UPSTREAM … -> 503` | **字段方言**（`max_completion_tokens` / `max_output_tokens` / 三种思考方言任一） | 开字段归一化；见 §4.3 |
| 面板测试 503 且日志**没有**改写记录 | 改写分支没生效（路径不是 `…/completions`、或跑的不是归一化版本） | 确认 baseUrl 以 `/v1` 结尾、接口类型是 OpenAI 兼容 |
| 长思考会话中途断开 / "Connection closed mid-response" | 空闲超时 | 代理不设空闲超时；确认没有别的中间层 |
| 模型能回话但**内容为空**、`finish_reason: length` | **思考 token 吃光 `max_output_tokens`**（模型特性，非代理故障） | 提高输出上限（≤65536）；降低思考档位 |
| 模型选择器出现两个同名 Gemini、参数不同 | provider 已删但**模型规则残留** | 清理悬空 `providerModelRules`；见 §5.3 |
| 面板里找不到该 provider 的模型 / 提示不支持 | 挂到了**内置模板 provider**（`opencode-go-chat`） | 改挂自定义 provider；见 §3 障碍 ⑤ |
| 改完配置不生效 | 只改了 `config.json` 没改 `provider_config.json`（或反之） | **双写**；权威是 `provider_config.json` |
| 代理日志出现 `unresolved` 告警（cc-linker） | baseUrl 少了 alias 段 | baseUrl 必须是 `http://127.0.0.1:8765/<alias>/v1` |
| `uninstall --all` 之后路由也没了（cc-linker） | `--all` 是"清空全部"语义，**包含手工路由** | 重新注册 |
| 账单突然翻倍 | **2026-12-01** OpenCode Go 恢复原价（$4/$20） | 提前调整用量；注意 allowance 按未折价计费 |
| 多模态"图片看不见" | 若走 **Anthropic 协议**（`/v1/messages`），cc-linker 的剥图逻辑会把图片替换成 `[img: 路径]` 文本 | OpenCode 路径走 chat/completions 不受影响；若将来接 Anthropic 协议的多模态，需给路由加 `strip_images: false` 开关 |

---

## 8. 回滚手册

| 层 | 回滚动作 |
|---|---|
| ZCode provider 配置 | 恢复 `~/.zcode/v2/provider_config.json.bak-<ts>` 与 `config.json.bak-<ts>`（两份都要） |
| 独立代理 | `bash uninstall-macos.sh`（`--purge` 连文件一起删）；Linux/Windows 停掉对应进程/服务 |
| cc-linker 全局安装 | `cp /usr/local/lib/node_modules/cc-linker/dist/cli.js.bak-<ts> .../dist/cli.js` 后 `launchctl kickstart -k gui/$(id -u)/com.cclinker.img-proxy` |
| 路由表（cc-linker） | 手工路由直接 `addRoute` 重注册；或从 `~/.cc-linker/img-proxy/routes.json` 删对应 alias |
| 临时兜底 | 任何实现了 §4.3 四条的本地代理都能顶上 |

---

## 附录 A：实测矩阵（每行都有对照组）

### 网关与 ZCode 侧（2026-10-30）

| 场景 | 结果 | 对照 |
|---|---|---|
| 直连 `zen/go/v1`，不带 session 头 | 400 MissingSessionID | 带同头 → 200 |
| 直连 `zen/go/v1`（ZCode 真实会话） | 卡死 → cancelled（24.1s / 14.9s / 20.7s） | 经代理同模型 → success（6.8s / 7.2s / 13.0s） |
| `max_tokens` 标准字段 | 200 | 别名字段 → 503 |
| `reasoning_effort` | 200（low/high 均通过，high 回传 reasoning_tokens） | 三种思考方言 → 503 |
| 冷会话首字节 | 最长 ~50s（响应头与首内容一起） | → 必须豁免空闲超时 |
| 冷 28K token 载荷 | 首字节 5.5s（cache 读写均为 0） | 大载荷不必然慢 |
| 16KB system + 12 工具 | 首字节 8.1s | — |
| UA 换成 ZCode 原版 | 200（**网关不按 UA 拦截**） | — |
| temperature / top_p / stream_options | 兼容（官方明示采样参数被忽略） | — |
| 代理侧实测长流 | 82.6s / 110.2s 请求全 200 | 空闲豁免生效 |

### 独立代理（`examples/zcode-opencode-go/`，2026-10-30 实测）

| 项 | 结果 |
|---|---|
| `GET /healthz` / `GET /v1` | 200 / 200 JSON |
| `GET /v1/models` | 200，28 个模型，含 gemini-4-argon |
| 四方言 body（`max_completion_tokens` + 三思考方言） | 200 |
| 标准 body（对照组） | 200 且内容正确 |
| 缺 Authorization | 401 |
| 深思考 `reasoning_effort=high` | 首字节 20.5s、61 事件、思考可见、未被掐断 |
| 工具调用 | 200，`get_weather({"city":"Beijing"})` |
| 多模态（1×1 红像素） | 200，答 `"Red"` |
| 8 路并发 | 8/8 全 200 且回显正确 |
| 归一化边界自测 | 12/12 断言全过 |
| `install-macos.sh` → `verify.sh` | 5/5 PASS |
| `uninstall-macos.sh` | 正常停止并移除自启（过程中修掉 2 个脚本 bug：`$PORT` 未定义、plist 端口解析带 XML 标签） |

## 附录 B：证据索引

| 内容 | 位置 |
|---|---|
| **独立代理套件（主方案）** | `examples/zcode-opencode-go/`（`opencode_relay.py` + `install-macos.sh` + `uninstall-macos.sh` + `verify.sh` + `README.md`） |
| cc-linker 实现（可选方案） | `src/img-proxy/openai-dialect.ts`、`src/img-proxy/{types,routes,server}.ts`、`src/img-proxy/console/types.ts`、`src/cli/commands/img-proxy.ts`（commit `30ec748`） |
| cc-linker 路由注册 | `~/.cc-linker/img-proxy/routes.json`（alias=`opencode`） |
| 代理请求日志（改写审计） | cc-linker：`~/.cc-linker/img-proxy/img-proxy.log`（`dialect_changed`）；独立脚本：`~/.zcode/opencode-relay/relay.log`（`REWRITE … changed=`） |
| ZCode 实发 body 抓取（改写前 321 字节 / 改写后 310 字节） | `~/.zcode/logs/opencode-relay.log` |
| ZCode 权威 provider 配置 | `~/.zcode/v2/provider_config.json`（镜像 `config.json`） |
| ZCode 运行日志（ttft/重试特征） | `~/.zcode/v2/logs/2026-10-30.log` |
| 官方模型规格 | Google《What's new in Gemini 4 Argon》/ Vertex AI 模型页；OpenCode `GET /inference/go/v1/models` |
| 网关行为 | OpenCode Go 文档 `opencode.ai/v2/docs/console/go/`（"Where can I use it" 一节要求 session 头与专用 UA） |
| 审查报告（实现链四份 + 文档三轮） | `~/.zcode/review-reports/cc-linker-opencode-route-*.md`、`~/.zcode/review-reports/cc-linker-doc-zcode-opencode-*.md` |
