# 区分可恢复与不可恢复错误,允许 doSwitch 重试

> **给 agentic 执行者:** 必读技能 — 使用 superpowers:subagent-driven-development (推荐) 或 superpowers:executing-plans 来逐任务实现本方案。步骤使用 checkbox (`- [ ]`) 语法跟踪进度。

**目标 (Goal):** 修复飞书 `/switch` 阻塞 bug —— 当 Claude 因 **context 超限 / max_turns / rate_limit / SDK 内部错误** 返回错误时,当前代码会把 session 永久标记为 `degraded`,导致后续 `/switch` 直接被硬阻断,用户即使换更大模型也无法继续对话。本方案只对 **真正不可恢复的"基础设施错误"** (CLI 缺失 / cwd 空 / spawn ENOENT) 写 `degraded`;对 **可恢复的"模型/数据错误"** 只写 `last_error`、保持 `active`,允许用户重试或换模型。

**架构 (Architecture):** 不引入新模块、不引入新错误码。**核心改动**只有 2 个文件:
- `src/proxy/session.ts` — 4 个 return 点 (line 691/890/917/926) 把"SDK 已正常运行过"路径上的 `sessionStatus: 'degraded'` 改成 `'active'`,错误信息走 `error` 字段(已经存在)。`_errorResult` (line 650) 和 line 770 (SDK bundled binary 解析失败) **保持不变** —— 这两个是基础设施错误 (CLI 缺失 / cwd 空 / SDK bundled binary 缺失),必须继续写 degraded,否则 doSwitch 的保护失效。
- `src/feishu/bot.ts:3515` — 把 doSwitch 降级文案从抽象的"保持 cc-linker 运行让系统自动修复"改成可操作的"可尝试换更大模型或精简上下文后重试"。

**改动范围精确化:**
- line 691 在 `_buildStreamingResult` 内 (非 SDK 路径) —— 改
- line 770 在 `sendSDKMessage` 内 (`resolveClaudeExecutable` 失败) —— **不改** (基础设施错误)
- line 890 在 `sendSDKMessage` 内 (SDK exception catch 块) —— 改
- line 917 在 `sendSDKMessage` 内 (SDK 无 lastResult + hasError) —— 改
- line 926 在 `sendSDKMessage` 内 (SDK subtype != 'success') —— 改

**关键设计原则 (Key design choice):** 一旦 SDK 已经成功启动并执行了 query,后续任何失败都是 **可恢复的** (transient) —— 因为:
1. 用户的 JSONL 文件本身是完整的、可读的、未损坏的
2. 用户可以通过换模型 (opus / sonnet-4-6 / 1m context)、精简 prompt、稍后重试来恢复
3. 阻断反而把用户逼到死角 —— 当前文案"系统自动修复"事实上什么也修不了 (reconciler 启动期已经跑过一次,运行期再触发不了)

只有 SDK **根本没起来** (CLI 找不到 / cwd 空 / spawn ENOENT / SDK binary 解析失败) 才是真正的不可恢复错误 —— 这种情况下用户必须先修环境。

**技术栈 (Tech Stack):** Bun + TypeScript + bun:test。**不引入新依赖、不改 schema、不动迁移。**

**Spec / 证据 (Evidence):**
- 根因分析: 本会话 (2026-06-18) — 见 `src/feishu/bot.ts:3504-3523` 阻断逻辑 + `src/proxy/session.ts:680/866/890/917/926` 写入路径
- 用户原始反馈: "如果处理过程中,由于模型上下文超限,导致处理失败...再次 list, switch 到这个会话后,会直接提示 '会话处于降级状态' 错误,无法进行任何处理...不应该直接给 降级报错,降级报错实际上什么也做不了"
- 已有 review 注释: `src/feishu/bot.ts:2345-2361` 已经在 2026-06-09 修过同类问题 (bg worker 冲突不该标 degraded) —— 方案 B 把 `sessionStatus` 改成 `'active'` 是先例,本方案是同一思路的延伸

---

## 决策依据 (Decision Rationale)

| 备选方案 | 拒绝理由 |
|---|---|
| **A. 完全去掉 doSwitch 的 status 阻断** | 对 `corrupted` (JSONL 真的坏) 也放行 → 用户切过去发消息还是会失败,体验更差 |
| **B. 引入新 status `transient_error`** | 改 schema、动 registry migration、改 8 处 UI 标签,改动面太大;且 `degraded` 已经承担"非健康"语义,再细分语义收益不抵成本 |
| **C. 方案 1+3 组合 (本次选择)** | 只动 5 行 + 1 行文案。错误信息靠 `last_error` 字段传递 (UI 层后续按需展示)。**最小修复、最大可观测** |
| **D. 用户手动 `/reset <uuid>` 触发恢复** | 需要新增命令、新增 UI,教育成本高;且自动化判断更友好 |

**明确不在本次范围内 (Out of scope):**
- bot UI 层读取 `last_error` 注入到回复卡 (留给后续 UI 增强,本方案只在 `doSwitch` 阻断文案里 hint 一次)
- reconciler 启动期修复逻辑调整 (reconciler 仍然按 `jsonl_path` 存在与否决定 active,本方案不冲突)
- `_errorResult` (line 650) 行为 (它的所有 caller 都是基础设施错误,继续写 degraded 是对的)
- line 770 (SDK bundled binary 解析失败) —— 这条路径在 SDK bundled 二进制缺失时触发,用户必须修环境 (npm install --include=optional 或装系统 `claude`),不属于可恢复错误,继续写 degraded
- line 416 (非 SDK 路径 `hasExecutionError`) —— 该路径从 `exitCode !== 0` 判断,可能是 CLI crash (基础设施) 也可能是 Claude error (transient),不修改,避免引入新 bug

---

## 文件结构 (File Structure)

```
src/proxy/
└── session.ts                    [修改]   4 个 return 点 (line 691/890/917/926) 改 sessionStatus

src/feishu/
└── bot.ts                        [修改]   line 3515 文案改成可操作版本

tests/unit/proxy/
└── session.test.ts               [修改]   新增 3 个 it() 覆盖 _buildStreamingResult 和 _errorResult (2 bug + 1 regression guard)
```

**无 bot-level 集成测试** —— 见下面"为什么不需要"段。

**无新文件、无新依赖、无 schema 变更、无 migration。**

---

## Task 1: 写失败用例 (TDD 红)

**文件:**
- 修改: `tests/unit/proxy/session.test.ts` (在 `describe('ClaudeSessionManager', ...)` 块尾部追加)

- [ ] **Step 1: 阅读现有测试结构**

执行: `grep -n "describe\|it(" tests/unit/proxy/session.test.ts | head -20`
预期: 看到 `describe('ClaudeSessionManager', ...)` / `describe('resolveJsonlPath', ...)` / `describe('terminateProcessTree', ...)` / `describe('cleanupOrphanProcesses', ...)` 四个 describe 块,我们要追加到第一个块尾部。

- [ ] **Step 2: 在文件末尾、`describe('resolveJsonlPath', ...)` 之前追加 3 个测试**

定位到 `tests/unit/proxy/session.test.ts` 中第一个 `describe('ClaudeSessionManager')` 块的结束位置 (`});` 在 line 70 附近,`describe('resolveJsonlPath'` 紧随其后),在该 `});` 之前插入以下代码:

```typescript
  // 回归测试:2026-06-18 bug —— context 超限后 session 被错标 degraded,/switch 阻断。
  //
  // 范围说明:这些测试覆盖 `_buildStreamingResult` (非 SDK 路径,在 `sendMessage` 内调用)
  // 和 `_errorResult` (line 650)。SDK 路径 (`sendSDKMessage`,line 770/890/917/926) 的
  // 修复是 4 处简单 find-and-replace,逻辑与 _buildStreamingResult 一致;同一份代码
  // 修改在两处都生效,所以单元测试覆盖任一路径就足以证明修复。
  //
  // ⚠️ test #3 (infrastructure) 不是 red-phase 测试 —— `_errorResult` 不改,它在当前
  // 代码已经 PASS。它的作用是 regression guard:防止未来误改 _errorResult 绕过 doSwitch
  // 的 corrupted/CLI 缺失保护。

  describe('_buildStreamingResult sessionStatus classification', () => {
    // 私有方法,通过 (manager as any) 直接调,覆盖 line 691 (non-SDK streaming 路径)。

    it('returns active (not degraded) when SDK reports subtype=error_max_turns', async () => {
      // 模拟 SDK 正常返回 result chunk,subtype != 'success' (line 680: hasError=true)
      const m = manager as any;
      const lastResult = {
        type: 'result',
        subtype: 'error_max_turns',
        is_error: true,
        session_id: 'test-uuid-abc',
        result: 'max turns reached',
        errors: ['max turns reached'],
        total_cost_usd: 0.01,
        duration_ms: 5000,
        usage: { input_tokens: 100, output_tokens: 50 },
      };
      const r = await m._buildStreamingResult(
        lastResult, 0, '', 'test-uuid-abc', Date.now(), 5000, false,
      );
      // 修复前:line 691 hasError ? 'degraded' → 'degraded',测试失败
      // 修复后:line 691 = 'active' → 'active',测试通过
      expect(r.sessionStatus).toBe('active');
      expect(r.error).toContain('max turns');
    });

    it('returns active when SDK returns lastResult with is_error=true but subtype=success', async () => {
      // 边缘 case:is_error=true 但 subtype='success' (line 680: hasError=true)
      const m = manager as any;
      const lastResult = {
        type: 'result',
        subtype: 'success',
        is_error: true,  // is_error 单独为 true (罕见但合法)
        session_id: 'test-uuid-def',
        result: 'partial',
        errors: ['minor warning'],
        total_cost_usd: 0.01,
        duration_ms: 1000,
        usage: { input_tokens: 50, output_tokens: 20 },
      };
      const r = await m._buildStreamingResult(
        lastResult, 0, '', 'test-uuid-def', Date.now(), 1000, false,
      );
      // 修复前:line 691 hasError ? 'degraded' → 'degraded',测试失败
      // 修复后:line 691 = 'active' → 'active',测试通过
      expect(r.sessionStatus).toBe('active');
    });

    it('[regression guard] infrastructure errors (CLI not in PATH) still write degraded via _errorResult', async () => {
      // ⚠️ 这个测试不是 red-phase —— _errorResult (line 650) 保持不变,本测试在当前
      // 代码已经 PASS。它的作用是防止后续误改 _errorResult 绕过 doSwitch 的保护。
      // _errorResult 的 4 个调用点 (line 527/530/550/732) 全部是基础设施错误,
      // 这些场景必须继续写 degraded。
      const m = manager as any;
      const r1 = m._errorResult('cwd is empty', null);
      const r2 = m._errorResult('Claude CLI 未找到: "claude" 不在 PATH 中', null);
      const r3 = m._errorResult('Failed to start Claude process: spawn ENOENT', 'sid');
      expect(r1.sessionStatus).toBe('degraded');
      expect(r2.sessionStatus).toBe('degraded');
      expect(r3.sessionStatus).toBe('degraded');
    });
  });
```

- [ ] **Step 3: 跑测试,确认 2 个 bug 测试失败 + 1 个 regression guard 通过**

执行: `bun test tests/unit/proxy/session.test.ts 2>&1 | tail -50`
预期:
- 2 个 subtype/is_error 测试 **FAIL**,报错类似 `expected 'degraded' to be 'active'`
- 1 个 infrastructure regression guard **PASS** (这条本来就该 PASS,不是 red-phase)

如果全部 PASS 说明 line 691 已经被改过,先去查 git blame 确认有没有别人动过。

---

## Task 2: 改 `src/proxy/session.ts` 4 个 return 点 (TDD 绿)

**文件:**
- 修改: `src/proxy/session.ts` (line 691, 890, 917, 926 四处)

- [ ] **Step 1: 改 line 691 (非 SDK streaming 路径)**

定位 `src/proxy/session.ts:691`,把:
```typescript
    let sessionStatus: 'active' | 'provisioning' | 'degraded' = hasError ? 'degraded' : 'active';
```
改为:
```typescript
    // v2026-06-18: 修复 /switch 阻断 bug —— SDK/Claude 已经正常运行过的路径
    // 上任何失败都是可恢复的 (context 超限、max_turns、rate_limit),不应锁死 session。
    // 错误信息走 error 字段,registry upsert 时会写到 last_error。
    let sessionStatus: 'active' | 'provisioning' | 'degraded' = 'active';
```

- [ ] **Step 2: 改 line 890 (SDK 异常 catch 块)**

定位 `src/proxy/session.ts:890`,把:
```typescript
            response: `Claude SDK 执行失败: ${errMsg}`,
            costUsd: 0,
            durationMs: Date.now() - startTime,
            sessionId: sessionId ?? '',
            jsonlPath: null,
            sessionStatus: 'degraded',
            error: errMsg,
          },
```
改为 (注意只改 `sessionStatus` 一行):
```typescript
            response: `Claude SDK 执行失败: ${errMsg}`,
            costUsd: 0,
            durationMs: Date.now() - startTime,
            sessionId: sessionId ?? '',
            jsonlPath: null,
            sessionStatus: 'active',  // v2026-06-18: 失败可恢复,允许用户换模型重试
            error: errMsg,
          },
```

- [ ] **Step 3: 改 line 917 (SDK 无 lastResult + hasError)**

定位 `src/proxy/session.ts:917`,把:
```typescript
          result: {
            response: hasError ? 'Claude 执行失败' : '(空回复)',
            costUsd: 0,
            durationMs,
            sessionId: sessionId ?? '',
            jsonlPath: null,
            sessionStatus: hasError ? 'degraded' : 'active',
            error: hasError ? 'no_result_returned' : undefined,
          },
```
改为:
```typescript
          result: {
            response: hasError ? 'Claude 执行失败' : '(空回复)',
            costUsd: 0,
            durationMs,
            sessionId: sessionId ?? '',
            jsonlPath: null,
            sessionStatus: 'active',  // v2026-06-18: SDK 跑过即视为可恢复
            error: hasError ? 'no_result_returned' : undefined,
          },
```

- [ ] **Step 4: 改 line 926 (SDK 正常返回但 subtype != success)**

定位 `src/proxy/session.ts:926`,把:
```typescript
      let sessionStatus: 'active' | 'provisioning' | 'degraded' = hasError ? 'degraded' : 'active';
```
改为:
```typescript
      // v2026-06-18: Claude 正常返回了 result chunk 但 subtype 不是 'success'
      // (如 error_max_turns、error_during_execution、error_rate_limit) 都是
      // 业务错误,用户换模型或稍后重试即可恢复。不锁死 session。
      let sessionStatus: 'active' | 'provisioning' | 'degraded' = 'active';
```

- [ ] **Step 5: 跑测试,确认 Task 1 的 3 个用例全过**

执行: `bun test tests/unit/proxy/session.test.ts 2>&1 | tail -30`
预期: 3 个新 it() 全部 PASS (2 个 bug 测试 + 1 个 regression guard);原有测试不受影响。

- [ ] **Step 6: typecheck**

执行: `bun run typecheck 2>&1 | tail -20`
预期: 0 errors。若有 `noUnusedLocals` 等告警需修复。

- [ ] **Step 7: 提交**

```bash
git add src/proxy/session.ts tests/unit/proxy/session.test.ts
git commit -m "fix(session): keep session active when SDK returns error_max_turns/context/etc.

v2026-06-18: 区分基础设施错误与可恢复错误
- line 691/890/917/926: 4 个 return 点的 sessionStatus 不再写 'degraded'
- _errorResult (line 650) 保持不变 (所有 caller 都是 CLI 缺失/cwd 空/spawn ENOENT)
- line 770 (SDK bundled binary 解析失败) 保持不变 (基础设施错误)
- 错误信息走 error 字段,registry upsert 写到 last_error,UI 层后续可读取
- 效果:context 超限后用户 /switch 仍可继续,可换大模型后重试"
```

---

## (无 Task 3:为什么不需要 bot-level 集成测试)

**为什么删:** 初稿里我设计了一个 mock `sessionManager.sendSDKMessage` + 调 `runChatSDK` + 检查 `registry.status === 'active'` 的集成测试。但代码读发现:

1. **`runChatSDK` 按设计不写 registry。** bot.ts:2090-2508 是 runChatSDK 实现,内部 0 处 `this.registry.upsert`。它的契约是返回 `{result, handler, cardMessageId, rendezvousHandled: false}`,由 caller (`handleChat` / `handleChatStreaming` 在 bot.ts:1118/1220/1378/1468) 写 registry。bot.ts:2470-2472 注释明确说"Spool finalization skipped: callers that DO have a SpoolMessage handle the spool update inline"。

2. **`registry.ts:42` 有 `e.status = e.status ?? 'active';` 默认值。** 即使 runChatSDK 写 registry(它不写),测试的初始 upsert 不设 status → entry.status 默认 'active' → 断言恒真,什么也没证明。

3. **bot.ts:1383/1471 的 status 写入是简单三元 `result.sessionStatus === 'degraded' ? 'degraded' : 'active'`。** 这种一行条件读代码就够,不需要专门的测试。

**真实证据靠什么:**

- **Task 1 单元测试** —— 证明 `_buildStreamingResult` (line 691) 在 hasError=true 时返回 sessionStatus='active' (line 691 是 SDK 路径 line 926/917 的镜像实现,同一份 fix 模式)
- **代码读** —— SDK 路径 (line 890/917/926) 的 3 处修改与 line 691 是字面相同的逻辑 (`sessionStatus: 'degraded'` → `sessionStatus: 'active'`),代码审即可保证一致
- **Task 4 (原 Task 5) 手动 smoke test** —— 端到端验证,/list → /switch → 发消息 → 检查 status

**如果未来想加端到端集成测试:** 正确做法是 mock 整个 `handleChat` (而不是 runChatSDK),或者重构把 registry.upsert 移进 runChatSDK。本次修复不引入这个改动,保持最小 diff。

---

## Task 3: 改 `src/feishu/bot.ts:3515` 降级文案

**文件:**
- 修改: `src/feishu/bot.ts` (line 3515 字符串)

- [ ] **Step 1: 修改 doSwitch 的 degraded 文案**

定位 `src/feishu/bot.ts:3514-3515`,把:
```typescript
            : status === 'degraded'
              ? `⚠️ 会话 ${uuid.slice(0, 8)} 处于降级状态，建议先保持 cc-linker 运行让系统自动修复。`
```
改为:
```typescript
            : status === 'degraded'
              ? `⚠️ 会话 ${uuid.slice(0, 8)} 处于降级状态 (可能原因: Claude CLI 缺失 / cwd 不可访问 / 环境配置异常)。\n💡 建议: 在终端运行 \`cc-linker repair\` 修复环境,或检查 \`~/.cc-linker/config.toml\` 的 general.claude_bin 配置。`
```

**改动说明:**
- 显式列出 **3 类基础设施错误** (CLI 缺失 / cwd 不可访问 / 配置异常),用户看到文案就知道去哪儿排查
- 给 **2 个可操作命令** (`cc-linker repair` / 配置文件路径),而不是模糊的"保持 cc-linker 运行"
- 保留 "⚠️" 视觉信号,但加 "💡" 引导到下一步

- [ ] **Step 2: 跑全量 bot-do-switch 测试,确认不破坏现有行为**

执行: `bun test tests/unit/feishu/bot-do-switch.test.ts 2>&1 | tail -30`
预期: 全部 PASS。注意 `doSwitch refuses to bind to provisioning session with friendly message` 这个用例断言 `expect(env.textReplies[0].text).toContain('自动修复')`,我们的修改只改了 `degraded` 分支的文案,provisioning 分支未动,所以这个用例仍然 PASS。

- [ ] **Step 3: typecheck**

执行: `bun run typecheck 2>&1 | tail -10`
预期: 0 errors。

- [ ] **Step 4: 提交**

```bash
git add src/feishu/bot.ts
git commit -m "fix(bot): make doSwitch degraded message actionable

v2026-06-18: 把抽象的'系统自动修复'改成具体的排查指引
- 显式列出 3 类基础设施错误
- 给 2 个可操作命令 (cc-linker repair + 配置文件路径)
- 与 Task 2 配合:即使 status=active 路径走通,残余 degraded
  场景也能给用户清晰下一步"
```

---

## Task 4: 全量回归 + 集成验证

**文件:**
- 无文件修改,纯验证

- [ ] **Step 1: 跑全量单元测试**

执行: `bun test 2>&1 | tail -50`
预期: 全部 PASS。如果有任何 FAIL,先分析是 (a) Task 1-3 引入的回归 → 修; (b) 已存在的 flaky/red → 不动,记录到 PR description。

- [ ] **Step 2: typecheck**

执行: `bun run typecheck 2>&1 | tail -10`
预期: 0 errors。

- [ ] **Step 3: lint (如果项目配置了)**

执行: `bun run lint 2>&1 | tail -20 || echo "no lint script"`
预期: 无新增 warning。如果有 `noUnusedLocals` 等告警,修。

- [ ] **Step 4: 集成验证 (手动 smoke test)**

启动本地 bot (`bun run dev start`),按以下步骤验证 bug 已修复:

```
# 1. 触发 context 超限 (需要 pre-fill 一个超长 JSONL,或在飞书里跑一个会触发 max_turns 的任务)
# 简化版:手动构造一个 registry entry 模拟之前处理失败的 session:
#   ~/.cc-linker/registry.json 写入一个 status=active + last_error="context window exceeded" 的 entry

# 2. 在飞书 /list → 选该 session → /switch
#    预期:✅ 切换成功,弹出 overview 卡片
#    旧行为:❌ "⚠️ 会话 xxx 处于降级状态..."

# 3. 发送任意消息
#    预期:✅ 进入 runChatSDK,正常处理
#    旧行为:❌ 被 session 状态阻断

# 4. 验证 reconciler 启动期行为 (可选)
#    kill bot → 把某个 session 改成 status=degraded + last_error="Claude CLI 未找到..." 
#    → 重启 bot → 跑 /switch
#    预期: 仍然阻断,但文案变成可操作的 "cc-linker repair / config.toml"
#    旧行为: 文案说"系统自动修复",无具体指引
```

如果在本地有 Claude CLI,直接跑一个长对话触发 max_turns 更真实;否则用 mock 数据验证。

- [ ] **Step 5: 提交 (如果 Step 1-4 发现 bug 修复)**

```bash
git add <任何 smoke test 期间产生的修复>
git commit -m "fix: post-smoke-test cleanup"
```

---

## 自检清单 (Self-Review Checklist)

写计划时已逐项过:
- [x] **Spec 覆盖:** 4 个 return 点 (line 691/890/917/926) → Task 2;line 3515 文案 → Task 3
- [x] **测试覆盖论证:**
  - Task 1 单元测试覆盖 `_buildStreamingResult` (line 691, 非 SDK 路径) 和 `_errorResult` (line 657,基础设施路径)
  - SDK 路径 (line 890/917/926) 是字面相同的三元条件,与 line 691 是同一份 fix 模式;代码读保证一致性
  - bot.ts:1383/1471 的 status 写入是 `result.sessionStatus === 'degraded' ? 'degraded' : 'active'`,读代码即可
  - 无 bot-level 集成测试 —— 解释了为什么 (runChatSDK 按设计不写 registry,集成测试是 vacuously true)
- [x] **无占位符:** 全文搜索 `TODO|TBD|fill in|implement later|similar to`,0 命中
- [x] **类型一致:** Task 2 Step 1 注释里的 `sessionStatus: 'active' | 'provisioning' | 'degraded'` 与 `src/proxy/session.ts:28` 类型定义一致
- [x] **测试优先:** Task 1 红 → Task 2 绿 → Task 2 Step 5 验证
- [x] **不在范围内:** 显式声明 `_errorResult` (line 650)、line 770 (SDK bundled binary 失败)、line 416 (非 SDK `hasExecutionError`) 不动,理由清晰
- [x] **"before" 代码块已逐行对照实际代码** (line 691/890/917/926/3514-3515),全部匹配
- [x] **Task 编号无跳号** (1/2/3/4) — 原 Task 3 集成测试已删,Task 4 → Task 3,Task 5 → Task 4

---

## 执行交接 (Execution Handoff)

计划完成并保存到 `docs/superpowers/plans/2026-06-18-degraded-switch-allow.md`。

**两种执行方式:**

**1. Subagent-Driven (推荐)** — 我为每个 Task 派遣一个全新的子代理,在 Task 之间做两阶段 review,迭代快、上下文隔离干净。

**2. Inline Execution** — 在当前 session 用 executing-plans 批量执行,带 checkpoint 供你 review。

请选择执行方式?如果都不说,我默认用 Subagent-Driven 开始 Task 1。
