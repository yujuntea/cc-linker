# `cc-linker img-proxy` 使用说明

让**纯文本模型**(glm-5.2、qwen3、deepseek、kimi 等)在 Claude Code 里也能"接收"你粘贴的图片。

> **重要心智模型**:`img-proxy` 不是让模型直接"看见"图片——它把图片**保存成本地文件**,然后给模型发一段**文本**(图片路径),并提示模型"如果你想识别这张图片,请调图片识别 MCP 工具"。所以你需要让模型**能访问图片识别 MCP**(比如 `mcp__MiniMax__understand_image`)。

---

## 目录

- [TL;DR — 3 步上手](#tldr--3-步上手)
- [它做了什么 / 没做什么](#它做了什么--没做什么)
- [完整命令列表](#完整命令列表)
- [配置文件](#配置文件)
- [常见问题](#常见问题)
- [故障排除](#故障排除)
- [卸载](#卸载)
- [限制 / 已知问题](#限制--已知问题)

---

## TL;DR — 3 步上手

```bash
# 1. 选你要启用图片识别的 provider(可选多个,逗号分隔)
cc-linker img-proxy install --providers glm-5.2,byte-agent-glm

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

---

## 冷启动 / CC Switch 用户

`img-proxy install` 默认从 `~/.claude/providers/*.json` 找 provider 文件。**如果你之前没用过 cc-linker(或没用过手工 `~/.claude/providers/*.json`)**,这个目录是空的,install 会直接报错。

**好消息:CC Switch 自动支持**。img-proxy 会在 `scanProviderFiles()` 时**额外**扫 `~/.cc-switch/cc-switch.db`(CC Switch 的 SQLite),如果有 `app_type='claude'` 的 provider,**首次调用时同步到 `~/.cc-linker/auto-providers/<alias>.json`**,然后跟 manual 目录合并展示。

所以 CC Switch 用户**完全不用手动建 provider 文件**——直接 `cc-linker img-proxy install --all`,你会看到所有 CC Switch 里的 provider 都列出来了,选要启用的即可。

### 数据来源优先级

`scanProviderFiles()` 合并两路,manual 优先(同名 alias 时 manual 赢):

```
~/.claude/providers/*.json   ← manual (你手写 / img-proxy install 改写后)
   ↓ alias 冲突时覆盖
~/.cc-linker/auto-providers/*.json  ← cc-switch 同步生成
```

`~/.cc-linker/auto-providers/` 跟 `ProviderManager`(Bot 那边)共享同一个目录,两边都会读。

### CC Switch 数据库变了怎么办?

每次 `img-proxy status` / `install` / `uninstall` 都会触发 scan,如果 `cc-switch.db` 的 mtime 比 `auto-providers/` 新,就重新同步一次。**不需要手动重启**。

### 在 CC Switch 里加新 provider 后...

下次跑 `cc-linker img-proxy install` 就能看到。**`img-proxy` 不会自动启用新 provider**——需要显式 install,避免"加了 CC Switch provider 自动启用代理"的意外。

### 完全不用 CC Switch,也不想手写?

最简单:**装 CC Switch** (https://github.com/farion1231/cc-switch),用它 GUI 管理所有 provider,img-proxy 自动读。如果不想装 CC Switch,手工创建 `~/.claude/providers/my-provider.json`:

```json
{
  "model": "opus",
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

| 命令 | 做什么 |
|------|--------|
| `cc-linker img-proxy install` | 交互式选 provider |
| `cc-linker img-proxy install --providers <aliases>` | 指定 provider(逗号分隔) |
| `cc-linker img-proxy install --all` | 所有有 `ANTHROPIC_BASE_URL` 的 provider |
| `cc-linker img-proxy status` | 看运行状态、监听地址、已安装/未安装 provider |
| `cc-linker img-proxy start` | 前台启动(`Ctrl+C` 停) |
| `cc-linker img-proxy start --daemon` | 后台启动(写 PID 文件) |
| `cc-linker img-proxy stop` | 停后台 daemon(顺手 unload launchd plist) |
| `cc-linker img-proxy uninstall` | 交互式卸 |
| `cc-linker img-proxy uninstall --providers <aliases>` | 指定卸 |
| `cc-linker img-proxy uninstall --all` | 卸所有 |
| `cc-linker img-proxy daemon install` | macOS launchd 开机自启 |
| `cc-linker img-proxy daemon uninstall` | 卸 launchd |

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
```

环境变量也能覆盖:

- `CC_LINKER_IMG_PROXY_ENABLED`
- `CC_LINKER_IMG_PROXY_PORT`
- `CC_LINKER_IMG_PROXY_HOSTNAME`
- `CC_LINKER_IMG_PROXY_CACHE_HOURS`
- `CC_LINKER_IMG_PROXY_PROMPT_TEMPLATE`

### 自定义 prompt template

**如果你用别的图片识别 MCP**(不是 `mcp__MiniMax__understand_image`),改 `prompt_template`:

```toml
[img_proxy]
prompt_template = "[用户粘贴的图片已保存到本地: {path}] 请用你的图片识别工具(image_source 传这个路径)来查看。"
```

模板里必须含 `{path}` 占位符,代理会把图片路径填进去。如果模板不含 `{path}`,代理会**回退到默认文案**(避免空 text block 触发上游 4xx)。

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
- `routes.json` 里的 upstream 仍是真上游,不会变成 self-loop

### Q: 我手动改了某个 provider 的 `BASE_URL`(迁移到别的服务器),卸的时候会丢吗?

**不会**。`uninstall` 只在我们确实写进去过的代理 URL 才还原;你手动改的 `BASE_URL` 保留原样。routes 和 `.bak` 还是会清。

### Q: 启动两次会冲突吗?

第二次会优雅退出 `⚠️ 代理已在运行 (PID: ...)`。如果之前崩溃留下 stale PID 文件,会自动检测 + 清理。

### Q: 哪些 provider 可以用?

**只要 `ANTHROPIC_BASE_URL` 不为空就行**(见 `cc-linker img-proxy status` 的 "未纳入代理的 provider" 列表)。这个列表里的都可用。

### Q: 哪些 provider **不**能用?

- 真实 upstream URL 不带 path 的(Claude Code 保留 path 段才能正确路由,我们实测 ARK `/api/plan` 工作)
- HTTPS-only 上游不影响(proxy 用 http,只听 loopback)
- 模型本身不识别 image 的——没图片识别 MCP 就只是把图片存了,模型看不到

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

**日志里看到大量 `cleanup removed N cached images`** — 正常,每小时定时清过期图片

---

## 卸载

完整清理(回到原始状态):

```bash
# 1. 卸每个 provider
cc-linker img-proxy uninstall --all

# 2. 停 daemon
cc-linker img-proxy stop

# 3. (如果装了 launchd)卸开机自启
cc-linker img-proxy daemon uninstall

# 4. 删缓存(可选)
rm -rf ~/.cc-linker/img-proxy/cache
```

`uninstall` 会把 provider 文件的 `BASE_URL` 还原(如果是我们装上去的),`routes.json` 清空,`.bak` 删除。**注意**:`uninstall` 会清掉 `.bak`,token 不会丢但需要手动管理(默认 `uninstall --all` 后下次 install 会重新生成 `.bak`)。

---

## 限制 / 已知问题

1. **URL 形式的 image block 不处理**(`source.type === 'url'`)。Claude Code 通常把 URL 转 base64,如果是纯 URL,代理会原样转发,模型能不能 fetch 看上游能力。

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
2. **清理 cache 是定时的**(启动 + 每小时),不会"立刻清"。如果磁盘敏感,手动 `rm` 即可。
3. **没自动迁移其他 provider 来源**(cc-switch 的 `auto-providers/` 目录)——目前只扫 `~/.claude/providers/`。
4. **`mcp__MiniMax__understand_image` 是硬编码到默认 prompt template**——如果你用别的 MCP,改 `prompt_template`。
5. **Phase 2 控制台**(Web 监控)还没做,要看实时计数只能 `grep stripped ~/.cc-linker/img-proxy/img-proxy.log`。

---

## 容易踩的坑

1. **第一次安装前先 `cc-linker img-proxy status`** — 看看哪些 provider 是"未纳入代理",这就是你能启用的范围。
2. **不要把 `img_proxy.enabled = false` 跟 daemon `start --daemon` 混用** — enabled 是总开关,daemon 启了但 enabled=false 会立刻退出。
3. **改 `config.toml` 的 `[img_proxy]` section 后,daemon 不会自动 reload** — 需要 `cc-linker img-proxy stop && cc-linker img-proxy start --daemon`。
4. **cache 文件 mode 0o600**(owner-only),有敏感截图的话别 chmod 放开。