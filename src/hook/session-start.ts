import { execFileSync } from 'child_process';
import { logger } from '../utils/logger';
import { isValidUUID } from '../utils/validation';

export function hookSessionStart(): void {
  try {
    const sessionId = detectSessionId();
    if (!sessionId) {
      logger.hook('warn', '无法获取 session ID，跳过注册');
      return;
    }

    const cwd = process.env.PWD || process.cwd();

    execFileSync('cc-bridge', ['register', sessionId, '--origin', 'cli', '--cwd', cwd, '--source', 'terminal'], {
      stdio: 'pipe',
      timeout: 5000,
    });

    logger.hook('info', `已注册会话 ${sessionId} (cwd: ${cwd})`);
  } catch (err: any) {
    logger.hook('error', `Hook 执行失败: ${err.message}`);
  }
}

function detectSessionId(): string | null {
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
