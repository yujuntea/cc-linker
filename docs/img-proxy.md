# `cc-linker img-proxy` 使用说明

让**纯文本模型**(glm-5.2、qwen3、deepseek、kimi 等)在 Claude Code 里也能"接收"你粘贴的图片。

> **重要心智模型**:`img-proxy` 不是让模型直接"看见"图片——它把图片**保存成本地文件**,然后给模型发一段**文本**(图片路径),并提示模型"如果你想识别这张图片,请调图片识别 MCP 工具"。所以你需要让模型**能访问图片识别 MCP**(比如 `mcp__MiniMax__understand_image`)。

---

## 目录

- [TL;DR — 3 步上手](#tldr--3-步上手)
- [冷启动 / CC Switch 用户](#冷启动--cc-switch-用户)
- [它做了什么 / 没做什么](#它做了什么--没做什么)
- [完整命令列表](#完整命令列表)
- [配置文件](#配置文件)
- [Shell wrapper 模式 (CC Switch 用户专用)](#shell-wrapper-模式cc-switch-用户专用)
- [常见问题](#常见问题)
- [故障排除](#故障排除)
- [卸载](#卸载)
- [升级 / 迁移 (v2 智能安装)](#升级--迁移-v2-智能安装)
- [智能模式 (smart_mode)](#智能模式-smart_mode)
- [限制 / 已知问题](#限制--已知问题)
- [容易踩的坑](#容易踩的坑)

---

## TL;DR — 3 步上手

> **v2 默认 smart 模式**:`install` 自动跳过 multimodal 模型(Claude / GPT-4 / Kimi 等),只装文本模型。不用担心破坏图片能力。

```bash
# 1. 智能安装(自动发现 + 分类 + 选 text-only 模型,可能提示装 wrapper)
cc-linker img-proxy install --yes

# 2. 后台启动代理(监听 127.0.0.1:8765)
cc-linker img-proxy start --daemon

# 3. (可选)macOS 开机自启
cc-linker img-proxy daemon install
```

之后在 Claude Code 里粘贴图片,**就这样能用**了。模型会收到一段文本:

```
[用户粘贴的图片已保存到本地: /Users/you/.cc-linker/img-proxy/cache/1783143359780-o07orl.png]
当前模型为纯文本模型,无法直接查看图片内容。
如需识别这张图片,请调用 mcp__MiniMax__understand_image 工具,image_source 参数传上述本地路径。
```

如果模型配了图片识别 MCP,就会调 MCP 工具去读图,然后正常回答你的问题。

### 只想装某个 model?

```bash
# dumb 模式(不过滤 multimodal,装你想装的)
cc-linker img-proxy install --providers glm-5.2,byte-agent-glm

# 或显式 dumb 模式 + 全部
cc-linker img-proxy install --all
```

### CC Switch 用户(直接跑 `claude` 不用 alias)?

装个 shell wrapper 就好(`install` 会自动问):

```bash
cc-linker img-proxy wrapper install   # 装 cc-linker-proxy() 函数到 ~/.zshrc
source ~/.zshrc                       # 重载 shell
cc-linker-proxy "看这个图"             # 走 proxy,claude 直跑没影响
```

详见 [Shell wrapper 模式](#shell-wrapper-模式-cc-switch-用户专用)。

---

## 冷启动 / CC Switch 用户

`img-proxy install` 默认从 3 个来源合并发现 candidate:

1. `~/.claude/providers/*.json`(你手写 / 之前 install 改写过的)
2. `~/.cc-linker/auto-providers/*.json`(CC Switch 同步生成)
3. `~/.zshrc` / `~/.bashrc` 里的 `alias cc-X='claude --settings ...'`(自动检测,pre-select 对应 provider)

**如果你之前没用过 cc-linker(或没用过手工 `~/.claude/providers/*.json`)**,目录 1 是空的,install 会直接报错并给两种解决方案。

**好消息:CC Switch 自动支持**。`discoverCandidates()` 在每次 install/status/uninstall 时调用,如果 `cc-switch.db` 的 mtime 比 `auto-providers/` 新,就重新同步一次。同时**清理 stale entries**(你在 CC Switch 里删的 provider 也会从 `auto-providers/` 清掉)。

所以 CC Switch 用户**完全不用手动建 provider 文件**——直接 `cc-linker img-proxy install --yes`,你会看到所有 CC Switch 里的 provider 都列出来了,smart 模式预选 text-only(默认跳过 Kimi / Claude / GPT-4 等 multimodal),回车确认即可。

### 数据来源优先级

```
[alias] / cc-* alias in rc file
   ↓ source 优先级
~/.claude/providers/*.json   ← manual (你手写 / img-proxy install 改写后)
   ↓ alias 冲突时覆盖
~/.cc-linker/auto-providers/*.json  ← cc-switch 同步生成
```

`~/.cc-linker/auto-providers/` 跟 `ProviderManager`(Bot 那边)共享同一个目录,两边都会读。

### CC Switch 数据库变了怎么办?

每次 `install` / `status` / `uninstall` 都会触发 sync + stale cleanup。**不需要手动重启**。

### 在 CC Switch 里加新 provider 后...

下次跑 `cc-linker img-proxy install --yes` 就能看到。**`img-proxy` 不会自动启用新 provider**——需要显式 install,避免"加了 CC Switch provider 自动启用代理"的意外。

### 你有 shell alias 怎么办?

smart install 会自动扫 `~/.zshrc` / `~/.bashrc` / `~/.zprofile` / `~/.bash_profile` 里 `alias cc-X='claude --settings ...'` 这样的行,**自动 pre-select 对应 provider 文件**。例如:

```bash
# ~/.zshrc:
alias cc-glm='claude --settings ~/.claude/providers/glm-5.2.json'
```

跑 `install` 时 `glm-5.2` 默认勾选(且 classified 为 text-only)。无需手动 `--providers glm-5.2`。

**注意**:shell alias 用的是哪个 provider 文件,决定粘贴图片会不会被剥离——同名近似(比如 `cc-byte-glm` 指向 `byte-glm.json` 而你想装的是 `byte-agent-glm.json`)容易踩坑,详见 [Gotcha: cc-byte-glm ≠ cc-byte-agent-glm](#gotcha-cc-byte-glm--cc-byte-agent-glmname-collision-陷阱)。

### 完全不用 CC Switch,也不想手写?

最简单:**装 CC Switch** (https://github.com/farion1231/cc-switch),用它 GUI 管理所有 provider,img-proxy 自动读。如果不想装 CC Switch,手工创建 `~/.claude/providers/my-provider.json`:

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "sk-...",
    "ANTHROPIC_BASE_URL": "https://your-provider.example/anthropic",
    "ANTHROPIC_MODEL": "your-model-name"
  }
}
```

格式参考已有 provider 文件(任何 Anthropic API 兼容的 endpoint 都可以)。`ANTHROPIC_BASE_URL` 是必需字段,其他 `ANTHROPIC_DEFAULT_*_MODEL` 可选。

---

## 它做了什么 / 没做什么

| 行为 | |
|------|---|
| ✅ 把 `~/.claude/providers/*.json` 的 `ANTHROPIC_BASE_URL` 改成 `http://127.0.0.1:8765/<alias>` | |
| ✅ Claude Code 发的请求里的 base64 image block 自动剥离,落盘到 `~/.cc-linker/img-proxy/cache/` | |
| ✅ 替换成含本地路径的 text block,再转发给真实上游 | |
| ✅ SSE 流式 / Authorization header / 其它 headers 透传 | |
| ✅ `uninstall` 完全还原(保留你手动改过的 `BASE_URL`) | |
| ❌ 让模型"看见"图片本身 | 模型需要**主动调图片识别 MCP** |
| ❌ 压缩图片 / 改格式 / 上传云端 | 完全本地落盘 |
| ❌ 处理 URL image(`{type:'image', source:{type:'url'}}`) | 只处理 base64 inline |

---

## 完整命令列表

### 主命令

| 命令 | 做什么 |
|------|--------|
| `cc-linker img-proxy install` | 交互式选 provider(smart 模式默认) |
| `cc-linker img-proxy install --providers <aliases>` | dumb 模式 + 指定 provider(逗号分隔) |
| `cc-linker img-proxy install --all` | dumb 模式 + 所有 |
| `cc-linker img-proxy install --yes` | smart 模式 + 不交互(用默认预选) |
| `cc-linker img-proxy install --mode <smart\|dumb>` | 显式指定模式 |
| `cc-linker img-proxy uninstall` | 交互式卸 |
| `cc-linker img-proxy uninstall --providers <aliases>` | 指定卸 |
| `cc-linker img-proxy uninstall --all` | 卸所有 + 提示卸 wrapper(已装的话) |
| `cc-linker img-proxy status` | 看 daemon / 已装 / 未装 / wrapper / launchd |
| `cc-linker img-proxy start` / `start --daemon` | 前台 / 后台启动 |
| `cc-linker img-proxy stop` | 停后台 daemon |

### Shell wrapper(CC Switch 用户)

| 命令 | 做什么 |
|------|--------|
| `cc-linker img-proxy wrapper install` | 装 `cc-linker-proxy()` 函数到 `~/.zshrc` / `~/.bashrc` |
| `cc-linker img-proxy wrapper uninstall` | 从 rc 文件移除 wrapper |
| `cc-linker img-proxy wrapper status` | 看 wrapper 是否已装 + rc 文件路径 |

### 子命令(wrapper 调用用)

| 命令 | 做什么 |
|------|--------|
| `cc-linker img-proxy current-url` | 读 `~/.claude/settings.json` 的 `env.ANTHROPIC_BASE_URL`(空 = 没装) |
| `cc-linker img-proxy resolve <upstream>` | 按 upstream URL 查 proxy URL(空 = 没在 routes 里) |
| `cc-linker img-proxy daemon install` / `uninstall` | macOS launchd 开机自启 |

### 标志速查(`install`)

| Flag | 含义 |
|------|------|
| `-p, --providers <aliases>` | 逗号分隔,显式指定 + 强制 dumb 模式 |
| `--all` | 全装 + 强制 dumb 模式 |
| `--yes` | smart 模式不交互(默认预选) |
| `--mode <smart\|dumb>` | 显式模式,Commander 会校验非法值 |

---

## 配置文件

在 `~/.cc-linker/config.toml` 加 `[img_proxy]` section(全部可选,不写就用 defaults):

```toml
[img_proxy]
enabled = true                          # 总开关
port = 8765                              # 监听端口
hostname = "127.0.0.1"                  # 只绑 loopback,不暴露
cache_max_age_hours = 168               # 缓存文件保留 7 天,启动 + 每小时清过期
prompt_template = "..."                  # 给模型的文本,默认含 mcp__MiniMax__understand_image 提示
smart_mode = true                        # v2: 自动跳过 multimodal 模型
vision_model_patterns_extra = []        # 追加自定义 multimodal patterns
text_only_model_patterns_extra = []     # 追加自定义 text-only patterns
console_enabled = false                 # Phase 2 Web 控制台
```

环境变量也能覆盖(注:`smart_mode` / `*_extra` 没有 env var,只在 config.toml):

- `CC_LINKER_IMG_PROXY_ENABLED`
- `CC_LINKER_IMG_PROXY_PORT`
- `CC_LINKER_IMG_PROXY_HOSTNAME`
- `CC_LINKER_IMG_PROXY_CACHE_HOURS`
- `CC_LINKER_IMG_PROXY_PROMPT_TEMPLATE`

### 自定义模型分类 patterns

如果你的模型名不在内置列表里,可以追加 pattern(支持正则,大小写不敏感):

```toml
[img_proxy]
smart_mode = true

# 标记 multimodal(会被跳过)
vision_model_patterns_extra = [
  "my-custom-vl-*",
]

# 标记 text-only(会被 proxy)
text_only_model_patterns_extra = [
  "my-custom-text-*",
]
```

详见 [智能模式 (smart_mode)](#智能模式-smart_mode)。

### 自定义 prompt template

**如果你用别的图片识别 MCP**(不是 `mcp__MiniMax__understand_image`),改 `prompt_template`:

```toml
[img_proxy]
prompt_template = "[用户粘贴的图片已保存到本地: {path}] 请用你的图片识别工具(image_source 传这个路径)来查看。"
```

模板里必须含 `{path}` 占位符,代理会把图片路径填进去。如果模板不含 `{path}`,代理会**回退到默认文案**(避免空 text block 触发上游 4xx)。

---

## Shell wrapper 模式(CC Switch 用户专用)

> **适用人群**:你用 CC Switch 直接跑 `claude`(没有自定义 `cc-X` alias)。`~/.claude/settings.json` 是 CC Switch 写的,改 provider 文件没用。

### 它怎么工作

```
用户跑:  cc-linker-proxy "看这个图"
         ↓
shell 函数 cc-linker-proxy() (在 ~/.zshrc)
  1. 读 ~/.claude/settings.json 拿当前 upstream URL
  2. 查 img-proxy routes 表,找到 proxy URL
  3. ANTHROPIC_BASE_URL=<proxy> claude "看这个图"
```

### 3 步启用

```bash
# 1. 把要走 proxy 的 provider 都装上(从 CC Switch 同步出来)
cc-linker img-proxy install --yes

# 2. 装 wrapper 到 rc 文件
cc-linker img-proxy wrapper install
# 回答 y(默认)→ wrapper 装到 ~/.zshrc 或 ~/.bashrc

# 3. 重载 shell
source ~/.zshrc   # 或新开 terminal

# 验证
cc-linker-proxy "看这个图"   # 走 proxy
claude "看这个图"             # 直连(行为不变,不受影响)
```

**`install --yes` 检测到 CC Switch 时会自动问你要不要装 wrapper**,直接回车确认即可,不用单独跑第 2 步。

### Wrapper 关键行为

- **递归防护**:`ANTHROPIC_BASE_URL` 已设时直接 exec claude,不调 resolve(避免无限循环和多余 sub-shell)
- **幂等**:重复 `wrapper install` 不会重复写
- **备份**:修改 rc 文件前先备份到 `~/.cc-linker/img-proxy/wrapper-backups/`
- **支持 zsh + bash**(其他 shell 会提示不支持)
- **检测当前 shell**:`ZSH_VERSION` → `.zshrc`,`BASH_VERSION` → `.bashrc`

### 日常使用

```bash
# CC Switch 切到 glm-5.2
cc-switch use glm-5.2

# 跑 wrapper(走 proxy,图片被剥离)
cc-linker-proxy "看这个图"

# 直接跑 claude(直连,行为不变)
claude "看这个图"

# 切换 wrapper status
cc-linker img-proxy wrapper status
```

### 卸载 wrapper

```bash
cc-linker img-proxy wrapper uninstall
# 备份保留在 ~/.cc-linker/img-proxy/wrapper-backups/wrapper-backup-removed-<ts>-<uuid>

# 或者连同所有 provider 一起清:
cc-linker img-proxy uninstall --all
# v2.7+: 会提示"也卸载 wrapper?"(默认 N,避免误删)
```

---

## 常见问题

### Q: `glm-5.2` 用着用着突然不行了?

大概率是 token 过期了。看 `~/.cc-linker/img-proxy/img-proxy.log` 末尾的上游状态码,4xx/401 就是上游鉴权失败。**重装会让 token 保留**(不覆盖 `.bak`),直接:

```bash
cc-linker img-proxy uninstall --providers glm-5.2 && cc-linker img-proxy install --providers glm-5.2
```

### Q: 我改了 config 里的 port,需要重装吗?

不需要 `uninstall`。直接 `cc-linker img-proxy install --providers <alias>` 即可,代理会自动:

- 更新 `BASE_URL` 到新端口
- 保留 `.bak` 原上游(token 也不动)
- `routes.json` 里的 upstream 仍是真上游,不会变成 self-loop(URL 规范化在 resolve 时自动剥 trailing slash + lowercase host)

### Q: 我手动改了某个 provider 的 `BASE_URL`(迁移到别的服务器),卸的时候会丢吗?

**不会**。`uninstall` 只在我们确实写进去过的代理 URL 才还原;你手动改的 `BASE_URL` 保留原样。routes 和 `.bak` 还是会清。

### Q: 启动两次会冲突吗?

第二次会优雅退出 `⚠️ 代理已在运行 (PID: ...)`。如果之前崩溃留下 stale PID 文件,会自动检测 + 清理(还加了 `isPidAlive()` check,防 EADDRINUSE 后假报成功)。

### Q: smart 模式下 multimodal 模型去哪了?

被自动跳过(显示 `⏭ multimodal-skip`)。它们不会进 routes.json,所以你直接用 Claude/Kimi 时仍走真上游,图片能力不受影响。想装某个 multimodal:用 `--providers <alias> --mode dumb`。

### Q: 哪些 provider 可以用?

**只要 `ANTHROPIC_BASE_URL` 不为空就行**(见 `cc-linker img-proxy status` 的 "未纳入代理的 provider" 列表)。这个列表里的都可用。

### Q: 哪些 provider **不**能用?

- 真实 upstream URL 不带 path 的(Claude Code 保留 path 段才能正确路由,我们实测 ARK `/api/plan` 工作)
- HTTPS-only 上游不影响(proxy 用 http,只听 loopback)
- 模型本身不识别 image 的——没图片识别 MCP 就只是把图片存了,模型看不到

### Q: 我装了 CC Switch 后跑 smart install,看不到我新加的 provider?

下次跑 `cc-linker img-proxy install` 时自动重新同步 + 清理 stale。**不需要手动触发**。

### Q: 为什么 `cc-linker-proxy` 报"X 没在 img-proxy 里"?

意味着当前 CC Switch 激活的 provider(`~/.claude/settings.json` 里的 `ANTHROPIC_BASE_URL`)没被你 install 到 img-proxy 里。**重新跑 `install`** 把它装上即可。

---

## 故障排除

**装完不工作** — 按顺序检查:

1. `cc-linker img-proxy status` 看 daemon 是否在跑、port 是否对
2. `tail -20 ~/.cc-linker/img-proxy/img-proxy.log` 看请求日志(`stripped`、`upstream_status`、`duration_ms`)
3. `curl http://127.0.0.1:8765/<alias>/v1/models` 看代理是否能 reach upstream(200 = OK)

**"已在运行" 但端口没监听** — PID 文件 stale(进程死了 PID 文件还在):

```bash
# 看实际进程
lsof -nP -iTCP:8765

# 清 stale,重启(自动检测)
cc-linker img-proxy stop
cc-linker img-proxy start --daemon
```

**Claude Code 提示图片发不出去 / 4xx** — 看 `img-proxy.log` 的 `upstream_status`:

| 状态码 | 含义 | 怎么办 |
|--------|------|--------|
| 401 / 403 | 上游鉴权失败 | 重装 + token 刷新 |
| 404 | upstream URL 错(路径被裁剪) | 验证你的 `ANTHROPIC_BASE_URL` 完整保留 |
| 502 + `unknown alias` | 路由表没这个 provider | `cc-linker img-proxy install --providers <alias>` |

**模型说"我看不到图片"** — 不是 proxy 的问题,是模型没调图片识别 MCP:

- 确认你的 MCP 配置里启用了图片识别工具(`claude --mcp-config …` 或 `.mcp.json`)
- 看模型 response 里有没有 "I'll call the image recognition tool" 类似措辞
- 如果没有,把 `prompt_template` 改成更适合你模型的措辞

**`cc-linker-proxy` 报 "找不到当前 provider URL"** — `~/.claude/settings.json` 没 `env.ANTHROPIC_BASE_URL` 字段:

- CC Switch 用户:在 CC Switch GUI 里选个 provider 激活
- 其他用户:在 `settings.json` 加 `env.ANTHROPIC_BASE_URL`

**日志里看到大量 `cleanup removed N cached images`** — 正常,每小时定时清过期图片

---

## 卸载

完整清理(回到原始状态):

```bash
# 1. 卸每个 provider(已装 wrapper 的话会提示一并卸,默认 N)
cc-linker img-proxy uninstall --all

# 2. 卸 wrapper(如果上面没卸)
cc-linker img-proxy wrapper uninstall

# 3. 停 daemon
cc-linker img-proxy stop

# 4. (如果装了 launchd)卸开机自启
cc-linker img-proxy daemon uninstall

# 5. 删缓存(可选)
rm -rf ~/.cc-linker/img-proxy/cache
```

`uninstall` 会把 provider 文件的 `BASE_URL` 还原(如果是我们装上去的),`routes.json` 清空,`.bak` 删除。**注意**:`uninstall` 会清掉 `.bak`,token 不会丢但需要手动管理(默认 `uninstall --all` 后下次 install 会重新生成 `.bak`)。

---

## 升级 / 迁移 (v2 智能安装)

从 v1 dumb install 升级到 v2 smart install:

### 轻量迁移

```bash
cc-linker img-proxy install --yes
```

smart 模式会跳过 multimodal、检测到 CC Switch 时会问要不要装 wrapper。**已装的 multimodal 不会被自动卸载**(smart 模式只加新路由,不删旧路由)。

### 严格迁移(推荐)

```bash
cc-linker img-proxy uninstall --all   # 还原所有 + 清 routes + 提示卸 wrapper
cc-linker img-proxy install --yes     # smart 模式重新挑选
```

### 回滚

如果新行为有问题:

```bash
cc-linker img-proxy uninstall --all
cc-linker img-proxy install --all      # dumb 模式(旧行为,装全部)
```

---

## 智能模式 (smart_mode)

v2 默认 smart 模式:`install` 自动分类模型,跳过 multimodal(避免破坏图片能力)。

### 内置分类规则(23+ multimodal / 17 text-only)

| 厂商 | Multimodal(跳过) | Text-only(装) |
|------|---------|--------|
| Anthropic | claude-3/opus/sonnet/haiku | (都 multimodal) |
| OpenAI | gpt-4 | gpt-3, gpt-3.5 |
| Google | gemini-1.5-pro, gemini-*-vision | |
| 阿里 Qwen | qwen-vl/qwen-omni/qwen3.X-plus | qwen-turbo/max/long/coder/qwen3.X-max |
| 智谱 GLM | glm-*-v(4v, 4.5v, 5v) | glm-4.5/4.6/5/5.1/5.2/4-air/4-turbo |
| 月之暗 Kimi | 全部 multimodal | (都 multimodal) |
| 小米 MiMo | mimo-v2.5(base) | mimo-v2.5-pro / mimo-*-pro |
| MiniMax | MiniMax-M3 | MiniMax-M2 / MiniMax-Text- |
| DeepSeek | (都 text-only) | 全部 |

完整 patterns 见 `src/img-proxy/classify.ts`。

### 配置自定义 patterns

```toml
[img_proxy]
smart_mode = true

# 额外标 multimodal(也会被跳过)
vision_model_patterns_extra = [
  "my-custom-vl-*",
]

# 额外标 text-only(也会被 proxy)
text_only_model_patterns_extra = [
  "my-custom-text-*",
]
```

Pattern 是正则,大小写不敏感。后缀(如 `[1m]`, `[256k]`)会被自动剥离再匹配。

### 关闭 smart(全装)

```toml
[img_proxy]
smart_mode = false
```

或 CLI:`cc-linker img-proxy install --all`(dumb 模式,不过滤)。

或单次用 `--mode dumb` 显式覆盖:

```bash
cc-linker img-proxy install --mode dumb
```

---

## 限制 / 已知问题

### ⚠️ Gotcha: `cc-byte-glm` ≠ `cc-byte-agent-glm`(name collision 陷阱)

如果你的 `~/.claude/providers/` 里有多个文件名相近的 provider,shell alias 用的是哪个文件决定了图片会不会被剥离。常见陷阱:

```bash
# ~/.zshrc 里:
alias cc-byte-glm='claude --settings ~/.claude/providers/byte-glm.json'        # ← 没装!
alias cc-byte-agent='claude --settings ~/.claude/providers/byte-agent-glm.json' # ← 装了
```

你可能以为 `cc-byte-glm` 走的是 byte-agent 那个 provider,其实它们是**两个独立的 provider 文件**。即使你 install 了 `byte-agent-glm.json`,`cc-byte-glm` 仍然加载没装的 `byte-glm.json`,图片直接发到原 upstream。

**症状**:粘贴图片 → `API Error: 400 Model only support text input`。看 `~/.cc-linker/img-proxy/img-proxy.log` 发现**没有任何该 alias 的请求记录**——proxy 完全没被 hit。

**修复**(`cc-linker img-proxy` 工具已帮你装这个):

```bash
# 把所有相近名字的都装上,或直接装全部:
cc-linker img-proxy install --providers byte-glm,byte-agent-glm
cc-linker img-proxy install --all
```

**预防**:安装前先看 `cc-linker img-proxy status` 的 "未纳入代理的 provider" 列表,确保你日常用的每个 shell alias 对应的 provider 文件都在装过的列表里。

### 其他限制

1. **URL 形式的 image block 不处理**(`source.type === 'url'`)。Claude Code 通常把 URL 转 base64,如果是纯 URL,代理会原样转发,模型能不能 fetch 看上游能力。
2. **清理 cache 是定时的**(启动 + 每小时),不会"立刻清"。如果磁盘敏感,手动 `rm` 即可。
3. **`mcp__MiniMax__understand_image` 是硬编码到默认 prompt template**——如果你用别的 MCP,改 `prompt_template`。
4. **fish / sh / ksh 等其他 shell 不支持 wrapper**。Fish 用 `alias cc-X cmd`(无等号),语法不同,未实现。
5. **login shells**(ssh 登录、macOS 开机)不 source `.zshrc`,wrapper 不会被加载——只对交互式终端有效。
6. **Phase 2 控制台**(Web 监控)还没做,要看实时计数只能 `grep stripped ~/.cc-linker/img-proxy/img-proxy.log`。

---

## 容易踩的坑

1. **第一次安装前先 `cc-linker img-proxy status`** — 看看哪些 provider 是"未纳入代理",这就是你能启用的范围。
2. **不要把 `img_proxy.enabled = false` 跟 daemon `start --daemon` 混用** — enabled 是总开关,daemon 启了但 enabled=false 会立刻退出。
3. **改 `config.toml` 的 `[img_proxy]` section 后,daemon 不会自动 reload** — 需要 `cc-linker img-proxy stop && cc-linker img-proxy start --daemon`。
4. **cache 文件 mode 0o600**(owner-only),有敏感截图的话别 chmod 放开。
5. **`cc-linker-proxy` 必须从装了 wrapper 的 shell 跑**(`source ~/.zshrc` 后)。在 IDE 集成终端里需要重启 IDE 或手动 source。
6. **别把同一个 provider 文件名既给手动 `~/.claude/providers/`,又给 CC Switch 同步的 `auto-providers/`** — manual 优先,auto 会被覆盖,但同时两份会让修改分散难追溯。