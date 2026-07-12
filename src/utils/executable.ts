import { existsSync, realpathSync } from 'fs';
import { dirname, isAbsolute, join } from 'path';

/**
 * 解析 cc-linker 可执行文件路径,用于 spawn daemon child。
 * 处理三种运行形态:
 * - compiled binary(argv[0] 以 cc-linker 结尾)
 * - 全局 npm 安装(argv[1] 含 node_modules,或 symlink)
 * - 开发模式(bun run src/index.ts → 用 dist 编译产物或 PATH 里的 cc-linker)
 *
 * 可选 `argv` 参数让测试/特定调用方注入 process.argv,避免依赖全局状态。
 * 不传时,行为与原实现一致(读 process.argv)。
 */
export function getExecutablePath(argv: string[] = process.argv): string {
  const argv0 = argv[0] ?? '';
  if (argv0.endsWith('cc-linker')) return argv0;

  const scriptPath = argv[1] || '';

  // 全局 npm 包(node_modules/cc-linker/dist/cli.js)→ 用 PATH 里的 cc-linker
  if (scriptPath.includes('node_modules')) return 'cc-linker';

  // 全局 symlink(/usr/local/bin/cc-linker 解析后)
  if (scriptPath.endsWith('/cc-linker')) return 'cc-linker';

  // 开发模式(bun run src/index.ts):优先 dist 编译产物,否则用 PATH
  const scriptDir = dirname(scriptPath);
  const distPath = join(scriptDir, '..', 'dist', 'cc-linker');
  if (existsSync(distPath)) return distPath;

  return 'cc-linker';
}

/**
 * 为 launchd plist 解析 ProgramArguments[0] —— launchd 对 daemon/agent 要求
 * executable 必须是绝对路径或能被 launchd 自己的 PATH 解析到。
 *
 * 与 getExecutablePath 的关键区别:后者在"全局 npm/symlink"形态下返回裸字符串
 * "cc-linker",对 spawn(PATH 走 shell 解析)没问题,但对 launchd 直接 exec 失败
 * (EX_CONFIG,KeepAlive 一直重启),daemon 永远起不来。
 *
 * 这里强制解析出绝对路径,解析失败时回退到 "cc-linker"(老行为)以便测试和 dev
 * 模式仍能工作。**plist 写入必须用本函数,而不是 getExecutablePath**。
 *
 * 解析策略:
 *   1. argv[0] 是绝对路径 → realpath 后返回(去掉 symlink,launchd 更稳);
 *   2. argv 命中 "cc-linker" 名称 → 沿 process.env.PATH 逐个 existsSync,
 *      命中第一个返回绝对路径;失败时回退 "cc-linker" 兜底;
 *   3. 不依赖 `which` 等外部命令(测试并发 + launchd 域 PATH 差异下更稳)。
 */
export function getLaunchdExecutablePath(argv: string[] = process.argv): string {
  const resolved = getExecutablePath(argv);
  if (isAbsolute(resolved)) {
    // argv[0] 已经是绝对路径(comiled binary)。但它可能指向 symlink;为了 launchd
    // 跨过用户登录/launchd domain 边界的稳定性,realpath 一次拿到 target。
    try { return realpathSync(resolved); } catch { return resolved; }
  }
  if (resolved === 'cc-linker') {
    const fromPath = resolveFromPath('cc-linker');
    if (fromPath) return fromPath;
  }
  return resolved;
}

function resolveFromPath(name: string): string | null {
  const dirs = (process.env.PATH ?? '').split(':');
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
