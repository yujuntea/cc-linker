// tests/unit/utils/executable.test.ts
//
// Regression for: launchd plist 的 ProgramArguments[0] 写成了相对命令 `cc-linker`,
// 导致 macOS launchd 报 EX_CONFIG (78),KeepAlive 一直重启失败,8765 永远空。
//
// 这套测试锁定两个行为:
//   1) getLaunchdExecutablePath() 始终返回可被 launchd 直接 exec 的路径(绝对路径
//      或 PATH 里能 resolve 到的真名)。
//   2) getLaunchdExecutablePath() 在全局 symlink 形态(脚本路径含 node_modules 或
//      软链到 /usr/local/bin/cc-linker → ../lib/node_modules/.../cli.js)下不再
//      返回裸字符串 "cc-linker",而返回解析后的绝对路径。
//
// 由于 getExecutablePath 直接读 process.argv,测试通过参数化注入 argv 模拟各种
// 启动形态,不依赖真实 process 状态(也避免污染其它测试)。

import { describe, test, expect } from 'bun:test';
import { realpathSync, existsSync } from 'fs';
import { join, isAbsolute } from 'path';

import { getExecutablePath, getLaunchdExecutablePath } from '../../../src/utils/executable';

describe('getLaunchdExecutablePath (launchd plist writer contract)', () => {
  test('在全局 npm 安装形态(脚本路径含 node_modules)返回绝对路径,不是裸 "cc-linker"', () => {
    // 模拟 npm install -g cc-linker 后的 argv: [bun, /usr/local/lib/node_modules/cc-linker/dist/cli.js]
    const argv = [
      '/usr/local/bin/bun',
      '/usr/local/lib/node_modules/cc-linker/dist/cli.js',
    ];
    const exe = getLaunchdExecutablePath(argv);
    expect(exe === 'cc-linker').toBe(false);
    expect(isAbsolute(exe)).toBe(true);
    // 解析后真实指向的文件必须存在 —— launchd 不会再 exec 失败。
    expect(existsSync(exe)).toBe(true);
  });

  test('在全局 symlink 形态(argv[1] 末尾是 cc-linker)返回绝对路径', () => {
    // 模拟通过 /usr/local/bin/cc-linker symlink 调用:
    //   argv[0] = bun
    //   argv[1] = /usr/local/bin/cc-linker (但 Node 看到的是 symlink target 后的真实路径)
    // 我们用 realpath 把 symlink 解析成 ../lib/node_modules/cc-linker/dist/cli.js
    // 的真实路径,然后传入。
    const realCli = realpathSync('/usr/local/bin/cc-linker');
    const argv = ['/usr/local/bin/bun', realCli];
    const exe = getLaunchdExecutablePath(argv);
    expect(isAbsolute(exe)).toBe(true);
    expect(exe === 'cc-linker').toBe(false);
    // 解析后必须能落在一个真实文件上。
    expect(existsSync(exe)).toBe(true);
  });

  test('在 compiled binary 形态(argv[0] 是绝对路径且以 cc-linker 结尾)返回该绝对路径(可能 realpath 解析 symlink)', () => {
    // 模拟 bun build --compile 后的 argv: argv[0] = /usr/local/bin/cc-linker (真二进制
    // 或 symlink)。realpath 会把它解析到 ../lib/node_modules/.../cli.js,
    // 两种结果都满足 launchd 的 exec 契约;这里只断言 "绝对路径且真实文件存在"。
    const argv = ['/usr/local/bin/cc-linker'];
    const exe = getLaunchdExecutablePath(argv);
    expect(isAbsolute(exe)).toBe(true);
    expect(existsSync(exe)).toBe(true);
  });

  test('在 dev 形态(脚本路径在仓库内、dist 编译产物存在)返回绝对路径', () => {
    // 模拟 bun run src/index.ts —— argv[1] = 仓库内 src/index.ts
    const argv = [
      '/usr/local/bin/bun',
      join(process.cwd(), 'src/index.ts'),
    ];
    const exe = getLaunchdExecutablePath(argv);
    expect(isAbsolute(exe)).toBe(true);
    // 路径必须存在(dist 编译产物或 src/index.ts 本身)
    expect(existsSync(exe)).toBe(true);
  });
});

describe('getExecutablePath (保留旧行为,新加 argv 参数化注入)', () => {
  test('compiled binary 形态:argv[0] 以 cc-linker 结尾直接返回', () => {
    const argv = ['/usr/local/bin/cc-linker'];
    expect(getExecutablePath(argv)).toBe('/usr/local/bin/cc-linker');
  });

  test('全局 npm 形态:脚本路径含 node_modules 仍返回可解析的 "cc-linker" (旧行为)', () => {
    // 行为保持兼容:旧代码允许 spawn('cc-linker', ...) 走 PATH 解析。
    const argv = [
      '/usr/local/bin/bun',
      '/usr/local/lib/node_modules/cc-linker/dist/cli.js',
    ];
    expect(getExecutablePath(argv)).toBe('cc-linker');
  });
});
