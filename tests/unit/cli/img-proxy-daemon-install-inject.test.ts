// tests/unit/cli/img-proxy-daemon-install-inject.test.ts
//
// 2026-07-10 配套 P1-4:runLaunchdInstallWithDeps 用 deps 注入版本。
// 之前的 daemon-install test 必须跑真实 imgProxyDaemonInstall(写 plist + launchctl load),
// 污染 CI runner 的 launchd。改用 deps 注入后,所有副作用都可用 fake,test 100% 纯净。
//
// 覆盖:
//  - 非 darwin 抛错(用 fake deps 测 platform 分支,无 macOS 启动副作用)
//  - 正常流程:stop → write → load → start → health check pass
//  - 健康检查失败 throw 含失败项
//  - launchctl load 失败 throw
//  - buildLaunchdPlistContent 纯函数(escape 防 plist 损坏)

import { describe, it, expect, beforeEach } from 'bun:test';
import {
  buildLaunchdPlistContent,
  runLaunchdInstallWithDeps,
  type LaunchdInstallDeps,
} from '../../../src/cli/commands/img-proxy';

/**
 * 构造一组 fake deps,默认所有副作用 no-op + 返回 success。
 * test 改哪个字段就直接覆盖。recordCalls[] 收集调用历史供断言。
 */
function makeFakeDeps(overrides: Partial<LaunchdInstallDeps> = {}): LaunchdInstallDeps & { recordCalls: { name: string; args?: unknown }[] } {
  const recordCalls: { name: string; args?: unknown }[] = [];
  const rec = (name: string, args?: unknown) => { recordCalls.push({ name, args }); };

  const base: LaunchdInstallDeps = {
    platform: 'darwin',
    plistPath: '/tmp/fake-plist',
    writePlist: (content) => rec('writePlist', { len: content.length }),
    mkdirPlistDir: () => rec('mkdirPlistDir'),
    existsPlist: () => false,  // 默认:无现有 plist,跳过 stop+unload 路径
    runLaunchctl: (args) => { rec('runLaunchctl', args); return { status: 0, stdout: '', stderr: '' }; },
    readPid: () => { rec('readPid'); return null; },
    clearPid: () => rec('clearPid'),
    isProcessAlive: () => { rec('isProcessAlive'); return true; },
    killProcess: (pid, signal) => { rec('killProcess', [pid, signal]); return true; },
    sleep: async () => rec('sleep'),
    getUid: () => 501,
    label: 'com.cclinker.test',
    probeHttp: async () => true,  // 默认 health check 返 true,test 可覆盖
  };
  return { ...base, ...overrides, recordCalls } as LaunchdInstallDeps & { recordCalls: { name: string; args?: unknown }[] };
}

describe('buildLaunchdPlistContent (pure function)', () => {
  it('includes the expected keys + values', () => {
    const xml = buildLaunchdPlistContent({
      executable: '/usr/local/bin/cc-linker',
      home: '/Users/test',
      logFile: '/Users/test/.cc-linker/img-proxy/img-proxy.log',
      envPath: '/usr/local/bin:/usr/bin',
    });
    expect(xml).toContain('<string>/usr/local/bin/cc-linker</string>');
    expect(xml).toContain('<string>img-proxy</string>');
    expect(xml).toContain('<string>start</string>');
    expect(xml).toContain('<string>/Users/test</string>');
    expect(xml).toContain('<key>CC_LINKER_IMG_PROXY_DAEMON</key><string>1</string>');
    expect(xml).toContain('<key>RunAtLoad</key><true/>');
    expect(xml).toContain('<key>KeepAlive</key><true/>');
    expect(xml).toContain('<key>ThrottleInterval</key><integer>10</integer>');
  });

  it('escapes special characters in paths to prevent plist corruption', () => {
    // 历史上 plist 写 & 不转义导致 launchctl load 静默失败。改 escape 行为
    // 不会破坏 plist 格式 — 这条 test 是防回归点。
    const xml = buildLaunchdPlistContent({
      executable: '/usr/bin/cc-linker&evil',  // 包含 &
      home: '/Users/with"quote',
      logFile: '/tmp/log<file>',
      envPath: '/usr/bin',
    });
    // & / " / < 都要被转义
    expect(xml).not.toContain('cc-linker&evil');
    expect(xml).not.toContain('with"quote');
    expect(xml).not.toContain('<file>');
  });

  it('escapes > and \' (more XML chars to prevent plist corruption)', () => {
    // 2026-07-10 P1-3: 扩展 escape 测试覆盖。> 闭合 plist 标签,' 在 plist 字符串里
    // 不强制 escape 但我们要确保不会因为顺序问题破坏 plist 解析。
    const xml = buildLaunchdPlistContent({
      executable: '/bin/cc-linker>evil',         // > 闭合 plist 标签
      home: "/Users/with'apostrophe",          // ' XML attribute 里关键
      logFile: '/tmp/log>path',                 // 路径里的 >
      envPath: '/usr/bin:cc-linker\'s',
    });
    expect(xml).not.toContain('cc-linker>evil');
    expect(xml).not.toContain("/Users/with'apostrophe");
    expect(xml).not.toContain('log>path');
  });

  it('preserves Unicode paths (Chinese / emoji) without breaking plist', () => {
    // 2026-07-10 P1-3: 验证 unicode 路径(home 含中文、logFile 含 emoji)正常
    // 写到 plist 不破坏 XML(escapePlistString 应该保留 unicode 不过度转义)。
    const xml = buildLaunchdPlistContent({
      executable: '/usr/local/bin/cc-linker',
      home: '/Users/张三',
      logFile: '/Users/张三/Logs/cc🚀.log',
      envPath: '/usr/bin',
    });
    expect(xml).toContain('/Users/张三');
    expect(xml).toContain('cc🚀.log');
    // 结构完好(没破坏 plist 标签)
    expect(xml).toContain('<plist version="1.0">');
    expect(xml).toContain('</plist>');
  });
});

describe('runLaunchdInstallWithDeps (deps-injected, no side effects)', () => {
  it('throws on non-darwin (uses deps.platform, not real platform())', async () => {
    const deps = makeFakeDeps({ platform: 'linux' });
    await expect(runLaunchdInstallWithDeps(deps)).rejects.toThrow(/仅支持 macOS/);
  });

  it('skips stop+unload path when plist does not exist', async () => {
    const deps = makeFakeDeps({ existsPlist: () => false });
    await runLaunchdInstallWithDeps(deps);
    // 没有 stop 也没有 unload,但有 writePlist + load + start
    expect(deps.recordCalls.some(c => c.name === 'runLaunchctl' && c.args?.[0] === 'stop')).toBe(false);
    expect(deps.recordCalls.some(c => c.name === 'runLaunchctl' && c.args?.[0] === 'unload')).toBe(false);
    expect(deps.recordCalls.some(c => c.name === 'writePlist')).toBe(true);
    expect(deps.recordCalls.some(c => c.name === 'runLaunchctl' && c.args?.[0] === 'load')).toBe(true);
  });

  it('runs stop+unload path when plist exists (Fix #5)', async () => {
    const deps = makeFakeDeps({ existsPlist: () => true });
    await runLaunchdInstallWithDeps(deps);
    expect(deps.recordCalls.some(c => c.name === 'runLaunchctl' && c.args?.[0] === 'stop')).toBe(true);
    expect(deps.recordCalls.some(c => c.name === 'runLaunchctl' && c.args?.[0] === 'unload')).toBe(true);
  });

  it('skips old-daemon kill when PID file empty (no existing daemon)', async () => {
    const deps = makeFakeDeps({
      existsPlist: () => true,
      readPid: () => null,
    });
    await runLaunchdInstallWithDeps(deps);
    // runLaunchctl['stop'] 跑了,但 killProcess 没跑(没 existingPid)
    expect(deps.recordCalls.some(c => c.name === 'killProcess')).toBe(false);
  });

  it('kills old daemon when PID file has alive process', async () => {
    const deps = makeFakeDeps({
      existsPlist: () => true,
      readPid: () => 12345,
      isProcessAlive: () => true,
    });
    await runLaunchdInstallWithDeps(deps);
    // SIGTERM 应该被发,然后 sleep 0 次(因 isProcessAlive mock 一直 true),然后 SIGKILL
    const killCalls = deps.recordCalls.filter(c => c.name === 'killProcess').map(c => c.args?.[1]);
    expect(killCalls).toContain('SIGTERM');
    expect(killCalls).toContain('SIGKILL');
  });

  it('skips SIGKILL when old daemon dies during wait loop', async () => {
    // isProcessAlive 第一次 true(传进去),sleep 一次后,isProcessAlive 第二次 false
    // → break 出循环,不 SIGKILL
    let aliveCheckCount = 0;
    const deps = makeFakeDeps({
      existsPlist: () => true,
      readPid: () => 12345,
      isProcessAlive: () => {
        aliveCheckCount++;
        return aliveCheckCount === 1;  // 第一次 true,之后 false
      },
    });
    await runLaunchdInstallWithDeps(deps);
    const killCalls = deps.recordCalls.filter(c => c.name === 'killProcess').map(c => c.args?.[1]);
    expect(killCalls).toEqual(['SIGTERM']);  // 只 SIGTERM,没 SIGKILL
  });

  it('throws on launchctl load failure with exit code in message', async () => {
    const deps = makeFakeDeps({
      runLaunchctl: (args) => {
        if (args[0] === 'load') {
          return { status: 1, stdout: '', stderr: 'permission denied' };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    await expect(runLaunchdInstallWithDeps(deps)).rejects.toThrow(/launchctl load 失败.*exit 1.*permission denied/);
  });

  it('treats "already loaded" stderr as success (idempotent install)', async () => {
    const deps = makeFakeDeps({
      runLaunchctl: (args) => {
        if (args[0] === 'load') {
          return { status: 1, stdout: '', stderr: 'already loaded' };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    // 不应该 throw — already loaded 视为 success
    await expect(runLaunchdInstallWithDeps(deps)).resolves.toBeUndefined();
  });

  it('throws on health check failure (plist-loaded fails)', async () => {
    const deps = makeFakeDeps({
      runLaunchctl: (args) => {
        if (args[0] === 'print') {
          return { status: 0, stdout: 'state = spawn scheduled\n', stderr: '' };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    await expect(runLaunchdInstallWithDeps(deps)).rejects.toThrow(/健康检查未通过.*plist-loaded/);
  });

  it('writes plist with built content (plumbing check)', async () => {
    const deps = makeFakeDeps();
    await runLaunchdInstallWithDeps(deps);
    const writeCall = deps.recordCalls.find(c => c.name === 'writePlist');
    expect(writeCall).toBeDefined();
    // writeCall.args 是 { len: number },验证 len > 0(plist 内容非空)
    expect((writeCall!.args as { len: number }).len).toBeGreaterThan(100);
  });
});
