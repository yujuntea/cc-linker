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

/**
 * 优先级链解析器。详细设计见文件头注释。
 *
 * @param configLike - 任何 `{get}` 形态。生产传单例 `config` 模块;测试传 `{get: (k, d) => mockValue}`。
 *   解耦让我们能写纯函数测试,不用 mock.module。
 * @param options - 测试注入钩子。默认: 真实的 `process.platform` / `process.arch`,
 *   真实的 `createRequire`,真实的 `Bun.which`。
 * @throws 当所有来源都解析不到时,抛 code 为 `E_SDK_NO_CLAUDE` 的 CCLinkerError。
 */
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
        `(bundled 缺失;首次警告见上方日志,设置 [sdk] claude_executable 可消除)`,
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
     npm install -g cc-linker@latest --include=optional

  2) 安装 Claude Code CLI:
     npm install -g @anthropic-ai/claude-code
     (完成后会自带 system 'claude',会被 resolver 自动 fallback 捕获)

  3) 在 config.toml 显式指定二进制路径:
     sdk.claude_executable = "/path/to/claude"`,
  );
}
