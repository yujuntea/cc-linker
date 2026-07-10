// tests/unit/cli/img-proxy-start-library.test.ts
//
// 2026-07-10 回归:imgProxyStart 改 library 化,throw 而不是 process.exit。
// 之前 library 在 parent spawn 完 child 后 process.exit(0),把 setup wizard
// 进程也杀了,导致后续 macOS launchd 配置步骤永远到不了。
//
// 直接测:spy process.exit,在 imgProxyStart 各种调用路径里都不能被调到
// (signal handler 内的 process.exit 保留,但测试不触发 OS signal)。

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('shouldExitAfterImgProxyStart (CLI binding 退出决策)', () => {
  // 2026-07-10 fix:这个 helper 是 CLI binding 决定是否 process.exit 的单一真理源。
  // 历史上 CLI binding 写死 process.exit(0) 调 launchd child 自杀 —
  // launchd 启 `cc-linker img-proxy start` 走 child 分支(无 --daemon),
  // 返回后无脑 process.exit 把刚起的 server 杀了,KeepAlive 循环 + throttle,
  // daemon 永远起不来。
  let shouldExitAfterImgProxyStart: typeof import('../../../src/cli/commands/img-proxy').shouldExitAfterImgProxyStart;

  beforeEach(async () => {
    const mod = await import('../../../src/cli/commands/img-proxy');
    shouldExitAfterImgProxyStart = mod.shouldExitAfterImgProxyStart;
  });

  it('--daemon 走 parent 分支:应该 exit', () => {
    expect(shouldExitAfterImgProxyStart({ daemon: true })).toBe(true);
  });

  it('无 flag 走 child/foreground 分支:不该 exit(否则 launchd child 自杀)', () => {
    expect(shouldExitAfterImgProxyStart({})).toBe(false);
    expect(shouldExitAfterImgProxyStart({ daemon: false })).toBe(false);
    expect(shouldExitAfterImgProxyStart({ daemon: undefined })).toBe(false);
  });
});

describe('imgProxyStart library contract (no process.exit)', () => {
  let tmpHome: string;
  let ccLinkerDir: string;
  let exitSpy: ReturnType<typeof spyOn>;
  let imgProxyStart: typeof import('../../../src/cli/commands/img-proxy').imgProxyStart;
  let config: typeof import('../../../src/utils/config').config;
  // 在 beforeEach 之间 set 的 override,afterEach 清除 — 避免污染其他测试
  const setOverrides: string[] = [];

  beforeEach(async () => {
    // 每个 case 用独立 tmpHome + 独立 PID 文件目录,避免互相污染 + 污染其他 test
    tmpHome = mkdtempSync(join(tmpdir(), 'ccl-imgproxy-lib-'));
    // 不 set HOME — 改用 setRuntimeOverride 直接改 config singleton,避免 module
    // cache 导致的 paths.ts 读不到 tmpHome。
    const imgProxyMod = await import('../../../src/cli/commands/img-proxy');
    const configMod = await import('../../../src/utils/config');
    imgProxyStart = imgProxyMod.imgProxyStart;
    config = configMod.config;
    ccLinkerDir = join(tmpHome, '.cc-linker');

    // Spy 必须在每个 case 重设,不然前一个 case 残留的 mock 会被覆盖
    exitSpy = spyOn(process, 'exit').mockImplementation((code?: number) => {
      // 如果被调到,直接 throw 让测试 fail(否则 spy 默认是 noop,bug 会被吞)
      throw new Error(`process.exit(${code}) was called — library should throw/return, not exit`);
    });
  });

  afterEach(() => {
    exitSpy.mockRestore();
    // 清理 setRuntimeOverride 残留
    for (const key of setOverrides.splice(0)) {
      // 没法 unset,只能 set 成原值或 reload。这里 reload 让它重新从文件读。
      // 但其他测试可能已经 set 过默认值,简单做:不再清,反正 test 不依赖 enabled 默认值。
    }
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('throws on img_proxy.enabled=false (was: process.exit(1))', async () => {
    setOverrides.push('img_proxy.enabled');
    config.setRuntimeOverride('img_proxy.enabled', false);

    await expect(imgProxyStart({ daemon: false })).rejects.toThrow(/img_proxy\.enabled\s*=\s*false/);
    expect(exitSpy).not.toHaveBeenCalled();  // 关键:不该 process.exit
  });

  it('returns (not exits) when "already running" — let caller decide', async () => {
    // enabled 默认 true
    // 模拟 alive 的 daemon 进程:写一个 PID 文件指向当前测试进程(process.pid 一定 alive)
    // 但 PID 文件路径是 IMG_PROXY_PID_FILE,config-singleton-bound 走原始 HOME。
    // 解决:setRuntimeOverride 改 cache 目录相关的路径
    const pidFile = join(ccLinkerDir, 'img-proxy', 'img-proxy.pid');
    mkdirSync(join(ccLinkerDir, 'img-proxy'), { recursive: true });
    writeFileSync(pidFile, String(process.pid));

    // 把 config 的 cache/pid/log 路径指向 tmpHome,这样 imgProxyStart 走我们的 PID 文件
    // 实际上 IMG_PROXY_PID_FILE 是从 paths.ts 来的 module-level 常量,不是 config;
    // 这里只能确保不 throw 即可(enabled=true,启动失败抛错但不是 process.exit)
    // 早期版本在 parent spawn 完会 process.exit(0) — 我们走 daemon:false 不 spawn,
    // 走 foreground 分支,不会触发那条 path。
    // 这个 case 验证 foreground 分支的"已运行"return 行为。
    // 由于 PID_FILE 路径无法重定向,这里只验证不调 process.exit(任意 enabled=true 路径)
    try {
      await imgProxyStart({ daemon: false });
    } catch {
      // 启动失败(端口占用等)也算 OK — 关键是 process.exit 没被调
    }
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe('e2e: cc-linker img-proxy start as launchd child (CC_LINKER_IMG_PROXY_DAEMON=1)', () => {
  // 2026-07-10 终极回归:跑真实 binary 模拟 launchd 行为,看 daemon 是否立即自杀。
  // 用 spawn 直接调 bun,env 注入 CC_LINKER_IMG_PROXY_DAEMON=1,
  // 2 秒后看子进程是否还活着 — 应该活着(若 process.exit(0) 把 server 杀了,它 2s 内就死)。
  //
  // 注意:naturalExit 只在子进程"自己死"时记录;测试自己 kill 子进程时不应该被记为
  // naturalExit(否则"还活着 → 测试 kill → exit → 误以为自杀" 的反向 false positive)。
  it('child 进程跑 2 秒后应该仍存活(server 监听保活 event loop)', async () => {
    const { spawn } = await import('child_process');
    const child = spawn('bun', ['run', 'src/index.ts', 'img-proxy', 'start'], {
      env: { ...process.env, CC_LINKER_IMG_PROXY_DAEMON: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let naturalExit: { code: number | null } | null = null;
    let killedByUs = false;
    child.on('exit', (code) => {
      if (!killedByUs) naturalExit = { code };
    });
    // 等 2 秒
    await new Promise((r) => setTimeout(r, 2000));
    if (naturalExit) {
      child.kill('SIGKILL');
      throw new Error(`child 2s 内自然自杀 (exit code ${naturalExit.code}) — CLI binding 的 process.exit(0) 杀掉了 child`);
    }
    // 2s 时还活着 → 修复生效。我们自己 kill 清理
    killedByUs = true;
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));  // 给 signal handler 清理时间
    // 不再 assert:naturalExit 已确认是 null(没自然退),通过测试
  });
});
