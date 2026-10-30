# ZCode 接入 OpenCode Go 的 Gemini 4 Argon —— 独立方案（不依赖 cc-linker）

> 本目录是**自包含交付物**：一个零依赖的本地代理 + 安装/卸载/验证脚本。
> 不需要 cc-linker，不需要任何 Python 包（仅标准库）。
>
> 适用：ZCode 桌面端 3.17.1 + OpenCode Go（`opencode.ai/zen/go`）+ Gemini 4 Argon。
> 文中"实测"数据来自 2026-10-30 的逐项对照实验（每条都有对照组）。

---

## 0. 三十秒结论

| 问题 | 答案 |
|---|---|
| 能不能把 ZCode 的 Base URL 直接填 `https://opencode.ai/zen/go/v1`？ | **不能**。会话会表现为"发消息一直转圈、只能手动停止"。原因见 §1 |
| 要装什么？ | 一个本地代理（本目录 `opencode_relay.py`，Python 标准库）+ ZCode 里改一个 Base URL |
| 装完长什么样？ | `ZCode → http://127.0.0.1:8787/v1 →（代理补头 + 改字段）→ opencode.ai/zen/go → Gemini 4 Argon` |
| 装完要改 ZCode 哪里？ | 供应商 Base URL 指向 `http://127.0.0.1:8787/v1`；添加模型 `gemini-4-argon`（配置见 §4） |
| 怎么确认成功？ | `bash verify.sh` 五项全绿，再去 ZCode 面板点「测试」 |

---

## 1. 为什么必须过一层本地代理

OpenCode Go 网关对**对话端点**有两道硬性要求，而 ZCode 的"自定义 API-Key 供应商"路径两条都过不去。

### 障碍 A：网关强制 `x-opencode-session` 头

实测（2026-10-30）：

| 请求 | 结果 |
|---|---|
| `POST /zen/go/v1/chat/completions` **不带**该头 | **400** `{"type":"error","error":{"type":"MissingSessionID",…}}` |
| 同上，**带**该头 | **200** |
| `GET /zen/go/v1/models` 不带该头 | 200（**模型列表接口不校验**，别用它判断连通性） |

ZCode 侧：注头逻辑确实存在，但挂在**账号凭证刷新**通道上——只为 `account:` 开头的订阅型供应商生效。
当天日志实证：**运行时请求头交换 1768 次（当日快照计数），供应商全部是订阅型，自定义供应商 0 次**。

所以即使你把 Base URL 填得完全正确，自定义供应商也**永远拿不到这个头**。

**症状（务必记住）**：发消息后一直转圈，按停止才停；日志里是
`attempt(≈1s) → retry_wait(1.2–9.0s) → attempt …` 的**退避重试循环**，且**全程没有 HTTP 错误日志**（400 被 SDK 吞成了重试）。
> 排查口诀：**"卡死 + 无错误日志 + 有退避重试" = 缺 session 头**，不是网络慢。

### 障碍 B：网关只认标准字段名

ZCode 用 Vercel AI SDK 发请求，字段名与 OpenAI 规范不同。逐项实测（同一 body 只改一个字段）：

| 字段 | 网关响应 |
|---|---|
| `"max_tokens": 1`（标准） | **200** |
| `"max_completion_tokens": 1` | **503** `Endpoint is unavailable` |
| `"max_output_tokens": 1` | **503** |
| `"reasoning_effort": "low"` | **200** ✅ 唯一受支持的思考档位字段 |
| `"thinking": {"type":"enabled"}` | **503** |
| `"enable_thinking": true` | **503** |
| `"reasoning": {"effort":"low"}` | **503** |

ZCode 实发 body 里这些方言**同时在场**（审计行样例）：

```
"dialect_changed":"max_completion_tokens->max_tokens,drop thinking,drop enable_thinking,drop reasoning"
```

### 障碍 C（附加）：长思考期的流式静默

Gemini 4 Argon 深思考期**首字节实测可达 20–50 秒**（实测 20.5s / 49.4s）。一些 HTTP 客户端默认 10 秒空闲即断连，会把长思考会话拦腰截断。本代理**不设空闲超时**并逐块 flush SSE。

---

## 2. 代理做了什么（三个动作，对应三个障碍）

`opencode_relay.py`（约 320 行，含注释；零依赖）：

| 动作 | 对应 | 实现要点 |
|---|---|---|
| **A. 注入 `x-opencode-session`** | 障碍 A | 值默认按主机名派生并**保持固定**（固定值便于服务端路由与 prompt 缓存）；`--session` 可自定义 |
| **B. 字段方言归一化** | 障碍 B | 只动**顶层标量字段**，`messages` 原样透传（多模态图片 parts 必须完整送达） |
| **C. 逐块 flush 的 SSE 透传 + 无空闲超时** | 障碍 C | 深思考 20–50s 首字节不掐断；客户端断开即释放上游连接 |

### B 的五条边界（每条都是踩出来的，改代码前先读）

1. **别名字段无条件删除**——`max_completion_tokens` / `max_output_tokens` 单独存在即 503；与标准字段并存也 503。
2. **值只搬一次**——双别名同时在场时，第二个必须**也剥掉**（只搬不剥 = 仍然 503）。
3. **`max_tokens: null` 要先剔**——否则 `{"max_tokens":null,"max_completion_tokens":128}` 会把 128 吞掉。
4. **只动顶层标量字段**——绝不碰 `messages`（多模态 `image_url` parts 必须原样送达）。
5. **fail-open + 幂等**——非 JSON / 数组 / 标量 body 原字节透传；已是标准形态则不重序列化。

另有：剥除清单会写进日志（`REWRITE … changed=…`），便于事后审计"ZCode 发了什么 → 代理改成了什么"。

---

## 3. 安装（macOS）

```bash
cd examples/zcode-opencode-go
bash install-macos.sh          # 默认端口 8787；也可：bash install-macos.sh 8899
```

安装脚本会：复制脚本到 `~/.zcode/opencode-relay/` → 写 LaunchAgent（开机自启 + 崩溃自动拉起）→ 启动 → 自检 `/healthz` → 打印下一步。

**Linux**：用 systemd unit（把 `ExecStart` 指向脚本、`Restart=always`）或 `nohup python3 opencode_relay.py --port 8787 &`。
**Windows**：`py -3 opencode_relay.py --port 8787`（需自行常驻，或用 nssm 注册为服务）。

**卸载**：`bash uninstall-macos.sh`（加 `--purge` 连文件与日志一起删）。
> ⚠️ 卸载后，ZCode 里指向本代理的供应商会立刻不可用——直连 opencode.ai 就是 §1 那个"卡死"。

---

## 4. ZCode 侧配置

### 4.1 供应商

设置 → 模型供应商 → 新增：

| 字段 | 值 |
|---|---|
| 名称 | `OpenCode-OpenApi`（随意） |
| 接口类型 / API 类型 | **OpenAI 兼容**（`openai-chat-completions`） |
| Base URL | `http://127.0.0.1:8787/v1` ← **指向本地代理，不是 opencode.ai** |
| API Key | 你的 OpenCode Go key（opencode.ai Console 获取） |

> 想要**面板里能直接编辑配置文件**的用户，也可以直接改 `~/.zcode/v2/provider_config.json`：
> 这是 ZCode 的**权威**配置（后端运行时直接读，改完即时生效）；
> `~/.zcode/v2/config.json` 是镜像/回退层，**两者保持一致**（只改其一会不生效或被覆写）。
> 改前先备份：
> ```bash
> cp ~/.zcode/v2/provider_config.json ~/.zcode/v2/provider_config.json.bak-$(date +%Y%m%d-%H%M%S)
> cp ~/.zcode/v2/config.json       ~/.zcode/v2/config.json.bak-$(date +%Y%m%d-%H%M%S)
> ```
> provider 条目形如：
> ```jsonc
> {
>   "providerId": "<你的 id>",
>   "providerName": "OpenCode-OpenApi",
>   "config": {
>     "group": "standard-personal",
>     "access": { "type": "api-key", "apiKey": "<OpenCode Go key>" },
>     "api": { "type": "openai-chat-completions", "baseUrl": "http://127.0.0.1:8787/v1" },
>     "personalModelIds": ["gemini-4-argon"],
>     "modelOrder": ["gemini-4-argon"]
>   }
> }
> ```

### 4.2 模型规则（`provider_config.json` → `config.modelConfigRules.providerModelRules[]`）

```jsonc
{
  "modelId": "gemini-4-argon",
  "providerId": "<与上面同一个 providerId>",
  "config": {
    "enabled": true,
    "properties": {
      "contextWindow": 1048576,          // 官方统一窗口 1,048,576（输入+思考+输出共享）
      "inputFormat": { "supportsImage": true, "supportsVideo": true },
      "supportsJsonSchemaOutput": true
    },
    "optionSpecs": {
      "reasoningLevel": { "values": ["low", "medium", "high"] },  // 官方 thinking_level 三档
      "maxOutputTokens": { "max": 65536 }                          // 官方流式单请求上限
    }
  }
}
```

取值依据（官方规格，详见 §5）：

| 字段 | 取值 | 官方依据 | 配错的后果 |
|---|---|---|---|
| `contextWindow` | `1048576` | 统一 1M 窗口 | 配 128K 会提前截断长上下文；配 1000000（K 数）低估 4.8% |
| `maxOutputTokens.max` | `65536` | 流式上限 65,536（非流式 32,768） | 配 256000 超过官方上限；**配太小会被思考 token 吃光 → 空回复** |
| `reasoningLevel.values` | `low/medium/high` | 官方三档（medium 为默认） | 出现 `max`/`xhigh` 等非官方档位 → 网关按最高档处理，费 token 且不可控 |
| `supportsImage`/`supportsVideo` | `true` | 输入模态含 image/video | 配 `false` 则无法上传图片/视频 |
| `supportsJsonSchemaOutput` | `true` | 官方支持结构化输出 | 配 `false` → 结构化输出降级为文本解析 |

**不要配** `temperature` / `top_p` / `top_k`——官方明示这些自定义值一律被忽略。

### 4.3 子智能体（agent）引用

```
model: "<providerId>/gemini-4-argon"
```

---

## 5. Gemini 4 Argon 官方规格速查

来源：Google《What's new in Gemini 4 Argon》、Vertex AI 模型页、OpenCode 官方模型目录（`GET /inference/go/v1/models`），2026-10-30 采集。

| 项 | 值 |
|---|---|
| 模型 ID | `gemini-4-argon`（canonical `google/gemini-4-argon`） |
| 发布 / 知识截止 | 2026-10-13 / 2026-03 |
| 上下文窗口 | **统一 1,048,576 token**（输入 + 思考 + 输出共享同一窗口） |
| 单请求输出上限 | **流式 65,536**；**非流式 32,768** |
| 长解码 | 可到"1M − 输入"，需 `background`/`continuation_token`（仅 v1beta1 generateContent，OpenAI 兼容接口不暴露） |
| 思考等级 | `low` / `medium`（**官方默认**）/ `high`；`thinking_budget`、`"MINIMAL"` → 400 |
| 采样参数 | `temperature`/`top_p`/`top_k` **自定义值被忽略** |
| 缓存 | **仅隐式缓存**，最小前缀 4,096 token；不支持显式缓存 |
| 输入模态 | text / image / video / audio / PDF |
| 输出模态 | 仅 text |
| 能力 | function calling ✓、structured output ✓、search grounding ✓、URL context ✓、code execution ✓ |
| 定价（至 2026-11-30） | 输入 **$2**/1M、输出 **$10**/1M、缓存读 **$0.10**/1M |
| 定价（2026-12-01 起） | 输入 **$4**/1M、输出 **$20**/1M、缓存读 **$0.20**/1M（**×2**） |

> ⚠️ **思考 token 计入 `max_output_tokens`**。预算被思考吃满时模型返回空文本 + `finish_reason: length` —— 这是模型特性，**不是代理故障**。

---

## 6. 验证

```bash
OPENCODE_API_KEY=<你的 key> bash verify.sh
```

五项检查（每项都带对照）：

| # | 检查 | 期望 |
|---|---|---|
| 1 | `GET /healthz` | 200 |
| 2 | `GET /v1/models` | 200 且含 `gemini-4-argon` |
| 3 | **ZCode 真实方言 body**（四方言 + `max_completion_tokens`） | **200**（修复前必 503） |
| 4 | 标准 body（对照组） | 200 且内容正确 |
| 5 | 缺 `Authorization` | **401**（证明凭证确实透传给网关） |

最后去 ZCode 面板对该模型点「测试」/ 发一句话。

### 怎么确认"真的是这条链路通的"（避免假绿）

- ❌ 不要用"某个子代理回了一句你期望的字符串"当证据——**提示词里含期望串时，任何模型（哪怕回落的默认模型）都会照抄**。
- ✅ 可靠判据：
  1. 代理日志出现该请求且 `UPSTREAM … -> 200`；
  2. 日志里的 `REWRITE … changed=…` 恰好列出被剥的字段；
  3. ZCode 侧会话遥测里的 `provider` / `model` 字段正确。

看日志：
```bash
tail -f ~/.zcode/opencode-relay/relay.log
```

---

## 7. 防踩坑表

| 症状 | 根因 | 处置 |
|---|---|---|
| 发消息一直转圈，只能手动停止；日志有重试循环但无 HTTP 错误 | **缺 `x-opencode-session`**（Base URL 填了 opencode.ai） | Base URL 改指本地代理（§4.1） |
| 面板测试失败，代理日志 `UPSTREAM … -> 503` | **字段方言**未归一化 | 确认跑的是本目录脚本、且改写逻辑在（看 `REWRITE` 行） |
| 面板测试 503 且**没有** `REWRITE` 行 | 请求没经过 `…/completions` 分支 | 确认 Base URL 以 `/v1` 结尾、接口类型是 OpenAI 兼容 |
| 长思考会话中途断开 | 客户端/代理空闲超时 | 本代理默认不设空闲超时；确认没有别的中间层 |
| 模型能回话但**内容为空**、`finish_reason: length` | **思考 token 吃光输出预算** | 提高 `maxOutputTokens.max`（≤65536）或降低思考档位 |
| 模型选择器出现两个同名 Gemini、参数不同 | 删过供应商但**模型规则残留** | 清理 `providerModelRules` 中指向已删 provider 的条目 |
| 改完配置不生效 | 只改了一个文件 | `provider_config.json`（权威）+ `config.json`（镜像）**双写** |
| 账单突然翻倍 | **2026-12-01** OpenCode Go 恢复原价（$4/$20） | 提前调整用量；注意额度按未折价计费 |
| 图片/视频传不上去 | `inputFormat.supportsImage/Video` 配成了 false | 改回 `true` |

---

## 8. 回滚

| 层 | 动作 |
|---|---|
| ZCode 供应商配置 | 恢复 `~/.zcode/v2/provider_config.json.bak-*` 与 `config.json.bak-*`（两份都要） |
| 常驻服务 | `bash uninstall-macos.sh`（或 `launchctl bootout gui/$(id -u)/com.user.zcode-opencode-relay`） |
| 彻底清除 | `bash uninstall-macos.sh --purge` |

---

## 9. 文件清单

| 文件 | 用途 |
|---|---|
| `opencode_relay.py` | 代理本体（Python 3.8+，零依赖） |
| `install-macos.sh` | macOS 安装（LaunchAgent 开机自启 + 崩溃拉起） |
| `uninstall-macos.sh` | 卸载（`--purge` 连文件一起删） |
| `verify.sh` | 五项链路自检 |
| `README.md` | 本文件 |

代理参数：

```
--port 8787                 监听端口（仅 127.0.0.1）
--session <id>              x-opencode-session 的值（默认按主机名派生）
--upstream-host opencode.ai
--upstream-prefix /zen/go
--timeout 600               上游读超时秒数（别调小：深思考首字节可达 50s）
--log-file <path>           额外落盘日志
```
