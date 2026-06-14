# cc-linker 轻量自动升级 v1 设计

**日期：** 2026-06-14
**版本：** v1
**状态：** 设计稿（待评审）
**作者：** wuyujun + brainstorm session

---

## 1. 背景与现状

### 1.1 工具当前形态
- **开发者**（wuyujun）：在本地通过 `bun run deploy` 一条命令把 cc-linker 升级到自己的 Mac
- **端用户**（开源后通过 `npm i -g cc-linker` 安装）：装一次后再无任何升级信号，靠记忆 / 刷 GitHub releases 升级

### 1.2 已有基础（无需重做）
- `scripts/postinstall.js` —— 已经在 `npm install -g` 后检测 daemon 并自动 `cc-linker restart`（端用户 apply 阶段已托管）
- `bun run deploy` —— 开发者侧 7 项 hardening 的全流程（atomic build + sha256 校验 + launchd unload/load + 版本验证）
- `src/version.ts` —— `PKG_VERSION` 暴露
- `src/agent-view/version-guard.ts` —— 同模式（检查子进程 `claude` 版本）可借鉴

### 1.3 现状问题（端用户视角）
1. 升级完全靠**主动**记忆
2. 没有"有新版本"提示
3. 没有"一键升级"入口（虽然一条 `npm i -g` 就能搞定，但对非开发者不友好）
4. 端用户跑在后台的 daemon 永远停在装的那一刻

### 1.4 npm 真源（live verify）
```
cc-linker@0.6.3 | MIT | deps: 9 | versions: 20
dist-tags.latest: 0.6.3
unpackedSize: 19.7 MB
```

---

## 2. 设计目标 / 非目标

### 2.1 Goals
- **G1**：端用户**被动收到**"有新版本"提示，零记忆负担
- **G2**：提示后端用户**一键升级**（一条命令 / 一张卡片按钮）
- **G3**：daemon 升级后**自动 restart**（已由 `postinstall.js` 实现，零新代码）
- **G4**：开发者**继续用** `bun run deploy`，零影响
- **G5**：网络 / 解析 / CAS / 并发 / 部署形态 5 类失败场景**全部静默 no-op**，不污染主流程
- **G6**：≤ 5 分钟可一键关停（默认 `enabled = true` + 配置文件 override）

### 2.2 Non-Goals
- ❌ Daemon 自己 `npm install -g` + 自重启（lifecycle 复杂、跟 postinstall 竞争、surprise 用户）
- ❌ CHANGELOG 自动 parse + 卡片展示（v2 再做，先 link 到 GitHub releases URL）
- ❌ 跨设备协调（一台 Skip 全设备 Skip）
- ❌ 多渠道通知（email / slack / discord）
- ❌ `min_version` 黑名单强制升级（留到真 CVE 再说）
- ❌ 改 `bun run deploy` / `scripts/postinstall.js` / `daemon.ts` / `package.json` bin

---

## 3. 架构总览

### 3.1 一句话总结
`src/updater/` 新模块 + `cc-linker upgrade` CLI + daemon 24h ticker + Feishu 通知。`apply` 阶段全交给 `npm i -g` + 现有 `postinstall.js`，**不碰 binary，不碰 daemon lifecycle**。

### 3.2 模块职责

```
src/updater/
  check.ts     # 纯函数: fetch npm registry + 24h 缓存 + semver 对比
                # 三个调用方共享: CLI / daemon / 集成测试
                # 无副作用 (只读写 ~/.cc-linker/.update-check.json)

  notify.ts    # 纯函数: UpdateInfo → 文本 banner / console 输出
                # 单测覆盖所有 status

  types.ts     # UpdateInfo, CachedCheck, SkippedVersionEntry
                # 共享给 CLI / daemon / 测试

  lifecycle.ts # 状态协调: 检查 / 写 user-mapping.json 的 skipped_versions
                # 走现有 CAS 协议, 不绕过

src/cli/commands/upgrade.ts   # CLI 入口
src/runtime/updater-tick.ts   # Daemon 入口 (启动 + 24h)
src/feishu/updater-card.ts    # Feishu 卡片构造
```

### 3.3 三个触发点，同一个 check

| 触发点 | 频率 | 行为 | 失败处理 |
|--------|------|------|---------|
| CLI: `cc-linker upgrade --check` | 用户主动 | 查 registry（命中 24h 缓存就跳过），打印 banner 到 stdout | 静默 no-op |
| CLI: `cc-linker status` | 用户主动 | **异步**触发 check（1s 软超时），主 status 输出后再打印 banner 行 | 超时静默，banner 不出现 |
| CLI: `cc-linker start`（前台，非 daemon） | 用户主动 | 同步查一次（5s timeout），打印 banner 到 stdout 后再启 bot | 静默 no-op |
| Daemon: `cc-linker start --daemon` 启动后 | 一次 | 同步查一次（5s timeout），新版本 → sleep 30s → 发 Feishu 卡片 | 跳过本次 |
| Daemon 24h ticker | 每天 | 跟启动相同 | 静默 no-op |

**关键差异**：
- `cc-linker upgrade --check` / `status` / `start`（前台）= 走 24h 缓存（用 `check()` 共享函数）
- `cc-linker upgrade`（无 flag，用户主动 apply）= **强制不走缓存**（用 `check({ force: true })`）

### 3.4 数据流（高层）

```
                    ┌────────────────────────┐
                    │  registry.npmjs.org/   │
                    │    cc-linker/latest    │
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
   │ CLI: notify.ts     │  │ Daemon:              │
   │  → console.log     │  │  updater-tick.ts     │
   │  → cc-linker       │  │  → updater-card.ts   │
   │     upgrade apply  │  │  → im.v1.message     │
   │                    │  │     .create()        │
   └────────┬───────────┘  └──────────┬───────────┘
            │                          │
            ▼                          ▼
   ┌────────────────────────────────────────────┐
   │  apply:  npm i -g cc-linker@latest        │
   │          ↓ (postinstall.js 自动接)         │
   │          ↓ cc-linker restart               │
   │          ↓ (无 main upgrade 代码)           │
   └────────────────────────────────────────────┘
```

---

## 4. 数据流详细

### 4.1 数据流 A：CLI 触发

#### `cc-linker upgrade --check` 状态机

```
entry: upgrade --check
  ↓
read .update-check.json (TTL 24h?)
  ├─ cache hit (within TTL)  → return cached UpdateInfo
  └─ cache miss / stale      → GET registry.npmjs.org/cc-linker/latest
                                 ├─ 2xx + valid JSON → parse + semver compare + write cache
                                 └─ 非 2xx / 非 JSON / timeout → write cache{error:reason} + return check_failed
  ↓
notify.formatBanner(info) → console.log
  ↓
exit 0 (banner-only, 不报错)
```

#### `cc-linker upgrade`（无 `--check`，用户主动 apply）

```
entry: cc-linker upgrade [--dry-run] [--to <version>]
  ↓
  ├── --dry-run: 强制不 apply, 只 print "would install X (current Y), no changes" + exit 0
  ↓
check({ force: true }) (强制不走缓存, 走 fresh fetch)
  ↓
case status:
  up_to_date        → print "已是最新", exit 0
  update_available  → confirmPrompt("升级到 v{latest}?")
                          ↓ yes → execFileSync('npm', ['install', '-g', 'cc-linker@latest'])
                                  → (postinstall.js 自动 restart daemon)
                                  → print "✅ 升级完成, daemon 已自动重启", exit 0
                          ↓ no  → exit 0
  local_newer       → refuse: "本地版本新于 published, 跳过", exit 0
  prerelease_only   → refuse: "stable 已是最新, 跳过 pre-release", exit 0
  check_failed      → refuse: "无法检查, 请稍后重试", exit 1
  disabled          → exit 0
```

`--to <version>` 走 `npm i -g cc-linker@<version>` 精确版本（不走 latest），用于回退到旧版本。

#### CLI 跟 daemon 协调（v1.1 合并后）

跟 owner.lock 完全解耦（不碰它的字段）。互斥信号 = `pending_upgrade.json` 存在 + pid alive。

- **文件存在 + pid alive** = 升级进行中, 拒绝新 apply
- **文件存在 + pid dead** = 上一轮 crash, 接管（覆盖）
- **文件不存在** = 可发起新升级

读 `readFileSync + parseInt + process.kill(pid, 0)`；写走 atomic rename。CLI 路径下 `chat_id` 和 `message_id` 为 null。

> 早期设计另开 `.upgrading.lock` 是过度拆分, v1.1 合并为单文件。

### 4.2 数据流 B：Daemon 启动检查

#### 时序（基于 post-init hook，不是 wall clock）

```
t=0      start --daemon
t=0~Xs   StateCoordinator.tryAcquire + WSClient.connect() + registry.sync() + startupReconcile()
t=Xs     ←  bot 'ready' 事件触发 (post-init hook)
            这里调 checkAndNotify (不阻塞其他 init)
t=Xs     checkAndNotify:
           fetch (timeout 5s, 1 retry)
           parse + semver compare
           若 update_available:
              setTimeout(() => sendCard(), notify_delay_ms)  ← 来自 config
              写 notified_at = now() 到 .update-check.json
           其它 status: 静默
t=X+30s  send Feishu card (only if update_available, setTimeout 可被 daemon shutdown clearTimeout)
```

#### 30s 缓冲的语义
- **不是** wall clock，是 `bot ready` 事件后的延迟
- 30s 给 bot 时间：warmup cache、active session 接管、spool reconcile
- launchd 启动后用户没在看屏幕，30s 缓冲
- 可配：`[updater] notify_delay_ms = 30000`（K 范围 0-300000）
- 实现用 `setTimeout`，daemon 优雅退出时 `clearTimeout`（不留 dangling timer）

#### 双发保护
- 启动检查成功后写 `notified_at = now()` 到 cache
- 24h ticker 看到 `notified_at` 在 24h 内就跳过（不重复发卡片，但 banner 仍可在 CLI 里看到）

### 4.3 数据流 C：Feishu 卡片 + 用户点按钮（v1.1 重构）

#### 核心矛盾

Bot 进程 = **即将被自己升级流程杀死的进程**。原 spec 让 Bot 既当"升级指挥官"又当"升级状态展示者"，但 Bot 会在 `cc-linker restart` 那一刻死亡，polling 永不结束 → 卡片永远卡在"升级中..."。

#### 解决：upgrader 子进程模型

状态管理权**完全**移交给独立 upgrader 子进程。Bot 只做"发卡片 + 写持久化状态 + spawn 子进程"，立刻返回。

#### 持久化文件（v1.1 合并：lock + pending = 单文件）

```
~/.cc-linker/pending_upgrade.json     # 合并了原 .upgrading.lock 的所有字段
{
  "pid": 111,                          # 谁在跑这个 upgrade
  "source": "card" | "cli",            # 来源
  "started_at": 1718...,               # 起始时间戳
  "target_version": "0.6.4",           # 目标版本
  "chat_id": "oc_xxx" | null,          # null for CLI
  "message_id": "om_xxx" | null,       # null for CLI
  "patched_by_upgrader": false         # upgrader 完成 patch 卡片后置 true
}

~/.cc-linker/.update-check.json       # 已存在, 复用 (status 字段追踪当前)
```

**合并理由**：原 `.upgrading.lock` 和 `pending_upgrade.json` 字段 60% 重复, 生命周期重叠, 状态机分裂。合并后:
- **文件存在 + pid alive** = 升级进行中, 互斥
- **文件存在 + pid dead** = 上轮 crash, 接管/兜底
- **文件不存在** = 无升级

文件删除 = 升级完成 (CLI 路径由 upgrade runner 删; card 路径由新 Bot 删)

#### 完整时序

```
T0      用户在飞书点 [Update]
T0+0.1s Bot 收 card action callback (Feishu 3s ack timeout)
T0+0.1s ├─ 写 pending_upgrade.json { message_id, chat_id, target_version, patched_by_upgrader: false }
T0+0.1s ├─ 写 .upgrading.lock { pid: bot.pid, target_version, source: "card" }
T0+0.1s ├─ 探测 .upgrading.lock 是否已存在 (上一轮 crash?)
T0+0.1s │   └─ 已存在 + pid alive → 拒绝 (patch 卡片 "升级中, 请勿重复", ack Feishu 200)
T0+0.1s │   └─ 已存在 + pid dead  → 接管, 覆盖 lock
T0+0.2s ├─ patch 卡片 → "升级中..." (best-effort, 500ms timeout, 失败无所谓)
T0+0.3s ├─ spawn: cc-linker upgrade --from-card --message-id=om_xxx --chat-id=oc_xxx --target-version=0.6.4
T0+0.3s │   (detached: true, stdio: logFd, child.unref())
T0+0.3s └─ ack Feishu 200, return
                                  
T0+0.3s Bot 返回其他工作, 之后会被 postinstall 杀 (见下)

T+1s    Upgrader 进程启动
         cc-linker 在 PATH 是 OLD 版本 (用户 spawn 时还没装新)
         但 npm i -g 会替换, postinstall 时 PATH 已是 NEW
T+3s    Upgrader 跑 `npm i -g cc-linker@latest` (stdio pipe 到 log)
T+4s    npm install 主体完成
         → postinstall.js 触发
         → postinstall 调 `cc-linker restart` (PATH 里已是 NEW binary)
         → restart 读 owner.lock 找 Bot PID
         → kill Bot (Bot 正在跑老代码, 死亡)
T+5s    Upgrader 看到 `npm install` exit code 0
T+5.1s  Upgrader patch 卡片 → "✅ 已升级到 v0.6.4, daemon 重启中..."
T+5.2s  Upgrader 写 pending_upgrade.json.patched_by_upgrader = true
T+5.3s  Upgrader 删 .upgrading.lock
T+5.4s  Upgrader exit 0
                                  
T+8s    新 Bot 启动 (跑 NEW binary)
T+10s   新 Bot 读 pending_upgrade.json
         ├─ patched_by_upgrader = true  → 删文件, 不动作 (upgrader 已搞定)
         ├─ .upgrading.lock 仍存在 (PID 还活) → spin wait 30s 再检查
         ├─ patched_by_upgrader = false (upgrader crash) → 兜底 patch 卡片 "❌ 状态未知, 请跑 cc-linker status 或手动 npm i -g cc-linker@latest"
         └─ 文件不存在 → 不动作
T+11s   新 Bot 正常 ready, 发用户消息
```

#### 关键 race 与裁决（v1.1 加 B1 双层防护）

| Race | 谁赢 | 保证 |
|------|------|------|
| Bot patch 卡片 vs Bot 被杀 | 都无所谓 | Bot 用 500ms 超时, 失败无所谓, upgrader 会 patch |
| npm i -g vs `cc-linker restart` 杀 Bot | **postinstall 杀 Bot** | npm lifecycle 顺序: install 主体 → postinstall (不可打断) |
| Upgrader patch 卡片 vs Upgrader 被杀 | **新 Bot 兜底** | 新 Bot 看到 patched=false → 兜底 patch "❌ 状态未知" |
| 新 Bot 启动 vs Upgrader 还在跑 | **新 Bot 等** | 新 Bot 看到 pending 存在 + pid 活 → spin wait 30s |
| 用户点 [Update] 两次 (同 Bot 内) | **第二次拒绝** | Bot handler 查 pending 已存在 + 同 target_version → patch "升级中, 请勿重复" |
| **用户点 [Update] + Bot 已死 + 新 Bot 收重试** (跨重启) | **新 Bot + Upgrader PID 守卫双层** | 见下方 B1.1 + B1.2 |
| postinstall 跑 `cc-linker restart` 时 cc-linker 在 PATH 是新版 | OK | npm install 先 replace symlink 再跑 postinstall |

##### B1.1 — 新 Bot 收 Update callback 时

```ts
async function onUpdateClick(targetVersion: string, chatId: string, messageId: string) {
  const existing = await readPendingUpgrade();
  if (existing && isAlive(existing.pid)) {
    if (existing.target_version === targetVersion) {
      // 同次升级, 拒绝
      await patchCard(messageId, '升级中, 请勿重复');
      return;
    }
    // 不同版本: 接管 (覆盖 pending, 由新的 upgrader 接管)
    // 罕见: dist-tags.latest 唯一, target_version 应该一致
  }
  if (existing && !isAlive(existing.pid)) {
    // 上一轮 crash, 接管
    logger.warn(`Takeover from dead pid ${existing.pid}`);
  }
  // 走正常流程: 写 pending + spawn upgrader
}
```

##### B1.2 — Upgrader 每次 destructive 操作前 check pid 所有权

```ts
async function upgraderRunner() {
  // 启动后第一次 check: 自己是 owner
  const lock = await readPendingUpgrade();
  if (lock.pid !== process.pid) {
    logger.warn('Another upgrader has taken over, aborting');
    return;
  }

  await runNpmInstall();
  // ↑ 期间如果有别的 upgrader 接管, lock.pid 已经变了

  // patch 前再 check (PID 守卫)
  const lock2 = await readPendingUpgrade();
  if (lock2.pid !== process.pid) {
    logger.warn('Lost ownership during npm install, aborting patch');
    return;
  }

  await patchCard(...);
  await markPendingPatched();
  await deletePendingUpgrade();
}
```

**核心不变量**: 文件存在期间, `pid` 字段是**单一真相**。谁先写入谁就拥有所有权, 后续每次 destructive 操作必须 check。

#### 为什么不能用 bot poll cache 文件

- Bot 进程会被杀，polling 终止 → 卡片永远卡住
- 改用 **upgrader 直接 patch 卡片**，因为 upgrader 跟 postinstall 是**独立进程**，不被影响
- 新 Bot 仅作 safety net，不参与正常流程

#### Skip / Changelog 按钮

| 按钮 | 行为 | 卡片演化 |
|------|------|---------|
| `Update` | 见上文完整时序 | "升级中..." → "✅/❌" |

#### 卡片内容变体（B2 UX 警告）

**默认版本**（无活跃 session）：
```
┌─────────────────────────────────────┐
│  🆕 cc-linker 有新版本              │  ← header
├─────────────────────────────────────┤
│ 当前 v0.6.3 → v0.6.4                │
│                                     │
│ [View changelog] [Skip] [Update]    │  ← action row
└─────────────────────────────────────┘
```

**有活跃 session 时**（用 `UserManager.entries` 探测 active sessions）：
```
┌─────────────────────────────────────┐
│  ⚠️  cc-linker 升级会重启 daemon    │  ← header (warning 风格)
├─────────────────────────────────────┤
│ 当前 v0.6.3 → v0.6.4                │
│                                     │
│ 🚨 检测到 1 个会话进行中             │
│ 升级将中断当前对话, 完成后可 resume  │
│                                     │
│ [View changelog] [Skip] [我知道了, 升级]  ← 按钮文案变
└─────────────────────────────────────┘
```

**决策**: 探测到 active session 时**只改文案 + 按钮 label**, **不**做 confirm step。理由:
- cc-linker 现状 `cc-linker restart` 本来就会中断流式, 升级自动 restart 不比手动更严重
- 做 confirm step 会让"点击 → 二次确认 → 升级" 变成 3 步, 体验差
- 信息告知足够, 决策权给用户

探测方式:
```ts
const activeSessions = Object.values(userManager.entries).filter(e =>
  e.type === 'session' || e.type === 'pending_new_session_claimed'
);
const hasActive = activeSessions.length > 0;
```
| `Skip` | 写 `skipped_versions` 到 user-mapping.json（CAS retry × 1），patch 卡片 "已忽略 v0.6.4, 30 天内不再提醒" | 终态 |
| `View changelog` | URL = `https://github.com/yujuntea/cc-linker/releases/tag/v0.6.4` | 卡片不变 |

#### Skip 状态持久化

跟 `user-mapping.json` 复用 CAS，**不绕过**：
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

**过期策略**：30 天滚动窗口
```ts
const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
return (entry.skipped_versions ?? []).filter(
  s => Date.now() - new Date(s.skipped_at).getTime() < THIRTY_DAYS
);
```

---

## 5. 错误处理（18 个边界场景）

### 5.1 网络 / 远端失败
| # | 触发 | 期望 | 测信号 |
|---|------|------|--------|
| N1 | DNS 失败 / 离线 | `check_failed`, 不抛 | mock fetch throw EAI_AGAIN |
| N2 | registry 5xx | 同 N1 | mock 500/502/503 |
| N3 | 404（包不存在） | 同 N1，reason='not_found' | mock 404 |
| N4 | 5s timeout | reason='timeout' | mock fetch 永不返回 |
| N5 | registry 返回非 JSON | reason='parse_error' | mock 200 + text/html |
| N6 | 304 Not Modified | 复用本地 cache | mock 304 |
| N7 | 429 rate limit | retry 1 次 + 1s 退避 | mock 429 |

**关键不变量：网络失败 = 静默 no-op。**

### 5.2 版本解析 / 比较
| # | 触发 | 期望 | 测信号 |
|---|------|------|--------|
| V1 | `0.6.3` vs `0.6.3` | `up_to_date` | 正常 |
| V2 | `0.6.3` vs `0.6.4` | `update_available` | 正常 |
| V3 | `0.6.3-dev` vs `0.6.3` | `local_newer` | dev prerelease |
| V4 | `0.6.3` vs `0.6.3-rc.1` | `prerelease_only` | stable 优先 |
| V5 | `0.6.3` vs next=`0.7.0-beta.1` latest=`0.6.3` | `up_to_date` | 不主动推 next |
| V6 | 解析失败 | `check_failed` 防御性 | mock 坏字符串 |
| V7 | `0.6.3` vs `0.6.10` | `0.6.10 > 0.6.3`（用 semver） | 防字符串陷阱 |

**关键不变量：永远以 `dist-tags.latest` 为准。**

### 5.3 并发 / 状态冲突
| # | 触发 | 期望 | 测信号 |
|---|------|------|--------|
| C1 | CLI check + daemon tick 并发 | 互不干扰，proper-lockfile 串行写 | 并行 5 个 |
| C2 | 启动 + 24h tick 同时到 | `notified_at` 守卫跳过 tick | mock mtime |
| C3 | 卡片 Update 点两次 | 第二次 `upgrading=true` → 拒绝 | mock 双击 |
| C4 | Skip 时 user-mapping.json 已被改 | CAS retry 1 次 | mock CAS 失败 |
| C5 | `cc-linker upgrade` 中发飞书消息 | 走 graceful stop, spool 落盘 | e2e |
| C6 | `upgrade` 跑中再来一次 | owner.lock 拒绝 | 第二次 spawn |

### 5.4 部署形态差异
| # | 触发 | 期望 | 探测 |
|---|------|------|------|
| D1 | npm global | `npm i -g cc-linker@latest` | `/usr/local/lib/node_modules/cc-linker/package.json` |
| D2 | standalone binary | 拒绝 + 提示下载新 binary | `__dirname` 不在 node_modules |
| D3 | dev mode | 提示 `bun run deploy` | `argv[1]` 含 `src/index.ts` |
| D4 | `bun link` | 提示 `bun run deploy` | symlink → 项目 |
| D5 | 探测失败 | 走 D1，失败 fallback D2 | try/catch |

### 5.5 持久化 / 文件
| # | 触发 | 期望 | 测信号 |
|---|------|------|--------|
| F1 | `.update-check.json` 不存在 | 视为 cache miss | 单测 |
| F2 | 解析失败（半写） | 备份到 `.bak.<ts>`，fresh fetch | mock 坏 JSON |
| F3 | 并发写 cache | proper-lockfile 串行 | mock 并发 |
| F4 | 写时 ENOSPC | 静默, 用 in-memory 结果 | mock ENOSPC |
| F5 | user-mapping.json 不存在 | 启动检查静默（无 owner），CLI 照常 | 集成测试 |
| F6 | `~/.cc-linker/` 不存在 | CLI 首次跑自动建 | 单测 |

**写 cache 走 atomic write：**
```ts
const tmp = `${path}.tmp.${process.pid}`;
await Bun.write(tmp, JSON.stringify(payload));
await rename(tmp, path);  // atomic on POSIX
```

### 5.6 端用户业务场景
| # | 触发 | 期望 |
|---|------|------|
| B1 | 端用户点 Update | Bot 写状态 + spawn upgrader + ack; Upgrader 跑 npm i -g + patch 卡片 ✅/❌; 新 Bot 启动后清理 pending_upgrade.json |
| B2 | 端用户 idle 时收到卡片 | 卡片躺着，飞书原生行为 |
| B3 | Skip 后 30 天内又发版 | 卡片不发，CLI banner 仍显示 |
| B4 | Skip 31 天后发版 | 卡片正常推 |
| B5 | 升级失败（npm exit ≠ 0） | Upgrader patch "❌ 失败: {stderr snippet}"，不重试，不删 .upgrading.lock；新 Bot 看到 lock 存在但 PID 死 → 接管，patch 兜底 "❌ 状态未知, 请手动 npm i -g cc-linker@latest" |
| B6 | 端用户没装飞书 | daemon 静默，CLI 仍可用 |
| B7 | 端用户多台机器 | 每台独立（不跨设备协调） |
| B8 | session 进行中升级 | postinstall graceful stop + startupReconcile 恢复（已有路径） |
| B9 | 慢网络 `npm i -g` > 60s | Upgrader 仍在跑（postinstall 还没返回），新 Bot spin wait 30s；超时仍 patch "❌ 状态未知"，**实际升级可能仍在进行**（卡片 caveat） |
| B10 | Upgrader 进程被 OOM 杀 | pending_upgrade.json.patched_by_upgrader 仍为 false；新 Bot 兜底 patch |
| B11 | 用户点 Update 时 Bot 已被别的流程杀（race） | 飞书 3 次重试，新 Bot 收到 callback，照常处理 |
| B12 | user-mapping.json 不存在（bot 没 init-feishu） | 启动检查静默 no-op；`notify_channel = none` 隐式 |
| B13 | bun-only 用户没装 node | postinstall 失败 → 升级"成功"但 daemon 没 restart；Upgrader 检 postinstall 退出码 → patch "❌ postinstall 失败, 请手动 cc-linker restart" |

### 5.7 配置
```toml
[updater]
enabled = true
check_on_status = true
check_on_start = true
notify_channel = "feishu"   # feishu | cli | none
registry_url = "auto"        # "auto" = 读用户 .npmrc registry; 或写死 https://...
check_interval_hours = 24
skipped_ttl_days = 30
notify_delay_ms = 30000      # daemon ready 后多久发卡片
test_mode = false            # true = 卡片发到 test_openid 而非真实 owner
test_openid = "ou_test"
# priority: env > CLI flag > config
# CC_LINKER_UPDATER_DISABLED=1  全局关
```

| # | 触发 | 期望 |
|---|------|------|
| K1 | `enabled = false` | 立即返回 `disabled` |
| K2 | `notify_channel = "cli"` | daemon 启动 / tick 时**不**发 Feishu 卡片，改写 `~/.cc-linker/cc-linker.log`（用 `logger.info`）一行 banner；CLI `status` / `upgrade --check` 仍照常 |
| K3 | `notify_channel = "none"` | daemon 侧完全静默, 跳过发卡片 + 不写 log；cache 仍写（CLI 用） |
| K4 | 删 `.update-check.json` | 下次 fresh fetch |
| K5 | section 不存在 | 用默认值（enabled=true, check_interval_hours=24, skipped_ttl_days=30, notify_delay_ms=30000, test_mode=false） |

#### Registry 解析（避免镜像延迟导致"假升级成功"）

```ts
async function resolveRegistryUrl(): Promise<string> {
  const config = getConfig('updater.registry_url', 'auto');
  if (config !== 'auto') return `${config}/cc-linker/latest`;
  // auto: 读用户 .npmrc, 跟 npm i -g 用同一个 registry
  const { stdout } = await execFileAsync('npm', ['config', 'get', 'registry'], { timeout: 3000 })
    .catch(() => ({ stdout: 'https://registry.npmjs.org/' }));
  const base = stdout.trim().replace(/\/$/, '');
  return `${base}/cc-linker/latest`;
}
```

**关键不变量：check 的 registry 跟 apply (`npm i -g`) 的 registry 一定一致**。否则用户看到 "v0.6.4 available" 但 apply 装到 v0.6.3（镜像延迟）。

**优先级：env > CLI flag > config**

---

## 6. 测试策略

### 6.1 单测覆盖矩阵

| 文件 | LOC | 场景数 | 重点 |
|------|-----|--------|------|
| `tests/unit/updater/check.test.ts` | ~150 | 16 | fetch / cache / semver / 错误 |
| `tests/unit/updater/notify.test.ts` | ~80 | 7 | 6 种 status banner |
| `tests/unit/updater/detect-install-mode.test.ts` | ~60 | 5 | 5 种部署形态 |
| `tests/unit/updater/lifecycle.test.ts` | ~120 | 6 | Skip CAS / 过期 |

### 6.2 集成测试

#### CLI 路径
| 场景 | 操作 | 期望 |
|------|------|------|
| `fake-registry → CLI banner` | 起 mock server, 跑 `upgrade --check` | banner 正确 |
| `CLI upgrade apply` | mock 200 + tgz, 跑 `upgrade` | 调 `npm install`（mock 不真装） |
| `CLI upgrade --dry-run` | 跑 `upgrade --dry-run` | 打印 "would install X", 不调 npm |
| `CLI upgrade --to 0.6.2` | 跑 `upgrade --to 0.6.2` | 调 `npm i -g cc-linker@0.6.2` |
| `status async banner` | mock 1.5s 慢 fetch, 跑 `status` | 主 status 立即输出, banner 1s 后追加 |

#### 卡片路径（upgrader 子进程模型，**新增**）
| 场景 | 操作 | 期望 |
|------|------|------|
| `card Update happy path` | mock Feishu action, mock npm install 成功, mock postinstall 成功 | Bot 写 pending + lock + spawn; Upgrader patch ✅; 新 Bot 清理文件 |
| `card Update double click` | 1s 内点 2 次 Update | 第一次正常, 第二次 patch "升级中, 请勿重复" |
| `card Update + slow npm` | mock `npm install` 跑 90s | Upgrader 仍在跑 → patch 兜底超时; 实际升级可能成功（B9 caveat） |
| `card Update + upgrader crash` | mock Upgrader 进程被 SIGKILL 在 patch 前 | pending.patched=false; 新 Bot 兜底 patch "❌ 状态未知" |
| `card Update + new bot spins` | mock 新 Bot 启动时 Upgrader 还在跑 | 新 Bot spin wait 30s, 看到 patched=true 后清理 |
| `card Update + test_mode` | `[updater] test_mode=true, test_openid=ou_test` | 卡片发到 test_openid 而非 owner |
| `card Update + active session` | mock UserManager 有 1 个 active session | 卡片 header 改 warning, 按钮文案 "我知道了, 升级" |
| `card Update + 双次同次 (B1.1)` | mock 第一次 click 1.5s 内又 click 一次 | 第一次正常, 第二次 patch "升级中, 请勿重复" |
| `card Update + 跨重启 (B1.1+1.2)` | mock Bot 死 → 新 Bot 收 Feishu 重试 | 新 Bot 查 pending 存在 (pid dead) → 接管, 写新 pending, spawn 新 upgrader; 旧 upgrader 在 destructive op 前 check pid mismatch → abort |
| `card Skip + CAS conflict` | mock UserManager.casUpdate 失败 1 次 | retry 1 次, 仍失败 patch "状态冲突, 请重试" |
| `card Skip + expired entries` | mock user-mapping 含 35 天前 skip | getActiveSkips 过滤, 新版本正常推 |

### 6.3 α 阶段真实走通 checklist
- [ ] `bun run dev upgrade --check` 在 fake registry 下跑通
- [ ] `bun run dev upgrade` 跑 `npm i -g cc-linker@0.6.3`（用 `next` tag）
- [ ] postinstall.js 自动 restart daemon
- [ ] 启动检查 30s 后飞书卡片正确显示
- [ ] 卡片 Skip 按钮写 user-mapping.json 正确
- [ ] 30 天后 Skip 自动失效（mock Date.now()）
- [ ] standalone binary 探测正确

---

## 7. 灰度方案

| 阶段 | 触发 | 范围 | 验证信号 |
|------|------|------|---------|
| **α** | 开发者本地 + 你自己的 Mac | 0 个端用户 | 单测 + e2e + 真实 npm i -g 一次 |
| **β** | 发 `0.6.4-rc.1` 到 npm（`next` dist-tag） | 你自己 + 1-2 个内测 | npm 下载数 + issue |
| **γ** | 发 `0.6.4` 到 npm（`latest`），默认 `enabled = true` | 全部端用户 | 1 周监控：调用率、点击率、升级率、失败 issue |
| **δ** | 1 周后调参 | | |

### γ 阶段监控埋点（**这次不写代码**）
1. `.update-check.json` 命中率
2. `cc-linker upgrade` 调用次数 vs `npm i -g` 升级数（用 `npm view cc-linker` 比对）
3. 卡片 Skip 比例
4. Apply 失败次数

---

## 8. 风险与回滚

| 风险 | 概率 | 影响 | 回滚 |
|------|------|------|------|
| registry 被 GFW/防火墙拦 | 中 | 通知不到 | cache 24h + 失败静默 |
| `semver` 包 CVE | 极低 | 升级判断错 | 锁 `semver@^7.6.0` |
| 24h ticker 抢 CPU | 低 | daemon 慢 | 5s timeout, idle event loop |
| 卡片点击率太高 | 中 | 体验差 | Skip / 调 interval / 文档关 |
| `npm i -g` 失败 | 中 | apply 失败 | 打印原始 stderr |
| Check 跟 restart 撞车 | 极低 | 丢一次检查 | 24h 周期，丢一次不致命 |
| 新 spec 写错 compare | 极低 | 误报 | 7 个版本对比单测 + CI gate |
| 作者发坏 tgz | 极低 | 端用户全炸 | `npm unpublish` + hotfix, sha512 校验 |

### 一键关停
1. **温和**：发文档教用户加 `[updater] enabled = false`
2. **小版本升级**：把默认改成 `enabled = false`（老用户配置文件不变所以自动停）
3. **核选项**：发 `0.6.5` 删 `updater/` 模块代码，老用户 `[updater]` section 不会被读，不报错

**关键不变量：`enabled` 默认 `true`，关停必须 ≤ 5 分钟完成。**

---

## 9. 关键不变量总结（一行一条）

1. 网络失败 = 静默 no-op，**绝不抛错**
2. `dist-tags.latest` 是唯一真源，不看 `versions[]`，不看 GitHub
3. 写 cache 走 atomic rename + proper-lockfile
4. Skip 状态走 user-mapping.json CAS，**不绕过**
5. apply 阶段是 fork exec，**绝不在 bot 进程内 `npm install`**
6. daemon 24h tick 跟启动 check 不重复发（`notified_at` 守卫）
7. detectInstallMode 单测 5 个 fixture
8. pre-release / dev tag 永远不当 "update"
9. owner.lock 的 `upgrading` flag 是软锁（TOML 读，不破坏 StateCoordinator）
10. 配置文件、env、CLI flag 三层覆盖，优先级 env > CLI flag > config

---

## 10. 时间线 + LOC 估算（v1.1 终版）

> v1.1 在 v1.0 基础上：+250 (upgrader 子进程) -30 (A1 文件合并) +30 (B1 race 防护) +30 (B2 UX 警告) = **+280 LOC**。

| 时段 | 内容 | LOC |
|------|------|-----|
| Day 1 上午 | `src/updater/{check,types,notify,lifecycle}.ts` + 单测 | ~250 + ~250 |
| Day 1 下午 | `src/cli/commands/upgrade.ts` + status async banner + 单测 | ~180 + ~140 |
| Day 1 晚上 | `src/feishu/updater-card.ts` + 卡片 action handler + **B2 active session 探测** | ~170 + ~140 |
| Day 1 晚+ | `src/upgrader/{runner,patch-card,state}.ts` + **A1 单 pending_upgrade.json** + **B1 PID 守卫** + 单测 | ~250 + ~250 |
| Day 2 上午 | `src/runtime/updater-tick.ts` + 启动 hook + **新 Bot 兜底** + **B1.1 cross-restart race 修** + 单测 | ~170 + ~130 |
| Day 2 下午 | `src/utils/paths.ts` + `src/utils/config.ts` + `package.json`（+ semver dep） | ~40 |
| Day 2 晚上 | **改 `scripts/postinstall.js` 加 bun fallback**（I1 修） | ~10 |
| Day 2 晚+ | e2e 升级走通（fake registry + 真 daemon + 真实卡片） | ~120 |
| **合计** | | **~1850 LOC（含测试）** |

---

## 11. Out of Scope（明确不做）

- ❌ CHANGELOG 自动 parse + 卡片展示
- ❌ 跨设备协调
- ❌ 多渠道通知
- ❌ `min_version` 黑名单强制升级
- ❌ 开发者侧 `bun run deploy` 整合进 `cc-linker upgrade`
- ❌ Auto-update `cc-linker` binary（不走 npm 时）

### 11.1 本次**必须改**的现有文件（不是 Out of Scope）

- ✅ **`scripts/postinstall.js`**：加 bun fallback shebang（I1 修复）。原本 spec 写"不改 postinstall.js"是错的——bun-only 用户场景需要这个修。改动 ≤ 10 行，幂等性不变。
- ❌ 不改 `bun run deploy` / `daemon.ts` / `package.json` bin

---

## 12. 落地决策

> 原"Open Questions"已在本节内化为硬决策，避免实现期返工。

- **D1**：`skipped_versions` 字段写到现有 `<owner-openid>` entry 的子字段（`user-mapping.json`），复用 `UserManager` 的 `casUpdate` 协议。**不**另起独立 section / 独立文件。
- **D2**：卡片 action handler 直接用 `@larksuiteoapi/node-sdk` 的 `client.im.v1.message.patch`（跟 `src/feishu/card-updater.ts` 一致），**不**走 `lark-cli`。
- **D3**：24h ticker 用 `setTimeout` 递归链（每次重排），不用 `setInterval`，daemon 优雅退出时不留 dangling interval。
- **D4**：启动检查**只在 bot init 完成后**触发（`init-feishu` 之后），user-mapping.json 还不存在时静默 no-op。
- **D5**：`cc-linker upgrade --from-card`（卡片按钮 spawn 出来的）跟用户主动 `cc-linker upgrade` 行为完全一致，**唯一差异**是 `--from-card` 时打印 `Card patch update status` 到 log（方便诊断卡片状态演化）。

---

## 13. 决策记录

| 决策 | 选择 | 否决 |
|------|------|------|
| 数据源 | `https://registry.npmjs.org/cc-linker/latest` | GitHub releases API（mirror，不真源） |
| Semver 库 | `semver@^7.6.0`（新加 dep） | 自己写 compare（V7 字符串陷阱） |
| Skip 状态位置 | 现有 user-mapping.json CAS | 独立文件（绕过 CAS 风险） |
| apply 路径 | fork exec `cc-linker upgrade` | bot 进程内 `npm install`（race） |
| 卡片触发点 | daemon 启动 + 24h tick | 每条飞书消息都查（噪音） |
| 默认行为 | `enabled = true` | opt-in（覆盖率太低，违背 G1） |
| Skip TTL | 30 天滚动窗口 | 永久 Skip（用户改主意走不掉） |
| Pre-release 处理 | 只看 `dist-tags.latest` | 也看 `next`（端用户不该被推 beta） |
| Caching 策略 | 24h TTL + ETag | 1h TTL（请求过多） |
| `check_interval_hours` 默认 | 24 | 6（没必要刷这么勤） |
