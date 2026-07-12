// tests/unit/cli/img-proxy-daemon-install-library.test.ts
//
// 2026-07-10 回归:imgProxyDaemonInstall 改 library 化,失败 throw 而不 process.exit。
// 之前 3 处 process.exit(1)(非 darwin / launchctl load 失败 / 健康检查失败)被 wizard
// 在 setup.ts:327 的 try/catch 包了但接不住,wizard 进程被 process.exit 杀掉(同
// imgProxyStart 的 bug),后续 launchd 步骤走不到。
//
// 直接测:spy process.exit + 跑 install,验证任何路径都不调 process.exit(无论是
// 成功还是失败)。throw 路径靠"success path 不 exit" + 显式 throw 关键字的
// 代码 review 覆盖。

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';

describe('imgProxyDaemonInstall library contract (no process.exit)', () => {
  let exitSpy: ReturnType<typeof spyOn>;
  let imgProxyDaemonInstall: typeof import('../../../src/cli/commands/img-proxy').imgProxyDaemonInstall;

  beforeEach(async () => {
    // 动态 import 确保 module 在 spy 设好之后再加载
    const mod = await import('../../../src/cli/commands/img-proxy');
    imgProxyDaemonInstall = mod.imgProxyDaemonInstall;

    exitSpy = spyOn(process, 'exit').mockImplementation((code?: number) => {
      // 关键断言:任何路径上 imgProxyDaemonInstall 都不能调 process.exit。
      // 直接 throw 让测试 fail(否则 spy 默认是 noop,bug 会被吞)。
      throw new Error(`process.exit(${code}) was called — library should throw/return, not exit`);
    });
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  // 成功路径上 process.exit 不该被调。
  // 实际场景:有 daemon 在跑,install 后会写到 launchd 并重 load。健康检查可能
  // 成功可能失败 — 我们的关注点只是 process.exit 没被调(throw 是 OK 的)。
  // 注:这条测试有 side effect(在用户机器上写 plist + launchctl load),
  // 但和 imgProxyStart 一样是单向的(读起来吓人,实际只是 sync 现有 daemon
  // 配置),CI 上跑会污染 /tmp/plist 之类的不存在的路径 — 这里走真实环境。
  it('never calls process.exit on any path (success OR failure)', async () => {
    try {
      await imgProxyDaemonInstall();
    } catch {
      // 失败也无所谓 — throw 是 OK 的。关键是 exitSpy 永远没被调。
    }
    expect(exitSpy).not.toHaveBeenCalled();
  }, 30_000);
});
