# cc-linker 轻量自动升级 v1.2 简化版

**日期：** 2026-06-14
**版本：** v1.2（v1.1 简化版：放弃"一键升级"，保留"通知 + 1 行命令"）
**状态：** 设计稿（待评审）
**作者：** wuyujun + brainstorm session
**前置版本：** v1.1（4 轮 review 后放弃，详见"v1.1 教训"）

---

## 0. v1.1 教训（为什么要简化）

v1.1 试图做"飞书卡片一键升级"：bot spawn upgrader 子进程跑 `npm i -g`，upgrader 在 bot 死后接管卡片 patch 责任。4 轮 review 后发现：

- 涉及 2 个进程 + 1 个新持久化文件 + 6 个 race + action handler 攻击面
- Standalone binary 用户路径走不通
- launchd KeepAlive 跟新 binary 解析时序有坑
- Feishu 3s ack timeout 下 bot 要做太多事
- Bun-only 用户的 postinstall 路径不工作

**根因**：v1.1 把"通知"和"执行"耦合在一张卡上。**通知 + 1 行命令 = 用户自己执行** 是更朴素的解，砍掉 50% 复杂度。

---

## 1. 设计目标 / 非目标

### 1.1 Goals
- **G1**：端用户**被动收到**"有新版本"提示（飞书卡片）
- **G2**：卡片**直接给出升级命令**（`cc-linker upgrade`），用户复制到 terminal 跑
- **G3**：CLI `cc-linker upgrade` 跑 `npm i -g cc-linker@latest`，postinstall 自动 restart daemon（**沿用现有 `scripts/postinstall.js` 零修改**）
- **G4**：开发者**继续用** `bun run deploy`
- **G5**：网络 / 解析 / Skip CAS / 部署形态差异 4 类失败场景**全部静默 no-op**
- **G6**：≤ 5 分钟可一键关停

### 1.2 Non-Goals
- ❌ 飞书卡片"一键升级"按钮（用户复制命令去 terminal）
- ❌ Daemon 自升级 / 自重启（apply 是用户主动 CLI，不在 daemon 路径上）
- ❌ CHANGELOG 自动 parse
- ❌ 跨设备协调
- ❌ 多渠道通知
- ❌ `min_version` 黑名单强制升级
- ❌ 改 `scripts/postinstall.js` / `bun run deploy` / `daemon.ts` / `package.json` bin

---

## 2. 架构

### 2.1 一句话总结
CLI 侧 `cc-linker upgrade` 一条命令 + daemon 24h 检查发飞书通知卡片（**静态无 action**）。apply 全交给 `npm i -g` + 现有 `postinstall.js`。

### 2.2 模块

```
src/updater/
  check.ts     # 纯函数: fetch npm registry + 24h 缓存 + semver 对比
                # 三个调用方共享: CLI / daemon / 集成测试
                # 无副作用 (只读写 ~/.cc-linker/.update-check.json)

  notify.ts    # 纯函数: UpdateInfo → 文本 banner / 卡片 JSON payload
                # 单测覆盖所有 status

  types.ts     # UpdateInfo, CachedCheck, SkippedVersionEntry

  lifecycle.ts # Skip 状态协调: 跟 user-mapping.json CAS 走

src/cli/commands/upgrade.ts   # CLI 入口
src/runtime/updater-tick.ts   # Daemon 入口 (启动 + 24h)
src/feishu/updater-card.ts    # 静态卡片 JSON builder (无 action handler)
```

**对比 v1.1 砍掉的**：
- ❌ `src/upgrader/{runner,patch-card,state}.ts` 整个目录
- ❌ `pending_upgrade.json` 状态协调
- ❌ Feishu card action handler（无 [Update] 按钮）
- ❌ PID 守卫 / 新 Bot 兜底 / launchd unload 改写

### 2.3 数据流（2 条）

```
                    ┌────────────────────────┐
                    │  registry.npmjs.org/   │
                    │  cc-linker/latest      │  ← resolveRegistryUrl()
                    │  (或用户的 .npmrc)     │     读 .npmrc, 跟 npm i -g 一致
                    └───────────┬────────────┘
                                │ HTTPS GET (5s timeout, 1 retry)
                                ▼
┌──────────────────────────────────────────────────┐
│  src/updater/check.ts                            │
│  ─ fetch with ETag                               │
│  ─ read ~/.cc-linker/.update-check.json (TTL 24h)│
│  ─ semver compare (PKG_VERSION vs latest)        │
│  ─ write back cache atomically                   │
└──────────────┬─────────────────────┬─────────────┘
               │ UpdateInfo          │
               ▼                     ▼
   ┌────────────────────┐  ┌──────────────────────┐
   │ CLI: cc-linker     │  │ Daemon 24h tick:     │
   │  upgrade --check   │  │  send 静态卡片        │
   │  upgrade           │  │  (无 action)          │
   │  upgrade --dry-run │  │  + 写 log banner      │
   │  upgrade --to X    │  │                      │
   └────────┬───────────┘  └──────────┬───────────┘
            │                          │
            ▼                          ▼ (用户复制卡片里的命令到 terminal)
   ┌────────────────────────────────────────────┐
   │  apply:  npm i -g cc-linker@latest        │
   │          ↓ (postinstall.js 自动接)         │
   │          ↓ cc-linker restart               │
   │          ↓ (零新代码)                       │
   └────────────────────────────────────────────┘
```

---

## 3. 触发点

| 触发点 | 频率 | 行为 | 失败处理 |
|--------|------|------|---------|
| CLI: `cc-linker upgrade --check` | 用户主动 | 查 registry（命中 24h 缓存就跳过），打印 banner | 静默 no-op |
| CLI: `cc-linker status` | 用户主动 | **异步**末尾追加 banner（1s 软超时） | 超时静默 |
| CLI: `cc-linker start`（前台） | 用户主动 | 同步查一次，打印 banner 后再启 bot | 静默 no-op |
| CLI: `cc-linker upgrade` | 用户主动 | **强制 fresh fetch**，confirm → `npm i -g` | 用户看得到 |
| Daemon: `start --daemon` 后 | 一次 | post-init hook 触发 check；新版本 → setTimeout(sendCard, notify_delay_ms) | 静默 no-op |
| Daemon 24h ticker | 每天 | 跟启动相同 | 静默 no-op |

---

## 4. 数据流 A：CLI

### 4.1 `cc-linker upgrade --check`

```
entry: upgrade --check
  ↓
read .update-check.json (TTL 24h)
  ├─ cache hit (within TTL)  → return cached
  └─ cache miss / stale      → GET registry (5s timeout, 1 retry)
                                 ├─ 2xx + valid Zod JSON → parse + semver compare + write cache
                                 └─ 非 2xx / 非 JSON / timeout → write cache{error:reason} + return check_failed
  ↓
notify.formatBanner(info) → console.log
  ↓
exit 0 (banner-only)
```

### 4.2 `cc-linker upgrade`（apply）

```
entry: cc-linker upgrade [--dry-run] [--to <version>] [--yes]
  ↓
  ├── --dry-run: print "would install X (current Y), no changes" + exit 0
  ↓
check({ force: true })  (强制不走缓存)
  ↓
case status:
  up_to_date        → print "已是最新", exit 0
  update_available  →
    ├── --to <version>:
    │   ├─ 打印 warning: "确定要从 v0.6.3 降级/跳到 v0.5.0 吗?"
    │   ├─ 二次 confirm (除非 --yes)
    │   └─ execFileSync('npm', ['install', '-g', `cc-linker@${version}`])
    │
    └── 默认 (升级到 latest):
        ├─ confirmPrompt "升级到 v{latest}?" (除非 --yes)
        └─ execFileSync('npm', ['install', '-g', 'cc-linker@latest'])
  ↓
  // R1 修复: 主动 idempotent restart, 不依赖 postinstall
  // (postinstall 可能被用户 .npmrc ignore-scripts 关掉, 也可能 fire 多次)
  ↓
  (a) postinstall 触发 cc-linker restart  (best effort, 可能跑可能不跑)
  (b) 我们自己再调一次 cc-linker restart  (兜底, 幂等)
  ↓
  if (restart 成功):
    print "✅ 升级完成, daemon 已自动重启", exit 0
  else:
    print "✅ 升级完成, 但 daemon 自动 restart 失败"
    print "   请手动跑: cc-linker restart"
    exit 0  (升级成功, restart 失败不报错)
```

**R1 关键不变量**:
- `npm i -g` 调用方是**用户主动**的 CLI, 我们**自己负责** daemon restart
- postinstall 是 best effort (用户 `.npmrc` 可能 `ignore-scripts=true`, bun `add -g` 行为也不同)
- 双重 restart 是幂等的: 第一次杀老 daemon 启新 daemon, 第二次发现 daemon 已是新 binary, 快速 no-op

### 4.3 `cc-linker upgrade` 状态检查

```ts
case status:
  local_newer       → print "本地版本新于 published, 跳过", exit 0
  prerelease_only   → print "stable 已是最新", exit 0
  check_failed      → print "无法检查, 请稍后或手动 `npm i -g cc-linker@latest`", exit 1
  disabled          → exit 0
```

### 4.4 `cc-linker upgrade` 跟 daemon 协调

`cc-linker upgrade` 跑之前探测 daemon 是否在跑：

- `~/.cc-linker/owner.lock` 存在 + pid alive = daemon 在跑
- postinstall 会 restart 它，**不需要** pre-check
- 但要给用户提示：升级会导致 daemon 短暂中断（无 active session 也提示，因为 postinstall 一定会 restart）

```
if (daemonRunning) {
  print "⚠️  升级会重启 daemon, 进行中的对话会中断"
}
```

#### 4.4.1 R2 修复: `cc-linker restart` 在 launchd 下走 unload/load

**问题**: 现有 `src/cli/commands/restart.ts` 直接 kill + spawn, 在 launchd 环境下不够:
- launchd 在 plist load 时解析 `ProgramArguments` 里的 symlink 一次
- symlink 替换 (npm install 改了 `/usr/local/bin/cc-linker`) 不影响 launchd 缓存
- launchd 拉起新 daemon 时用**旧 binary path** (即使 symlink 改了)

**修法**: 改 `restart.ts`, 在 macOS launchd 环境下走 `launchctl unload && launchctl load`:

```ts
// src/cli/commands/restart.ts  改造点
async function restart() {
  if (isMacOS && existsSync(launchdPlistPath)) {
    // 走 launchctl unload/load 强制重新解析 symlink
    execFileSync('launchctl', ['unload', launchdPlistPath], { stdio: 'inherit' });
    // wait for old daemon to exit (spin 15s)
    await waitDaemonExit(15000);
    execFileSync('launchctl', ['load', launchdPlistPath], { stdio: 'inherit' });
    // wait for new daemon to start (spin 15s)
    await waitDaemonReady(15000);
  } else {
    // 纯 --daemon 模式 或 Linux, 走原 stop+start
    await stop();
    await start({ daemon: true });
  }
}
```

**R2 是已有 bug 修, 不是 v1.2 引入的**. 借这次升级 feature 顺手修。deploy-local.js 已有完整 launchctl 逻辑可复用。

**关键不变量**: `cc-linker restart` 跟 `cc-linker upgrade` 调 `cc-linker restart` 走同一份代码, 都用 launchctl unload/load (macOS launchd 环境)。

---

## 5. 数据流 B：Daemon 静态通知

### 5.1 时序

```
t=0      start --daemon
t=0~Xs   StateCoordinator.tryAcquire + WSClient.connect() + registry.sync() + startupReconcile()
t=Xs     ← bot 'ready' 事件 (post-init hook)
t=Xs     checkAndNotify (异步, 5s timeout):
           fetch → semver compare
           if update_available:
             setTimeout(() => sendCard(), notify_delay_ms)
             write notified_at = now()
           else: 静默
t=X+30s  send Feishu card (only if update_available, setTimeout 可被 clearTimeout)
```

### 5.2 24h ticker

- `setTimeout` 链（不是 `setInterval`）
- 每次触发后 setTimeout 下一次（24h 后）
- daemon 优雅退出时 clearTimeout

### 5.3 通知卡片（**静态**，无 action 按钮 — R3 修复：根据 install mode 定制内容）

**detectInstallMode 决定卡片内容**：

```ts
async function buildCardPayload(targetVersion: string) {
  const mode = await detectInstallMode();
  const changelogUrl = `https://github.com/yujuntea/cc-linker/releases/tag/v${targetVersion}`;

  switch (mode) {
    case 'npm_global':
      return {
        header: '🆕 cc-linker 有新版本',
        body: [
          `当前 v{PKG_VERSION} → v${targetVersion}`,
          '',
          '升级命令:',
          '```',
          'cc-linker upgrade',
          '```',
        ].join('\n'),
        actions: [
          { type: 'url', text: 'View changelog', url: changelogUrl },
          { type: 'button', text: 'Skip 30 天', value: { action: 'skip', version: targetVersion } },
        ],
      };

    case 'standalone_binary':
      return {
        header: '🆕 cc-linker 有新版本',
        body: [
          `当前 v{PKG_VERSION} → v${targetVersion}`,
          '',
          '你是 standalone binary 安装, 自动升级不支持',
          '请下载新 binary:',
          changelogUrl,
        ].join('\n'),
        actions: [
          { type: 'url', text: 'Download v' + targetVersion, url: changelogUrl },
          { type: 'button', text: 'Skip 30 天', value: { action: 'skip', version: targetVersion } },
        ],
      };

    case 'dev':
      return {
        header: '🆕 cc-linker 有新版本',
        body: [
          `当前 v{PKG_VERSION} → v${targetVersion}`,
          '',
          '你是 dev mode, 升级用:',
          '```',
          'bun run deploy',
          '```',
        ].join('\n'),
        actions: [
          { type: 'url', text: 'View changelog', url: changelogUrl },
          { type: 'button', text: 'Skip 30 天', value: { action: 'skip', version: targetVersion } },
        ],
      };
  }
}
```

**视觉示例**（npm global 用户）：
```
┌─────────────────────────────────────┐
│  🆕 cc-linker 有新版本              │
├─────────────────────────────────────┤
│ 当前 v0.6.3 → v0.6.4                │
│                                     │
│ 升级命令:                            │
│ cc-linker upgrade                   │
│                                     │
│ [View changelog] [Skip 30 天]      │
└─────────────────────────────────────┘
```

**视觉示例**（standalone binary 用户）：
```
┌─────────────────────────────────────┐
│  🆕 cc-linker 有新版本              │
├─────────────────────────────────────┤
│ 当前 v0.6.3 → v0.6.4                │
│                                     │
│ 你是 standalone binary 安装        │
│ 自动升级不支持, 请下载新 binary:    │
│ github.com/.../releases/tag/v0.6.4  │
│                                     │
│ [Download v0.6.4] [Skip 30 天]     │
└─────────────────────────────────────┘
```

**为什么没 [Update] 按钮**：
- v1.1 试图做一键升级，4 轮 review 砍掉
- 端用户复制 1 行命令到 terminal = 10 秒，足够轻
- 砍掉: action handler、upgrader 子进程、pending 文件、race、attack surface
- Skip 按钮**保留**（只写 user-mapping CAS，不动 binary，极简）

### 5.4 Skip 按钮

唯一保留的 action handler，逻辑极简：

```ts
async function onSkipClick(targetVersion: string, messageId: string) {
  // 1. CAS retry × 2 写 user-mapping.json
  // 2. patchCard(messageId, "✅ 已忽略 v0.6.4, 30 天内不再提醒")
  // 3. ack Feishu 200
}
```

不影响 binary，不涉及 race。

### 5.5 Skip 状态持久化

跟 `user-mapping.json` 复用 CAS：
```json
{
  "<owner-openid>": {
    "type": "session",
    "sessionUuid": "...",
    "casToken": 5,
    "skipped_versions": [
      { "version": "0.6.4", "skipped_at": "2026-06-14T10:00:00Z" }
    ]
  }
}
```

**过期策略**：30 天滚动窗口。

---

## 6. 配置

```toml
[updater]
enabled = true
check_on_status = true
check_on_start = true
notify_channel = "feishu"   # feishu | cli | none
registry_url = "auto"        # "auto" = 读用户 .npmrc registry
check_interval_hours = 24
skipped_ttl_days = 30
notify_delay_ms = 30000
test_mode = false
test_openid = "ou_test"
# priority: env > CLI flag > config
# CC_LINKER_UPDATER_DISABLED=1  全局关
```

**Registry 解析**（避免镜像延迟导致"假升级"）：
```ts
async function resolveRegistryUrl(): Promise<string> {
  const config = getConfig('updater.registry_url', 'auto');
  if (config !== 'auto') return `${config}/cc-linker/latest`;
  const { stdout } = await execFileAsync('npm', ['config', 'get', 'registry'], { timeout: 3000 })
    .catch(() => ({ stdout: 'https://registry.npmjs.org/' }));
  const base = stdout.trim().replace(/\/$/, '');
  return `${base}/cc-linker/latest`;
}
```

**关键不变量：check 的 registry 跟 apply (`npm i -g`) 的 registry 一定一致**。

---

## 7. 错误处理

### 7.1 网络 / 远端
| # | 触发 | 期望 |
|---|------|------|
| N1 | DNS 失败 / 离线 | `check_failed`, reason='offline'，不抛 |
| N2 | 5xx / 404 | `check_failed` |
| N3 | 5s timeout | `check_failed`, reason='timeout' |
| N4 | 非 JSON | `check_failed`, reason='parse_error' |
| N5 | 304 Not Modified | 复用 cache |
| N6 | 429 | retry 1 次 + 1s 退避 |

**关键不变量：网络失败 = 静默 no-op**。

### 7.2 版本解析
| # | 触发 | 期望 |
|---|------|------|
| V1 | `0.6.3` vs `0.6.3` | `up_to_date` |
| V2 | `0.6.3` vs `0.6.4` | `update_available` |
| V3 | `0.6.3-dev` vs `0.6.3` | `local_newer` |
| V4 | `0.6.3` vs `0.6.3-rc.1` | `prerelease_only` |
| V5 | `0.6.3` vs `0.6.10` | `0.6.10 > 0.6.3`（用 semver） |

**关键不变量：永远以 `dist-tags.latest` 为准**。

### 7.3 并发（**v1.2 极简**）
| # | 触发 | 期望 |
|---|------|------|
| C1 | CLI check + daemon tick 并发 | 互不干扰，`proper-lockfile` 串行写 cache |
| C2 | 启动 + 24h tick 同时到 | `notified_at` 守卫 |

**v1.1 砍掉的所有 race（B1.1/B1.2/C3/C4/C5/C6）在 v1.2 都不存在**——没有 action handler，没有 upgrader 子进程，没有 pending 文件。

### 7.4 部署形态差异
| # | 触发 | 期望 |
|---|------|------|
| D1 | npm global install | `npm i -g cc-linker@latest` 走通 |
| D2 | standalone binary | `cc-linker upgrade` 拒绝 + 提示下载新 binary；通知卡片照发 |
| D3 | dev mode (`bun run dev`) | 提示用 `bun run deploy`；通知卡片照发 |
| D4 | `bun link` | 提示 `bun run deploy`；通知卡片照发 |

**关键差异（v1.2 vs v1.1）**：v1.2 通知卡片**统一发**，不管用户是哪种部署模式。Standalone binary 用户照样收到通知，**只是 CLI 升级会拒绝**（因为检测到不能 `npm i -g` 覆盖 standalone binary）。这是 v1.1 #15 漏修的问题，v1.2 自然解决。

### 7.5 持久化 / 文件
| # | 触发 | 期望 |
|---|------|------|
| F1 | `.update-check.json` 不存在 | 视为 cache miss |
| F2 | 解析失败 | 备份到 `.bak.<ts>`，fresh fetch |
| F3 | 并发写 cache | proper-lockfile 串行 |
| F4 | ENOSPC | 静默，用 in-memory 结果 |
| F5 | user-mapping.json 不存在 | Skip 按钮静默 no-op |

### 7.6 端用户业务场景
| # | 触发 | 期望 |
|---|------|------|
| B1 | 端用户收到通知卡片 | 复制命令到 terminal 跑 |
| B2 | 端用户 idle 时收到卡片 | 卡片躺着，飞书原生行为 |
| B3 | Skip 后 30 天内又发版 | 卡片不发，CLI banner 仍显示 |
| B4 | Skip 31 天后发版 | 卡片正常推 |
| B5 | CLI 升级失败（npm exit ≠ 0） | 错误信息打印原始 stderr |
| B6 | 端用户没装飞书 | daemon 静默，CLI 仍可用 |
| B7 | 端用户多台机器 | 每台独立 |
| B8 | session 进行中用户跑 `cc-linker upgrade` | postinstall graceful stop + startupReconcile（已有） |
| B9 | 慢网络 `npm i -g` > 60s | 用户在 terminal 看得到，**自决** |
| B10 | user-mapping.json 不存在（bot 没 init-feishu） | 通知静默 no-op；CLI 仍可用 |
| B11 | Standalone binary 用户跑 `cc-linker upgrade` | 拒绝 + 提示下载新 binary；通知卡片照发 |
| B12 | Bun-only 用户（无 node） | postinstall 失败 → 用户看得到，建议用 `cc-linker upgrade` 不用 `npm i -g` |

### 7.7 配置
| # | 触发 | 期望 |
|---|------|------|
| K1 | `enabled = false` | 立即返回 `disabled` |
| K2 | `notify_channel = "cli"` | daemon 不发卡片，写 `~/.cc-linker/cc-linker.log` |
| K3 | `notify_channel = "none"` | daemon 静默；cache 仍写（CLI 用） |
| K4 | `test_mode = true` | 卡片发到 `test_openid` |

---

## 8. 测试策略

### 8.1 单测覆盖

| 文件 | LOC | 重点 |
|------|-----|------|
| `tests/unit/updater/check.test.ts` | ~150 | fetch / cache / semver / 错误 |
| `tests/unit/updater/notify.test.ts` | ~80 | 6 种 status banner |
| `tests/unit/updater/detect-install-mode.test.ts` | ~60 | 4 种部署形态 |
| `tests/unit/updater/lifecycle.test.ts` | ~80 | Skip CAS / 过期 |

### 8.2 集成测试
| 场景 | 操作 | 期望 |
|------|------|------|
| `fake-registry → CLI banner` | 起 mock server, 跑 `upgrade --check` | banner 正确 |
| `CLI upgrade apply` | mock 200 + tgz, 跑 `upgrade` | 调 `npm install`（mock 不真装） |
| `CLI upgrade --dry-run` | 跑 `upgrade --dry-run` | 打印 "would install", 不调 npm |
| `CLI upgrade --to X --yes` | mock 200, 跑 `upgrade --to 0.5.0 --yes` | 调 `npm i -g cc-linker@0.5.0` |
| `status async banner` | mock 1.5s 慢 fetch, 跑 `status` | 主 status 立即输出, banner 1s 后追加 |
| `daemon check on start` | 启 daemon, wait 30s | fetch 1 次 + 卡片 1 次 |
| `daemon Skip button` | mock Feishu action | patch 卡片 "已忽略", CAS 写 user-mapping |
| `daemon 24h ticker` | mock Date.now() 推进 25h | ticker 触发 + 写 cache |
| `standalone binary user` | mock D2 detect, 跑 `upgrade` | 拒绝 + 提示下载 binary |

**v1.1 砍掉的测试**（~10 个 card-path case）：
- ❌ Upgrader 子进程 mock
- ❌ pending_upgrade.json 3 态
- ❌ 跨重启 race
- ❌ Feishu 3s ack timeout
- ❌ PID 守卫

---

## 9. 灰度方案

| 阶段 | 触发 | 范围 | 验证信号 |
|------|------|------|---------|
| **α** | 开发者本地 + 你自己的 Mac | 0 端用户 | 单测 + e2e + 真实 `cc-linker upgrade` 一次 |
| **β** | 发 `0.6.4-rc.1` 到 npm（`next` dist-tag） | 你自己 + 1-2 个内测 | npm 下载数 + issue |
| **γ** | 发 `0.6.4` 到 npm（`latest`），默认 `enabled = true` | 全部端用户 | 1 周监控：通知接收率、CLI 升级调用率、Skip 点击率、失败 issue |

### α 阶段真实走通 checklist
- [ ] `bun run dev upgrade --check` 在 fake registry 下跑通
- [ ] `bun run dev upgrade` 跑 `npm i -g cc-linker@0.6.3`（用 `next` tag）
- [ ] postinstall.js 自动 restart daemon（**沿用现有，不改**）
- [ ] 启动检查 30s 后飞书卡片正确显示
- [ ] 卡片 Skip 按钮写 user-mapping.json 正确
- [ ] 30 天后 Skip 自动失效（mock Date.now()）
- [ ] standalone binary 探测正确

---

## 10. 风险与回滚

| 风险 | 概率 | 影响 | 回滚 |
|------|------|------|------|
| registry 被 GFW/防火墙拦 | 中 | 通知不到 | cache 24h + 失败静默 |
| `semver` 包 CVE | 极低 | 升级判断错 | 锁 `semver@^7.6.0` |
| 24h ticker 抢 CPU | 低 | daemon 慢 | 5s timeout, idle event loop |
| 卡片点击率太高 | 中 | 体验差 | Skip / 调 interval / 文档关 |
| `npm i -g` 失败 | 中 | apply 失败 | 打印原始 stderr, **用户看得到** |
| Check 跟 restart 撞车 | 极低 | 丢一次检查 | 24h 周期，丢一次不致命 |
| 新 spec 写错 compare | 极低 | 误报 | 单测 + CI gate |
| 作者发坏 tgz | 极低 | 端用户全炸 | `npm unpublish` + hotfix, sha512 校验 |

### 一键关停
1. **温和**：发文档教用户加 `[updater] enabled = false`
2. **小版本升级**：把默认改成 `enabled = false`（老用户配置文件不变所以自动停）
3. **核选项**：发 `0.6.5` 删 `updater/` 模块代码，老用户 `[updater]` section 不会被读

**关键不变量：`enabled` 默认 `true`，关停必须 ≤ 5 分钟完成**。

---

## 11. 关键不变量总结

1. **网络失败 = 静默 no-op**，绝不抛错
2. **`dist-tags.latest` 是唯一真源**
3. 写 cache 走 atomic rename + proper-lockfile
4. **Skip 是唯一保留的 action handler**（只写 user-mapping CAS，不动 binary）
5. **apply 是用户主动 CLI**，不在 daemon 路径上，没有 race
6. daemon 24h tick 跟启动 check 不重复发（`notified_at` 守卫）
7. detectInstallMode 单测 4 个 fixture
8. pre-release / dev tag 永远不当 "update"
9. 配置文件、env、CLI flag 三层覆盖
10. **不引入 upgrader 子进程**（v1.1 教训）

---

## 12. 时间线 + LOC 估算（v1.2 收尾版）

| 时段 | 内容 | LOC |
|------|------|-----|
| Day 1 上午 | `src/updater/{check,types,notify,lifecycle}.ts` + 单测 | ~250 + ~250 |
| Day 1 下午 | `src/cli/commands/upgrade.ts` + status async banner + **R1 idempotent restart** + 单测 | ~190 + ~150 |
| Day 1 晚+ | `src/feishu/updater-card.ts`（**R3 install mode 分支**）+ Skip handler + 单测 | ~180 + ~120 |
| Day 2 上午 | `src/runtime/updater-tick.ts` + 启动 hook + 单测 | ~100 + ~80 |
| Day 2 上午+ | **`src/cli/commands/restart.ts` R2 改 launchd unload/load** + 单测 | ~50 + ~40 |
| Day 2 下午 | `src/utils/paths.ts` + `src/utils/config.ts` + `package.json`（+ semver dep） | ~30 |
| Day 2 晚+ | e2e 升级走通（fake registry + 真 daemon） | ~80 |
| **合计** | | **~1520 LOC（含测试）** |

**v1.2 初版 → 收尾 +R1+R2+R3 +160 LOC**:
- R1: +10 (idempotent restart)
- R2: +90 (launchd unload/load 改造, 含单测)
- R3: +50 (install mode 卡片分支, 含单测)
- 测试: 各 +10

**vs v1.1 (1850 LOC)**: 仍省 -18%, 但 v1.2 收尾后**功能更完整** (R2 修了已有 bug, R3 修了 standalone binary 体验)。

---

## 13. Out of Scope（明确不做）

- ❌ 飞书卡片一键升级（v1.1 教训，v1.2 主动放弃）
- ❌ Daemon 自升级 / 自重启
- ❌ CHANGELOG 自动 parse + 卡片展示
- ❌ 跨设备协调
- ❌ 多渠道通知
- ❌ `min_version` 黑名单强制升级
- ❌ 开发者侧 `bun run deploy` 整合进 `cc-linker upgrade`
- ❌ 改 `scripts/postinstall.js` / `bun run deploy` / `daemon.ts` / `package.json` bin

### 13.1 v1.1 曾计划但 v1.2 砍掉

| v1.1 计划 | v1.2 状态 | 原因 |
|-----------|----------|------|
| `src/upgrader/` 子进程模型 | ❌ 砍 | race 多、维护复杂 |
| `pending_upgrade.json` 状态协调 | ❌ 砍 | 同上 |
| Feishu card [Update] 按钮 | ❌ 砍 | UX 跟 magic 风险不划算 |
| 改 `postinstall.js` 加 bun fallback | ❌ 不需要 | 用户主动跑 CLI 看得到 |
| B1.1/B1.2 PID 守卫 | ❌ 不需要 | 无子进程协调 |
| 新 Bot 兜底逻辑 | ❌ 不需要 | 无 pending 状态要恢复 |
| active session 警告（B2） | ❌ 不需要 | 不自动升级 |
| launchctl unload/load 改写 | ❌ 不需要 | 沿用现有 `cc-linker restart` |

---

## 14. 决策记录

| 决策 | 选择 | 否决 |
|------|------|------|
| 一键升级？ | **不**做（v1.1 教训） | v1.1 upgrader 子进程 |
| 数据源 | `https://registry.npmjs.org/cc-linker/latest` | GitHub releases API |
| Semver 库 | `semver@^7.6.0`（新加 dep） | 自己写 compare |
| Skip 状态位置 | 现有 user-mapping.json CAS | 独立文件 |
| apply 路径 | 用户主动 `cc-linker upgrade` CLI | bot fork exec |
| 卡片触发点 | daemon 启动 + 24h tick | 每条飞书消息都查 |
| 默认行为 | `enabled = true` | opt-in |
| Skip TTL | 30 天滚动窗口 | 永久 |
| Pre-release | 只看 `dist-tags.latest` | 也看 next |
| Caching | 24h TTL + ETag | 1h TTL |
| `check_interval_hours` 默认 | 24 | 6 |
| **卡片 action 按钮** | **只 Skip + Changelog** | v1.1 的 Update |

---

## 15. v1.1 → v1.2 迁移路径（实现期考虑）

如果有人已经按 v1.1 实现了一部分：
- `src/updater/` 完全保留，直接复用
- `src/cli/commands/upgrade.ts` 保留，去掉 `--from-card` 模式
- `src/runtime/updater-tick.ts` 保留，**不发** action 卡片
- `src/feishu/updater-card.ts` 改为静态 builder（移除 card action callback 注册）
- `src/upgrader/` 整个目录**删除**
- `~/.cc-linker/pending_upgrade.json` 启动时检测，**存在则警告并删除**（兼容旧版）
- 单测按 v1.2 矩阵重写

---

## 16. 与 v1.1 的最终对比

| 维度 | v1.1 | v1.2 | 差异 |
|------|------|------|------|
| 端用户升级步骤 | 点 1 次 Update | 复制 1 行命令 | v1.2 多 10 秒 |
| 端用户升级复杂度 | 完全透明 | 用户在 terminal 看得到 | v1.2 更可控 |
| 实现复杂度 | 1850 LOC, 6 race | **1360 LOC, 2 race** | v1.2 简单 30% |
| 涉及文件 | 2 状态文件 + 1 子进程协调 | 1 状态文件 | v1.2 简单 50% |
| 攻击面 | 1 action handler | 1 简单 action (Skip) | v1.2 小 |
| Standalone binary 支持 | ❌ #15 漏修 | ✅ 自然支持 | v1.2 完整 |
| launchd KeepAlive 问题 | ❌ #2 漏修 | ✅ 不触发 | v1.2 完整 |
| Bun-only 用户 | ❌ #C2 漏修 | ✅ 用户看得到 | v1.2 完整 |
| Feishu 3s ack timeout | ❌ #8 漏修 | ✅ 不触发（卡片是 daemon 主动发） | v1.2 完整 |
| 估时 | 2.5 天 | **1.5 天** | v1.2 快 40% |
| "magic" 程度 | 高 | 低 | v1.2 用户更安心 |
