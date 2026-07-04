import { existsSync } from 'fs';
import { dirname, join } from 'path';

/**
 * 解析 cc-linker 可执行文件路径,用于 spawn daemon child / launchd plist。
 * 处理三种运行形态:
 * - compiled binary(argv[0] 以 cc-linker 结尾)
 * - 全局 npm 安装(argv[1] 含 node_modules,或 symlink)
 * - 开发模式(bun run src/index.ts → 用 dist/cc-linker 或 PATH 里的 cc-linker)
 */
export function getExecutablePath(): string {
  const argv0 = process.argv[0];
  if (argv0.endsWith('cc-linker')) return argv0;

  const scriptPath = process.argv[1] || '';

  // 全局 npm 包(node_modules/cc-linker/dist/cli.js)→ 用 PATH 里的 cc-linker
  if (scriptPath.includes('node_modules')) return 'cc-linker';

  // 全局 symlink(/usr/local/bin/cc-linker 解析后)
  if (scriptPath.endsWith('/cc-linker') || scriptPath === 'cc-linker') return 'cc-linker';

  // 开发模式(bun run src/index.ts):优先 dist 编译产物,否则用 PATH
  const scriptDir = dirname(scriptPath);
  const distPath = join(scriptDir, '..', 'dist', 'cc-linker');
  if (existsSync(distPath)) return distPath;

  return 'cc-linker';
}