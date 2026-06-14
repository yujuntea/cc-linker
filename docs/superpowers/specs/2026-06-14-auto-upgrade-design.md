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
| CLI 启动 (`upgrade --check` / `status` / `start`) | 每次 | 查 registry（命中缓存就跳过），打印 banner | 静默 no-op |
| Daemon 启动 | 一次 | 同步查一次（5s timeout），新版本 → 等 30s 后发卡片 | 跳过本次 |
| Daemon 24h ticker | 每天 | 跟启动相同 | 静默 no-op |

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
entry: cc-linker upgrade
  ↓
check() (强制不走缓存)
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

#### CLI 跟 daemon 协调
- `cc-linker upgrade` 跑前读 `~/.cc-linker/owner.lock` 的 `upgrading` 字段
- 若 `upgrading=true` → 拒绝（避免双重 apply）
- 否则写 `upgrading=true` + `upgrade_started_at=now`，跑完恢复
- 用 `@iarna/toml` 已有 dep 读写

### 4.2 数据流 B：Daemon 启动检查

#### 时序

```
t=0    start --daemon
t=0~3s StateCoordinator.tryAcquire + WSClient connect + registry sync
t=3s   ← 在这里调 checkAndNotify (不阻塞 bot ready)
t=3s   checkAndNotify:
         fetch (timeout 5s, 1 retry)
         parse + semver compare
         若 update_available:
            sleep 30s (等 bot 完全 ready)
            send Feishu card to owner
            write notified_at = now() to .update-check.json
         其它 status: 静默
t=30s+ send Feishu card (only if update_available)
```

#### 为什么 sleep 30s
- 启动后用户可能在 5s 内发消息（resume 旧 session），不希望 daemon 第一时间弹卡片
- launchd 启动后用户没在看屏幕，30s 缓冲

#### 双发保护
- 启动检查成功后写 `notified_at = now()` 到 cache
- 24h ticker 看到 `notified_at` 在 24h 内就跳过（不重复发卡片，但 banner 仍可在 CLI 里看到）

### 4.3 数据流 C：Feishu 卡片 + 用户点按钮

#### 卡片样式

```
┌─────────────────────────────────────┐
│  🆕 cc-linker 有新版本              │  ← header
├─────────────────────────────────────┤
│ 当前 v0.6.3 → v0.6.4                │
│                                     │
│ 6 个 commits since v0.6.3           │  ← 暂不 parse, link 到 GitHub
│                                     │
│ [View changelog] [Skip] [Update]    │  ← action row
└─────────────────────────────────────┘
```

#### Action callbacks

| 按钮 | 行为 | 卡片演化 |
|------|------|---------|
| `Update` | `lark-cli invoke` → `applyCardAction` → fork exec `cc-linker upgrade --from-card` | patch "升级中..." → "✅ 已升级" / "❌ 失败" |
| `Skip` | 写 `skipped_versions` 到 user-mapping.json（CAS），30 天内不再推 | patch "已忽略 v0.6.4, 30 天内不再提醒" |
| `View changelog` | URL = `https://github.com/yujuntea/cc-linker/releases/tag/v0.6.4` | 卡片不变 |

#### Apply 路径：fork exec（不在 bot 进程内）

```ts
// 卡片按钮 handler
const child = spawn('cc-linker', ['upgrade', '--from-card'], {
  detached: true,
  stdio: ['ignore', logFd, logFd],
});
child.unref();
return card.patch({ state: 'upgrading' });
// 后续 polling: child 退出后定时 poll .update-check.json
// status 变 up_to_date 即视为升级成功 (60s 兜底 timeout)
```

**为什么 fork exec：**
- bot 进程不能 `npm i -g cc-linker@latest` —— 它自己就是被升级的目标
- fork 后 bot 仍跑旧 binary，`cc-linker restart` 触发 postinstall → 切到新 binary

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
| B1 | 端用户点 Update | 卡片"升级中" → "✅ 已升级" |
| B2 | 端用户 idle 时收到卡片 | 卡片躺着，飞书原生行为 |
| B3 | Skip 后 30 天内又发版 | 卡片不发，CLI banner 仍显示 |
| B4 | Skip 31 天后发版 | 卡片正常推 |
| B5 | 升级失败 | 卡片"❌ 失败, 跑 npm i -g cc-linker@latest"，不重试 |
| B6 | 端用户没装飞书 | daemon 静默，CLI 仍可用 |
| B7 | 端用户多台机器 | 每台独立（不跨设备协调） |
| B8 | session 进行中升级 | postinstall graceful stop + startupReconcile 恢复 |

### 5.7 配置
```toml
[updater]
enabled = true
check_on_status = true
check_on_start = true
notify_channel = "feishu"   # feishu | cli | none
registry_url = "https://registry.npmjs.org/cc-linker/latest"
check_interval_hours = 24
skipped_ttl_days = 30
```

| # | 触发 | 期望 |
|---|------|------|
| K1 | `enabled = false` | 立即返回 `disabled` |
| K2 | `notify_channel = "cli"` | 写 log + status, 不发卡片 |
| K3 | `notify_channel = "none"` | 静默, cache 仍写 |
| K4 | 删 `.update-check.json` | 下次 fresh fetch |
| K5 | section 不存在 | 用默认值 |

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
| 场景 | 操作 | 期望 |
|------|------|------|
| `fake-registry → CLI banner` | 起 mock server, 跑 `upgrade --check` | banner 正确 |
| `CLI upgrade apply` | mock 200 + tgz, 跑 `upgrade` | 调 `npm install`（mock 不真装） |
| `daemon check on start` | 启 daemon, wait 30s | fetch 1 次 + 卡片 1 次 |
| `24h ticker` | mock Date.now() 推进 25h | ticker 触发 + 写 cache |

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

## 10. 时间线 + LOC 估算

| 时段 | 内容 | LOC |
|------|------|-----|
| Day 1 上午 | `src/updater/{check,types,notify,lifecycle}.ts` + 单测 | ~250 + ~250 |
| Day 1 下午 | `src/cli/commands/upgrade.ts` + status banner + 单测 | ~150 + ~120 |
| Day 1 晚上 | `src/feishu/updater-card.ts` + 卡片 action handler | ~120 |
| Day 2 上午 | `src/runtime/updater-tick.ts` + 启动 hook + 单测 | ~100 + ~80 |
| Day 2 下午 | `src/utils/paths.ts` + `src/utils/config.ts` + `package.json`（+ semver dep） | ~30 |
| Day 2 晚上 | e2e 升级走通（fake registry + 真 daemon） | ~80 |
| **合计** | | **~1180 LOC（含测试）** |

---

## 11. Out of Scope（明确不做）

- ❌ CHANGELOG 自动 parse + 卡片展示
- ❌ 跨设备协调
- ❌ 多渠道通知
- ❌ `min_version` 黑名单强制升级
- ❌ 开发者侧 `bun run deploy` 整合进 `cc-linker upgrade`
- ❌ Auto-update `cc-linker` binary（不走 npm 时）
- ❌ 改 `scripts/postinstall.js` / `bun run deploy` / `daemon.ts` / `package.json` bin

---

## 12. Open Questions

- OQ1: `skipped_versions` 字段是写到现有 `<owner-openid>` entry，还是另起一个独立 `[updater]` section 在 user-mapping.json 根？
  - 倾向：写到现有 entry，复用 CAS，最小改动
- OQ2: 卡片 action handler 是用现成的 `lark-cli` 还是直接 SDK？
  - 倾向：直接 SDK（跟 `card-updater.ts` 一致）
- OQ3: 24h ticker 是用 `setInterval` 还是 `setTimeout` 链？
  - 倾向：`setTimeout` 链（daemon 优雅退出时不留 dangling interval）

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
