# Claude 二进制解析器:Sdk bundled binary 缺失时的回退链

> **给 agentic 执行者:** 必读技能 — 使用 superpowers:subagent-driven-development (推荐) 或 superpowers:executing-plans 来逐任务实现本方案。步骤使用 checkbox (`- [ ]`) 语法跟踪进度。

**目标 (Goal):** 新增 `resolveClaudeExecutable()` 优先级链解析器,让飞书机器人的 SDK 路径在 `@anthropic-ai/claude-agent-sdk-{platform}-{arch}` (SDK 的 optional-dep 原生二进制) 缺失的机器上仍能工作 —— 当前 SDK 会抛 `Native CLI binary for darwin-arm64 not found.`,用户在飞书卡里看到的是一句让人摸不着头脑的 `Claude SDK 执行失败: …`。解析器在 SDK bundled 二进制缺失时,会降级回退到 `general.claude_bin` (系统 PATH 中的 `claude`),并打一条醒目的 WARN 日志;如果连这个也没有,就抛 `E_SDK_NO_CLAUDE`,错误消息里直接列出三种可操作的修法。

**架构 (Architecture):** 纯函数 `resolveClaudeExecutable(configLike, options)`,放在新增的 `src/proxy/claude-executable.ts`。优先级链: `1. sdk.claude_executable → 2. SDK bundled (require.resolve 命中) → 3. general.claude_bin (Bun.which 命中) → 4. 抛 E_SDK_NO_CLAUDE`。返回 `{path, source, fallback}`,调用方可以日志记录选了哪个来源、是不是降级路径。`sendSDKMessage` (`src/proxy/session.ts`) 在入口调用解析器,把解析出来的路径作为 `pathToClaudeCodeExecutable` 传给 SDK —— **永远传,不再有"省略"分支**。解析器抛错时,`sendSDKMessage` 直接 short-circuit,把可操作的错误消息塞进响应卡,**不会进入 `query()`**。

**技术栈 (Tech Stack):** Bun + TypeScript + bun:test。**不引入新依赖**。复用已有的 `CCLinkerError`(或扩展)、`config`、`logger`。

**Spec / 证据 (Evidence):**
- 根因分析: 本会话 (2026-06-15) — SDK 包 optionalDependency 结构、`sdk.mjs` 解析代码、`599b2da` 回归历史
- 回归 commit: `599b2da` "fix: SDK 默认使用自带二进制,避免与全局 claude-code 版本不兼容" —— 解释为什么现在默认是 `''`
- 原始设计意图: `docs/superpowers/specs/2026-05-24-feishu-permission-interaction-design.md:94,334-349` —— 显示原本 `pathToClaudeCodeExecutable: 'claude'` 是默认值,而非"fallback 路径"

---

## 决策依据 (Decision Rationale)

| 备选方案 | 拒绝理由 |
|---|---|
| **A. 把默认值改回 `'claude'`** | 直接撤销 `599b2da`。会让所有默认用户(不只是 omit=optional 那批)重新陷入"系统 claude 与 SDK 0.3.150 不兼容"的旧 bug |
| **B. 只翻译错误消息** | 表面功夫。没有触及"找不到二进制"这个根因 |
| **C. bundled 缺失时启动期硬错** | 牺牲可用性。很多用户(CI、standalone binary、NODE_ENV=production)系统里有 `claude`,让他们跑不起来太浪费 |
| **D. 优先级链解析器 + 显式 fallback** (本次选择) | 对 bundled 存在的场景保留 `599b2da` 意图;bundled 缺失场景优雅降级;WARN + source 标记让降级可观测;复用 `sdk.claude_executable` 和 `general.claude_bin` 已有配置,**不增加新配置面** |

**关键设计选择 (Key design choices):**

1. **解析器是纯函数 + DI**: 入参 `configLike`(任何 `{get}` 形态) + 可选 `platform` / `arch` / `resolveBundled` / `resolveBinaryOverride`。生产环境传真 `config`;测试传 mock。**不用 `mock.module`**,测试简单,解析器可独立 review
2. **fallback 永远 WARN,绝不静默**: 运维必须能 grep `binary=.*fallback` 找出降级实例
3. **永远传 `pathToClaudeCodeExecutable`**: 去掉 `sendSDKMessage` 里"省略"分支。解析器保证返回值可用,`sdkOptions` 里那个条件判断就没必要了
4. **错误消息列三种修法**: `npm install --include=optional` / `npm i -g @anthropic-ai/claude-code` / 设置 `sdk.claude_executable`。用户**永远不会看到原始英文 SDK 错误**

**明确不在本次范围内 (Out of scope,留给其他方案):**
- `package.json` 里把 `^0.3.150` 缩紧到 `~0.3.150` (单独方案: SDK 版本锁定)
- `sdk.min_sdk_version` 运行时检测 (单独方案: SDK 版本探测)
- `bun build --compile` 出的 standalone binary 里 `tryResolveBundled` 的行为 —— 尽力而为,预期 fall through 到 general fallback
- `L2 postinstall` 主动装 optional-dep 二进制 (锦上添花,本次修复不依赖)

---

## 文件结构 (File Structure)

```
src/proxy/
├── claude-executable.ts          [新增]   纯解析器 + 类型定义 (~170 行,含注释)
└── session.ts                    [修改]   sendSDKMessage: 替换内联 config 读取 + sdkOptions 条件分支为解析器调用 (~30 行 diff)

tests/unit/proxy/
└── claude-executable.test.ts     [新增]   13 个用例覆盖所有优先级分支 + one-shot de-noise + 平台注入

src/utils/
└── errors.ts                     [可能修改] 如果错误码注册表需要预先登记则加 E_SDK_NO_CLAUDE;否则通过 CCLinkerError 直接传字符串 code

README.md / README_en.md          [修改]   SDK 模式一节加一句话:"若 SDK bundled 二进制缺失,cc-linker 自动 fallback 到 general.claude_bin (系统 PATH 'claude'),并打 WARN 日志。"
```

**Scope 澄清(为什么不动非 SDK 路径):** `_doSendMessage` / `_doStreamingMessage` 这两条非 SDK 路径也读 `general.claude_bin`,但它们已有清晰的中文错误消息(`Claude CLI 未找到: ...`),且不依赖 SDK 的 optional-dep 二进制 —— 本次修复只针对 SDK 模式(`sendSDKMessage`)的 `pathToClaudeCodeExecutable` 这一个调用点。

**无新依赖、无迁移、无 lockfile 变更。**

---

## Task 0: 写失败用例 (TDD 红)

**文件:**
- 新增: `tests/unit/proxy/claude-executable.test.ts`

- [ ] **Step 1: 确认测试目录存在**

执行: `ls tests/unit/proxy/ 2>/dev/null || echo "MISSING"`
预期: 目录存在(若不存在需创建;`tests/unit/` 按 repo 结构已存在)

- [ ] **Step 2: 写 13 个测试用例**

新建 `tests/unit/proxy/claude-executable.test.ts`,内容如下:

```typescript
import { describe, test, expect, beforeEach, spyOn, afterEach } from 'bun:test';
import { resolveClaudeExecutable, __resetResolverState } from '../../../src/proxy/claude-executable';
import * as loggerModule from '../../../src/utils/logger';

/**
 * Mock config 构造器。测试只传关心的 key,其他走 fallback 默认值。
 * 避免 mock 模块、避免污染全局 config。
 */
const mockConfig = (overrides: Record<string, any> = {}) => ({
  get: <T>(key: string, fallback?: T): T => {
    if (key in overrides) return overrides[key] as T;
    return fallback as T;
  },
});

describe('resolveClaudeExecutable', () => {
  let warnSpy: any;
  let errorSpy: any;
  let infoSpy: any;

  beforeEach(() => {
    // 重置 one-shot de-noise 状态,保证测试间不互相污染。
    __resetResolverState();
    warnSpy = spyOn(loggerModule.logger, 'warn').mockImplementation(() => {});
    errorSpy = spyOn(loggerModule.logger, 'error').mockImplementation(() => {});
    infoSpy = spyOn(loggerModule.logger, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    infoSpy.mockRestore();
  });

  // --- 优先级 1: sdk.claude_executable ---
  describe('优先级 1: sdk.claude_executable (用户显式配置)', () => {
    test('1.1 绝对路径存在 → 用它,source=sdk_configured,fallback=false', () => {
      const cfg = mockConfig({
        'sdk.claude_executable': '/usr/local/bin/claude',
        'general.claude_bin': 'never-used',
      });
      const r = resolveClaudeExecutable(cfg, {
        platform: 'darwin',
        arch: 'arm64',
        resolveBundled: () => null,
        resolveBinaryOverride: (spec: string) =>
          spec === '/usr/local/bin/claude' ? '/usr/local/bin/claude' : null,
      });
      expect(r.path).toBe('/usr/local/bin/claude');
      expect(r.source).toBe('sdk_configured');
      expect(r.fallback).toBe(false);
    });

    test('1.2 纯名 "claude" 命中 PATH → 用 PATH 解析结果,source=sdk_configured', () => {
      const cfg = mockConfig({
        'sdk.claude_executable': 'claude',
      });
      const r = resolveClaudeExecutable(cfg, {
        platform: 'darwin',
        arch: 'arm64',
        resolveBundled: () => null,
        resolveBinaryOverride: (spec: string) =>
          spec === 'claude' ? '/opt/homebrew/bin/claude' : null,
      });
      expect(r.path).toBe('/opt/homebrew/bin/claude');
      expect(r.source).toBe('sdk_configured');
      expect(r.fallback).toBe(false);
    });

    test('1.3 用户指定路径不存在 → 警告并降级到 bundled', () => {
      const cfg = mockConfig({
        'sdk.claude_executable': '/nonexistent/path',
      });
      const r = resolveClaudeExecutable(cfg, {
        platform: 'darwin',
        arch: 'arm64',
        resolveBundled: () => '/node_modules/.../claude',
        resolveBinaryOverride: () => null,
      });
      expect(r.path).toBe('/node_modules/.../claude');
      expect(r.source).toBe('sdk_bundled');
      expect(warnSpy).toHaveBeenCalled();
      const warnMsg = warnSpy.mock.calls[0][0];
      expect(warnMsg).toContain('/nonexistent/path');
      expect(warnMsg).toContain('不可用');
    });
  });

  // --- 优先级 2: SDK bundled ---
  describe('优先级 2: SDK bundled (require.resolve 命中)', () => {
    test('2.1 darwin-arm64 + bundled 可用 → 用它,source=sdk_bundled,fallback=false', () => {
      const cfg = mockConfig({});
      const r = resolveClaudeExecutable(cfg, {
        platform: 'darwin',
        arch: 'arm64',
        resolveBundled: (p, a) =>
          p === 'darwin' && a === 'arm64' ? '/nm/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude' : null,
      });
      expect(r.path).toContain('claude-agent-sdk-darwin-arm64/claude');
      expect(r.source).toBe('sdk_bundled');
      expect(r.fallback).toBe(false);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    test('2.2 linux-x64-musl + bundled 可用 → 用它', () => {
      const cfg = mockConfig({});
      const r = resolveClaudeExecutable(cfg, {
        platform: 'linux',
        arch: 'x64',
        resolveBundled: (p, a) =>
          p === 'linux' && a === 'x64' ? '/nm/.../claude-agent-sdk-linux-x64-musl/claude' : null,
      });
      expect(r.source).toBe('sdk_bundled');
    });

    test('2.3 win32-x64 + bundled 可用 → 用它(binary 名 claude.exe,resolver 返回完整路径)', () => {
      const cfg = mockConfig({});
      const r = resolveClaudeExecutable(cfg, {
        platform: 'win32',
        arch: 'x64',
        resolveBundled: (p, a) =>
          p === 'win32' && a === 'x64' ? 'C:\\nm\\...\\claude.exe' : null,
      });
      expect(r.source).toBe('sdk_bundled');
    });
  });

  // --- 优先级 3: general.claude_bin fallback ---
  describe('优先级 3: general.claude_bin fallback', () => {
    test('3.1 bundled 缺失 + general.claude_bin="/custom/claude" 存在 → fallback + WARN,source=general_claude_bin,fallback=true', () => {
      const cfg = mockConfig({
        'general.claude_bin': '/custom/claude',
      });
      const r = resolveClaudeExecutable(cfg, {
        platform: 'darwin',
        arch: 'arm64',
        resolveBundled: () => null,
        resolveBinaryOverride: (spec) =>
          spec === '/custom/claude' ? '/custom/claude' : null,
      });
      expect(r.path).toBe('/custom/claude');
      expect(r.source).toBe('general_claude_bin');
      expect(r.fallback).toBe(true);
      expect(warnSpy).toHaveBeenCalled();
      const warnMsg = warnSpy.mock.calls[0][0];
      expect(warnMsg).toContain('SDK bundled binary 缺失');
      expect(warnMsg).toContain('--omit=optional');
      expect(warnMsg).toContain('NODE_ENV=production');
      expect(warnMsg).toContain('/custom/claude');
    });

    test('3.2 bundled 缺失 + general.claude_bin="claude"(默认)+ PATH 命中 → fallback + WARN,source=system_path,fallback=true', () => {
      const cfg = mockConfig({
        'general.claude_bin': 'claude',
      });
      const r = resolveClaudeExecutable(cfg, {
        platform: 'darwin',
        arch: 'arm64',
        resolveBundled: () => null,
        resolveBinaryOverride: (spec) =>
          spec === 'claude' ? '/opt/homebrew/bin/claude' : null,
      });
      expect(r.path).toBe('/opt/homebrew/bin/claude');
      expect(r.source).toBe('system_path');
      expect(r.fallback).toBe(true);
      expect(warnSpy).toHaveBeenCalled();
    });

    test('3.3 同一进程内多次 fallback:首次 WARN,后续 INFO(one-shot de-noise)', () => {
      // 验证 24/7 bot + bundled 缺失场景下,WARN 不会每请求一行。
      const cfg = mockConfig({
        'general.claude_bin': 'claude',
      });
      const opts = {
        platform: 'darwin' as NodeJS.Platform,
        arch: 'arm64',
        resolveBundled: () => null,
        resolveBinaryOverride: (spec: string) =>
          spec === 'claude' ? '/opt/homebrew/bin/claude' : null,
      };
      // 第一次:应触发 WARN,infoSpy 不被调用
      const r1 = resolveClaudeExecutable(cfg, opts);
      expect(r1.fallback).toBe(true);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(infoSpy).not.toHaveBeenCalled();
      // 第二次:同一进程,WARN 不再触发,infoSpy 被调用
      const r2 = resolveClaudeExecutable(cfg, opts);
      expect(r2.fallback).toBe(true);
      expect(warnSpy).toHaveBeenCalledTimes(1);  // 没新增
      expect(infoSpy).toHaveBeenCalledTimes(1);
      // 第三次:稳定
      resolveClaudeExecutable(cfg, opts);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(infoSpy).toHaveBeenCalledTimes(2);
    });
  });

  // --- 优先级 4: 硬错误 ---
  describe('优先级 4: 硬错误', () => {
    test('4.1 bundled 缺失 + general.claude_bin 无法解析 → 抛 E_SDK_NO_CLAUDE 带三种修法', () => {
      const cfg = mockConfig({
        'general.claude_bin': 'claude',
      });
      let caught: any = null;
      try {
        resolveClaudeExecutable(cfg, {
          platform: 'darwin',
          arch: 'arm64',
          resolveBundled: () => null,
          resolveBinaryOverride: () => null,
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).not.toBeNull();
      expect(caught.code).toBe('E_SDK_NO_CLAUDE');
      expect(caught.message).toContain('找不到 Claude CLI');
      expect(caught.message).toContain('--include=optional');
      expect(caught.message).toContain('npm install -g @anthropic-ai/claude-code');
      expect(caught.message).toContain('sdk.claude_executable');
    });

    test('4.2 bundled 缺失 + general.claude_bin=""(空字符串) → 抛错(空字符串视为未配置)', () => {
      const cfg = mockConfig({
        'general.claude_bin': '',
      });
      expect(() =>
        resolveClaudeExecutable(cfg, {
          platform: 'darwin',
          arch: 'arm64',
          resolveBundled: () => null,
          resolveBinaryOverride: () => null,
        }),
      ).toThrow(/找不到 Claude CLI/);
    });
  });

  // --- 平台参数注入 ---
  describe('平台/架构参数注入', () => {
    test('5.1 darwin-arm64 用户但只有 linux-x64 bundled → 不能跨平台用 linux 包,降级到 fallback', () => {
      const cfg = mockConfig({});
      const r = resolveClaudeExecutable(cfg, {
        platform: 'darwin',
        arch: 'arm64',
        resolveBundled: (p, a) => {
          // 模拟: 只有 linux 包存在
          if (p === 'linux' && a === 'x64') return '/nm/.../claude';
          return null;
        },
        resolveBinaryOverride: (spec) =>
          spec === 'claude' ? '/usr/bin/claude' : null,
      });
      // 解析器绝对不能跨平台,必须降级
      expect(r.path).toBe('/usr/bin/claude');
      expect(r.source).toBe('system_path');
      expect(r.fallback).toBe(true);
    });

    test('5.2 不传 platform 时默认用 process.platform(冒烟测试:不传 options 也能跑)', () => {
      // 不注入 platform —— 验证解析器在真实环境下能跑(dev 机器 bundled 在)。
      // 这是冒烟测试:如果 bundled 真不在 node_modules,允许抛 E_SDK_NO_CLAUDE。
      const cfg = mockConfig({});
      try {
        const r = resolveClaudeExecutable(cfg);
        // 能走到这 → bundled 或 fallback 解析到了某个东西
        expect(r.path).toBeTruthy();
        expect(['sdk_bundled', 'sdk_configured', 'general_claude_bin', 'system_path']).toContain(r.source);
      } catch (e: any) {
        // 唯一可接受的失败:错误消息含 "找不到 Claude CLI"(bundled 缺 + system 也缺)
        expect(e.message).toContain('找不到 Claude CLI');
      }
    });
  });
});
```

- [ ] **Step 3: 跑测试,确认全部失败(红)**

执行: `bun test tests/unit/proxy/claude-executable.test.ts`
预期: 13 个全部失败,失败原因是 "Cannot find module '@/proxy/claude-executable'" 或类似 import 错误。**这恰好证明了解析器文件还没创建**。

---

## Task 1: 实现解析器 (TDD 绿)

**文件:**
- 新增: `src/proxy/claude-executable.ts`

- [ ] **Step 1: 创建解析器文件**

新建 `src/proxy/claude-executable.ts`,内容:

```typescript
/**
 * Claude CLI 二进制解析器 —— 带显式 fallback 的优先级链。
 *
 * SDK 包 `@anthropic-ai/claude-agent-sdk` 把原生 `claude` 二进制声明为
 * *可选* 依赖,放在按平台划分的子包里
 * (`@anthropic-ai/claude-agent-sdk-{platform}-{arch}`)。当那个子包不在磁盘上
 * (典型原因: 用户 npm install 用了 `--omit=optional`、`NODE_ENV=production`,
 * 或者 cc-linker 跑在 `bun build --compile` 的 standalone binary 里),
 * SDK 的 `require.resolve('@anthropic-ai/claude-agent-sdk-{platform}-{arch}/claude')`
 * 抛 `MODULE_NOT_FOUND`,被 SDK 包成下面这段话抛出来:
 *
 *   "Native CLI binary for {platform}-{arch} not found. Reinstall
 *    @anthropic-ai/claude-agent-sdk without --omit=optional, or set
 *    options.pathToClaudeCodeExecutable."
 *
 * 本解析器就是 cc-linker 这一侧的"set options.pathToClaudeCodeExecutable"分支:
 * 在调用 SDK 之前先确定一个能用的 `claude` 二进制路径,通过定义的优先级链让选择
 * 可观测(`source` 字段),让降级路径很响(`fallback=true` 触发 WARN 日志 + 可操作修法)。
 *
 * 为什么不直接把 `sdk.claude_executable` 默认值改成 `'claude'`?因为那是 `599b2da`
 * 之前的行为,会导致默认用户撞上版本不兼容 bug。本解析器在 bundled 可用时优先用 bundled
 * (保留 599b2da 修复意图),bundled 缺失时才走 fallback。
 */

import { existsSync } from 'fs';
import { createRequire } from 'module';
import { platform as procPlatform, arch as procArch } from 'process';
import { logger } from '../utils/logger';
import { CCLinkerError } from '../utils/errors';

/** 解析到的二进制来自哪。每次调用都会日志记录。 */
export type ClaudeSource =
  | 'sdk_configured'       // 用户显式设了 `sdk.claude_executable`
  | 'sdk_bundled'          // SDK optional-dep 原生二进制(平台匹配)
  | 'general_claude_bin'   // 用户显式设了 `general.claude_bin` 为非默认路径
  | 'system_path';         // `general.claude_bin` 保持默认 `'claude'`,Bun.which 命中 PATH

export interface ClaudeResolution {
  /** 磁盘上存在的绝对路径,SDK 直接拿来 spawn。 */
  path: string;
  source: ClaudeSource;
  /** true = 不是 bundled (降级路径)。日志里会 warn。 */
  fallback: boolean;
}

export interface ResolveOptions {
  /** 测试用: 覆盖 `process.platform` */
  platform?: NodeJS.Platform;
  /** 测试用: 覆盖 `process.arch` */
  arch?: string;
  /** 测试用: 覆盖 bundled 二进制解析器。返回 bundled `claude` 的绝对路径或 null。生产用 require.resolve,测试注入桩函数。 */
  resolveBundled?: (platform: NodeJS.Platform, arch: string) => string | null;
  /** 测试用: 覆盖二进制路径解析 (包了 `existsSync` + `Bun.which`)。生产用下面的实现,测试注入桩函数。 */
  resolveBinaryOverride?: (spec: string) => string | null;
}

const PKG_PREFIX = '@anthropic-ai/claude-agent-sdk';

/**
 * 把"name 或 path"规格解析为磁盘上存在的绝对路径。
 * - 含路径分隔符 → 当字面路径,必须 existsSync
 * - 否则 → Bun.which 走 PATH
 * 任何失败返回 null,不抛
 */
function defaultResolveBinary(spec: string): string | null {
  if (!spec) return null;
  if (spec.includes('/') || (procPlatform === 'win32' && spec.includes('\\'))) {
    return existsSync(spec) ? spec : null;
  }
  try {
    return Bun.which(spec) ?? null;
  } catch {
    return null;
  }
}

/**
 * 探测 SDK 的 optional-dep 原生二进制是否装了。复刻 sdk.mjs 内部做的:
 *   `require.resolve('@anthropic-ai/claude-agent-sdk-{platform}-{arch}/claude')`
 * 命中返回绝对路径,未命中返回 null。
 */
function defaultResolveBundled(platform: NodeJS.Platform, arch: string): string | null {
  const pkg = `${PKG_PREFIX}-${platform}-${arch}`;
  const binName = platform === 'win32' ? 'claude.exe' : 'claude';
  try {
    const req = createRequire(import.meta.url);
    // require.resolve 自身校验存在性,不需要再 existsSync
    return req.resolve(`${pkg}/${binName}`);
  } catch {
    return null;
  }
}

/**
 * 优先级链解析器。详细设计见文件头注释。
 *
 * @param configLike - 任何 `{get}` 形态。生产传单例 `config` 模块;测试传 `{get: (k, d) => mockValue}`。
 *   解耦让我们能写纯函数测试,不用 mock.module。
 * @param options - 测试注入钩子。默认: 真实的 `process.platform` / `process.arch`,
 *   真实的 `createRequire`,真实的 `Bun.which`。
 * @throws 当所有来源都解析不到时,抛 code 为 `E_SDK_NO_CLAUDE` 的 CCLinkerError。
 */

// 模块级:每个进程内,SDK bundled 缺失导致 fallback 的 WARN 只发一次,
// 后续降级走 INFO。避免 standalone binary (`bun --compile`) / `--omit=optional` /
// `NODE_ENV=production` 的 24/7 bot 每请求一行 WARN 日志。`source` 字段
// 和 `binarySource` 日志(在 session.ts 里)不受影响,仍是 INFO 级,运维
// 仍然可以 grep `binary=.*fallback` 定位降级实例。
let fallbackWarned = false;

/**
 * 测试钩子:重置 one-shot 状态。每个 test 的 beforeEach 必须调用,
 * 保证测试间不互相污染。生产代码永远不要调用。
 * @internal
 */
export function __resetResolverState(): void {
  fallbackWarned = false;
}

export function resolveClaudeExecutable(
  configLike: { get: <T>(key: string, fallback?: T) => T },
  options: ResolveOptions = {},
): ClaudeResolution {
  const platform = options.platform ?? procPlatform;
  const arch = options.arch ?? procArch;
  const resolveBinary = options.resolveBinaryOverride ?? defaultResolveBinary;
  const resolveBundled = options.resolveBundled ?? defaultResolveBundled;

  // --- 1. sdk.claude_executable (用户显式配置) ---
  const sdkCfg = String(configLike.get<string>('sdk.claude_executable', ''));
  if (sdkCfg) {
    const p = resolveBinary(sdkCfg);
    if (p) {
      return { path: p, source: 'sdk_configured', fallback: false };
    }
    logger.warn(
      `[claude-resolver] sdk.claude_executable=${sdkCfg} 不可用 (路径不存在或 PATH 中找不到),继续尝试下一来源`,
    );
  }

  // --- 2. SDK bundled (optional-dep 原生二进制) ---
  const bundled = resolveBundled(platform, arch);
  if (bundled) {
    return { path: bundled, source: 'sdk_bundled', fallback: false };
  }

  // --- 3. general.claude_bin fallback ---
  const generalBin = String(configLike.get<string>('general.claude_bin', 'claude'));
  const generalResolved = resolveBinary(generalBin);
  if (generalResolved) {
    // One-shot de-noise: 首次 fallback 发 WARN(让运维看到),后续走 INFO。
    // 模块级 fallbackWarned 由 __resetResolverState 在测试间重置。
    if (fallbackWarned) {
      logger.info(
        `[claude-resolver] 继续走 fallback → ${generalResolved} ` +
        `(bundled 缺失;首次警告见 bot 启动早期日志,设置 [sdk] claude_executable 可消除)`,
      );
    } else {
      logger.warn(
        `[claude-resolver] SDK bundled binary 缺失 (常见原因: \`--omit=optional\` / NODE_ENV=production / standalone binary)。` +
        `回退到 general.claude_bin=${generalBin} → ${generalResolved}。` +
        `⚠️ 此 binary 版本可能与 SDK 不兼容 (exit code 1 / stream schema 异常),` +
        `如有问题请设置 [sdk] claude_executable 显式指向兼容版本,` +
        `或重装: \`npm install -g cc-linker@latest --include=optional\`。`,
      );
      fallbackWarned = true;
    }
    return {
      path: generalResolved,
      source: generalBin === 'claude' ? 'system_path' : 'general_claude_bin',
      fallback: true,
    };
  }

  // --- 4. 硬错误 ---
  throw new CCLinkerError(
    'E_SDK_NO_CLAUDE',
    `找不到 Claude CLI:
  - SDK bundled binary 缺失 (${PKG_PREFIX}-${platform}-${arch}/claude 不在)
  - general.claude_bin=${generalBin} 也无法解析

修法(任选一种):

  1) 重装 cc-linker, 保留 optional deps:
     \`npm install -g cc-linker@latest --include=optional\`

  2) 安装 Claude Code CLI:
     \`npm install -g @anthropic-ai/claude-code\`
     (完成后会自带 system 'claude',会被 resolver 自动 fallback 捕获)

  3) 在 config.toml 显式指定二进制路径:
     [sdk]
     claude_executable = "/path/to/claude"`,
  );
}
```

- [ ] **Step 2: 确认 CCLinkerError 有 `code` 字段**

执行: `grep -n "class CCLinkerError\|code:" src/utils/errors.ts | head -20`
预期: 看到一个带 `code: string` 字段的类。如果模式不同(比如工厂函数),相应调整 throw 处 —— 但保留 `code: 'E_SDK_NO_CLAUDE'` 这个值不变。

- [ ] **Step 3: 跑测试,确认全部通过(绿)**

执行: `bun test tests/unit/proxy/claude-executable.test.ts`
预期: 13 个全部通过。

如果有失败,改解析器(不是改测试)。常见踩坑:
- `Bun.which` 调用签名变了 → 直接调 `Bun.which(name)`
- `createRequire` 在测试环境解析有奇怪行为 → 用 `options.resolveBundled` 注入(不改解析器代码)
- Windows 上测试 1.1 的路径分隔符 → 测试用的是 POSIX 绝对路径,如果真在 Windows 上跑需调整 `expect(r.path).toBe(...)` 来匹配平台

---

## Task 2: 接入 sendSDKMessage

**文件:**
- 修改: `src/proxy/session.ts` (只在 `sendSDKMessage` 方法里,约 30 行 diff)

- [ ] **Step 1: 加 import**

在 `src/proxy/session.ts` 顶部 import 区,加:

```typescript
import { resolveClaudeExecutable, type ClaudeResolution } from './claude-executable';
```

(放在已有 `./stream-adapter` import 之后,按主题分组。)

- [ ] **Step 2: 用解析器调用替换内联 `claudeExecutable` 配置读取**

在 `sendSDKMessage` 里找到这段:

```typescript
      const permissionMode = config.get<string>('sdk.permission_mode', 'acceptEdits');
      const claudeExecutable = config.get<string>('sdk.claude_executable', '');

      let lastResult: any = null;
      let hasError = false;
```

把 `const claudeExecutable = config.get<string>('sdk.claude_executable', '');` 替换成:

```typescript
      const permissionMode = config.get<string>('sdk.permission_mode', 'acceptEdits');

      // 优先级链解析 claude 二进制路径 (见 claude-executable.ts)。
      // 抛 E_SDK_NO_CLAUDE 时 short-circuit 给出可操作消息 —— 不会进入 query(),
      // 不会产生误导性的 "Claude SDK 执行失败"。
      let claudeResolution: ClaudeResolution;
      try {
        claudeResolution = resolveClaudeExecutable(config);
      } catch (err: any) {
        logger.error(`[sendSDKMessage] Claude binary 解析失败: ${err.message}`);
        return {
          result: {
            response: `❌ ${err.message}`,
            costUsd: 0,
            durationMs: 0,
            sessionId: sessionId ?? '',
            jsonlPath: null,
            sessionStatus: 'degraded',
            error: err.message,
          },
          handler: new PermissionHandler({
            allowedTools: config.get<string[]>('claude.allowed_tools', []),
            disallowedTools: config.get<string[]>('claude.disallowed_tools', []),
            timeoutMs: config.get<number>('sdk.timeout_ms', 600_000),
          }),
        };
      }
```

- [ ] **Step 3: `sdkOptions` 永远包含 `pathToClaudeCodeExecutable`**

找到这段:

```typescript
      const sdkOptions: Record<string, any> = {
        permissionMode: permissionMode as any,
        canUseTool: handler.canUseTool.bind(handler),
        cwd: expandedCwd,
        allowedTools: config.get<string[]>('claude.allowed_tools', []),
        disallowedTools: config.get<string[]>('claude.disallowed_tools', []),
        abortController,
        includePartialMessages: true,
      };
      if (claudeExecutable) {
        sdkOptions.pathToClaudeCodeExecutable = claudeExecutable;
      }
```

替换成:

```typescript
      const sdkOptions: Record<string, any> = {
        permissionMode: permissionMode as any,
        canUseTool: handler.canUseTool.bind(handler),
        cwd: expandedCwd,
        allowedTools: config.get<string[]>('claude.allowed_tools', []),
        disallowedTools: config.get<string[]>('claude.disallowed_tools', []),
        abortController,
        includePartialMessages: true,
        pathToClaudeCodeExecutable: claudeResolution.path,
      };
```

- [ ] **Step 4: `binarySource` 日志改用解析器的 source**

找到:

```typescript
      // Diagnostic logging before spawning
      const binarySource = claudeExecutable
        ? `external (${claudeExecutable})`
        : 'SDK-bundled (default)';
      logger.info(
        `SDK: spawning Claude — binary=${binarySource}, ` +
          `session=${sessionId ?? 'new'}, resume=${!isNew && !!sessionId}, ` +
          `cwd=${expandedCwd}, settings=${settingsPath ?? 'none'}`
      );
```

把 `binarySource` 声明替换成:

```typescript
      // Diagnostic logging before spawning
      const binarySource = claudeResolution.fallback
        ? `${claudeResolution.source} (fallback)`
        : claudeResolution.source;
```

(后面的 `logger.info(...)` 块不动。)

- [ ] **Step 5: 跑 typecheck**

执行: `bun run typecheck`
预期: 通过(无 TS 错误)。如果 `claudeResolution.source` 字面量类型被加宽了,加 `as const` 或类型断言。

- [ ] **Step 6: 跑全套测试,确认无回归**

执行: `bun test`
预期: 之前通过的所有测试仍然通过;新加的 13 个解析器测试也通过。

如果现有 `session.ts` 测试因 mock 了 `config.get('sdk.claude_executable', ...)` 而失败,**改测试用 `resolveClaudeExecutable(cfg, options)` 的方式注入**(参考 Task 0 的测试模式),不要绕过解析器去 mock `config.get`。所有测试改动在注释里写明原因。

---

## Task 3: 三个场景的手动验证

**这个 Task 不能自动化**。在开发机或一次性容器里跑。

- [ ] **场景 A: bundled 存在 (开发机默认)**

```bash
ls node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude
bun run dev start  # 前台跑 bot
# 发任意飞书消息,观察 daemon 日志:
#   "SDK: spawning Claude — binary=sdk_bundled, session=..., ..."
# 预期: 无 WARN 日志;聊天成功;卡片正常显示 thinking/text
```

- [ ] **场景 B: bundled 缺失 (模拟 omit=optional)**

```bash
# 把平台 binary 挪到一边(不要删除,遵守 CLAUDE.md 安全规则)
mv node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64{,.bak}
# 确认系统 claude 可用
which claude && claude --version
bun run dev start  # 前台跑 bot
# 发任意飞书消息,观察 daemon 日志:
#   "[claude-resolver] SDK bundled binary 缺失 ... 回退到 general.claude_bin=claude → /opt/homebrew/bin/claude ..."
#   "SDK: spawning Claude — binary=system_path (fallback), ..."
# 预期: WARN 可见;聊天可能成功(版本兼容时)或失败(版本不兼容 —— 这是 599b2da 旧 bug 的交集,**不算回归**)
# 还原:
mv node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64{.bak,}
```

- [ ] **场景 C: bundled 缺失 + 系统 claude 也缺失 (最坏情况)**

```bash
mv node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64{,.bak}
# 用空目录覆盖 PATH,模拟"系统也没 claude"(不需要 sudo):
mkdir -p /tmp/no-claude-bin
PATH=/tmp/no-claude-bin:$PATH bun run dev start
# 发任意飞书消息,观察:
#   daemon 日志: 错误带三种修法
#   飞书卡: ❌ 找不到 Claude CLI: ... 修法: 1) ... 2) ... 3) ...
# 预期: 卡片里是可操作的修复指引,不再是含糊的 "Claude SDK 执行失败"
# 还原:
mv node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64{.bak,}
rmdir /tmp/no-claude-bin
```

- [ ] **把验证结果写进 commit body**

最终 commit 信息里要包含:
- 每个场景 pass/fail
- 每个场景的 daemon 日志片段(一两行,显示 `binary=` 和 WARN 标记)
- 场景 C 的飞书卡文本

任一场景 fail,**STOP,不要进 Task 4**。按 systematic-debugging 重新排查。

---

## Task 4: 改 README

**文件:**
- 修改: `README.md`
- 修改: `README_en.md`

- [ ] **Step 1: 找两个 README 里 SDK 模式那一节**

执行: `grep -n "SDK 模式\|SDK mode" README.md README_en.md`
预期: 每个文件一个段落标题(按当前项目状态在 459 行附近)

- [ ] **Step 2: 在原有"需要系统 claude"那句话下加一句**

`README.md` (中文)里找:

```
**注意：** SDK 模式需要系统已安装 `claude` 命令行工具（`npm install -g @anthropic-ai/claude-code`）。如需自定义可执行文件路径，可使用 `general.claude_bin` 或 `sdk.claude_executable`。
```

下面加:

```
> cc-linker 默认使用 SDK 自带的 claude 二进制（保证版本兼容）。若该二进制在 npm install 时被 omit（如 `--omit=optional`、`NODE_ENV=production`），cc-linker 会自动 fallback 到 `general.claude_bin`（通常是系统 PATH 中的 `claude`），并在日志中输出 WARN。如遇版本不兼容，可显式设置 `sdk.claude_executable` 指向兼容版本。
```

`README_en.md` 里找:

```
**Note**: SDK mode requires the `claude` CLI to be installed on the system (`npm install -g @anthropic-ai/claude-code`). You can override the executable path with `general.claude_bin` or `sdk.claude_executable`.
```

下面加:

```
> cc-linker defaults to the SDK-bundled `claude` binary (guaranteed version compatibility). If that binary is omitted during install (e.g. `--omit=optional`, `NODE_ENV=production`), cc-linker automatically falls back to `general.claude_bin` (typically system PATH `claude`) and emits a WARN log. If you hit version-incompatibility issues, set `sdk.claude_executable` explicitly to a compatible path.
```

---

## Task 5: 最终验证 + commit

- [ ] **Step 1: 跑 typecheck + 全套测试**

```bash
bun run typecheck
bun test
```

预期: 都通过。

- [ ] **Step 2: 暂存并 commit**

```bash
git add src/proxy/claude-executable.ts src/proxy/session.ts tests/unit/proxy/claude-executable.test.ts README.md README_en.md
git commit -m "$(cat <<'EOF'
fix(proxy): claude 二进制解析器 —— SDK bundled 缺失时的优雅 fallback

新增 src/proxy/claude-executable.ts,带优先级链解析器:

  1. sdk.claude_executable (用户显式配置)
  2. SDK bundled (require.resolve 命中 @anthropic-ai/claude-agent-sdk-{platform}-{arch}/claude)
  3. general.claude_bin (系统 PATH fallback)
  4. 抛 E_SDK_NO_CLAUDE 带三种可操作修法

sendSDKMessage 现在总是传 pathToClaudeCodeExecutable;遇到 E_SDK_NO_CLAUDE
时 short-circuit 给出可操作消息,而不是让 SDK 那句含糊的
"Native CLI binary ... not found" 传到飞书卡里。

修复了 --omit=optional / NODE_ENV=production / bun --compile standalone
binary 这几类用户的 "Claude SDK 执行失败: Native CLI binary for
darwin-arm64 not found" 报错。

工程权衡: fallback 到系统 claude 可能会撞 599b2da 修复前的版本不兼容
风险。这是故意的 —— bundled 存在的多数用户 (599b2da 保护路径)
完全不受影响。fallback 路径会 WARN 日志 + source 标记,运维可以
grep `binary=.*fallback` 定位降级实例。

13 个单元测试覆盖所有优先级分支 + one-shot de-noise + 平台注入 + 错误路径。

手动验证三个场景:
- A) bundled 存在 → 无 warn, binary=sdk_bundled
- B) bundled 缺 + 系统 claude 在 → warn, binary=system_path (fallback)
- C) bundled 缺 + 系统 claude 不在 → E_SDK_NO_CLAUDE,飞书卡显示三种修法
EOF
)"
```

- [ ] **Step 3: 推送并按项目惯例开 PR**

```bash
git push -u origin <branch-name>
gh pr create --base master --title "fix(proxy): claude 二进制解析器带 fallback 链" --body-file <(git log -1 --pretty=%b)
```

(分支名按当前 PR 惯例;`git branch --show-current` 看当前分支,看已有 PR 分支命名风格。)

---

## 验收清单 (Verification Checklist)

声明完成前,以下全部必须为真:

- [ ] 13 个解析器测试全部通过
- [ ] 全套测试 (`bun test`) 通过
- [ ] Typecheck (`bun run typecheck`) 通过
- [ ] Task 3 三个场景手动验证通过
- [ ] 场景 B 的 daemon 日志包含 `binary=system_path (fallback)` 和 WARN 行
- [ ] 场景 C 的飞书卡包含三种修法(中文)
- [ ] `package.json` / `bun.lock` 无新依赖
- [ ] README 中英文都更新了
- [ ] Commit body 包含三个场景的日志片段

## 风险与缓解 (Risks & Mitigations)

| 风险 | 缓解措施 |
|---|---|
| Fallback 到系统 `claude` 撞 599b2da 时代的版本不兼容 | WARN 日志 + source 标记让降级实例可观测。Commit body 里写明。受影响人群是"bundled 缺 + 系统 claude 不兼容"交集,远比 方案A 的"所有默认用户"小 |
| `createRequire(import.meta.url)` 在 `bun build --compile` standalone binary 里行为不可预测 | 尽力而为: 解析不了就 fall through 到 fallback,绝不崩。WARN 由 `fallbackWarned` one-shot 控制 —— 每个进程最多发一次 WARN,后续降级走 INFO,避免 standalone binary 的 24/7 bot 每请求一行 WARN |
| `Bun.which` 解析行为与 shell `which` 在边缘路径上不一致 | cc-linker 已经依赖 Bun runtime,用 `Bun.which` 一致性最好 |
| 现有 `session.ts` 测试 mock config,在新解析器下坏掉 | Task 2 Step 6 显式提到: 测试改成直接调 `resolveClaudeExecutable(cfg, options)` 注入,不要绕过解析器去 mock config.get |
| `E_SDK_NO_CLAUDE` 错误码可能需要登记到 `src/utils/errors.ts` | Task 1 Step 2 显式检查。如果注册表模式要求预先登记就加;否则直接 `new CCLinkerError(code, message)` |

## 回滚 (Rollback)

如果合入生产后出问题:

1. Revert 合并 commit (`git revert <merge-sha>`)
2. 排查: 是解析器本身的问题,还是 session.ts 里配置类型改的问题?
3. 如果只是 `sdkOptions` 的"总是传 pathToClaudeCodeExecutable"这一步的回归,回滚可以是**部分的** —— 恢复 `if (claudeExecutable) { sdkOptions.pathToClaudeCodeExecutable = claudeExecutable; }` 条件分支,同时保留解析器调用(解析器仍提供优雅错误消息)

新增文件 `src/proxy/claude-executable.ts` 在回滚后留着也没事 —— 它只被 `sendSDKMessage` import,如果 import 也回滚了,文件就成 dead code(模块加载无副作用)。

## 不在本次范围内 (Out of Scope,其他方案)

这些 2026-06-15 会话里讨论过,但不属于本方案:

1. **`package.json` 里把 `^0.3.150` 收紧到 `~0.3.150`** —— 限制 SDK 自动 minor 升级。需要单独方案,因为改了 bun.lock 解析行为
2. **`sdk.min_sdk_version` 运行时检测** —— 检查装的 SDK 包版本是否达标。能提早发现 schema 不兼容,但不修本次 bundled 缺失 bug
3. **`L2 postinstall` 主动安装** —— 在 `scripts/postinstall.js` 里加 `npm install --no-save @anthropic-ai/claude-agent-sdk-{platform}-{arch}`。覆盖部分 omit=optional 场景,但 standalone binary 覆盖不了
4. **`sdk.enabled` 默认值重评** —— 当前 `true` (默认 SDK 模式)。改成 `false` 会路由到非 SDK 路径,绕过 bundled 二进制依赖,但失去 `canUseTool` 权限回调 UX。这是产品决策,不是 bug 修复