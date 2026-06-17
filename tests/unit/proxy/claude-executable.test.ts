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
