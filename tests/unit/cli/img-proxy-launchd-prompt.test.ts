// tests/unit/cli/img-proxy-launchd-prompt.test.ts
//
// 2026-07-10: 测 promptLaunchdAutoStart(从 imgProxyInstall 抽出的引导 launchd 函数)。
// 只覆盖"early-return 路径"(平台 / TTY),这些不调 inquirer 所以单测稳。
//
// **不**测 inquirer 路径(用户答 Yes/No + daemon install 成功/失败):
// - inquirer 已在 imgProxy.ts module closure 里固化,不能用 mock.module 替换
// - 完整路径会跑真实 launchctl,有副作用
// - 这部分在 setup wizard 的 e2e 测 + 真实 install 跑过验证

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';

describe('promptLaunchdAutoStart (early-return paths)', () => {
  let promptLaunchdAutoStart: typeof import('../../../src/cli/commands/img-proxy').promptLaunchdAutoStart;
  let platformSpy: ReturnType<typeof spyOn>;
  let originalStdinDescriptor: PropertyDescriptor | undefined;

  beforeEach(async () => {
    const mod = await import('../../../src/cli/commands/img-proxy');
    promptLaunchdAutoStart = mod.promptLaunchdAutoStart;

    // save 原始 stdin descriptor,afterEach 还原
    originalStdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin');

    // 默认: darwin + TTY(让"非 darwin"和"非 TTY"case 显式覆盖)
    platformSpy = spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  });

  afterEach(() => {
    platformSpy.mockRestore();
    // 还原 stdin
    if (originalStdinDescriptor) {
      Object.defineProperty(process, 'stdin', originalStdinDescriptor);
    }
  });

  // Helper:override stdin.isTTY
  function setTTY(value: boolean) {
    Object.defineProperty(process, 'stdin', {
      value: { isTTY: value } as any,
      writable: true,
      configurable: true,
    });
  }

  it('returns false on linux (non-darwin early return, no TTY check)', async () => {
    platformSpy.mockReturnValue('linux');
    setTTY(true);  // TTY 也不该被检查
    const result = await promptLaunchdAutoStart({ yes: true });
    expect(result).toBe(false);
  });

  it('returns false on win32 (non-darwin early return)', async () => {
    platformSpy.mockReturnValue('win32');
    setTTY(true);
    const result = await promptLaunchdAutoStart({ yes: true });
    expect(result).toBe(false);
  });

  it('returns false on darwin with non-TTY (CI / script / no-TTY session)', async () => {
    platformSpy.mockReturnValue('darwin');
    setTTY(false);
    const result = await promptLaunchdAutoStart({ yes: true });
    expect(result).toBe(false);
  });
});

describe('imgProxyInstall return type (autoStart field added 2026-07-10)', () => {
  // 单独验 type-level contract,确保 caller 拿到 autoStart 字段。
  it('return type includes autoStart: boolean', () => {
    type Ret = Awaited<ReturnType<typeof import('../../../src/cli/commands/img-proxy').imgProxyInstall>>;
    const _typecheck: Ret = {
      installedCount: 0,
      failedCount: 0,
      wrapperInstalled: false,
      wrapperSkipped: false,
      consoleInstalled: false,
      consoleSkipped: false,
      autoStart: false,  // ← 必须存在
    };
    expect(_typecheck.autoStart).toBe(false);
  });
});
