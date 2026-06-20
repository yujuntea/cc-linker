import { appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { HOOK_LOG_PATH } from './paths';

/** Format date as local time string: YYYY-MM-DD HH:mm:ss */
export function formatLocalTime(date: Date = new Date()): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hour = pad(date.getHours());
  const minute = pad(date.getMinutes());
  const second = pad(date.getSeconds());
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * PR 7 m-10: 栈追踪中的 secrets sanitizer.
 *
 * 历史 bug: logger.error 内部吞错时 (handleClaimed / handleChat try/catch),
 *   err.stack 可能含 wecom bot_secret / app_secret / feishu app_secret 等,
 *   落日志后会泄露凭证到 ~/.cc-linker/logs/
 *   (例: stack frame "at sdkCall (app_secret=BOT_SECRET_VALUE)").
 * 修法: 在 format() / hook() 调 maskSecrets, 用 key=*** 模式盖值.
 *
 * 覆盖 keys (大小写不敏感):
 * - secret, app_secret, bot_secret, feishu_secret
 * - password, passwd
 * - token, access_token, refresh_token, bot_token
 *
 * @param input 原始 stack / message 字符串
 * @returns 安全字符串, 所有 secret-shaped key 的 value 替换为 ***
 */
export function sanitizeStackSecrets(input: string): string {
  if (!input) return input;
  // 匹配 key=value 或 key: 'value' (含空格/引号), 跟 SDK stack frame 格式对齐
  // - key 必须在白名单 (避免误伤 .at file:line:col)
  // - value 边界: 空格 / 引号 / 逗号 / ) / ] / } / 换行
  const SECRET_KEYS = [
    'secret', 'app_secret', 'bot_secret', 'feishu_secret',
    'password', 'passwd',
    'token', 'access_token', 'refresh_token', 'bot_token',
  ];
  const KEY_PATTERN = SECRET_KEYS.join('|');
  // key=value (无空格) | key: 'value' | key: "value" | key = value
  const PATTERN = new RegExp(
    `\\b(${KEY_PATTERN})\\s*[:=]\\s*(?:"([^"]*)"|'([^']*)'|([^\\s,)}\\]]+))`,
    'gi',
  );
  return input.replace(PATTERN, (_match, key, dq, sq, bare) => {
    const replacement = dq !== undefined ? '""' : sq !== undefined ? "''" : '***';
    return `${key}=${replacement}`;
  });
}

class Logger {
  private level: LogLevel = 'info';

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[this.level];
  }

  private format(level: LogLevel, message: string): string {
    // PR 7 m-10: sanitize secrets before logging
    return `[${formatLocalTime()}] [${level.toUpperCase()}] ${sanitizeStackSecrets(message)}`;
  }

  debug(message: string): void {
    if (this.shouldLog('debug')) {
      console.debug(this.format('debug', message));
    }
  }

  info(message: string): void {
    if (this.shouldLog('info')) {
      console.log(this.format('info', message));
    }
  }

  warn(message: string): void {
    if (this.shouldLog('warn')) {
      console.warn(this.format('warn', message));
    }
  }

  error(message: string): void {
    if (this.shouldLog('error')) {
      console.error(this.format('error', message));
    }
  }

  hook(level: LogLevel, message: string): void {
    try {
      mkdirSync(dirname(HOOK_LOG_PATH), { recursive: true });
      appendFileSync(HOOK_LOG_PATH, this.format(level, message) + '\n');
    } catch {
      // Silently fail for hook logging
    }
  }
}

export const logger = new Logger();
