# ZCode 接入 OpenCode Go 的 Gemini 4 Argon —— 完整实操方案

> 适用范围：ZCode 桌面端 3.17.1 + OpenCode Go（`opencode.ai/zen/go`）+ Gemini 4 Argon。
> 文中所有"实测"数据均来自 2026-10-30 当天的逐项对照实验（含对照组），证据可复现。
> 配套实现：本仓库 `cc-linker` 的 img-proxy 路由级能力（commit `30ec748`）。

---

## 0. 结论速览

| 问题 | 结论 |
|---|---|
| 能不能直连 `https://opencode.ai/zen/go/v1`？ | **不能**。ZCode 3.17.1 的自定义 api-key provider 永远拿不到网关强制的 `x-opencode-session` 头 → 400 → 退避重试 → **会话卡死** |
| 本地代理是可选优化还是必须？ | **必须**。不是"保险"，是唯一可行路径（证据见 §3） |
| 用 ZCode 内置模板 provider（`opencode-go-chat`）行不行？ | **不行**。模板由后端下发，本机 `api` 为 `null`、客户端无定义、日志零调用 |
| Gemini 4 Argon 的 ZCode 配置怎么填？ | 1M 上下文 / 65,536 输出上限 / 思考档位 low·medium·high / 图+视频输入 / 结构化输出（官方规格逐项对齐，见 §2） |
| 最容易踩的坑 | ① 直连卡死 ② 输出上限设太小被思考 token 吃光 ③ 字段方言导致 503 ④ 12-01 价格翻倍 |

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
| `maxOutputTokens.max` | `65536` | 流式上限 65,536 | 配 256000（OpenCode 目录里 `opencode-go-chat` 模板给的值）**超过官方流式上限**；配太小则思考吃光预算 → 空回复 |
| `reasoningLevel.values` | `low/medium/high` | 官方三档 | 出现 `max`/`xhigh` 等非官方档位 → 网关按最高档处理，行为不可控且费 token |
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
│ baseUrl:                     │
│  http://127.0.0.1:8765/      │
│       opencode/v1            │   ← 关键：指向本地代理，不是 opencode.ai
└──────────┬───────────────────┘
           │ HTTP POST /opencode/v1/chat/completions
           │ （带 ai-sdk 方言字段 max_completion_tokens + thinking 等）
┌──────────▼───────────────────┐
│ cc-linker img-proxy :8765    │
│ 路由表 ~/.cc-linker/routes.json
│   alias=opencode             │
│   upstream=opencode.ai/zen/go│
│   inject_headers:            │
│     x-opencode-session: …    │  ← ①补上网关强制的头
│   request_transform:         │
│     openai-dialect-normalizer│  ← ②归一化字段方言
│  + idleTimeout 豁免          │  ← ③长流不被 10s 掐断
└──────────┬───────────────────┘
           │
           ▼
   https://opencode.ai/zen/go  →  Gemini 4 Argon
```

好处：一次改造，**整条 OpenCode Go 通道都活了**（gemini-4-argon / glm-5.3-flash / deepseek-v4.1-flash / mimo 系列），并且白拿 cc-linker 的按 alias token 计量、SSE 透传、client 断开即取消上游、日志轮转、Web Console。

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
- 当天日志实证：**runtime-headers 交换 1768 次，providerId 全部是 `account:bigmodel-individual-coding-plan`，自定义 provider 0 次**。

结论：即便你把 baseUrl 写成完全正确的 `https://opencode.ai/zen/go/v1`，**自定义 api-key provider 也拿不到这个头**。

**症状（务必记住）**：面板/会话里发消息后转圈不止，按停止按钮才停；日志特征是
`ttft.phase attempt(≈1s) → ttft.phase retry_wait(≈6s) → attempt …` 的**退避重试循环**，且**全程无 HTTP 错误日志**（因为 400 被 SDK 吞成重试）。
当天三次直连尝试（17:42 / 17:45 / 17:58）全部 `outcome=cancelled`（用户手动停止），切到本地代理后同模型请求 `outcome=success`。

> 📌 排查口诀：**"卡死 + 无错误日志 + 有退避重试" = 缺 session 头**，不是网络慢。

### 障碍 ②：字段方言——网关只认 `max_tokens`

ZCode 用 Vercel AI SDK（provider-utils 4.0.x）发请求，字段名与 OpenAI 规范不同，且**随版本变化**（当天两种都出现过：18:26 捕获的是 `max_output_tokens`，22:21 捕获的是 `max_completion_tokens`）。

实测矩阵（同一 body，只改一个字段，其余不变）：

| 请求体差异 | 网关响应 |
|---|---|
| `"max_tokens": 1`（标准） | **200** |
| `"max_output_tokens": 1` | **503** `{"error":{"type":"server_error","message":"Upstream request failed: Endpoint is unavailable."}}` |
| `"max_completion_tokens": 1` | **503**（同上） |
| 标准 `max_tokens` + `"max_output_tokens"` **同时**在场 | 503（别名本身就是触发器，必须剥掉） |

### 障碍 ③：思考参数方言——三个字段各是一个独立的雷

ZCode 实发 body（当天实录，310 字节）**四方言齐发**：

```json
{"model":"gemini-4-argon","messages":[…],"stream":true,"stream_options":{"include_usage":true},
 "thinking":{"type":"enabled"},      // Anthropic 方言
 "enable_thinking":true,             // vLLM / Qwen 方言
 "reasoning_effort":"low",           // OpenAI 标准 ✅ 唯一合法
 "reasoning":{"effort":"low"},       // 又一种对象方言
 "max_output_tokens":1}
```

逐项隔离实测（每个字段单独加到基线 body 上）：

| 追加字段 | 结果 |
|---|---|
| `thinking:{"type":"enabled"}` | **503** |
| `enable_thinking:true` | **503** |
| `reasoning:{"effort":"low"}` | **503** |
| `reasoning_effort:"low"` | **200** ✅ |
| 三毒齐发 | **503** |

### 障碍 ④（附加）：Bun 默认 10s idleTimeout 会掐断长思考流

Gemini 4 Argon 冷会话/深思考期**首字节实测最长 ~50s**（响应头与首个内容事件一起迟发）。
Bun.serve 默认 `idleTimeout=10s`——流式响应静默超 10s 即断连。ZCode 原本只对 `POST /v1/messages` 豁免，**chat/completions 路径不豁免** → 长思考会话会被截断。

### 障碍 ⑤：ZCode 内置模板 provider 不可用

`opencode-go-chat`（providerName「OpenCode Go (Chat)」）看起来是官方模板，实测不可用：

- `provider_config.json` 中其 `api` 字段为 **null**（模板由后端下发，客户端本地无定义：`zcode.cjs` 与 `app.asar` 检索 `opencode-go` 零命中）；
- 当天日志中该 providerId 的真实请求记录 **0 条**；
- 其 `personalModelIds` 里虽然出现了 `gemini-4-argon`（ZCode 自动刷新），但请求不会由它发出。

> ⚠️ 陷阱：把 agent 的 model 行写成 `opencode-go-chat/gemini-4-argon` **不会明确报错**，可能静默回落到会话默认模型，让你误以为"模板能用"。

---

## 4. 本地代理必须做的三件事（cc-linker 实现清单）

### 4.1 改动一：路由级 `inject_headers`（补 session 头）

**为什么必须放在代理层**：ZCode 配置里**没有**自定义 header 的字段（`customHeaders` / `extraHeaders` 在 `zcode.cjs` 中均零命中），运行时也不允许自定义 provider 走 runtime-headers 通道。代理是唯一能补头的位置。

**a) 类型**（`src/img-proxy/types.ts`）：

```ts
export interface RouteEntry {
  // …既有字段…
  /** 转发上游时附加的请求头(在 sanitizeProxyRequestHeaders 之后注入,
   *  同名头以路由表为准 —— 客户端无法覆盖/剥除) */
  inject_headers?: Record<string, string>;
  /** 命名请求体改写器。目前仅 'openai-dialect-normalizer' */
  request_transform?: 'openai-dialect-normalizer';
}
```

**b) 路由读取**（`src/img-proxy/routes.ts`）：新增 `getRouteByAlias()` 返回完整 entry，`getUpstreamByAlias()` 委托它（行为不变，含 `disabled → null` 语义）；`addRoute()` 增加可选 `opts`，**重跑 install 不带 opts 时保留已有选项**（与 `disabled` 保留语义一致，防止静默丢掉手工配置）。

**c) 注入点**（`src/img-proxy/server.ts`）——必须**在请求头清理之后**注入：

```ts
const headers = sanitizeProxyRequestHeaders(req.headers);
if (route?.inject_headers) {
  for (const [k, v] of Object.entries(route.inject_headers)) {
    const lk = k.toLowerCase();
    if (lk === 'host' || lk === 'content-length' || HOP_BY_HOP_HEADERS.includes(lk)) {
      appendLog(`WARN inject_headers 跳过禁入头 ${k} (alias=${alias})`, logPath);
      continue;
    }
    try { headers.set(k, String(v)); }
    catch (err) { appendLog(`WARN inject_headers 跳过非法头 ${k}: ${(err as Error).message} (alias=${alias})`, logPath); }
  }
}
```

三条加固要点：
1. **禁入头守卫**：`host` / `content-length` / hop-by-hop 头不能经此通道重新注入（`content-length` 与 fetch 自算值冲突 → 502；hop-by-hop 与传输层冲突）。
2. **非法头值 try/catch**：`Headers.set` 遇到非 Latin-1 值（如中文、macOS 弯引号）会抛 `TypeError`，裸抛会变成**无日志无统计的 500**。
3. **客户端不可覆盖**：注入发生在 sanitize 之后，同名头以路由表为准。

### 4.2 改动二：OpenAI 方言归一化器（新文件 `src/img-proxy/openai-dialect.ts`）

```ts
export function normalizeOpenAIDialectBody(raw: Uint8Array): DialectNormalizeResult {
  // fail-open：非 JSON / 数组 / 标量 → 原字节透传，绝不阻塞转发
  const o = JSON.parse(text);
  // 1) 先剔 max_tokens:null —— 必须在别名搬运之前
  //    （否则 {max_tokens:null, max_output_tokens:128} 会吞掉 128）
  if ('max_tokens' in o && o.max_tokens === null) { delete o.max_tokens; changed.push('drop max_tokens:null'); }
  // 2) 别名全剥 + 值单次搬运（标准字段缺席且值非 null 时）
  let moved = false;
  for (const src of ['max_output_tokens', 'max_completion_tokens']) {
    if (src in o) {
      const v = o[src];
      if (!moved && !('max_tokens' in o) && v !== null && v !== undefined) {
        o.max_tokens = v; moved = true; changed.push(`${src}->max_tokens`);
      } else { changed.push(`drop ${src}`); }
      delete o[src];   // ← 别名必须无条件删除，它本身就是 503 触发器
    }
  }
  // 3) 剥思考方言，保留 reasoning_effort
  for (const bad of ['thinking', 'enable_thinking', 'reasoning']) {
    if (bad in o) { delete o[bad]; changed.push(`drop ${bad}`); }
  }
  if (changed.length === 0) return { body: raw, changed: [] };  // 幂等：不重序列化
  return { body: new TextEncoder().encode(JSON.stringify(o)), changed };
}
```

**五个必须遵守的边界**（每一条都是实战踩出来的）：

| 边界 | 原因 |
|---|---|
| 别名**无条件删除**，不只是"搬走" | `max_output_tokens` 单独存在即 503；与标准字段并存也 503 |
| 值搬运**只做一次**且**不覆盖**标准字段 | 双别名场景第二个残留出体仍 503（首审 P1-1） |
| `max_tokens:null` 剔除**必须在搬运之前** | 否则 null"在场"阻断有效值搬运（K3 P2-1） |
| 只动**顶层标量字段**，绝不碰 `messages` | 多模态 `image_url` parts 必须原样透传 |
| **fail-open** + **幂等** | 非 JSON 原字节透传；已是标准形态则不重序列化（保持字节级不变） |

**接入点**（`server.ts`）：与既有剥图分支**互斥**（`else if`），且只作用于 `POST …/chat/completions`：

```ts
const isChatCompletionsPost = req.method === 'POST' && /\/chat\/completions(\/|$|\?)/.test(url.pathname);
…
} else if (route?.request_transform === 'openai-dialect-normalizer' && isChatCompletionsPost) {
  const rawBytes = new Uint8Array(await req.arrayBuffer());
  const r = normalizeOpenAIDialectBody(rawBytes);
  outBody = new Uint8Array(r.body);
  dialectChanged = r.changed;
}
```

> 故意**不覆盖** `/v1/responses`：Responses API 里 `max_output_tokens` 本就是原生字段名，套用 chat 归一化反而改错。

### 4.3 改动三：流式 POST 的 idleTimeout 豁免面扩展

```ts
// 原：仅 /v1/messages
const isStreamApiPost = req.method === 'POST'
  && /\/(v1\/)?(messages|chat\/completions|responses)(\/|$|\?)/.test(url.pathname);
if (isStreamApiPost) server.timeout(req, 0);   // 0 = 禁用此请求的 idle timeout
```

要点：
- `v1/` 前缀**可选**——必须与 `isChatCompletionsPost` 的口径一致，否则 upstream 自带版本前缀时豁免漏网（K3 P2-2）。
- 这是**对所有路由生效的全局行为改进**（此前非 messages 路径的长思考流会被 10s 掐断），不是 opt-in。

### 4.4 手工路由注册

`img-proxy install` 是面向 Anthropic provider 的发现流程；OpenCode 这种手工路由用库函数写一次即可（带 proper-lockfile 锁）：

```ts
import { addRoute } from '/path/to/cc-linker/src/img-proxy/routes';
import { IMG_PROXY_ROUTES_PATH } from '/path/to/cc-linker/src/utils/paths';

await addRoute(IMG_PROXY_ROUTES_PATH, 'opencode', 'https://opencode.ai/zen/go', '/manual/opencode', {
  inject_headers: { 'x-opencode-session': 'zcode-relay-<固定会话标识>' },
  request_transform: 'openai-dialect-normalizer',
});
```

落盘形态（`~/.cc-linker/routes.json`）：

```json
{"version":1,"routes":{"opencode":{
  "alias":"opencode","upstream":"https://opencode.ai/zen/go",
  "provider_path":"/manual/opencode","original_base_url":"https://opencode.ai/zen/go",
  "installed_at":"2026-10-30T…",
  "inject_headers":{"x-opencode-session":"zcode-relay-<主机名>"},
  "request_transform":"openai-dialect-normalizer"}}}
```

配套：`img-proxy update` 的**孤儿路由扫描**要跳过 `/manual/` 虚拟路径（手工路由本就不指向磁盘文件，不是 cc-switch 残留）。

### 4.5 如果不用 cc-linker：自建代理的等价最小实现

任何本地代理（Python/Node）只要做到以下 4 条即可，**约 80 行代码**：

1. 监听回环地址，把 `/v1/*` 转发到 `https://opencode.ai/zen/go/v1/*`；
2. **注入** `x-opencode-session: <固定值>`（会话标识稳定，便于服务端路由与 prompt 缓存）；
3. 对 `POST …/chat/completions` 的 JSON body 做 §4.2 的字段归一化（解析失败则原样转发）；
4. **流式响应逐块 flush**（不要缓冲），且**不设置**响应超时（长思考首字节可达 50s+）。

cc-linker 的优势是这些之外还白拿：SSE 透传与 client 断开即取消上游、按 alias 的 token 计量、请求头/缓存目录清理、日志轮转、Web Console、可观测的 `dialect_changed` 审计。

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
      "baseUrl": "http://127.0.0.1:8765/opencode/v1"   // ← 指向本地代理；alias 段与 routes.json 的 alias 对应
    },
    "personalModelIds": ["gemini-4-argon"],
    "modelOrder": ["gemini-4-argon"]
  }
}
```

要点：
- `api.type` 必须是 `openai-chat-completions`（网关的 OpenAI 兼容端点）。
- `baseUrl` 的**路径必须包含 alias 段**（`/opencode/v1`），否则代理的路由表匹配不到 alias → 502 "未知 provider alias"。
- 模型条目（§1.2）挂在**同一个 providerId** 下。
- 改前先备份：`provider_config.json.bak-<时间戳>`。

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

按顺序做，**每步都要看到期望输出再进下一步**：

| # | 验证项 | 命令 / 操作 | 期望 |
|---|---|---|---|
| 1 | 代理存活 | `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8765/` | `200`（console 首页） |
| 2 | 上游可达 + 头正确 | `curl -s -H "Authorization: Bearer $KEY" http://127.0.0.1:8765/opencode/v1/models` | `200`，28 个模型，含 `gemini-4-argon` |
| 3 | 代理确实补了头 | 同上加 `-H "x-opencode-session: whatever"` | 仍 `200`（说明路由表的头生效，未被客户端覆盖） |
| 4 | 方言归一化生效 | 用**四方言 body**（`thinking`/`enable_thinking`/`reasoning`/`max_output_tokens`）打 `/opencode/v1/chat/completions` | `200`（修复前必 `503`） |
| 5 | 归一化审计 | `tail -3 ~/.cc-linker/img-proxy/img-proxy.log` | 含 `"dialect_changed":"max_output_tokens->max_tokens,drop thinking,drop enable_thinking,drop reasoning"` |
| 6 | 端到端（面板） | ZCode 面板里对该模型点「测试」/ 发一句话 | 绿；日志 `upstream_status:200` |
| 7 | 多模态 | 发一张图，问颜色 | 模型能描述图片内容（`image_url` parts 未被剥） |

**判据的严谨性**（避免假绿）：

- 不要用"子代理回复了预期字符串"当连通性证据——**提示词里含期望串时，任何模型（含回落的默认模型）都会照抄**。可靠判据是 **代理日志里出现该请求且 `upstream_status=200`**，或 ZCode 侧 `ttft` 记录里 `provider`/`model` 字段正确。
- 不要用 `GET /models` 的成功判断连通性——该接口**不校验** session 头。

---

## 7. 防踩坑清单（症状 → 根因 → 处置）

| 症状 | 根因 | 处置 |
|---|---|---|
| 会话发消息一直转圈，按停止才停；日志有 `retry_wait` 循环但无 HTTP 错误 | **缺 `x-opencode-session`**（直连 opencode.ai） | baseUrl 改指本地代理；见 §4.1 |
| 面板测试报"连接失败"，代理日志 `upstream_status=503` | **字段方言**（`max_output_tokens` / `max_completion_tokens` / 三种思考方言任一） | 开 `request_transform`；见 §4.2 |
| 面板测试 503 且日志 `dialect_changed` 为空 | 改写器没挂上路由 | 检查 `routes.json` 里该 alias 的 `request_transform` 字段；重装 install 注意保留 opts |
| 长思考会话中途断开 / "Connection closed mid-response" | **10s idleTimeout** | 扩豁免面；见 §4.3 |
| 模型能回话但**内容为空**、`finish_reason: length` | **思考 token 吃光 `max_output_tokens`**（模型特性，非代理故障） | 提高输出上限（≤65536）；降低思考档位 |
| 模型选择器出现两个同名 Gemini、参数不同 | provider 已删但**模型规则残留** | 清理悬空 `providerModelRules`；见 §5.3 |
| 面板里找不到该 provider 的模型 / 提示不支持 | 挂到了**内置模板 provider**（`opencode-go-chat`） | 改挂自定义 provider；见 §3 障碍 ⑤ |
| 改完配置不生效 | 只改了 `config.json` 没改 `provider_config.json`（或反之） | **双写**；权威是 `provider_config.json` |
| 代理日志出现 `unresolved` 告警 | baseUrl 少了 alias 段 | baseUrl 必须是 `http://127.0.0.1:8765/<alias>/v1` |
| `uninstall --all` 之后 OpenCode 路由也没了 | `--all` 是"清空全部"语义，**包含手工路由** | 重新 `addRoute` 注册 |
| 账单突然翻倍 | **2026-12-01** OpenCode Go 恢复原价（$4/$20） | 提前调整用量；注意 allowance 按未折价计费 |
| 多模态"图片看不见" | 若走 **Anthropic 协议**（`/v1/messages`），cc-linker 的剥图逻辑会把图片替换成 `[img: 路径]` 文本 | OpenCode 路径走 chat/completions 不受影响；若将来接 Anthropic 协议的多模态，需给 RouteEntry 加 `strip_images: false` 开关 |

---

## 8. 回滚手册

| 层 | 回滚动作 |
|---|---|
| ZCode provider 配置 | 恢复 `~/.zcode/v2/provider_config.json.bak-<ts>` 与 `config.json.bak-<ts>`（两份都要） |
| cc-linker 全局安装 | `cp /usr/local/lib/node_modules/cc-linker/dist/cli.js.bak-<ts> .../dist/cli.js` 后 `launchctl kickstart -k gui/$(id -u)/com.cclinker.img-proxy` |
| 路由表 | 手工路由直接 `addRoute` 重注册；或从 `routes.json` 删对应 alias |
| 临时兜底（不想用 cc-linker） | 用任意本地代理实现 §4.5 的 4 条；或直接用 `opencode.ai` 的其他兼容入口（需自行解决 session 头） |

---

## 附录 A：当天实测矩阵（每行都有对照组）

| 场景 | 结果 | 对照 |
|---|---|---|
| 直连 `zen/go/v1`，不带 session 头 | 400 MissingSessionID | 带同头 → 200 |
| 直连 `zen/go/v1`（ZCode 真实会话） | 卡死 → cancelled（24.1s / 14.9s / 20.7s） | 经代理同模型 → success（6.8s / 7.2s / 13.0s） |
| `max_tokens` 标准字段 | 200 | 别名字段 → 503 |
| `reasoning_effort` | 200（low/high 均通过，high 回传 reasoning_tokens） | 三种思考方言 → 503 |
| 冷会话首字节 | 最长 ~50s（响应头与首内容一起） | → 必须豁免 idleTimeout |
| 冷 28K token 载荷 | 首字节 5.5s（cache 读写均为 0） | 大载荷不必然慢 |
| 冷 40K token 载荷 | 预填 5.5s | — |
| 16KB system + 12 工具 | 首字节 8.1s | — |
| UA 换成 ZCode 原版 | 200（**网关不按 UA 拦截**） | — |
| temperature / top_p / stream_options | 兼容（官方明示采样参数被忽略） | — |
| 多模态（1×1 红像素） | 200，模型答 "Red" | — |
| 代理侧实测长流 | 82.6s / 110.2s 请求全 200 | idleTimeout 豁免生效 |

## 附录 B：证据索引

| 内容 | 位置 |
|---|---|
| 代理实现（本次新增） | `src/img-proxy/openai-dialect.ts`、`src/img-proxy/{types,routes,server}.ts`、`src/img-proxy/console/types.ts`、`src/cli/commands/img-proxy.ts` |
| 实现 commit | `30ec748`（分支 `multi-model-review-engine-final`） |
| 单测 / 集成测试 | `tests/unit/img-proxy/{openai-dialect,routes-options}.test.ts`、`tests/integration/img-proxy-route-options.test.ts` |
| 路由注册 | `~/.cc-linker/routes.json`（alias=`opencode`） |
| 代理请求日志（含 `dialect_changed` 审计） | `~/.cc-linker/img-proxy/img-proxy.log` |
| ZCode 权威 provider 配置 | `~/.zcode/v2/provider_config.json` |
| ZCode 运行日志（ttft/重试特征） | `~/.zcode/v2/logs/2026-10-30.log` |
| 官方模型规格 | Google《What's new in Gemini 4 Argon》/ Vertex AI 模型页；OpenCode `GET /inference/go/v1/models` |
| 网关行为 | OpenCode Go 文档 `opencode.ai/v2/docs/console/go/`（"Where can I use it" 一节要求 session 头与专用 UA） |
| 审查报告（首审/修复审/K3/delta 四份） | `~/.zcode/review-reports/cc-linker-opencode-route-*.md` |
