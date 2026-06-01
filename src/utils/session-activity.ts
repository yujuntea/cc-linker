import { withTimeout } from './async';
import {
  getClaudeProcessesByCwd,
  getProcessCPUTimeSeconds,
  type ProcessInfo,
} from './process-info';
import { ACTIVITY_DIR, CC_LINKER_DIR } from './paths';
import {
  appendFileSync, readFileSync, existsSync, statSync, mkdirSync,
  unlinkSync, writeFileSync, readdirSync, openSync, readSync, closeSync,
} from 'fs';
import { realpathSync, readlinkSync } from 'fs';
import { join } from 'path';
import { config } from './config';
import { logger } from './logger';
import { PKG_VERSION } from '../version';

// === 类型定义 ===

export type ActivityConfidence = 'high' | 'medium' | 'low';
export type ActivitySource = 'marker' | 'cpu' | 'child' | 'mtime' | 'none';
export type ActivityPlatform = 'feishu' | 'cli';
export type MarkerAction = 'start' | 'end' | 'heartbeat';

export interface ActivityResult {
  isProcessing: boolean;
  confidence: ActivityConfidence;
  reason: string;
  source: ActivitySource;
}

export interface ActivityMarker {
  type: 'activity_marker';
  uuid: string;
  platform: ActivityPlatform;
  action: MarkerAction;
  timestamp: string;
  pid?: number;
  version: string;
}

export interface ChildResult {
  hasChildren: boolean;
  children: Array<{ pid: number; command: string }>;
}

export type DetectionDirection =
  | 'feishu-detects-cli'
  | 'cli-detects-feishu';

// === Sidecar 文件路径 ===

export function activityLogPath(sessionUuid: string): string {
  return join(ACTIVITY_DIR, `${sessionUuid}.log`);
}

// === 写入 marker ===

export function writeActivityMarker(
  sessionUuid: string,
  platform: ActivityPlatform,
  action: MarkerAction,
  pid?: number
): void {
  if (!sessionUuid) return;  // ★ 保护空字符串

  try {
    mkdirSync(ACTIVITY_DIR, { recursive: true, mode: 0o700 });
  } catch {
    // 目录已存在
  }

  const marker: ActivityMarker = {
    type: 'activity_marker',
    uuid: `am-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    platform,
    action,
    timestamp: new Date().toISOString(),
    pid,
    version: PKG_VERSION,
  };

  try {
    appendFileSync(activityLogPath(sessionUuid), JSON.stringify(marker) + '\n', { mode: 0o600 });
  } catch (err) {
    logger.warn(`写入 activity marker 失败: ${sessionUuid}: ${err}`);
  }
}

// === 读取最后一个 marker ===

export function readLastActivityMarker(sessionUuid: string): ActivityMarker | null {
  if (!sessionUuid) return null;
  const path = activityLogPath(sessionUuid);
  if (!existsSync(path)) return null;

  try {
    const stat = statSync(path);
    const readSize = Math.min(4096, stat.size);
    const fd = openSync(path, 'r');
    try {
      const buffer = Buffer.alloc(readSize);
      readSync(fd, buffer, 0, readSize, stat.size - readSize);
      const tail = buffer.toString('utf8');
      const lines = tail.split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const entry = JSON.parse(lines[i]);
          if (entry.type === 'activity_marker') {
            return entry as ActivityMarker;
          }
        } catch {
          // 跳过解析失败行
        }
      }
      return null;
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    logger.warn(`读取 activity marker 失败: ${sessionUuid}: ${err}`);
    return null;
  }
}
