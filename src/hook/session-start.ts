import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { RUNTIME_SESSION_EVENTS_DIR } from '../utils/paths';
import { logger } from '../utils/logger';
import { isValidUUID } from '../utils/validation';

/**
 * 会话启动 Hook：将 session 发现事件写入 runtime/session-events/ 目录，
 * 供 Round 5 Reconciler 在启动时归并。不再调用 `cc-linker register`。
 */
export function hookSessionStart(): void {
  try {
    const sessionId = detectSessionId();
    if (!sessionId) {
      logger.hook('warn', '无法获取 session ID，跳过事件写入');
      return;
    }

    // best-effort cwd 猜测:hook 触发时拿不到 bg session 的最终 cwd
    // (Claude CLI 会自己切到 project_dir),只能拿到 parent shell 的 PWD。
    // 对于从 /Users/wuyujun 启动的 bg session,这里写的就是 /Users/wuyujun,
    // 跟 bg session 实际工作的 cwd (e.g. /Users/wuyujun/Git/xxx) 不一致。
    //
    // 后续 reconciler 会用这个 cwd 创建 registry entry,然后 scanner 的
    // readFirstCwd() 检测到与 JSONL first cwd 不一致,触发 parseFull 修正
    // (src/scanner/jsonl.ts)。所以这里的错误数据最终会被覆盖。
    //
    // 如果将来想避免这个 brief window(registry 短暂存 wrong cwd),
    // 可以把这里改成写 '',scanner 在 reconciler 之后会自然填上正确的值
    // (走现有的 hasJsonlMeta=false → parseFull 路径)。但那会让 scanner
    // 对每个 reconciler-pre-registered session 都 parseFull,更 expensive。
    // 当前选择保留 PWD 作为 best-effort 提示,scanner 修正保证 correctness。
    const cwd = process.env.PWD || process.cwd();

    // 写入事件文件
    const eventFile = `${sessionId}.json`;
    const eventPath = join(RUNTIME_SESSION_EVENTS_DIR, eventFile);

    mkdirSync(RUNTIME_SESSION_EVENTS_DIR, { recursive: true, mode: 0o700 });

    const event = {
      sessionId,
      cwd,
      discoveredAt: new Date().toISOString(),
    };

    writeFileSync(eventPath, JSON.stringify(event, null, 2), { mode: 0o600 });

    logger.hook('info', `已写入 session 事件: ${eventPath}`);
  } catch (err: any) {
    logger.hook('error', `Hook 执行失败: ${err.message}`);
  }
}

export function detectSessionId(): string | null {
  const candidates = [
    'CLAUDE_CODE_SESSION_ID',
    'SESSION_ID',
    'CLAUDE_SESSION_ID',
  ];

  for (const name of candidates) {
    const value = process.env[name];
    if (value && isValidUUID(value)) {
      return value;
    }
  }

  return null;
}
