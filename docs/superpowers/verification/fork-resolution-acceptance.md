# Fork Resolution 验收指南

> 适用:验证 cc-linker v2.6 "透明 fork 解析" 在生产环境工作。
> 假设:cc-linker 已 build,`~/.cc-linker/`、`~/.claude/jobs/`、`~/.claude/daemon/roster.json` 存在。

---

## 总览:3 层验收

| 层 | 工具 | 用途 | 必需 Feishu? | 时长 |
|----|------|------|--------------|------|
| 1. Build + 单测 | `bun test` | 编译 + 全部 fork-resolver / migrator / manager 单元测试 | ❌ | 2 分钟 |
| 2. 集成 smoke | `bun run tests/integration/verify-fork-resolution.ts` | 真实数据上跑 fork 翻译,不需要飞书 | ❌ | 1 分钟 |
| 3. Live 飞书 | 启动 bot + 飞书交互 | 端到端真实场景 | ✅ | 15-30 分钟 |

**前两层** 验证 95% 的 fix。**第 3 层** 在 push 前做一次,确认 UI 行为符合预期。

---

## Layer 1: Build + 单测(2 分钟)

```bash
cd /path/to/cc-linker

# Typecheck
bun run typecheck

# 全部测试(975 个,应全过)
bun test

# 编译 standalone binary
bun run build

# 单独跑 fork 翻译相关(更快)
bun test tests/unit/agent-view/fork-resolver.test.ts
bun test tests/unit/agent-view/user-mapping-migrator.test.ts
bun test tests/unit/agent-view/job-state.test.ts
bun test tests/unit/agent-view/manager.test.ts
```

**通过标准**: 975/975 + typecheck clean + build 成功。

**如果失败**: 看具体失败 case 名,对照 `tests/unit/agent-view/fork-resolver.test.ts` 的命名约定,定位是哪个分支出问题。

---

## Layer 2: 集成 smoke test(1 分钟,推荐)

**目的**: 用本机真实数据验证 fork 翻译路径 work。无需 Feishu。

```bash
bun run tests/integration/verify-fork-resolution.ts
```

**脚本做什么**:
1. 读 `~/.claude/daemon/roster.json` + `~/.claude/jobs/<short>/state.json`
2. 自动找 (stale parent + live worker) 对
3. 对每对跑 3 个测试:
   - **Test 1** `resolveLiveSession(parentUuid)` — 验证 fork 翻译结果(short / pid / jsonl)
   - **Test 2** `checkRendezvousEligibility(workerShort)` — 验证 rendezvous 通道(sock 可用)
   - **Test 3** 模拟 `migrateUserMappingSessions` — 验证 user-mapping 翻译

**通过标准**:
```
=== Fork 翻译集成验收 (v2.6) ===

找到 N 个候选 (parent 死了 / worker 活着):

━━━ Candidate 1 ━━━
  parent (stale):  <stale uuid>
  worker (alive):  short=<short>  pid=<pid>
  shared JSONL:    <jsonl path>

  [Test 1] resolveLiveSession(parentUuid) — fork 翻译
    ✅ PASS
  [Test 2] checkRendezvousEligibility(workerShort) — rendezvous 通道
    ✅ PASS
  [Test 3] 模拟 user-mapping migration (内存)
    ✅ PASS

  🎉 Candidate 1: 全部通过

=== 总结 ===
候选数: N
结果:   ✅ 全部通过
```

**可能的结果**:

| 输出 | 含义 | 下一步 |
|------|------|--------|
| "没有找到候选" | 本机没有 stale→live 对(从未关过 TUI,或都是 alive) | 跳过 Layer 2,直接信任 Layer 1;或开多 TUI 制造场景 |
| "全部通过" | fork 翻译在你机器上 work | 继续 Layer 3 或推送 |
| "至少 1 个失败" | 见下面"失败诊断" | 排查 |

**失败诊断**:

| 现象 | 可能原因 | 修复 |
|------|----------|------|
| `liveFork === undefined` | 候选的 worker TUI 已死 | 启动 TUI: `cd <cwd> && claude` |
| `canUse: false` / `hasSock: false` | daemon socket 文件不在 | 查 `/tmp/cc-daemon-*/.../rv/<short>.sock` 是否存在 |
| `migrated: 0` 但 `scanned > 0` | user-mapping 已被翻译过(重启后已正确),或该 short 不在 roster | 看日志 `[INFO] user-mapping migrate: ...` 是否出现 |
| 任何 Test FAIL | 真 bug | 看 stack trace,对照 commit `15f984e` / `668b2f4` 的修复内容 |

---

## Layer 3: Live 飞书验证(15-30 分钟,推荐 push 前做)

**前置**:
- `cc-linker` 已 build,二进制在 `dist/cc-linker`
- `~/.cc-linker/config.toml` 配置好 `feishu_bot.app_id` / `app_secret` / `owner_open_id`
- 飞书 app 已 publish 事件订阅(`im.message.receive_v1` + `im:message.p2p_msg:readonly` + `card.action.trigger`)
- 你的 openId 已知(在 `~/.cc-linker/config.toml` 或测试时填入)

**注意**: 不要把 app_id / app_secret / openId commit 到 repo。下面场景用 `<your_openId>` 占位。

### 场景 A: 透明 fork 续接(原始 bug case)

**目的**: 验证 TUI 关掉 + 新 TUI `--resume --fork` 后,旧 card 的 [Reply] 还能用,不再 "Claude Code process exited with code 1"。

**步骤**:
1. 启动 bot:
   ```bash
   cd /path/to/cc-linker
   bun run dev start --daemon
   ```
2. 在 trae-data 目录(`cwd` 在 user-mapping 的 `pending_agent_reply` 或 list card 里)启动新 TUI:
   ```bash
   cd /path/to/your/project
   claude
   ```
   (或 `claude --resume <stale_session_id> --fork` 制造新 fork)
3. **等几秒**让 daemon 注册 worker
4. 在飞书 IM 找 bot,发:
   ```
   /agents
   ```
5. **预期**: 列表卡显示**新 TUI 的 short**(不含 stale parent),没 [Reply] 按钮表示它 waiting 时才有

6. 在飞书侧翻历史消息,找那张 stale session 的旧 waiting card(如果有),点 [Reply]

7. 发"测试一下"

8. **预期日志** (`tail -f ~/.cc-linker/cc-linker.log`):
   ```
   [INFO] handleReply: 翻译 stale <parentShort> → 活 fork <workerShort>
   [INFO] rendezvous: inject short=<workerShort> text_len=... reason=bg_waiting
   ```

9. **预期结果**:
   - 新 TUI 收到消息,处理,回复流回飞书卡
   - **没有** "❌ 处理失败: Claude Code process exited with code 1"

**通过标准**: reply 成功 + TUI 收到消息 + 飞书卡显示回复 + log 无 "exit code 1"。

### 场景 B: /agents 列表正确过滤

**步骤**:
1. 继续场景 A 的状态
2. 飞书发 `/agents`
3. **预期**: 列表只显示活 worker,**不显示** stale parent
4. 列表卡显示 `🛰 N sessions · /agents to refresh`

**通过标准**: 列表内只有 live session,无 stale。

### 场景 C: bot 重启后 user-mapping 自动迁移

**步骤**:
1. **制造场景**: 在飞书侧点一张 [Reply] 卡 → 进入 pending_agent_reply 状态(用户此时不发文字)
2. **停 bot**:
   ```bash
   bun run stop
   ```
3. **手动设置 stale entry**(模拟 bot crash 后 user-mapping 里的 stale):
   ```bash
   # 备份当前 user-mapping
   cp ~/.cc-linker/user-mapping.json ~/.cc-linker/user-mapping.json.bak

   # 改 sessionUuid 为 stale UUID(假设你的活 session 短是 ABCD1234,stale 是 STALE0)
   # (或者直接编辑,改成你环境里 stale session 的 UUID)
   ```
4. **重启 bot**:
   ```bash
   bun run dev start --daemon
   ```
5. **预期日志**:
   ```
   [INFO] user-mapping migration: 1 scanned, 1 migrated
   [INFO] user-mapping migrate: <openId> <staleShort> → <workerShort>
   ```
6. 验证:
   ```bash
   cat ~/.cc-linker/user-mapping.json | grep sessionUuid
   ```
   **预期**: sessionUuid 是活 worker 的(不是 stale 的)

**通过标准**: migrator 翻译成功 + 翻译方向正确。

### 场景 D: 多 TUI 切换无感

**步骤**:
1. 在不同 cwd 启动多个 claude TUI(每个会得到自己的 short)
2. 飞书发 `/agents`,应该看到多个 session 列表
3. 对每个 waiting session 点 [Reply] 发消息
4. **预期**: 每个 reply 都注入到对应的 TUI,无错误

---

## 修复结论

| 验收层级 | 通过 | 含义 |
|----------|------|------|
| Layer 1 全过 | ✅ 编译 + 975 个单测 | 逻辑代码正确 |
| Layer 2 通过 | ✅ 真实数据上 fork 翻译 work | 适配你的环境 |
| Layer 3 通过 | ✅ 飞书侧 UI 行为符合预期 | 端到端可发布 |

**3 层全过即可推送 + 开 PR。**

---

## 故障排查

### Layer 1 失败

- **Typecheck error**: 看错误信息,通常是 import 路径错或类型不一致。`git log --oneline` 看最近改动,revert 到上一个 commit 验证。
- **单测 fail**: 看失败 case 名,优先看 `fork-resolver.test.ts`(核心)。如果 fork-resolver fail,后面 8 个调用点都不可信。

### Layer 2 失败

- **`liveFork === undefined`**: 候选 worker 的 roster entry 不存在(daemon 没在跑 / 已死)。启动 claude TUI。
- **`canUse: false`**: daemon 的 rendezvous socket 没创建。检查 `~/.claude/daemon/roster.json` 里有没有这个 short + 查 `/tmp/cc-daemon-*/.../rv/<short>.sock` 文件。
- **migrator 跳过**: 查 `~/.cc-linker/cc-linker.log` 里 `user-mapping migrate` 日志,看具体 reason(已有翻译 / CAS 冲突 / fork-resolver 失败)。

### Layer 3 失败

- **"❌ 会话已不存在"**: 候选 fork 真的死了,`/agents` 重新拉,等 5 秒再试。
- **"❌ 状态冲突"**: 多个用户操作并发,retry 即可。
- **"Claude Code process exited with code 1"**: fork-resolver 没工作。看 log:
  ```bash
  grep "翻译\|resolveLive\|exited" ~/.cc-linker/cc-linker.log | tail -20
  ```
  如果 `翻译` 日志没出现,说明 fork 翻译没在那个入口跑。检查 `src/feishu/bot.ts` `tryRendezvousReply` 函数 + `src/agent-view/manager.ts` `handleReply` 函数。

### 通用诊断

```bash
# 看 daemon 是否在跑
ls /tmp/cc-daemon-*/  2>/dev/null

# 看 roster 当前状态
cat ~/.claude/daemon/roster.json | head -50

# 看 jobs 目录里有什么
ls ~/.claude/jobs/

# 看最近 bot 日志
tail -100 ~/.cc-linker/cc-linker.log

# 看 user-mapping 当前状态
cat ~/.cc-linker/user-mapping.json
```

---

## 相关 commit 历史

完整的 19 个 commit 含在分支 `feat/transparent-fork-resolution` 里(如果用 worktree 流程)或直接在 master 上。

按用途分组:
- **核心逻辑** (commit `1eee8cd`, `c70c673`, `4529c5a`, `72bc505`, `fd58d6b`)
  fork-resolver、jobStateToSession fix、AgentSession.liveFork、snapshot-fetcher 集成、handleList 过滤
- **入口集成** (`017bac8`, `bb8a141`, `6e84a9f`, `eadc30d`, `47ac2fd`, `197c204`, `5a24bc0`)
  7 个用户面入口:handleReplyRequest / handleReply / handlePeek / handleAttach / tryRendezvousReply / runChatSDK / expectedReply
- **启动迁移** (`765a37a`)
  bot 启动时扫描 user-mapping 把 stale session 翻译到活 fork
- **修复** (`15f984e`, `668b2f4`, `8f27d78`)
  Round 1: 8 cleanup + bug fix / Round 2: 3 P0 ordering / Round 3: N+1 perf

详细 plan 看 `docs/superpowers/plans/2026-06-15-transparent-fork-resolution.md`。

---

## 不需要做这些(plan 已明确排除)

- **3+ 层链式 fork**: 本方案支持 2 层(测试覆盖),3+ 层罕见,生产前手动验证
- **跨机器 fork 续接**: 只处理单机 daemon
- **手动指定"不要翻译"**: 100% 自动,UX 更简单
- **fork detection via `claude logs <short>`**: claude-code v2.1.163+ 不可靠
- **JSONL mtime 兜底**: 太脆弱
