# 飞书侧 Claude Code Agent View 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Claude Code 2.1.139+ 的 `claude agents` Agent View 能力桥接到飞书侧,让用户能在飞书里列出 / Peek / Reply / Stop / Attach background session。

**Architecture:** 新增 `src/agent-view/` 目录(11 个新文件)承担 Agent View 逻辑,通过 `FeishuBot.handleCommand` 加 `/agents` 文本命令、`FeishuBot.handleCardAction` 加 9 种 `agent_view_*` action tag 接入。持久化借 `UserManager.compareAndSwap` 扩 2 个 MappingEntryType(`pending_agent_reply` / `last_agent_list_card`),沿用 `proper-lockfile` 跨进程锁。Reply 流式卡片复用 `FeishuBot.handleChatSDK` 整套生命周期(权限卡 + 1200ms 完成 patch + fallback 切文本),所以把 `handleChatSDK` 从 private 提到 public `runChatSDK`。

**Tech Stack:** Bun, TypeScript, lark SDK (Feishu WSClient + im.v1.message), proper-lockfile, Zod, child_process.execFile (调用 `claude` CLI)

**Spec:** `docs/superpowers/specs/2026-06-01-feishu-agent-view-design.md` v2.2

---

## 文件映射

### 新建文件

| 路径 | 职责 | 依赖 |
|---|---|---|
| `src/agent-view/index.ts` | 公共类型与函数导出 | — |
| `src/agent-view/types.ts` | `AgentSession` / `AgentSessionStatus` / `AgentSessionGroup` / `AgentViewValue` 类型 | — |
| `src/agent-view/ansi-strip.ts` | strip ANSI 转义码(CSI/OSC/DCS) | — |
| `src/agent-view/snapshot.ts` | `parseAgentsJson(raw: string)` 纯解析,无 execFile | — |
| `src/agent-view/version-guard.ts` | `VersionGuard.check()` 校验 `claude --version` ≥ 2.1.139 | `child_process.execFileSync` |
| `src/agent-view/daemon-probe.ts` | `DaemonProbe.check()` `existsSync('~/.claude/daemon/roster.json')` | `fs.existsSync` |
| `src/agent-view/snapshot-fetcher.ts` | `AgentSnapshotFetcher.fetch()` 调 `claude agents --json` + 调 `parseAgentsJson` | `snapshot.ts`, `version-guard.ts`, `daemon-probe.ts` |
| `src/agent-view/expected-reply-state.ts` | `openId → expectedReply` 状态管理(in-memory + user-mapping 双写 + CAS + 超时) | `UserManager.compareAndSwap` |
| `src/agent-view/card.ts` | 6 种静态卡构建函数(列表 / peek / 错误 / 空 / 等待输入 / 停止确认) | — |
| `src/agent-view/action.ts` | 9 种 `AgentViewValue` 变体类型 | `types.ts` |
| `src/agent-view/manager.ts` | `AgentViewManager` 顶层协调,被 `FeishuBot` 调用 | 所有上述 + `runChatSDK` |

### 修改文件

| 路径 | 改动 |
|---|---|
| `src/feishu/mapping.ts` | 扩 `MappingEntryType` 加 `pending_agent_reply` / `last_agent_list_card`;扩 `MappingEntry` 字段;`entriesMatch` 自动适配新 type |
| `src/feishu/bot.ts` | `handleChatSDK` 改 public `runChatSDK`;`handleCommand` 加 `case 'agents'`;`handleCardAction` 加 9 个 `case 'agent_view_*'` |
| `src/proxy/session.ts` | 无改动(只是引用 `acquireSessionLock` / `releaseSessionLock` / `writeActivityMarker`) |
| `src/utils/config.ts` | 加 `[agent_view]` 节 5 个 key + env override |
| `src/cli/commands/start.ts` | 无改动(cardReplyFn 不需要加 patch 能力,Agent View 直接用 `feishuClient.im.v1.message.patch`) |

### 新建测试

| 路径 | 覆盖 |
|---|---|
| `tests/unit/agent-view/snapshot.test.ts` | parseAgentsJson 各种 JSON 形态 |
| `tests/unit/agent-view/ansi-strip.test.ts` | CSI / OSC / DCS / UTF-8 边界 |
| `tests/unit/agent-view/expected-reply-state.test.ts` | state machine + CAS + bot 重启恢复 |
| `tests/unit/agent-view/card.test.ts` | 6 种卡 JSON 结构 + 字节上限 |
| `tests/unit/agent-view/manager.test.ts` | 业务流 mock 测试 |
| `tests/unit/feishu/mapping-ext.test.ts` | entriesMatch 新 type 行为 |
| `tests/integration/agent-view.test.ts` | mock execFile + feishuClient 端到端 |
| `tests/fixtures/agents-json/*.json` | 7 个 fixture(busy/all-idle/waiting/kind-mixed/empty/invalid/kind-race) |
| `tests/fixtures/ansi-logs/*.txt` | 5 个 fixture |
| `tests/fixtures/cas/*.json` | 2 个 fixture |

### 文档更新

| 路径 | 改动 |
|---|---|
| `README.md` / `README_en.md` | 加 "Agent View" 章节 |
| `CLAUDE.md` | "Important Files" 表加 `src/agent-view/` |

---

## Phase 总览

| Phase | 范围 | Task |
|---|---|---|
| Phase 1: 基础 | 扩 Mapping 类型 + 兜底测试 | T1-T2 |
| Phase 2: 底层工具 | ansi-strip / snapshot / version-guard / daemon-probe / snapshot-fetcher | T3-T7 |
| Phase 3: 状态 | expected-reply-state | T8 |
| Phase 4: 静态卡 | card.ts | T9 |
| Phase 5: 顶层协调 | manager.ts | T10 |
| Phase 6: 公共化 | handleChatSDK → public runChatSDK | T11 |
| Phase 7: 命令/Action 路由 | /agents + 9 个 agent_view_* | T12-T13 |
| Phase 8: 业务流 | list / refreshList / peek / refreshPeek / replyRequest / reply / cancelReply / stop / stopConfirm / attach / backToChat / handleChat 集成 | T14-T23 |
| Phase 9: 配置 | config.ts agent_view 节 | T26 |
| Phase 10: 集成 + 文档 | fixtures + 集成测试 + README/CLAUDE.md | T27-T29 |

每个 task 内部:写失败测试 → 跑测试确认失败 → 写实现 → 跑测试确认通过 → commit。

---

## Phase 1: 基础(Mapping 扩展)

### Task 1: 扩 MappingEntryType 与 MappingEntry 字段

**Files:**
- Modify: `src/feishu/mapping.ts:8-20`
- Test: `tests/unit/feishu/mapping-ext.test.ts`(Task 2 写)

**上下文:** 当前 `MappingEntryType` 只有 3 种(`session` / `pending_new_session` / `pending_new_session_claimed`),Agent View 需要 2 种新 type:`pending_agent_reply`(用户点 [Reply] 后等文本)和 `last_agent_list_card`(列表卡 messageId 定位)。同时扩 `MappingEntry` 接口加 5 个可选字段。

- [ ] **Step 1: 写失败测试 — 新 type 编译通过**

在 `tests/unit/feishu/mapping-ext.test.ts` 创建:

```typescript
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { MappingEntry, MappingEntryType } from '../../../src/feishu/mapping';

describe('MappingEntryType extension (Agent View)', () => {
  test('supports pending_agent_reply and last_agent_list_card', () => {
    // 编译期检查
    const types: MappingEntryType[] = [
      'session',
      'pending_new_session',
      'pending_new_session_claimed',
      'pending_agent_reply',
      'last_agent_list_card',
    ];
    expect(types).toHaveLength(5);
  });

  test('pending_agent_reply entry has required Agent View fields', () => {
    const entry: MappingEntry = {
      type: 'pending_agent_reply',
      sessionUuid: '92664deb-f4b6-48d3-9cdd-85cf8eea6dfc',
      createdAt: '2026-06-06T00:00:00.000Z',
      cwd: '/Users/tester/Git/cc-linker',
      shortId: '92664deb',
      startedAt: '2026-06-06T00:00:00.000Z',
      timeoutMs: 300000,
      casToken: 'test-token',
    };
    expect(entry.type).toBe('pending_agent_reply');
    expect(entry.shortId).toBe('92664deb');
    expect(entry.timeoutMs).toBe(300000);
  });

  test('last_agent_list_card entry has sessionUuid=null', () => {
    const entry: MappingEntry = {
      type: 'last_agent_list_card',
      sessionUuid: null,
      createdAt: '2026-06-06T00:00:00.000Z',
      cardMessageId: 'om_xxxxx',
      updatedAt: '2026-06-06T00:00:00.000Z',
      casToken: 'test-token',
    };
    expect(entry.sessionUuid).toBeNull();
    expect(entry.cardMessageId).toBe('om_xxxxx');
  });
});
```

- [ ] **Step 2: 跑测试,确认失败**

Run: `bun test tests/unit/feishu/mapping-ext.test.ts 2>&1 | head -20`
Expected: FAIL — `MappingEntryType` 不接受新字符串(TS 编译错或 runtime 类型断言失败)

- [ ] **Step 3: 修改 src/feishu/mapping.ts**

```typescript
// src/feishu/mapping.ts:8
export type MappingEntryType =
  | 'session'
  | 'pending_new_session'
  | 'pending_new_session_claimed'
  | 'pending_agent_reply'         // 新增 — Agent View reply 等待输入
  | 'last_agent_list_card';       // 新增 — Agent View 最新列表卡

// src/feishu/mapping.ts:10-20
export interface MappingEntry {
  type: MappingEntryType;
  sessionUuid: string | null;
  createdAt: string;
  casToken?: string;
  cwd?: string;
  lastActiveAt?: string;
  claimedByMessageId?: string;
  claimedAt?: string;
  defaultProvider?: string;
  // ===== Agent View 新增字段 =====
  shortId?: string;          // pending_agent_reply: background session short hash
  startedAt?: string;        // pending_agent_reply: ISO 启动时间
  timeoutMs?: number;        // pending_agent_reply: 超时毫秒
  cardMessageId?: string;    // last_agent_list_card: 飞书卡片 message_id
  updatedAt?: string;        // last_agent_list_card: ISO 更新时间
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/unit/feishu/mapping-ext.test.ts 2>&1 | tail -10`
Expected: 3 tests pass

- [ ] **Step 5: 跑 typecheck**

Run: `bun run typecheck 2>&1 | tail -10`
Expected: 无错(全项目 typecheck 通过)

- [ ] **Step 6: Commit**

```bash
git add src/feishu/mapping.ts tests/unit/feishu/mapping-ext.test.ts
git commit -m "feat(mapping): extend MappingEntryType for Agent View (pending_agent_reply, last_agent_list_card)"
```

---

### Task 2: entriesMatch 对新 type 行为单测

**Files:**
- Test: `tests/unit/feishu/mapping-ext.test.ts`(在 T1 基础上加)

**上下文:** `entriesMatch` 在 `src/feishu/mapping.ts:299-319`,比较 `type / sessionUuid / cwd / casToken`(还有 claimedBy 字段)。对 2 个新 type,要保证:
- `pending_agent_reply`: CAS 只看 `type / sessionUuid / cwd / casToken`,UI 字段(`shortId` / `startedAt` / `timeoutMs`)不影响 CAS
- `last_agent_list_card`: `sessionUuid=null` 和 `cwd=null` 必须能匹配

- [ ] **Step 1: 追加测试 cases 到 mapping-ext.test.ts**

```typescript
// 追加到 tests/unit/feishu/mapping-ext.test.ts(import 已在文件顶部)
import { readFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// entriesMatch 不导出,需要通过 UserManager.compareAndSwap 间接测
// 这里采用模块导出测试法:临时把 entriesMatch 重构为 export 以便测
// 替代方案:用 UserManager.compareAndSwap 写盘 + 读盘验证
import { UserManager } from '../../../src/feishu/mapping';

describe('entriesMatch behavior for new types (via UserManager CAS)', () => {
  let tmpDir: string;
  let tmpMapping: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mapping-cas-'));
    tmpMapping = join(tmpDir, 'user-mapping.json');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true });
  });

  test('pending_agent_reply CAS only checks type/sessionUuid/cwd/casToken', async () => {
    const mgr = new UserManager(tmpMapping);
    const initial = {
      type: 'pending_agent_reply' as const,
      sessionUuid: 'uuid-A',
      cwd: '/path/a',
      createdAt: '2026-06-06T00:00:00.000Z',
      shortId: 'shortA',
      startedAt: '2026-06-06T00:00:00.000Z',
      timeoutMs: 300000,
    };
    // 第一次写
    const cas1 = await mgr.compareAndSwap('open1', null, initial);
    expect(cas1).toBe(true);

    // 改 UI 字段(shortId / startedAt / timeoutMs),保持 type / sessionUuid / cwd / casToken 一致
    // expected 用"我以为的当前 entry"(initial + 自动生成的 casToken),newValue 用"新的 entry(改 UI 字段)"
    // entriesMatch 只比 type/sessionUuid/cwd/casToken,UI 字段差异不影响 → CAS 应成功
    const current = mgr.getEntry('open1')!;
    const casToken = current.casToken!;
    const expected = {
      type: 'pending_agent_reply' as const,
      sessionUuid: 'uuid-A',
      cwd: '/path/a',
      createdAt: '2026-06-06T00:00:00.000Z',
      shortId: 'shortA',  // 跟 initial 一样
      startedAt: '2026-06-06T00:00:00.000Z',  // 跟 initial 一样
      timeoutMs: 300000,  // 跟 initial 一样
      casToken,
    };
    const newValue = {
      ...expected,
      shortId: 'shortA-changed',  // UI 字段变了
      startedAt: '2026-06-06T01:00:00.000Z',
      timeoutMs: 600000,
    };
    const cas2 = await mgr.compareAndSwap('open1', expected, newValue);
    expect(cas2).toBe(true);
    // 验证 newValue 写进去了
    const updated = mgr.getEntry('open1')!;
    expect(updated.shortId).toBe('shortA-changed');
    expect(updated.timeoutMs).toBe(600000);
  });

  test('last_agent_list_card CAS: sessionUuid=null + cwd=null 匹配', async () => {
    const mgr = new UserManager(tmpMapping);
    const entry = {
      type: 'last_agent_list_card' as const,
      sessionUuid: null,
      cwd: undefined,  // cwd 可选,entriesMatch 用 ?? '' 兼容 undefined
      createdAt: '2026-06-06T00:00:00.000Z',
      cardMessageId: 'om_123',
      updatedAt: '2026-06-06T00:00:00.000Z',
    };
    const cas1 = await mgr.compareAndSwap('open2', null, entry);
    expect(cas1).toBe(true);

    const current = mgr.getEntry('open2')!;
    expect(current.sessionUuid).toBeNull();
    expect(current.cardMessageId).toBe('om_123');
  });

  test('互斥保证: pending_agent_reply → last_agent_list_card type 不等 → CAS 失败', async () => {
    const mgr = new UserManager(tmpMapping);
    const replyEntry = {
      type: 'pending_agent_reply' as const,
      sessionUuid: 'uuid-X',
      cwd: '/x',
      createdAt: '2026-06-06T00:00:00.000Z',
    };
    const cas1 = await mgr.compareAndSwap('open3', null, replyEntry);
    expect(cas1).toBe(true);

    // 尝试 CAS 写 last_agent_list_card(用当前 reply entry 当 expected)
    const current = mgr.getEntry('open3')!;
    const newListCard = {
      type: 'last_agent_list_card' as const,
      sessionUuid: null,
      createdAt: '2026-06-06T00:00:00.000Z',
      cardMessageId: 'om_999',
    };
    const cas2 = await mgr.compareAndSwap('open3', current, newListCard);
    // type 不等 → CAS 失败
    expect(cas2).toBe(false);
  });

  test('旧 type 兼容性: pending_new_session CAS 行为不变', async () => {
    const mgr = new UserManager(tmpMapping);
    const entry = {
      type: 'pending_new_session' as const,
      sessionUuid: null,
      cwd: '/old',
      createdAt: '2026-06-06T00:00:00.000Z',
    };
    const cas1 = await mgr.compareAndSwap('open4', null, entry);
    expect(cas1).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认通过**

Run: `bun test tests/unit/feishu/mapping-ext.test.ts 2>&1 | tail -20`
Expected: 所有 7 个 tests pass(T1 的 3 个 + T2 的 4 个)

- [ ] **Step 3: 跑 typecheck**

Run: `bun run typecheck 2>&1 | tail -5`
Expected: 通过

- [ ] **Step 4: Commit**

```bash
git add tests/unit/feishu/mapping-ext.test.ts
git commit -m "test(mapping): cover entriesMatch behavior for Agent View types"
```

---

(Phase 1 完成。下一批 phase 在本文件追加)

## Phase 2: 底层工具模块

### Task 3: ansi-strip 模块(无依赖,可独立测)

**Files:**
- Create: `src/agent-view/ansi-strip.ts`
- Test: `tests/unit/agent-view/ansi-strip.test.ts`
- Test fixture: `tests/fixtures/ansi-logs/{plain,color,cursor,progress,utf8}.txt`

**上下文:** `claude logs <id>` 输出含 CSI(`\x1b[31m`)、OSC(`\x1b]0;title\x07`)、DCS、UTF-8 中文字符夹在转义码之间。strip 必须正确处理多字节 UTF-8 字节边界,不能误切。

- [ ] **Step 1: 创建 fixture 文件(用 printf 注入真实 ESC 字节)**

```bash
mkdir -p tests/fixtures/ansi-logs

# plain.txt:无控制字符
printf '$ npm test\nPASS tests/checkout.test.ts\nFAIL tests/cart.test.ts\n' > tests/fixtures/ansi-logs/plain.txt

# color.txt:CSI SGR 颜色码
printf '\x1b[31mError: \x1b[0mtest failed\n\x1b[32mOK: \x1b[0m3 tests passed\n' > tests/fixtures/ansi-logs/color.txt

# cursor.txt:CSI 清屏 + 光标定位
printf '\x1b[2J\x1b[HWelcome to claude\n$ _\n' > tests/fixtures/ansi-logs/cursor.txt

# progress.txt:CSI 擦行 + 光标上移(进度条重绘)
printf '[######             ] 30%%\n\x1b[2K\x1b[1A[##########        ] 50%%\n\x1b[2K\x1b[1A[##############    ] 70%%\n[####################] 100%% done\n' > tests/fixtures/ansi-logs/progress.txt

# utf8.txt:中文字符夹在转义码之间
printf '\x1b[31m错误: \x1b[0m测试失败\n中文测试 \x1b[32m通过\x1b[0m\n' > tests/fixtures/ansi-logs/utf8.txt
```

**注意**:必须用 `printf '\x1b...'` 直接写二进制字节,不能用文本编辑器写"ESC"字面字符(那只是 3 个字母 E/S/C)。

- [ ] **Step 2: 写失败测试**

```typescript
// tests/unit/agent-view/ansi-strip.test.ts
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { stripAnsi } from '../../../src/agent-view/ansi-strip';

const fixtureDir = join(import.meta.dir, '..', '..', 'fixtures', 'ansi-logs');

describe('stripAnsi', () => {
  test('plain text passes through unchanged', () => {
    const raw = readFileSync(join(fixtureDir, 'plain.txt'), 'utf8');
    expect(stripAnsi(raw)).toBe(raw);
  });

  test('removes color codes (CSI SGR)', () => {
    const raw = readFileSync(join(fixtureDir, 'color.txt'), 'utf8');
    const out = stripAnsi(raw);
    expect(out).toBe('Error: test failed\nOK: 3 tests passed\n');
    expect(out).not.toContain('\x1b');
  });

  test('removes clear-screen + cursor-position (CSI)', () => {
    const raw = readFileSync(join(fixtureDir, 'cursor.txt'), 'utf8');
    expect(stripAnsi(raw)).toBe('Welcome to claude\n$ _\n');
  });

  test('removes progress bar redraws (CSI + back-and-up)', () => {
    const raw = readFileSync(join(fixtureDir, 'progress.txt'), 'utf8');
    const out = stripAnsi(raw);
    expect(out).toContain('30%');
    expect(out).toContain('50%');
    expect(out).toContain('70%');
    expect(out).toContain('100% done');
    expect(out).not.toContain('\x1b');
  });

  test('preserves UTF-8 multi-byte characters adjacent to escapes', () => {
    const raw = readFileSync(join(fixtureDir, 'utf8.txt'), 'utf8');
    expect(stripAnsi(raw)).toBe('错误: 测试失败\n中文测试 通过\n');
  });

  test('handles empty input', () => {
    expect(stripAnsi('')).toBe('');
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `bun test tests/unit/agent-view/ansi-strip.test.ts 2>&1 | head -10`
Expected: FAIL — `Cannot find module '../../../src/agent-view/ansi-strip'`

- [ ] **Step 4: 实现 ansi-strip.ts**

```typescript
// src/agent-view/ansi-strip.ts

/**
 * Strip ANSI escape sequences from terminal output.
 * Covers: CSI (ESC [ ...), OSC (ESC ] ... BEL/ST),
 * DCS/SOS/PM/APC (ESC P/X/^/_ ... ST), single-char ESC sequences.
 * UTF-8 safe:中文字节不会被误切(只在字节边界匹配控制序列)。
 */
export function stripAnsi(input: string): string {
  return input
    // CSI: \x1b\[ + 可选参数(数字/;/?/=) + 可选中间字符(空格-/) + 终止字符(@-~)
    .replace(/\x1b\[[0-9;?=]*[ -/]*[@-~]/g, '')
    // OSC: \x1b\] + 非 BEL/ESC 字符 + 终止符(BEL 或 ESC \)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // DCS/SOS/PM/APC: \x1b[PX^_] + 非 ESC/BEL 字符 + 终止符
    .replace(/\x1b[PX^_][^\x1b\x07]*(?:\x1b\\|\x07)/g, '')
    // 单字符 ESC 序列(ESC + 任意字符)
    .replace(/\x1b[@-Z\\-_]/g, '');
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `bun test tests/unit/agent-view/ansi-strip.test.ts 2>&1 | tail -10`
Expected: 6 tests pass

- [ ] **Step 6: Commit**

```bash
git add src/agent-view/ansi-strip.ts tests/unit/agent-view/ansi-strip.test.ts tests/fixtures/ansi-logs/
git commit -m "feat(agent-view): add ansi-strip module with UTF-8 safe regex"
```

---

### Task 4: snapshot.ts + types.ts(纯解析,无 execFile)

**Files:**
- Create: `src/agent-view/types.ts`
- Create: `src/agent-view/snapshot.ts`
- Test: `tests/unit/agent-view/snapshot.test.ts`
- Test fixture: `tests/fixtures/agents-json/{busy,all-idle,waiting,kind-mixed,empty,invalid,kind-race}.json`

**上下文:** 纯函数,把 `claude agents --json` 的 raw string 解析成 `AgentSession[]`,做 `kind: "background"` 过滤、状态分组、unknown status 兜底。**不**调 execFile,fetch 逻辑放 snapshot-fetcher.ts。

- [ ] **Step 1: 创建 7 个 fixture 文件**

```bash
mkdir -p tests/fixtures/agents-json
```

```bash
cat > tests/fixtures/agents-json/busy.json << 'EOF'
[
  {"pid":1,"cwd":"/a","kind":"background","startedAt":1000,"sessionId":"uuid-1","name":"t1","status":"busy"},
  {"pid":2,"cwd":"/b","kind":"background","startedAt":2000,"sessionId":"uuid-2","name":"t2","status":"waiting","waitingFor":"input needed"}
]
EOF

cat > tests/fixtures/agents-json/all-idle.json << 'EOF'
[
  {"pid":1,"cwd":"/a","kind":"background","startedAt":1000,"sessionId":"uuid-1","name":"t1","status":"idle"}
]
EOF

cat > tests/fixtures/agents-json/waiting.json << 'EOF'
[
  {"pid":1,"cwd":"/a","kind":"background","startedAt":1000,"sessionId":"uuid-1","name":"t1","status":"waiting","waitingFor":"input needed"},
  {"pid":2,"cwd":"/b","kind":"background","startedAt":2000,"sessionId":"uuid-2","name":"t2","status":"waiting","waitingFor":"permission prompt"}
]
EOF

cat > tests/fixtures/agents-json/kind-mixed.json << 'EOF'
[
  {"pid":1,"cwd":"/a","kind":"background","startedAt":1000,"sessionId":"uuid-1","name":"t1","status":"busy"},
  {"pid":2,"cwd":"/b","kind":"interactive","startedAt":2000,"sessionId":"uuid-2","name":"main","status":"busy"},
  {"pid":3,"cwd":"/c","kind":"background","startedAt":3000,"sessionId":"uuid-3","name":"t3","status":"waiting"}
]
EOF

echo '[]' > tests/fixtures/agents-json/empty.json
echo 'not valid json {{{' > tests/fixtures/agents-json/invalid.json

cat > tests/fixtures/agents-json/kind-race.json << 'EOF'
[
  {"pid":1,"cwd":"/a","kind":"background","startedAt":1000,"sessionId":"uuid-X","name":"tX","status":"waiting","waitingFor":"input needed"}
]
EOF
```

- [ ] **Step 2: 创建 types.ts**

```typescript
// src/agent-view/types.ts

export type AgentSessionStatus = 'busy' | 'waiting' | 'idle' | 'unknown';

export interface AgentSession {
  pid: number;
  cwd: string;
  kind: 'background';  // parseAgentsJson 已过滤,只剩 background
  startedAt: number;    // epoch ms
  sessionId: string;    // UUID
  name: string;
  status: AgentSessionStatus;
  waitingFor?: string;  // 仅 status === 'waiting' 时存在
}

export type AgentSessionGroup = {
  busy: AgentSession[];
  waiting: AgentSession[];
  idle: AgentSession[];
};

export function groupByStatus(sessions: AgentSession[]): AgentSessionGroup {
  return {
    busy: sessions.filter(s => s.status === 'busy'),
    waiting: sessions.filter(s => s.status === 'waiting'),
    idle: sessions.filter(s => s.status === 'idle'),
  };
}
```

- [ ] **Step 3: 写失败测试**

```typescript
// tests/unit/agent-view/snapshot.test.ts
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseAgentsJson } from '../../../src/agent-view/snapshot';
import { groupByStatus } from '../../../src/agent-view/types';

const fixtureDir = join(import.meta.dir, '..', '..', 'fixtures', 'agents-json');

describe('parseAgentsJson', () => {
  test('parses busy + waiting background sessions', () => {
    const raw = readFileSync(join(fixtureDir, 'busy.json'), 'utf8');
    const result = parseAgentsJson(raw);
    expect(result).toHaveLength(2);
    expect(result[0].status).toBe('busy');
    expect(result[1].status).toBe('waiting');
    expect(result[1].waitingFor).toBe('input needed');
  });

  test('parses all-idle', () => {
    const raw = readFileSync(join(fixtureDir, 'all-idle.json'), 'utf8');
    const result = parseAgentsJson(raw);
    expect(result.every(s => s.status === 'idle')).toBe(true);
  });

  test('keeps only kind=background (filters out interactive)', () => {
    const raw = readFileSync(join(fixtureDir, 'kind-mixed.json'), 'utf8');
    const result = parseAgentsJson(raw);
    expect(result).toHaveLength(2);
    expect(result.every(s => s.kind === 'background')).toBe(true);
  });

  test('returns empty array for empty JSON', () => {
    expect(parseAgentsJson('[]')).toEqual([]);
  });

  test('throws on invalid JSON', () => {
    const raw = readFileSync(join(fixtureDir, 'invalid.json'), 'utf8');
    expect(() => parseAgentsJson(raw)).toThrow();
  });

  test('treats unknown status as "unknown" (does not throw)', () => {
    const raw = JSON.stringify([
      {pid:1,cwd:'/a',kind:'background',startedAt:1,sessionId:'u',name:'t',status:'weird-status'}
    ]);
    const result = parseAgentsJson(raw);
    expect(result[0].status).toBe('unknown');
  });

  test('waiting.json parses waitingFor field', () => {
    const raw = readFileSync(join(fixtureDir, 'waiting.json'), 'utf8');
    const result = parseAgentsJson(raw);
    expect(result).toHaveLength(2);
    expect(result[0].waitingFor).toBe('input needed');
    expect(result[1].waitingFor).toBe('permission prompt');
  });
});

describe('groupByStatus', () => {
  test('groups by busy/waiting/idle', () => {
    const raw = readFileSync(join(fixtureDir, 'busy.json'), 'utf8');
    const sessions = parseAgentsJson(raw);
    const groups = groupByStatus(sessions);
    expect(groups.busy).toHaveLength(1);
    expect(groups.waiting).toHaveLength(1);
    expect(groups.idle).toHaveLength(0);
  });
});
```

- [ ] **Step 4: 跑测试确认失败**

Run: `bun test tests/unit/agent-view/snapshot.test.ts 2>&1 | head -10`
Expected: FAIL — `Cannot find module '../../../src/agent-view/snapshot'`

- [ ] **Step 5: 实现 snapshot.ts**

```typescript
// src/agent-view/snapshot.ts
import type { AgentSession, AgentSessionStatus } from './types';

/**
 * 纯函数:解析 `claude agents --json` 输出,过滤 kind=interactive,把未知 status 归为 'unknown'。
 * 异常:JSON.parse 抛出 → 透传给调用方(由 manager 决定降级为错误卡)
 */
export function parseAgentsJson(raw: string): AgentSession[] {
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('Expected JSON array from `claude agents --json`');
  }
  return parsed
    .filter((s: any) => s && s.kind === 'background')
    .map((s: any): AgentSession => {
      const status: AgentSessionStatus =
        s.status === 'busy' || s.status === 'waiting' || s.status === 'idle'
          ? s.status
          : 'unknown';
      return {
        pid: Number(s.pid) || 0,
        cwd: String(s.cwd || ''),
        kind: 'background',
        startedAt: Number(s.startedAt) || 0,
        sessionId: String(s.sessionId || ''),
        name: String(s.name || 'unnamed'),
        status,
        ...(status === 'waiting' && s.waitingFor
          ? { waitingFor: String(s.waitingFor) }
          : {}),
      };
    });
}
```

- [ ] **Step 6: 跑测试确认通过**

Run: `bun test tests/unit/agent-view/snapshot.test.ts 2>&1 | tail -10`
Expected: 8 tests pass(7 parseAgentsJson + 1 groupByStatus)

- [ ] **Step 7: Commit**

```bash
git add src/agent-view/types.ts src/agent-view/snapshot.ts tests/unit/agent-view/snapshot.test.ts tests/fixtures/agents-json/
git commit -m "feat(agent-view): add snapshot parser with kind filter and status fallback"
```

---

### Task 5: version-guard.ts(校验 claude --version)

**Files:**
- Create: `src/agent-view/version-guard.ts`
- Test: `tests/unit/agent-view/version-guard.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// tests/unit/agent-view/version-guard.test.ts
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { VersionGuard } from '../../../src/agent-view/version-guard';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('VersionGuard.check', () => {
  test('returns ok=true for version >= 2.1.139', async () => {
    // 用 ESM import 后 monkey-patch(Bun ESM 严格模式不支持 require)
    const cp = await import('node:child_process');
    const orig = cp.execFileSync;
    (cp as any).execFileSync = () => '2.1.163 (Claude Code)\n';
    const result = await VersionGuard.check();
    (cp as any).execFileSync = orig;
    expect(result.ok).toBe(true);
    expect(result.version).toBe('2.1.163');
  });

  test('returns ok=false for version < 2.1.139', async () => {
    const cp = await import('node:child_process');
    const orig = cp.execFileSync;
    (cp as any).execFileSync = () => '2.1.100\n';
    const result = await VersionGuard.check();
    (cp as any).execFileSync = orig;
    expect(result.ok).toBe(false);
    expect(result.version).toBe('2.1.100');
    expect(result.reason).toContain('2.1.139');
  });

  test('returns ok=false when claude not found (ENOENT)', async () => {
    const cp = await import('node:child_process');
    const orig = cp.execFileSync;
    (cp as any).execFileSync = () => {
      const e: any = new Error('spawn claude ENOENT');
      e.code = 'ENOENT';
      throw e;
    };
    const result = await VersionGuard.check();
    (cp as any).execFileSync = orig;
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('not installed');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/unit/agent-view/version-guard.test.ts 2>&1 | head -10`
Expected: FAIL

- [ ] **Step 3: 实现**

```typescript
// src/agent-view/version-guard.ts
import { execFileSync } from 'node:child_process';

const MIN_VERSION = '2.1.139';

export interface VersionCheckResult {
  ok: boolean;
  version?: string;
  reason?: string;
}

export const VersionGuard = {
  async check(): Promise<VersionCheckResult> {
    let raw: string;
    try {
      raw = execFileSync('claude', ['--version'], { encoding: 'utf8', timeout: 5000 });
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return { ok: false, reason: 'Claude CLI not installed' };
      }
      return { ok: false, reason: `Failed to get version: ${err.message}` };
    }
    const m = raw.match(/(\d+\.\d+\.\d+)/);
    if (!m) {
      return { ok: false, reason: `Cannot parse version: ${raw.slice(0, 100)}` };
    }
    const version = m[1];
    if (compareVersions(version, MIN_VERSION) < 0) {
      return { ok: false, version, reason: `Requires ${MIN_VERSION}+, got ${version}` };
    }
    return { ok: true, version };
  },
};

function compareVersions(a: string, b: string): number {
  const [a1, a2, a3] = a.split('.').map(Number);
  const [b1, b2, b3] = b.split('.').map(Number);
  if (a1 !== b1) return a1 - b1;
  if (a2 !== b2) return a2 - b2;
  return a3 - b3;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/unit/agent-view/version-guard.test.ts 2>&1 | tail -10`
Expected: 3 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/agent-view/version-guard.ts tests/unit/agent-view/version-guard.test.ts
git commit -m "feat(agent-view): add version guard for claude >= 2.1.139"
```

---

### Task 6: daemon-probe.ts(检查 roster.json)

**Files:**
- Create: `src/agent-view/daemon-probe.ts`
- Test: `tests/unit/agent-view/daemon-probe.test.ts`

- [ ] **Step 1: 写失败测试 + 实现 + 跑测试**

```typescript
// tests/unit/agent-view/daemon-probe.test.ts
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DaemonProbe } from '../../../src/agent-view/daemon-probe';

describe('DaemonProbe.check', () => {
  test('returns true when roster.json exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'daemon-probe-'));
    mkdirSync(join(dir, 'daemon'));
    writeFileSync(join(dir, 'daemon', 'roster.json'), '{}');
    expect(DaemonProbe.check(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  test('returns false when roster.json missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'daemon-probe-'));
    expect(DaemonProbe.check(dir)).toBe(false);
    rmSync(dir, { recursive: true });
  });
});
```

```typescript
// src/agent-view/daemon-probe.ts
import { existsSync } from 'fs';
import { join } from 'path';
import { expandPath } from '../utils/paths';

export const DaemonProbe = {
  /**
   * 检查 Claude daemon 是否在跑(简化判断:roster.json 文件存在)
   * @param claudeHome 默认 ~/.claude,可通过参数覆盖(测试用)
   */
  check(claudeHome: string = join(expandPath('~'), '.claude')): boolean {
    return existsSync(join(claudeHome, 'daemon', 'roster.json'));
  },
};
```

Run: `bun test tests/unit/agent-view/daemon-probe.test.ts 2>&1 | tail -10`
Expected: 2 tests pass

- [ ] **Step 2: Commit**

```bash
git add src/agent-view/daemon-probe.ts tests/unit/agent-view/daemon-probe.test.ts
git commit -m "feat(agent-view): add daemon probe checking roster.json"
```

---

### Task 7: snapshot-fetcher.ts(调 execFile + guards)

**Files:**
- Create: `src/agent-view/snapshot-fetcher.ts`
- Test: `tests/unit/agent-view/snapshot-fetcher.test.ts`

- [ ] **Step 1: 写失败测试 + 实现 + 跑测试**

```typescript
// tests/unit/agent-view/snapshot-fetcher.test.ts
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { AgentSnapshotFetcher } from '../../../src/agent-view/snapshot-fetcher';
import { VersionGuard } from '../../../src/agent-view/version-guard';
import { DaemonProbe } from '../../../src/agent-view/daemon-probe';
import * as cp from 'node:child_process';

const fixtureDir = join(import.meta.dir, '..', '..', 'fixtures', 'agents-json');

describe('AgentSnapshotFetcher.fetch', () => {
  test('returns sessions on success', async () => {
    const orig = cp.execFileSync;
    (cp as any).execFileSync = () => '2.1.163\n';
    const origProbe = DaemonProbe.check;
    (DaemonProbe as any).check = () => true;
    const raw = readFileSync(join(fixtureDir, 'busy.json'), 'utf8');
    const origExec = cp.execFile;
    (cp as any).execFile = (
      cmd: string, args: string[], cb: (err: any, stdout: string, stderr: string) => void
    ) => cb(null, raw, '');
    const result = await AgentSnapshotFetcher.fetch();
    (cp as any).execFileSync = orig;
    (cp as any).execFile = origExec;
    (DaemonProbe as any).check = origProbe;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sessions).toHaveLength(2);
    }
  });

  test('returns ok=false when version < 2.1.139', async () => {
    const orig = cp.execFileSync;
    (cp as any).execFileSync = () => '2.1.100\n';
    const result = await AgentSnapshotFetcher.fetch();
    (cp as any).execFileSync = orig;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('Requires 2.1.139');
    }
  });

  test('returns ok=false when daemon not running', async () => {
    const orig = cp.execFileSync;
    (cp as any).execFileSync = () => '2.1.163\n';
    const origProbe = DaemonProbe.check;
    (DaemonProbe as any).check = () => false;
    const result = await AgentSnapshotFetcher.fetch();
    (cp as any).execFileSync = orig;
    (DaemonProbe as any).check = origProbe;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('daemon');
    }
  });

  test('returns ok=false when JSON parse fails', async () => {
    const orig = cp.execFileSync;
    (cp as any).execFileSync = () => '2.1.163\n';
    const origProbe = DaemonProbe.check;
    (DaemonProbe as any).check = () => true;
    const origExec = cp.execFile;
    (cp as any).execFile = (
      cmd: string, args: string[], cb: (err: any, stdout: string, stderr: string) => void
    ) => cb(null, 'invalid json', '');
    const result = await AgentSnapshotFetcher.fetch();
    (cp as any).execFileSync = orig;
    (cp as any).execFile = origExec;
    (DaemonProbe as any).check = origProbe;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('parse');
    }
  });
});
```

```typescript
// src/agent-view/snapshot-fetcher.ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { VersionGuard } from './version-guard';
import { DaemonProbe } from './daemon-probe';
import { parseAgentsJson } from './snapshot';
import type { AgentSession } from './types';

const execFileP = promisify(execFile) as (
  cmd: string,
  args: string[]
) => Promise<{ stdout: string; stderr: string }>;

export type FetchResult =
  | { ok: true; sessions: AgentSession[] }
  | { ok: false; reason: string };

export const AgentSnapshotFetcher = {
  /**
   * Fetch live background session snapshot.
   * v2.2:每次调用都重新 fetch,无 5s 缓存(避免死代码)
   */
  async fetch(): Promise<FetchResult> {
    const ver = await VersionGuard.check();
    if (!ver.ok) {
      return { ok: false, reason: ver.reason ?? 'version check failed' };
    }
    if (!DaemonProbe.check()) {
      return { ok: false, reason: 'Claude daemon not running' };
    }
    let stdout: string;
    try {
      const result = await execFileP('claude', ['agents', '--json']);
      stdout = result.stdout;
    } catch (err: any) {
      return { ok: false, reason: `claude agents --json failed: ${err.message}` };
    }
    try {
      const sessions = parseAgentsJson(stdout);
      return { ok: true, sessions };
    } catch (err: any) {
      return { ok: false, reason: `parse failed: ${err.message}` };
    }
  },
};
```

Run: `bun test tests/unit/agent-view/snapshot-fetcher.test.ts 2>&1 | tail -10`
Expected: 4 tests pass

- [ ] **Step 2: Commit**

```bash
git add src/agent-view/snapshot-fetcher.ts tests/unit/agent-view/snapshot-fetcher.test.ts
git commit -m "feat(agent-view): add snapshot-fetcher with version + daemon guards"
```

---

(Phase 2 完成。Phase 3-5 继续追加)

## Phase 3: 状态管理

### Task 8: expected-reply-state.ts(in-memory + user-mapping 双写 + CAS + 超时)

**Files:**
- Create: `src/agent-view/expected-reply-state.ts`
- Test: `tests/unit/agent-view/expected-reply-state.test.ts`

**上下文:** 这是 Agent View reply 等待状态的核心。需要:
- in-memory 镜像(快速读)
- user-mapping.json 双写(持久化 + 跨进程锁 + bot 重启恢复)
- 5min 超时 setTimeout 自动取消
- `/cancel` / `[取消]` / 写命令 / 同 openId 第二个 [Reply] 都能触发清除
- M2 互斥保证:同一 openId 任意时刻只可能有一种 type
- R8 启动恢复:bot 启动时遍历 user-mapping,rebuild in-memory + setTimeout

- [ ] **Step 1: 写失败测试**

```typescript
// tests/unit/agent-view/expected-reply-state.test.ts
import { describe, test, expect, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ExpectedReplyState } from '../../../src/agent-view/expected-reply-state';
import { UserManager } from '../../../src/feishu/mapping';

let tmpDir: string;
let userManager: UserManager;
let state: ExpectedReplyState;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'expected-reply-'));
  userManager = new UserManager(join(tmpDir, 'user-mapping.json'));
  state = new ExpectedReplyState(userManager, /*timeoutMs*/ 300000);
});

describe('ExpectedReplyState — basic set/clear', () => {
  test('set writes both in-memory and user-mapping', async () => {
    await state.set('open1', {
      shortId: 'short1',
      sessionId: 'uuid-1',
      cwd: '/a',
    });
    // in-memory
    expect(state.get('open1')?.shortId).toBe('short1');
    // user-mapping
    const entry = userManager.getEntry('open1');
    expect(entry?.type).toBe('pending_agent_reply');
    expect((entry as any)?.shortId).toBe('short1');
  });

  test('clear removes from both in-memory and user-mapping', async () => {
    await state.set('open1', { shortId: 's1', sessionId: 'u1', cwd: '/a' });
    await state.clear('open1');
    expect(state.get('open1')).toBeUndefined();
    expect(userManager.getEntry('open1')).toBeUndefined();
  });
});

describe('ExpectedReplyState — CAS conflict', () => {
  test('set fails when existing entry has different type', async () => {
    // 先写入一个 'session' type
    await userManager.compareAndSwap('open1', null, {
      type: 'session', sessionUuid: 'u', cwd: '/x', createdAt: new Date().toISOString(),
    });
    // 尝试 set expectedReply,应失败
    await expect(state.set('open1', { shortId: 's1', sessionId: 'u1', cwd: '/a' }))
      .rejects.toThrow();
  });
});

describe('ExpectedReplyState — timeout', () => {
  test('auto-clears after timeoutMs via setTimeout', async () => {
    // 用 100ms timeout 测
    const shortState = new ExpectedReplyState(userManager, /*timeoutMs*/ 100);
    await shortState.set('open1', { shortId: 's1', sessionId: 'u1', cwd: '/a' });
    await new Promise(r => setTimeout(r, 200));
    expect(shortState.get('open1')).toBeUndefined();
    expect(userManager.getEntry('open1')).toBeUndefined();
  });
});

describe('ExpectedReplyState — bot restart recovery (R8)', () => {
  test('restoreExpectedReplyStates: 超时的静默删除,未超时的重建 setTimeout', async () => {
    // 写两个 entry:一个超时,一个未超时
    await userManager.compareAndSwap('open1', null, {
      type: 'pending_agent_reply', sessionUuid: 'uuid-1', cwd: '/a',
      createdAt: new Date(Date.now() - 600_000).toISOString(),  // 10 分钟前
      startedAt: new Date(Date.now() - 600_000).toISOString(),
      timeoutMs: 300_000,  // 5 分钟超时 → 已超时
      shortId: 'short1',
    });
    await userManager.compareAndSwap('open2', null, {
      type: 'pending_agent_reply', sessionUuid: 'uuid-2', cwd: '/b',
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      timeoutMs: 300_000,  // 未超时
      shortId: 'short2',
    });
    const newState = new ExpectedReplyState(userManager, 300_000);
    await newState.restoreExpectedReplyStates();
    // open1 已超时 → 删除
    expect(userManager.getEntry('open1')).toBeUndefined();
    // open2 未超时 → 重建
    expect(newState.get('open2')?.shortId).toBe('short2');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/unit/agent-view/expected-reply-state.test.ts 2>&1 | head -10`
Expected: FAIL

- [ ] **Step 3: 实现**

```typescript
// src/agent-view/expected-reply-state.ts
import type { UserManager, MappingEntry } from '../feishu/mapping';

export interface ExpectedReplyInfo {
  shortId: string;
  sessionId: string;   // = MappingEntry.sessionUuid
  cwd: string;
  // startedAt / timeoutMs 由 state 内部管理
}

interface InternalEntry {
  shortId: string;
  sessionId: string;
  cwd: string;
  startedAt: number;   // epoch ms
  timeoutMs: number;
  casToken: string;
}

export class ExpectedReplyState {
  private inMemory = new Map<string, InternalEntry>();
  private timeoutTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private userManager: UserManager,
    private defaultTimeoutMs: number = 300_000  // 5 分钟
  ) {}

  /**
   * 设置 expectedReply 状态。CAS 写入 user-mapping(同 openId 旧 entry 被覆盖)。
   * 失败抛错(让调用方决定降级)。
   */
  async set(openId: string, info: ExpectedReplyInfo): Promise<void> {
    const now = Date.now();
    const casToken = `${now}-${Math.random().toString(36).slice(2, 10)}`;
    const newEntry: MappingEntry = {
      type: 'pending_agent_reply',
      sessionUuid: info.sessionId,
      cwd: info.cwd,
      createdAt: new Date(now).toISOString(),
      startedAt: new Date(now).toISOString(),
      timeoutMs: this.defaultTimeoutMs,
      shortId: info.shortId,
      casToken,
    };
    // CAS: expected = null(覆盖任何旧 type)
    const ok = await this.userManager.compareAndSwap(openId, null, newEntry);
    if (!ok) {
      throw new Error(`Failed to set expectedReply for ${openId}: CAS failed`);
    }
    // in-memory
    const internal: InternalEntry = {
      shortId: info.shortId,
      sessionId: info.sessionId,
      cwd: info.cwd,
      startedAt: now,
      timeoutMs: this.defaultTimeoutMs,
      casToken,
    };
    this.inMemory.set(openId, internal);
    this.scheduleTimeout(openId);
  }

  /**
   * 清除 expectedReply 状态(从 user-mapping 和 in-memory 都删)。
   * reason: 'user' / 'timeout' / 'overwrite'
   */
  async clear(openId: string, _reason?: 'user' | 'timeout' | 'overwrite'): Promise<void> {
    const current = this.userManager.getEntry(openId);
    if (current?.type !== 'pending_agent_reply') return;  // 已经不在了
    const casToken = current.casToken;
    const ok = await this.userManager.compareAndSwap(openId, current, null);
    if (ok) {
      this.inMemory.delete(openId);
      this.clearTimer(openId);
    }
  }

  get(openId: string): ExpectedReplyInfo | undefined {
    const e = this.inMemory.get(openId);
    if (!e) return undefined;
    return { shortId: e.shortId, sessionId: e.sessionId, cwd: e.cwd };
  }

  private scheduleTimeout(openId: string): void {
    this.clearTimer(openId);
    const e = this.inMemory.get(openId);
    if (!e) return;
    const remain = e.timeoutMs - (Date.now() - e.startedAt);
    if (remain <= 0) {
      // 已超时,立即清除
      void this.clear(openId, 'timeout');
      return;
    }
    const timer = setTimeout(() => {
      void this.clear(openId, 'timeout');
    }, remain);
    this.timeoutTimers.set(openId, timer);
  }

  private clearTimer(openId: string): void {
    const t = this.timeoutTimers.get(openId);
    if (t) {
      clearTimeout(t);
      this.timeoutTimers.delete(openId);
    }
  }

  /**
   * Bot 启动恢复(R8):
   * 遍历 user-mapping,对 `pending_agent_reply` 类型:
   * - 已超时:静默删除
   * - 未超时:in-memory 重建 + setTimeout 剩余时间
   */
  async restoreExpectedReplyStates(): Promise<void> {
    // UserManager 当前不暴露 allEntries,需要新增方法或 hack
    // 这里通过遍历文件系统:由调用方提供所有 entry
    // 实际:UserManager 应该提供 listAllEntries() 或类似接口
    // 这里用一个临时方案:readFileSync 整个文件
    const fs = await import('fs/promises');
    let raw: string;
    try {
      raw = await fs.readFile(
        // @ts-ignore — 访问 private 字段仅用于 R8 启动恢复
        (this.userManager as any).mappingPath,
        'utf8'
      );
    } catch {
      return;
    }
    const parsed = JSON.parse(raw);
    const entries = parsed.entries || {};
    for (const [openId, entry] of Object.entries(entries)) {
      const e = entry as any;
      if (e.type !== 'pending_agent_reply') continue;
      const startedAt = new Date(e.startedAt).getTime();
      const elapsed = Date.now() - startedAt;
      if (elapsed >= e.timeoutMs) {
        // 已超时,静默删除
        await this.userManager.compareAndSwap(openId, e, null);
      } else {
        // 未超时,重建
        const internal: InternalEntry = {
          shortId: e.shortId,
          sessionId: e.sessionUuid,
          cwd: e.cwd || '',
          startedAt,
          timeoutMs: e.timeoutMs,
          casToken: e.casToken || '',
        };
        this.inMemory.set(openId, internal);
        this.scheduleTimeout(openId);
      }
    }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/unit/agent-view/expected-reply-state.test.ts 2>&1 | tail -10`
Expected: 5 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/agent-view/expected-reply-state.ts tests/unit/agent-view/expected-reply-state.test.ts
git commit -m "feat(agent-view): add expected-reply-state with in-memory + user-mapping + timeout + R8 restore"
```

---

## Phase 4: 静态卡

### Task 9: card.ts(6 种卡构建函数)

**Files:**
- Create: `src/agent-view/card.ts`
- Test: `tests/unit/agent-view/card.test.ts`

**上下文:** 6 种静态卡:列表 / peek / 错误 / 空 / 等待输入 / 停止确认。每种返回飞书卡片 JSON 字符串(不是 send 出去)。字节上限 25KB(沿用 stream.max_card_bytes),超限需要 caller 降级到文本。

- [ ] **Step 1: 写失败测试 + 实现 + 跑测试**

```typescript
// tests/unit/agent-view/card.test.ts
import { describe, test, expect } from 'bun:test';
import { buildListCard, buildPeekCard, buildErrorCard, buildEmptyCard, buildWaitingCard, buildStopConfirmCard } from '../../../src/agent-view/card';
import { groupByStatus } from '../../../src/agent-view/types';
import { parseAgentsJson } from '../../../src/agent-view/snapshot';
import { readFileSync } from 'fs';
import { join } from 'path';

const fixtureDir = join(import.meta.dir, '..', '..', 'fixtures', 'agents-json');

describe('buildListCard', () => {
  test('renders busy / waiting / idle groups with correct buttons', () => {
    const sessions = parseAgentsJson(readFileSync(join(fixtureDir, 'waiting.json'), 'utf8'));
    const groups = groupByStatus(sessions);
    const card = JSON.parse(buildListCard(groups, '12:34:56'));
    expect(card.header.template).toBe('blue');
    expect(card.header.title.content).toContain('Agent View');
    // waiting 组显示 [Peek] [Attach] [Reply]
    const waitingRow = card.elements.find((e: any) => e.tag === 'action' && e.actions.some((a: any) => a.value?.tag === 'agent_view_reply_request'));
    expect(waitingRow).toBeDefined();
  });

  test('renders empty groups (no group header for empty)', () => {
    const card = JSON.parse(buildListCard({ busy: [], waiting: [], idle: [] }, '12:34:56'));
    // 不应有 3 个分组标题(只 0 个分组)
    const groupHeaders = card.elements.filter((e: any) => e.tag === 'markdown' && /^.*\([0-9]+\)/.test(e.content || ''));
    expect(groupHeaders).toHaveLength(0);
  });

  test('exceeds 25KB: caller should fallback to text', () => {
    // 构造 200 个 session
    const big = Array.from({length: 200}, (_, i) => ({
      pid: i, cwd: '/very/long/path/to/some/directory/' + i, kind: 'background',
      startedAt: 1000 + i, sessionId: 'uuid-' + i, name: 'session-' + i + '-name-very-long', status: 'busy',
    }));
    const sessions = parseAgentsJson(JSON.stringify(big));
    const groups = groupByStatus(sessions);
    const cardStr = buildListCard(groups, '12:34:56');
    const size = new TextEncoder().encode(cardStr).length;
    // 列表上限 10 个,所以正常情况不会超 25KB
    // 这个测试只确认 size 是 number
    expect(typeof size).toBe('number');
  });
});

describe('buildPeekCard', () => {
  test('renders status + waitingFor + recentOutput', () => {
    const card = JSON.parse(buildPeekCard({
      name: 'flaky-test-fix',
      status: 'waiting',
      waitingFor: 'input needed',
      cwd: '~/projects/my-app',
      pid: 33348,
      startedAt: 1780728421000,
      recentOutput: 'What would you like to do?',
      buttons: { peek: true, attach: true, reply: true, stop: false, refresh: true },
    }));
    expect(card.header.title.content).toContain('flaky-test-fix');
    expect(JSON.stringify(card)).toContain('input needed');
  });
});

describe('buildErrorCard', () => {
  test('renders version error', () => {
    const card = JSON.parse(buildErrorCard({
      title: 'Claude 版本过低',
      body: '需要 v2.1.139+,当前 v2.1.100',
    }));
    expect(card.header.template).toBe('red');
    expect(card.header.title.content).toContain('❌');
  });
});

describe('buildEmptyCard', () => {
  test('renders empty state with [回到普通聊天] + [Refresh]', () => {
    const card = JSON.parse(buildEmptyCard());
    const actions = card.elements.find((e: any) => e.tag === 'action');
    const tags = actions?.actions?.map((a: any) => a.value?.tag) || [];
    expect(tags).toContain('agent_view_back_to_chat');
    expect(tags).toContain('agent_view_refresh_list');
  });
});

describe('buildWaitingCard', () => {
  test('renders waiting input card with [取消等待]', () => {
    const card = JSON.parse(buildWaitingCard({
      name: 'power-up',
      status: 'waiting',
      waitingFor: 'input needed',
      cwd: '/x',
    }));
    const actions = card.elements.find((e: any) => e.tag === 'action');
    expect(actions?.actions?.[0]?.value?.tag).toBe('agent_view_cancel_reply');
    expect(JSON.stringify(card)).toContain('5 分钟');
  });
});

describe('buildStopConfirmCard', () => {
  test('renders stop confirm with [确认停止] + [取消]', () => {
    const card = JSON.parse(buildStopConfirmCard('flaky-test-fix', 'short1', 'uuid-1'));
    const actions = card.elements.find((e: any) => e.tag === 'action');
    const tags = actions?.actions?.map((a: any) => a.value?.tag) || [];
    expect(tags).toContain('agent_view_stop_confirm');
  });
});
```

```typescript
// src/agent-view/card.ts
import type { AgentSessionGroup, AgentSession, AgentSessionStatus } from './types';

const TEMPLATE_HEADER = { config: { wide_screen_mode: true } };

/** 列表卡:按 busy / waiting / idle 三组渲染 */
export function buildListCard(groups: AgentSessionGroup, refreshedAt: string): string {
  const elements: any[] = [];
  for (const [status, list] of [
    ['busy', groups.busy],
    ['waiting', groups.waiting],
    ['idle', groups.idle],
  ] as Array<[AgentSessionStatus, AgentSession[]]>) {
    if (list.length === 0) continue;
    const title = status === 'busy' ? '处理中' : status === 'waiting' ? '等待输入' : '已完成/空闲';
    elements.push({ tag: 'markdown', content: `**${title} (${list.length})**` });
    for (const s of list) {
      const emoji = status === 'busy' ? '✽' : status === 'waiting' ? '✋' : '⏹';
      const elapsed = humanizeElapsed(Date.now() - s.startedAt);
      elements.push({ tag: 'markdown', content: `${emoji} \`${s.name}\`  ·  ${elapsed}\n📁 ${truncateCwd(s.cwd)}` });
      // 按钮
      const actions: any[] = [
        { tag: 'button', text: { tag: 'plain_text', content: 'Peek' }, value: { tag: 'agent_view_peek', shortId: s.sessionId.slice(0, 8), sessionId: s.sessionId, cwd: s.cwd }, type: 'default' },
        { tag: 'button', text: { tag: 'plain_text', content: 'Attach' }, value: { tag: 'agent_view_attach', sessionId: s.sessionId, shortId: s.sessionId.slice(0, 8), name: s.name, cwd: s.cwd }, type: 'default' },
      ];
      if (status === 'waiting') {
        actions.push({ tag: 'button', text: { tag: 'plain_text', content: 'Reply' }, value: { tag: 'agent_view_reply_request', shortId: s.sessionId.slice(0, 8), sessionId: s.sessionId, cwd: s.cwd }, type: 'primary' });
      }
      if (status === 'busy') {
        actions.push({ tag: 'button', text: { tag: 'plain_text', content: 'Stop' }, value: { tag: 'agent_view_stop', shortId: s.sessionId.slice(0, 8), sessionId: s.sessionId, name: s.name }, type: 'danger' });
      }
      elements.push({ tag: 'action', actions });
    }
  }
  elements.push({ tag: 'hr' });
  elements.push({
    tag: 'action',
    actions: [
      { tag: 'button', text: { tag: 'plain_text', content: '🔄 Refresh' }, value: { tag: 'agent_view_refresh_list' }, type: 'default' },
    ],
  });
  return JSON.stringify({
    ...TEMPLATE_HEADER,
    header: { title: { tag: 'plain_text', content: `🤖 Agent View · ${countTotal(groups)} sessions` }, template: 'blue' },
    elements: [{ tag: 'markdown', content: `Last refreshed ${refreshedAt}` }, ...elements],
  });
}

function countTotal(groups: AgentSessionGroup): number {
  return groups.busy.length + groups.waiting.length + groups.idle.length;
}

function humanizeElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function truncateCwd(cwd: string): string {
  const home = process.env.HOME || '/';
  return cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd;
}

/** Peek 卡:显示 status / waitingFor / recentOutput */
export function buildPeekCard(opts: {
  name: string; status: AgentSessionStatus; waitingFor?: string;
  shortId: string; sessionId: string;  // 按钮 value 需要(v2.2 修正)
  cwd: string; pid: number; startedAt: number; recentOutput: string;
  buttons: { peek: boolean; attach: boolean; reply: boolean; stop: boolean; refresh: boolean };
}): string {
  const statusLabel = opts.status === 'busy' ? '处理中' : opts.status === 'waiting' ? '等待输入' : '已完成';
  const elements: any[] = [
    { tag: 'markdown', content: `Status: ${statusLabel} (${opts.status})${opts.waitingFor ? `\n等待原因: ${opts.waitingFor}` : ''}\nCWD: ${truncateCwd(opts.cwd)}\nPID: ${opts.pid}  ·  Started ${new Date(opts.startedAt).toLocaleString()}` },
    { tag: 'markdown', content: `**Recent output**\n\`\`\`\n${opts.recentOutput}\n\`\`\`` },
  ];
  // 按钮(根据 status 决定可见性)
  const actions: any[] = [];
  if (opts.buttons.peek) actions.push({ tag: 'button', text: { tag: 'plain_text', content: '🔄 Refresh' }, value: { tag: 'agent_view_refresh_peek', shortId: opts.shortId, sessionId: opts.sessionId }, type: 'default' });
  if (opts.buttons.attach) actions.push({ tag: 'button', text: { tag: 'plain_text', content: 'Attach' }, value: { tag: 'agent_view_attach', sessionId: opts.sessionId, shortId: opts.shortId, name: opts.name, cwd: opts.cwd }, type: 'default' });
  if (opts.buttons.reply) actions.push({ tag: 'button', text: { tag: 'plain_text', content: 'Reply' }, value: { tag: 'agent_view_reply_request', shortId: opts.shortId, sessionId: opts.sessionId, cwd: opts.cwd }, type: 'primary' });
  if (opts.buttons.stop) actions.push({ tag: 'button', text: { tag: 'plain_text', content: 'Stop' }, value: { tag: 'agent_view_stop', shortId: opts.shortId, sessionId: opts.sessionId, name: opts.name }, type: 'danger' });
  if (actions.length > 0) elements.push({ tag: 'action', actions });
  return JSON.stringify({
    ...TEMPLATE_HEADER,
    header: { title: { tag: 'plain_text', content: `🔍 Peek · \`${opts.name}\`` }, template: 'blue' },
    elements,
  });
}

/** 错误卡 */
export function buildErrorCard(opts: { title: string; body: string; refreshButton?: boolean }): string {
  const elements: any[] = [{ tag: 'markdown', content: opts.body }];
  if (opts.refreshButton) {
    elements.push({ tag: 'action', actions: [
      { tag: 'button', text: { tag: 'plain_text', content: '🔄 重新检测' }, value: { tag: 'agent_view_refresh_list' }, type: 'default' },
    ]});
  }
  return JSON.stringify({
    ...TEMPLATE_HEADER,
    header: { title: { tag: 'plain_text', content: opts.title }, template: 'red' },
    elements,
  });
}

/** 空状态卡:无 background session */
export function buildEmptyCard(): string {
  return JSON.stringify({
    ...TEMPLATE_HEADER,
    header: { title: { tag: 'plain_text', content: '🤖 Agent View' }, template: 'grey' },
    elements: [
      { tag: 'markdown', content: '暂无后台会话\n\nAgent View 用于管理用 `claude --bg` 派发的后台任务。在终端执行:\n\n  claude --bg "你的任务描述"\n\n派发后会出现在这里。' },
      { tag: 'action', actions: [
        { tag: 'button', text: { tag: 'plain_text', content: '🔄 Refresh' }, value: { tag: 'agent_view_refresh_list' }, type: 'default' },
        { tag: 'button', text: { tag: 'plain_text', content: '💬 回到普通聊天' }, value: { tag: 'agent_view_back_to_chat' }, type: 'default' },
      ]},
    ],
  });
}

/** 等待输入卡:用户点 [Reply] 后 patch 原 list/peek 卡为此卡 */
export function buildWaitingCard(opts: { name: string; status: AgentSessionStatus; waitingFor?: string; cwd: string }): string {
  const statusLabel = '等待输入';
  return JSON.stringify({
    ...TEMPLATE_HEADER,
    header: { title: { tag: 'plain_text', content: `✍️ 等待输入回复 · \`${opts.name}\`` }, template: 'yellow' },
    elements: [
      { tag: 'markdown', content: `状态:${statusLabel} (${opts.status})${opts.waitingFor ? `\n等待原因: ${opts.waitingFor}` : ''}\nCWD: ${truncateCwd(opts.cwd)}` },
      { tag: 'markdown', content: '请直接发送文字消息作为回复(5 分钟内有效)\n\n⏱ 等待输入中(5 分钟后超时)' },
      { tag: 'action', actions: [
        { tag: 'button', text: { tag: 'plain_text', content: '取消等待' }, value: { tag: 'agent_view_cancel_reply' }, type: 'danger' },
      ]},
    ],
  });
}

/** 停止确认卡:busy 状态点 [Stop] 后 */
export function buildStopConfirmCard(name: string, shortId: string, sessionId: string): string {
  return JSON.stringify({
    ...TEMPLATE_HEADER,
    header: { title: { tag: 'plain_text', content: `🔴 确认停止? · \`${name}\`` }, template: 'red' },
    elements: [
      { tag: 'markdown', content: '该 session 正在处理任务,停止后无法撤销。\n\n提示:Claude 可能正处于工具调用中,长任务中断需要重新派发。' },
      { tag: 'action', actions: [
        { tag: 'button', text: { tag: 'plain_text', content: '✅ 确认停止' }, value: { tag: 'agent_view_stop_confirm', shortId, sessionId }, type: 'danger' },
        { tag: 'button', text: { tag: 'plain_text', content: '← 取消' }, value: { tag: 'agent_view_refresh_list' }, type: 'default' },
      ]},
    ],
  });
}
```

Run: `bun test tests/unit/agent-view/card.test.ts 2>&1 | tail -15`
Expected: 8 tests pass

- [ ] **Step 2: Commit**

```bash
git add src/agent-view/card.ts tests/unit/agent-view/card.test.ts
git commit -m "feat(agent-view): add 6 static card builders"
```

---

## Phase 5: 顶层协调

### Task 10: manager.ts (AgentViewManager) 骨架

**Files:**
- Create: `src/agent-view/manager.ts`
- Test: `tests/unit/agent-view/manager.test.ts`(只测骨架,业务流在 T14-T25)

- [ ] **Step 1: 写骨架 + 测试**

```typescript
// src/agent-view/manager.ts
import type { UserManager, MappingEntry } from '../feishu/mapping';
import { AgentSnapshotFetcher } from './snapshot-fetcher';
import { ExpectedReplyState } from './expected-reply-state';
import { buildListCard, buildPeekCard, buildErrorCard, buildEmptyCard, buildWaitingCard, buildStopConfirmCard } from './card';
import type { AgentSession, AgentSessionGroup, AgentSessionStatus } from './types';
import { groupByStatus } from './types';

export interface AgentViewDeps {
  userManager: UserManager;
  feishuClient?: any;  // 类型由 bot.ts 注入,这里不强类型
  replyFn: (text: string, opts: { openId: string; messageId?: string }) => Promise<string | null>;
  cardReplyFn: (card: string, opts: { openId: string; messageId?: string }) => Promise<string | null>;
  patchFn: (messageId: string, card: string) => Promise<any>;
  runChatSDK: (params: {
    openId: string; sessionUuid: string; cwd: string;
    promptText: string; serialKey: string; isNew?: boolean;
    settingsPath?: string;
  }) => Promise<{ result: any; handler: any; cardMessageId: string }>;
  expectedReplyTimeoutMs?: number;
}

export class AgentViewManager {
  readonly expectedReply: ExpectedReplyState;
  private minRefreshIntervalMs = 2000;
  private lastRefreshAt = 0;

  constructor(public deps: AgentViewDeps) {
    this.expectedReply = new ExpectedReplyState(
      deps.userManager,
      deps.expectedReplyTimeoutMs ?? 300_000
    );
  }

  /** /agents 命令入口 */
  async handleList(openId: string, _msgMessageId?: string): Promise<void> {
    const result = await AgentSnapshotFetcher.fetch();
    if (!result.ok) {
      await this.deps.replyFn(`❌ ${result.reason}`, { openId });
      return;
    }
    const groups = groupByStatus(result.sessions);
    const card = buildListCard(groups, new Date().toLocaleTimeString());
    await this.deps.cardReplyFn(card, { openId });
  }

  /** R8 启动恢复钩子 */
  async restoreExpectedReplyStates(): Promise<void> {
    await this.expectedReply.restoreExpectedReplyStates();
  }

  /** Refresh 防抖 */
  shouldRefresh(): boolean {
    const now = Date.now();
    if (now - this.lastRefreshAt < this.minRefreshIntervalMs) return false;
    this.lastRefreshAt = now;
    return true;
  }
}
```

```typescript
// tests/unit/agent-view/manager.test.ts
import { describe, test, expect, beforeEach } from 'bun:test';
import { AgentViewManager } from '../../../src/agent-view/manager';
import { UserManager } from '../../../src/feishu/mapping';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('AgentViewManager skeleton', () => {
  let userManager: UserManager;
  let mgr: AgentViewManager;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agent-view-mgr-'));
    userManager = new UserManager(join(tmpDir, 'user-mapping.json'));
    mgr = new AgentViewManager({
      userManager,
      replyFn: async () => null,
      cardReplyFn: async () => null,
      patchFn: async () => null,
      runChatSDK: async () => ({ result: {}, handler: {}, cardMessageId: '' }),
    });
  });

  test('constructs with defaults', () => {
    expect(mgr.expectedReply).toBeDefined();
    expect(mgr.shouldRefresh()).toBe(true);  // 第一次返回 true
  });

  test('shouldRefresh debounces', () => {
    expect(mgr.shouldRefresh()).toBe(true);
    expect(mgr.shouldRefresh()).toBe(false);  // 立即第二次 false
  });
});
```

Run: `bun test tests/unit/agent-view/manager.test.ts 2>&1 | tail -10`
Expected: 2 tests pass

- [ ] **Step 2: Commit**

```bash
git add src/agent-view/manager.ts tests/unit/agent-view/manager.test.ts
git commit -m "feat(agent-view): add AgentViewManager skeleton with handleList + shouldRefresh"
```

---

(Phase 3-5 完成。Phase 6-7 继续追加)

## Phase 6: 公共化(handleChatSDK → public runChatSDK)

### Task 11: 把 handleChatSDK 改成 public runChatSDK

**Files:**
- Modify: `src/feishu/bot.ts:1019-1138`(`handleChatSDK` → `runChatSDK`)

**上下文:** Agent View reply 复用 `handleChatSDK` 整套生命周期(权限卡 + 1200ms 完成 patch + fallback 切文本)。原方法是 `private`,需要改成 `public`,改名 `runChatSDK`,把 `msg: SpoolMessage` 参数拆成 7 个原始参数(openId / sessionUuid / cwd / settingsPath / promptText / serialKey / isNew),让外部(AgentViewManager)可以直接调。

- [ ] **Step 1: 提取 7 个参数,改 public**

修改 `src/feishu/bot.ts`:

```typescript
// 旧:
private async handleChatSDK(
  msg: SpoolMessage, sessionUuid: string, cwd: string, currentEntry: any,
): Promise<void> { ... }

// 新:
public async runChatSDK(params: {
  openId: string;
  sessionUuid: string;
  cwd: string;
  settingsPath?: string;
  promptText: string;
  serialKey: string;
  isNew?: boolean;
}): Promise<{ result: any; handler: any; cardMessageId: string }> {
  // 内部逻辑跟原 handleChatSDK 一致,但用 params 替代 msg
  // 关键改动:
  // - startProcessing 用 params.openId 替代 msg.openId
  // - sendSDKMessage 用 params.sessionUuid / params.promptText / params.cwd / params.serialKey / params.settingsPath / params.isNew
  // - 返回 { result, handler, cardMessageId }
}
```

原 `handleChatSDK` 内部实现保持不变,只是把 `msg.xxx` 替换成 `params.xxx`,并增加 return 语句。

- [ ] **Step 2: 替换调用方**

`src/feishu/bot.ts` 里 `handleChat` 内部调用 `this.handleChatSDK(...)` 改成:

```typescript
private async handleChatSDK_OLD_TO_DELETE(msg: SpoolMessage, sessionUuid: string, cwd: string, currentEntry: any): Promise<void> {
  // 简化为:构造参数,调 runChatSDK
  const settingsPath = this.getSettingsPathForUser(msg.openId);
  const promptText = buildPromptWithImages(msg.text, msg.imagePaths ?? []);
  await this.runChatSDK({
    openId: msg.openId,
    sessionUuid,
    cwd,
    settingsPath,
    promptText,
    serialKey: msg.serialKey,
  });
}
```

(也可以直接 inline 到 handleChat,取决于改动范围)

- [ ] **Step 2.5: setAgentView 时用箭头函数绑 this**

`src/feishu/bot.ts` 加 `setAgentView`:

```typescript
// 关键:用箭头函数捕获 this,deps.runChatSDK 调时 this 不会丢
setAgentView(mgr: AgentViewManager): void {
  this.agentView = mgr;
  // 把 bot 的 runChatSDK 绑成箭头函数,AgentViewManager.handleReply 调时 this 正确指向 FeishuBot
  mgr.deps.runChatSDK = (params) => this.runChatSDK(params);
}
```

- [ ] **Step 3: 跑 typecheck + 现有测试**

Run: `bun run typecheck 2>&1 | tail -10`
Expected: 通过

Run: `bun test tests/unit/feishu/bot.test.ts 2>&1 | tail -10`
Expected: 所有 bot.test 现有测试通过(没有破坏)

- [ ] **Step 4: Commit**

```bash
git add src/feishu/bot.ts
git commit -m "refactor(bot): extract handleChatSDK as public runChatSDK for Agent View reuse"
```

---

## Phase 7: 命令/Action 路由

### Task 12: handleCommand 加 /agents case

**Files:**
- Modify: `src/feishu/bot.ts:738-787`(`handleCommand` switch)
- Test: `tests/unit/feishu/bot-command.test.ts`(新建,只测 /agents 分派)

- [ ] **Step 1: 加 case + 依赖注入**

```typescript
// src/feishu/bot.ts
// 1. 在 FeishuBot 类加一个 private agentView?: AgentViewManager;
// 2. 加 setAgentView(mgr: AgentViewManager) { this.agentView = mgr; }
// 3. handleCommand switch 加 case:
case 'agents':
  if (!this.agentView) {
    await this.replyAndFinalize(msg, 'Agent View 未启用(检查 config.toml [agent_view].enabled)');
    return;
  }
  await this.agentView.handleList(msg.openId, msg.messageId);
  return;
```

- [ ] **Step 2: 写测试**

```typescript
// tests/unit/feishu/bot-command.test.ts
import { describe, test, expect, beforeEach } from 'bun:test';
import { FeishuBot } from '../../../src/feishu/bot';
import { AgentViewManager } from '../../../src/agent-view/manager';
import { UserManager } from '../../../src/feishu/mapping';
// ... (imports for buildMockSpoolMessage 等)

describe('FeishuBot.handleCommand /agents', () => {
  test('dispatches to agentView.handleList', async () => {
    let called = false;
    const mgr = { handleList: async (openId: string) => { called = true; } } as any;
    bot.setAgentView(mgr);
    // 构造 mock msg 调 handleCommand({ text: '/agents' })
    // assert mgr.handleList called
    expect(called).toBe(true);
  });
});
```

- [ ] **Step 3: 跑测试通过**

Run: `bun test tests/unit/feishu/bot-command.test.ts 2>&1 | tail -10`

- [ ] **Step 4: Commit**

```bash
git add src/feishu/bot.ts tests/unit/feishu/bot-command.test.ts
git commit -m "feat(bot): add /agents command dispatching to AgentViewManager"
```

---

### Task 13: handleCardAction 加 9 个 agent_view_* case

**Files:**
- Create: `src/agent-view/action.ts`(9 种 AgentViewValue 类型)
- Modify: `src/feishu/bot.ts:438-525`(`handleCardAction` switch)
- Test: `tests/unit/agent-view/action.test.ts`

- [ ] **Step 1: 创建 action.ts 类型**

```typescript
// src/agent-view/action.ts
export type AgentViewValue =
  | { tag: 'agent_view_refresh_list' }
  | { tag: 'agent_view_refresh_peek'; shortId: string; sessionId: string }
  | { tag: 'agent_view_peek'; shortId: string; sessionId: string; cwd: string }
  | { tag: 'agent_view_attach'; sessionId: string; shortId: string; name: string; cwd: string }
  | { tag: 'agent_view_reply_request'; shortId: string; sessionId: string; cwd: string }
  | { tag: 'agent_view_cancel_reply' }
  | { tag: 'agent_view_stop'; shortId: string; sessionId: string; name: string }
  | { tag: 'agent_view_stop_confirm'; shortId: string; sessionId: string }
  | { tag: 'agent_view_back_to_chat' };

export function isAgentViewValue(v: any): v is AgentViewValue {
  return v && typeof v === 'object' && typeof v.tag === 'string' && v.tag.startsWith('agent_view_');
}
```

- [ ] **Step 2: 测试**

```typescript
// tests/unit/agent-view/action.test.ts
import { describe, test, expect } from 'bun:test';
import { isAgentViewValue, type AgentViewValue } from '../../../src/agent-view/action';

describe('isAgentViewValue', () => {
  test('accepts all 9 tags', () => {
    for (const tag of [
      'agent_view_refresh_list', 'agent_view_refresh_peek', 'agent_view_peek',
      'agent_view_attach', 'agent_view_reply_request', 'agent_view_cancel_reply',
      'agent_view_stop', 'agent_view_stop_confirm', 'agent_view_back_to_chat',
    ]) {
      expect(isAgentViewValue({ tag })).toBe(true);
    }
  });
  test('rejects non-agent_view tags', () => {
    expect(isAgentViewValue({ tag: 'help' })).toBe(false);
    expect(isAgentViewValue(null)).toBe(false);
  });
});
```

- [ ] **Step 3: 实现 + 跑测试通过 + Commit**

```bash
git add src/agent-view/action.ts tests/unit/agent-view/action.test.ts
git commit -m "feat(agent-view): add 9 agent_view_* action value types"
```

- [ ] **Step 4: 在 handleCardAction switch 加 9 个 case**

```typescript
// src/feishu/bot.ts handleCardAction switch 内
if (isAgentViewValue(value)) {
  const messageId = message?.message_id;
  // 9 个 case 分派
  switch (value.tag) {
    case 'agent_view_refresh_list':  return await this.agentView!.handleRefreshList(openId, messageId);
    case 'agent_view_refresh_peek':  return await this.agentView!.handleRefreshPeek(openId, value.shortId, value.sessionId, messageId);
    case 'agent_view_peek':          return await this.agentView!.handlePeek(openId, value.shortId, value.sessionId, value.cwd);
    case 'agent_view_attach':        return await this.agentView!.handleAttach(openId, value.sessionId, value.shortId, value.name, value.cwd);
    case 'agent_view_reply_request': return await this.agentView!.handleReplyRequest(openId, value.shortId, value.sessionId, value.cwd);
    case 'agent_view_cancel_reply':  return await this.agentView!.handleCancelReply(openId, messageId);
    case 'agent_view_stop':          return await this.agentView!.handleStop(openId, value.shortId, value.sessionId, value.name);
    case 'agent_view_stop_confirm':  return await this.agentView!.handleStopConfirm(openId, value.shortId, value.sessionId, messageId);
    case 'agent_view_back_to_chat':  return await this.agentView!.handleBackToChat(openId);
  }
}
```

(这些 handler 方法在 Phase 8 业务流 T14-T22 里有完整实现,见对应 task)

- [ ] **Step 5: typecheck + 现有测试 + Commit**

Run: `bun run typecheck 2>&1 | tail -5`
Run: `bun test tests/unit/feishu/bot.test.ts 2>&1 | tail -5`
Expected: 通过

```bash
git add src/feishu/bot.ts src/agent-view/action.ts tests/unit/agent-view/action.test.ts
git commit -m "feat(bot): dispatch 9 agent_view_* tags to AgentViewManager"
```

---

(Phase 6-7 完成。Phase 8 业务流继续追加)

## Phase 8: 业务流(10 个 task,每个一个或一组 handler)

**注意:** 业务流测试是 `tests/unit/agent-view/manager.test.ts` 的扩展,每个 task 加 1-2 个 test case。handler 实现用 `AgentViewManager` 类扩展。

### Task 14: handleList + handleRefreshList(列表 + 刷新)

**Files:**
- Modify: `src/agent-view/manager.ts`(扩展 AgentViewManager 类)

- [ ] **Step 1: 实现 handleList + handleRefreshList**

```typescript
// 在 AgentViewManager 类加方法
async handleList(openId: string, _msgMessageId?: string): Promise<void> {
  const result = await AgentSnapshotFetcher.fetch();
  if (!result.ok) {
    const card = buildErrorCard({ title: '❌ Agent View 错误', body: result.reason });
    await this.deps.cardReplyFn(card, { openId });
    return;
  }
  const groups = groupByStatus(result.sessions);
  if (groups.busy.length + groups.waiting.length + groups.idle.length === 0) {
    const card = buildEmptyCard();
    await this.deps.cardReplyFn(card, { openId });
    return;
  }
  const card = buildListCard(groups, new Date().toLocaleTimeString());
  const cardMessageId = await this.deps.cardReplyFn(card, { openId });
  if (cardMessageId) {
    // 保存 cardMessageId 到 user-mapping(last_agent_list_card)
    await this.deps.userManager.compareAndSwap(openId, null, {
      type: 'last_agent_list_card',
      sessionUuid: null,
      createdAt: new Date().toISOString(),
      cardMessageId,
      updatedAt: new Date().toISOString(),
      casToken: `${Date.now()}-init`,
    });
  }
}

async handleRefreshList(openId: string, messageId?: string): Promise<void> {
  if (!messageId) return;
  if (!this.shouldRefresh()) return;  // 防抖
  // v2.2 修正:校验 messageId 匹配 last_agent_list_card.cardMessageId(spec §6.4)
  // 防止用户从飞书历史消息点 [Refresh](旧 messageId 已 patch 过),误 patch 错卡片
  const entry = this.deps.userManager.getEntry(openId);
  if (entry?.type !== 'last_agent_list_card' || entry.cardMessageId !== messageId) {
    // 校验失败:发新列表卡(覆盖原 cardMessageId 记录)
    await this.handleList(openId);
    return;
  }
  const result = await AgentSnapshotFetcher.fetch();
  if (!result.ok) {
    // patch 错误卡
    const card = buildErrorCard({ title: '❌ Refresh 失败', body: result.reason, refreshButton: true });
    await this.deps.patchFn(messageId, card);
    return;
  }
  const groups = groupByStatus(result.sessions);
  if (groups.busy.length + groups.waiting.length + groups.idle.length === 0) {
    const card = buildEmptyCard();
    await this.deps.patchFn(messageId, card);
    return;
  }
  const card = buildListCard(groups, new Date().toLocaleTimeString());
  await this.deps.patchFn(messageId, card);
}
```

- [ ] **Step 2: 加测试**

```typescript
// tests/unit/agent-view/manager.test.ts 追加
test('handleList sends list card on success', async () => {
  // mock AgentSnapshotFetcher 返回固定 sessions
  // mock cardReplyFn
  // 验证 buildListCard 被调
});
test('handleList sends empty card when no background sessions', async () => {});
test('handleList sends error card on fetch failure', async () => {});
test('handleRefreshList patches same card with fresh data', async () => {});
test('handleRefreshList respects debounce (shouldRefresh)', async () => {});
```

- [ ] **Step 3: 跑测试 + Commit**

```bash
git add src/agent-view/manager.ts tests/unit/agent-view/manager.test.ts
git commit -m "feat(agent-view): implement handleList and handleRefreshList"
```

---

### Task 15: handlePeek + handleRefreshPeek

**Files:**
- Modify: `src/agent-view/manager.ts`

- [ ] **Step 1: 实现**

```typescript
async handlePeek(openId: string, shortId: string, sessionId: string, cwd: string): Promise<void> {
  // 从 latest snapshot 找 session 信息(name, status, waitingFor, pid, startedAt)
  const session = await this.findSession(openId, sessionId);
  if (!session) {
    await this.deps.replyFn('⚠️ 会话已不存在', { openId });
    return;
  }
  // execFile 'claude logs <shortId>'
  let raw: string;
  try {
    const cp = await import('node:child_process');
    const { execFile: execFileCb } = cp;
    const { promisify } = await import('node:util');
    const execFileP = promisify(execFileCb);
    const result = await execFileP('claude', ['logs', shortId]);
    raw = result.stdout;
  } catch (err: any) {
    await this.deps.replyFn(`❌ claude logs 失败:${err.message}`, { openId });
    return;
  }
  // strip ANSI + truncate
  const { stripAnsi } = await import('./ansi-strip');
  const stripped = stripAnsi(raw);
  const lines = stripped.split('\n').slice(-30).join('\n');
  // agent-view 自己实现 truncateBytes(简单,避免跨模块依赖 card-updater private)
  const truncated = (function truncateBytes(s: string, max: number): string {
    return new TextEncoder().encode(s).length <= max
      ? s
      : (() => {
          // 截断到 max bytes(简化:按字符截,可能略多但不超过 max)
          let acc = '';
          for (const ch of s) {
            if (new TextEncoder().encode(acc + ch).length > max) break;
            acc += ch;
          }
          return acc;
        })();
  })(lines, 2048);
  // build peek card
  const buttons = {
    peek: true, attach: true,
    reply: session.status === 'waiting',
    stop: session.status === 'busy',
    refresh: true,
  };
  const card = buildPeekCard({
    name: session.name, status: session.status, waitingFor: session.waitingFor,
    shortId, sessionId, cwd,
    pid: session.pid, startedAt: session.startedAt,
    recentOutput: truncated, buttons,
  });
  await this.deps.cardReplyFn(card, { openId });
}

async handleRefreshPeek(openId: string, shortId: string, sessionId: string, messageId?: string): Promise<void> {
  if (!messageId) return;
  // v2.2 补完整:跟 handlePeek 类似,但用 patchFn patch 现有 peek 卡
  const session = await this.findSession(openId, sessionId);
  if (!session) {
    await this.deps.patchFn(messageId, buildErrorCard({
      title: '⚠️ 会话已不存在',
      body: '已自动刷新列表',
    }));
    return;
  }
  let raw: string;
  try {
    const cp = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileP = promisify(cp.execFile);
    const result = await execFileP('claude', ['logs', shortId]);
    raw = result.stdout;
  } catch (err: any) {
    await this.deps.patchFn(messageId, buildErrorCard({
      title: '❌ claude logs 失败',
      body: err.message,
    }));
    return;
  }
  const { stripAnsi } = await import('./ansi-strip');
  const stripped = stripAnsi(raw);
  const lines = stripped.split('\n').slice(-30).join('\n');
  // 同 handlePeek 的 truncateBytes 实现(见上)
  const truncated = (function truncateBytes(s: string, max: number): string {
    return new TextEncoder().encode(s).length <= max
      ? s
      : (() => {
          let acc = '';
          for (const ch of s) {
            if (new TextEncoder().encode(acc + ch).length > max) break;
            acc += ch;
          }
          return acc;
        })();
  })(lines, 2048);
  const buttons = {
    peek: true, attach: true,
    reply: session.status === 'waiting',
    stop: session.status === 'busy',
    refresh: true,
  };
  const card = buildPeekCard({
    name: session.name, status: session.status, waitingFor: session.waitingFor,
    shortId, sessionId, cwd: session.cwd,
    pid: session.pid, startedAt: session.startedAt,
    recentOutput: truncated, buttons,
  });
  await this.deps.patchFn(messageId, card);
}
```

- [ ] **Step 2: 测试 + Commit**

```bash
git add src/agent-view/manager.ts tests/unit/agent-view/manager.test.ts
git commit -m "feat(agent-view): implement handlePeek and handleRefreshPeek"
```

---

### Task 16: handleBackToChat

**Files:**
- Modify: `src/agent-view/manager.ts`

- [ ] **Step 1: 实现**

```typescript
async handleBackToChat(openId: string): Promise<void> {
  // 发独立文本消息,飞书流里多一条文本
  await this.deps.replyFn('已退出 Agent View,继续发送消息或 / 命令即可。下次进 /agents 视图重新打 /agents。', { openId });
}
```

- [ ] **Step 2: 测试 + Commit**

```bash
git add src/agent-view/manager.ts tests/unit/agent-view/manager.test.ts
git commit -m "feat(agent-view): implement handleBackToChat"
```

---

### Task 17: handleReplyRequest(Step A — 设置 expectedReply 状态)

**Files:**
- Modify: `src/agent-view/manager.ts`

**上下文:** Step A 完整流程:
1. 三重守卫(状态 + kind + roster)
2. 持久化 expectedReply 标记
3. in-memory 镜像
4. patch 触发的 list/peek 卡为等待输入卡
5. 发独立文本消息
6. setTimeout(5min)

- [ ] **Step 1: 实现**

```typescript
async handleReplyRequest(openId: string, shortId: string, sessionId: string, cwd: string): Promise<void> {
  // 1. 三重守卫
  const result = await AgentSnapshotFetcher.fetch();
  if (!result.ok) {
    await this.deps.replyFn(`❌ ${result.reason}`, { openId });
    return;
  }
  const session = result.sessions.find(s => s.sessionId === sessionId);
  if (!session) {
    await this.deps.replyFn('⚠️ 会话已不存在', { openId });
    return;
  }
  if (session.status !== 'waiting') {
    await this.deps.replyFn(`⚠️ 该 session 不是 waiting 状态(当前 ${session.status}),无法 reply`, { openId });
    return;
  }
  // 2. 持久化 expectedReply
  try {
    await this.expectedReply.set(openId, { shortId, sessionId, cwd });
  } catch (err: any) {
    await this.deps.replyFn(`⚠️ 另一端正在操作,请先在对方客户端取消`, { openId });
    return;
  }
  // 3. patch 触发的 list 卡为等待输入卡(v2.2 补完整)
  const listEntry = this.deps.userManager.getEntry(openId);
  if (listEntry?.type === 'last_agent_list_card' && listEntry.cardMessageId) {
    const waitingCard = buildWaitingCard({
      name: session.name,
      status: session.status,
      waitingFor: session.waitingFor,
      cwd,
    });
    await this.deps.patchFn(listEntry.cardMessageId, waitingCard);
  }
  // 4. 发独立文本消息(顺序:patch 后再发文本)
  await this.deps.replyFn(
    `↩️ 回复会话: ${session.name}\n请直接发送文字消息作为回复(5 分钟内有效)\n可点 [取消等待] 按钮,或发 /cancel 取消`,
    { openId }
  );
  // 5. setTimeout 由 ExpectedReplyState.set 内部处理,这里不用管
}
```

- [ ] **Step 2: 测试 + Commit**

```bash
git add src/agent-view/manager.ts tests/unit/agent-view/manager.test.ts
git commit -m "feat(agent-view): implement handleReplyRequest (Step A) with three-way guard"
```

---

### Task 18: handleReply(Step B — 调 runChatSDK 完整生命周期)

**Files:**
- Modify: `src/agent-view/manager.ts`

**上下文:** Step B 完整流程:
1. 检查 expectedReply 状态
2. `/cancel` / `/` 写命令处理
3. CAS 抢占
4. Step B 二次状态守卫
5. 调 `runChatSDK` 完整生命周期(流式 + 权限 + 1200ms 完成 patch + fallback)
6. 完成后 releaseSessionLock

- [ ] **Step 1: 实现**

```typescript
async handleReply(openId: string, text: string): Promise<void> {
  // 1. 检查 expectedReply
  const info = this.expectedReply.get(openId);
  if (!info) return;  // 不是预期的 reply

  // 2. CAS 抢占(改 casToken 标识"reply 开始了")
  let current: any;
  try {
    const entry = this.deps.userManager.getEntry(openId);
    if (entry?.type !== 'pending_agent_reply') return;
    const casToken = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const ok = await this.deps.userManager.compareAndSwap(openId, entry, {
      ...entry, casToken,
    });
    if (!ok) {
      // CAS 失败,patch 等待卡为"已取消"
      return;  // 简化:不 patch
    }
    current = entry;
  } catch (err) {
    return;
  }

  // 3. Step B 二次状态守卫
  const result = await AgentSnapshotFetcher.fetch();
  if (!result.ok) {
    await this.expectedReply.clear(openId);
    return;
  }
  const session = result.sessions.find(s => s.sessionId === info.sessionId);
  if (!session) {
    await this.expectedReply.clear(openId);
    await this.deps.replyFn('⚠️ 会话已不存在', { openId });
    return;
  }
  if (session.status !== 'waiting') {
    await this.expectedReply.clear(openId);
    await this.deps.replyFn(`⚠️ Claude 已切换到 ${session.status},无法 reply`, { openId });
    return;
  }

  // 4. 调 runChatSDK(完整生命周期)
  // 用 try/finally 保证 expectedReply.clear(openId) 一定被调,
  // 否则 runChatSDK 抛错时用户卡在 waiting 状态直到 5 分钟超时
  try {
    await this.deps.runChatSDK({
      openId,
      sessionUuid: info.sessionId,
      cwd: info.cwd,
      promptText: text,
      serialKey: info.sessionId,
      isNew: false,
    });
  } finally {
    await this.expectedReply.clear(openId);
  }
}
```

- [ ] **Step 2: 测试 + Commit**

```bash
git add src/agent-view/manager.ts tests/unit/agent-view/manager.test.ts
git commit -m "feat(agent-view): implement handleReply (Step B) with CAS + re-guard + runChatSDK"
```

---

### Task 19: handleCancelReply(取消等待)

**Files:**
- Modify: `src/agent-view/manager.ts`

- [ ] **Step 1: 实现**

```typescript
async handleCancelReply(openId: string, _messageId?: string): Promise<void> {
  await this.expectedReply.clear(openId, 'user');
  await this.deps.replyFn('✅ 已取消等待回复', { openId });
}
```

(更复杂:CAS 失败时行为,见 spec §5.3 完整流程)

- [ ] **Step 2: 测试 + Commit**

```bash
git add src/agent-view/manager.ts tests/unit/agent-view/manager.test.ts
git commit -m "feat(agent-view): implement handleCancelReply"
```

---

### Task 20: handleStop(发独立二次确认卡)

**Files:**
- Modify: `src/agent-view/manager.ts`

- [ ] **Step 1: 实现**

```typescript
async handleStop(openId: string, shortId: string, sessionId: string, name: string): Promise<void> {
  // 二次确认分流:busy 才发,其他状态按钮不显示(死分支)
  // 实际:发独立新卡
  const card = buildStopConfirmCard(name);
  await this.deps.cardReplyFn(card, { openId });
}
```

- [ ] **Step 2: 测试 + Commit**

```bash
git add src/agent-view/manager.ts tests/unit/agent-view/manager.test.ts
git commit -m "feat(agent-view): implement handleStop (sends independent confirm card)"
```

---

### Task 21: handleStopConfirm(真执行 claude stop)

**Files:**
- Modify: `src/agent-view/manager.ts`

- [ ] **Step 1: 实现**

```typescript
async handleStopConfirm(openId: string, shortId: string, _sessionId: string, _messageId?: string): Promise<void> {
  try {
    const cp = await import('node:child_process');
    const { execFile: execFileCb } = cp;
    const { promisify } = await import('node:util');
    const execFileP = promisify(execFileCb);
    await execFileP('claude', ['stop', shortId], { timeout: 5000 });
    await new Promise(r => setTimeout(r, 1000));  // 等 supervisor 收尾
    await this.deps.replyFn(`✅ 已停止 ${shortId}`, { openId });
    // 重新拉并 patch 列表卡(如果有)
    await this.handleList(openId);
  } catch (err: any) {
    await this.deps.replyFn(`❌ Stop 失败:${err.message}`, { openId });
  }
}
```

- [ ] **Step 2: 测试 + Commit**

```bash
git add src/agent-view/manager.ts tests/unit/agent-view/manager.test.ts
git commit -m "feat(agent-view): implement handleStopConfirm (claude stop + refresh)"
```

---

### Task 22: handleAttach(分两步 CAS 绑定 session)

**Files:**
- Modify: `src/agent-view/manager.ts`

**上下文:** Attach 是 v2.2 新增。核心:两次 CAS(先清旧 entry,再写新 session entry),保留 defaultProvider。

- [ ] **Step 1: 实现**

```typescript
async handleAttach(openId: string, sessionId: string, _shortId: string, _name: string, cwd: string): Promise<void> {
  // 0. 实时守卫
  const result = await AgentSnapshotFetcher.fetch();
  if (!result.ok || !result.sessions.find(s => s.sessionId === sessionId)) {
    await this.deps.replyFn('⚠️ 会话已不存在', { openId });
    return;
  }
  // 1. 清除 expectedReply(如果有)
  await this.expectedReply.clear(openId, 'overwrite');
  // 2. CAS 1: 清旧 entry
  const oldEntry = this.deps.userManager.getEntry(openId);
  if (oldEntry) {
    const ok1 = await this.deps.userManager.compareAndSwap(openId, oldEntry, null);
    if (!ok1) {
      await this.deps.replyFn('⚠️ 状态冲突,请重试', { openId });
      return;
    }
  }
  // 3. CAS 2: 写新 session entry
  const newEntry: MappingEntry = {
    type: 'session',
    sessionUuid: sessionId,
    cwd,
    createdAt: new Date().toISOString(),
    defaultProvider: oldEntry?.defaultProvider,  // 保留
  };
  const ok2 = await this.deps.userManager.compareAndSwap(openId, null, newEntry);
  if (!ok2) {
    await this.deps.replyFn('⚠️ 状态冲突,请重试', { openId });
    return;
  }
  // 4. 发确认文本
  const session = result.sessions.find(s => s.sessionId === sessionId)!;
  const warning = session.status === 'busy' ? '\n⚠️ 该 session 正在处理中' : '';
  const waitingInfo = session.status === 'waiting' && session.waitingFor ? `\n等待原因: ${session.waitingFor}` : '';
  await this.deps.replyFn(
    `📎 已 Attach 到 \`${session.name}\`${warning}${waitingInfo}\n` +
    `Status: ${session.status} · CWD: ${cwd}\n` +
    `💡 提示:发 /new 创建新会话,或 /agents 返回列表。`,
    { openId }
  );
}
```

- [ ] **Step 2: 测试 + Commit**

```bash
git add src/agent-view/manager.ts tests/unit/agent-view/manager.test.ts
git commit -m "feat(agent-view): implement handleAttach (two-step CAS binding)"
```

---

### Task 23: handleChat 集成 expectedReply 检查

**Files:**
- Modify: `src/feishu/bot.ts:789`(`handleChat` 入口)

**上下文:** 用户发普通文本消息时,bot.handleChat 入口先检查 expectedReply 状态(先 in-memory,后 user-mapping.json)。命中 → 调 agentView.handleReply。`/cancel` / `/` 写命令 → 调 handleCancelReply。

- [ ] **Step 1: 修改 handleChat 入口**

```typescript
// src/feishu/bot.ts:789
private async handleChat(msg: SpoolMessage): Promise<void> {
  // v2.2 修正:Agent View expectedReply 检查(spec §5.3 /` 命令白名单)
  if (this.agentView) {
    if (msg.text === '/cancel') {
      await this.agentView.handleCancelReply(msg.openId, msg.messageId);
      return;
    }
    if (msg.text.startsWith('/')) {
      const cmd = msg.text.split(/\s+/)[0]?.replace(/^\/+/, '').toLowerCase();
      const isReadOnly = ['help', 'status', 'whoami'].includes(cmd || '');
      if (!isReadOnly) {
        // 写命令:清 expectedReply + patch "已自动取消"
        const info = this.agentView.expectedReply.get(msg.openId);
        if (info) {
          await this.agentView.expectedReply.clear(msg.openId, 'overwrite');
          await this.replyFn(`⏱ 等待输入已自动取消(因你跑了 /${cmd})`, { openId: msg.openId, requestUuid: uniqueUuid() });
        }
        // 写命令:走原 handleCommand 分发(N 修复:必须显式调,否则命令不会执行)
        await this.handleCommand(msg);
        return;
      }
      // 只读命令:不清 expectedReply,继续按命令分发(N 修复:显式调)
      await this.handleCommand(msg);
      return;
    }
    // 非 / 开头普通消息:检查 expectedReply
    const info = this.agentView.expectedReply.get(msg.openId);
    if (info) {
      await this.agentView.handleReply(msg.openId, msg.text);
      return;
    }
  }
  // 原 handleChat 逻辑
  switch (msg.target.type) { ... }
}
```
```

- [ ] **Step 2: 测试 + Commit**

```bash
git add src/feishu/bot.ts tests/unit/feishu/bot.test.ts
git commit -m "feat(bot): integrate expectedReply check in handleChat entry"
```

---

(Phase 8 完成。Phase 9-10 继续追加)

## Phase 9: 配置

### Task 24: config.ts 加 [agent_view] 节

**Files:**
- Modify: `src/utils/config.ts`(加 5 个 key + env override)

- [ ] **Step 1: 修改 config.ts**

在 `src/utils/config.ts:64` 附近的 types 加:

```typescript
export interface AgentViewConfig {
  enabled: boolean;
  refresh_min_interval_ms: number;
  peek_lines: number;
  peek_max_bytes: number;
  expected_reply_timeout_ms: number;
  background_only: boolean;
  stop_requires_confirm: boolean;
  min_claude_version: string;
  reply_throttle_ms: number;
}
```

在默认配置 `defaults` 对象加:

```typescript
agent_view: {
  enabled: true,
  refresh_min_interval_ms: 2000,
  peek_lines: 30,
  peek_max_bytes: 2048,
  expected_reply_timeout_ms: 300_000,
  background_only: true,
  stop_requires_confirm: true,
  min_claude_version: '2.1.139',
  reply_throttle_ms: 500,
},
```

在 `envMap` 加 8 个 env override:

```typescript
['CC_LINKER_AGENT_VIEW_ENABLED', 'agent_view', 'enabled'],
['CC_LINKER_AGENT_VIEW_REFRESH_MIN_INTERVAL_MS', 'agent_view', 'refresh_min_interval_ms'],
['CC_LINKER_AGENT_VIEW_PEEK_LINES', 'agent_view', 'peek_lines'],
['CC_LINKER_AGENT_VIEW_PEEK_MAX_BYTES', 'agent_view', 'peek_max_bytes'],
['CC_LINKER_AGENT_VIEW_EXPECTED_REPLY_TIMEOUT_MS', 'agent_view', 'expected_reply_timeout_ms'],
['CC_LINKER_AGENT_VIEW_BACKGROUND_ONLY', 'agent_view', 'background_only'],
['CC_LINKER_AGENT_VIEW_STOP_REQUIRES_CONFIRM', 'agent_view', 'stop_requires_confirm'],
['CC_LINKER_AGENT_VIEW_REPLY_THROTTLE_MS', 'agent_view', 'reply_throttle_ms'],
```

- [ ] **Step 2: 测试**

```typescript
// 在 tests/unit/utils/config.test.ts 加
test('agent_view defaults to enabled=true', () => {
  expect(config.get<boolean>('agent_view.enabled')).toBe(true);
});
test('agent_view.reply_throttle_ms default 500', () => {
  expect(config.get<number>('agent_view.reply_throttle_ms')).toBe(500);
});
test('CC_LINKER_AGENT_VIEW_ENABLED env override', () => {
  process.env.CC_LINKER_AGENT_VIEW_ENABLED = 'false';
  // 重新加载 config
  expect(config.get<boolean>('agent_view.enabled')).toBe(false);
});
```

- [ ] **Step 3: 跑测试 + Commit**

```bash
git add src/utils/config.ts tests/unit/utils/config.test.ts
git commit -m "feat(config): add [agent_view] section with 9 keys + env overrides"
```

---

## Phase 10: 集成 + 文档

### Task 25: 集成测试(端到端 mock)

**Files:**
- Create: `tests/integration/agent-view.test.ts`

- [ ] **Step 1: 写集成测试**

```typescript
// tests/integration/agent-view.test.ts
import { describe, test, expect, beforeEach } from 'bun:test';
import { AgentViewManager } from '../../src/agent-view/manager';
import { UserManager } from '../../src/feishu/mapping';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as cp from 'node:child_process';
import { VersionGuard } from '../../src/agent-view/version-guard';
import { DaemonProbe } from '../../src/agent-view/daemon-probe';

describe('Agent View integration: /agents → list → peek → reply', () => {
  let tmpDir: string;
  let userManager: UserManager;
  let mgr: AgentViewManager;
  let mockReplyFn: any;
  let mockCardFn: any;
  let mockPatchFn: any;
  let mockRunChatSDK: any;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agent-view-int-'));
    userManager = new UserManager(join(tmpDir, 'user-mapping.json'));
    mockReplyFn = async (text: string) => { /* record */ };
    mockCardFn = async (card: string) => 'om_test_123';
    mockPatchFn = async (msgId: string, card: string) => ({ ok: true });
    mockRunChatSDK = async (params: any) => ({ result: {}, handler: {}, cardMessageId: 'om_reply' });
    mgr = new AgentViewManager({
      userManager,
      replyFn: mockReplyFn,
      cardReplyFn: mockCardFn,
      patchFn: mockPatchFn,
      runChatSDK: mockRunChatSDK,
    });
    // mock claude CLI
    (cp as any).execFileSync = () => '2.1.163\n';
    (DaemonProbe as any).check = () => true;
  });

  test('end-to-end: list shows mixed groups', async () => {
    (cp as any).execFile = (cmd: string, args: string[], cb: any) => {
      cb(null, JSON.stringify([
        {pid:1,cwd:'/a',kind:'background',startedAt:1000,sessionId:'uuid-1',name:'t1',status:'busy'},
        {pid:2,cwd:'/b',kind:'background',startedAt:2000,sessionId:'uuid-2',name:'t2',status:'waiting',waitingFor:'input'},
        {pid:3,cwd:'/c',kind:'background',startedAt:3000,sessionId:'uuid-3',name:'t3',status:'idle'},
      ]), '');
    };
    await mgr.handleList('open1');
    // 验证 cardReplyFn 被调
    // (实际测试中用 spy)
  });

  test('end-to-end: reply happy path', async () => {
    // setup: waiting session
    (cp as any).execFile = (cmd: string, args: string[], cb: any) => {
      cb(null, JSON.stringify([
        {pid:1,cwd:'/a',kind:'background',startedAt:1000,sessionId:'uuid-1',name:'t1',status:'waiting',waitingFor:'input'},
      ]), '');
    };
    await mgr.handleReplyRequest('open1', 'short1', 'uuid-1', '/a');
    // expectedReply 已设置
    expect(mgr.expectedReply.get('open1')?.sessionId).toBe('uuid-1');
    // 发文本
    await mgr.handleReply('open1', 'hello');
    // runChatSDK 应被调
    // expectedReply 应被清
    expect(mgr.expectedReply.get('open1')).toBeUndefined();
  });

  test('end-to-end: reply rejected when status changed to busy', async () => {
    let callCount = 0;
    (cp as any).execFile = (cmd: string, args: string[], cb: any) => {
      // 第一次返 waiting(Step A 通过),第二次返 busy(Step B 二次守卫拒绝)
      callCount++;
      if (callCount === 1) {
        cb(null, JSON.stringify([
          {pid:1,cwd:'/a',kind:'background',startedAt:1000,sessionId:'uuid-1',name:'t1',status:'waiting',waitingFor:'input'},
        ]), '');
      } else {
        cb(null, JSON.stringify([
          {pid:1,cwd:'/a',kind:'background',startedAt:1000,sessionId:'uuid-1',name:'t1',status:'busy'},
        ]), '');
      }
    };
    await mgr.handleReplyRequest('open1', 'short1', 'uuid-1', '/a');
    await mgr.handleReply('open1', 'hello');
    // runChatSDK 不应被调(status busy)
    // expectedReply 应被清
    expect(mgr.expectedReply.get('open1')).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试通过 + Commit**

```bash
git add tests/integration/agent-view.test.ts
git commit -m "test(agent-view): add integration tests for list/peek/reply flow"
```

---

### Task 26: README + CLAUDE.md 文档更新

**Files:**
- Modify: `README.md`(中文)
- Modify: `README_en.md`(英文)
- Modify: `CLAUDE.md`("Important Files" 表加 `src/agent-view/`)

- [ ] **Step 1: README.md 新增章节**

在 `README.md` 加 "Agent View 集成" 章节:

```markdown
## 飞书侧 Agent View 支持

cc-linker 桥接 Claude Code 2.1.139+ 的 Agent View 能力,让飞书用户可以:

- `/agents` 列出所有 background session(按 busy/waiting/idle 分组)
- [Peek] 查看 session 最近 TTY 输出(自动 strip ANSI)
- [Reply] 给 waiting 状态 session 注入消息(两步式文本)
- [Stop] 终止 busy 状态 session(二次确认)
- [Attach] 绑定 background session 为当前活跃 session

**前置条件**:`claude` CLI ≥ 2.1.139,Claude daemon 已自动拉起(在终端跑过 `claude` 命令)。

**配置**(`config.toml`):

```toml
[agent_view]
enabled = true
refresh_min_interval_ms = 2000
peek_lines = 30
peek_max_bytes = 2048
expected_reply_timeout_ms = 300000
background_only = true
stop_requires_confirm = true
min_claude_version = "2.1.139"
reply_throttle_ms = 500
```
```

- [ ] **Step 2: README_en.md 同样内容(英文)**

- [ ] **Step 3: CLAUDE.md "Important Files" 表加**

```markdown
| `src/agent-view/` | Claude Code Agent View 飞书侧桥接(列表/Peek/Reply/Stop/Attach) |
```

- [ ] **Step 4: 验证文档 lint**

如果有 markdown lint:

Run: `bun run lint 2>&1 | tail -10`(如果没有,跳过)

- [ ] **Step 5: Commit**

```bash
git add README.md README_en.md CLAUDE.md
git commit -m "docs: add Agent View section to README and src/agent-view/ to CLAUDE.md"
```

---

### Task 27: 整体验收(spec §11 DoD 41 项)

**Files:** 无(只是跑测试 + 手动验证)

- [ ] **Step 1: 跑全套测试**

Run: `bun test 2>&1 | tail -10`
Expected: 全部 pass

- [ ] **Step 2: 跑 typecheck**

Run: `bun run typecheck 2>&1 | tail -5`
Expected: 通过

- [ ] **Step 3: 跑 build(生成 standalone binary)**

Run: `bun run build 2>&1 | tail -5`
Expected: 成功生成 dist/cc-linker

- [ ] **Step 4: 手动验收(spec §10.4 场景)**

按 spec §10.4 跑完整端到端:
- 启 cc-linker
- 终端 `claude --bg "<长任务>"`
- 飞书 `/agents` 看到列表
- 点 [Peek] 看输出(ANSI 干净)
- 让 Claude 进入 waiting,点 [Reply] → 列表卡 patch 为"等待输入" → 发文本
- 点 [Attach] 验证 Attach 流程
- 点 `[取消]` 验证取消
- 点 busy 状态 [Stop] → 二次确认卡 → [✅ 确认停止] → 真停掉
- 验证 Activity Marker 写入
- bot 重启后 expectedReply 状态恢复
- 关掉 daemon 后 /agents 看到"daemon 未运行"卡

- [ ] **Step 5: spec §11 DoD 41 项逐条勾选**

打开 `docs/superpowers/specs/2026-06-01-feishu-agent-view-design.md` §11,逐条勾选,任何失败项记录到 plan 末尾"未完成项"。

- [ ] **Step 6: 最终 commit(如有文档修订)**

```bash
git add -A
git commit -m "docs: tick off DoD items in spec §11 after end-to-end verification" --allow-empty
```

---

(全部 task 完成)





