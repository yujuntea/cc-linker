import { appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { HOOK_LOG_PATH } from './paths';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

class Logger {
  private level: LogLevel = 'info';

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[this.level];
  }

  private format(level: LogLevel, message: string): string {
    return `[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}`;
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
