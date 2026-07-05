import { readFileSync, statSync } from 'fs';
import type { LogEntry, ParsedLogEntry, ReadRecentOpts } from './types';

const LINE_RE = /^\[([^\]]+)\] (?:INFO|WARN|ERROR) (.+)$/;

function parseLine(raw: string): LogEntry | null {
  const m = raw.match(LINE_RE);
  if (!m) return null;
  const ts = Date.parse(m[1]!);
  if (Number.isNaN(ts)) return null;
  let parsed: ParsedLogEntry | null = null;
  try {
    const body = JSON.parse(m[2]!);
    if (body && typeof body === 'object' && body.alias) {
      parsed = body as ParsedLogEntry;
    }
  } catch {
    // WARN/ERROR 等非 JSON 行,parsed 留 null
  }
  return { ts, raw, parsed };
}

export async function readRecentLogLines(opts: ReadRecentOpts): Promise<LogEntry[]> {
  const { logPath, limit = 100, alias, status, streamStatus, sinceMs } = opts;
  let content: string;
  try {
    content = readFileSync(logPath, 'utf8');
  } catch {
    return [];  // 文件不存在/不可读
  }
  const lines = content.split('\n').filter(Boolean);
  const all: LogEntry[] = [];
  for (const line of lines) {
    const entry = parseLine(line);
    if (!entry) continue;
    if (alias && entry.parsed?.alias !== alias) continue;
    if (status !== undefined && entry.parsed?.upstream_status !== status) continue;
    if (streamStatus && entry.parsed?.stream_status !== streamStatus) continue;
    if (sinceMs !== undefined && entry.ts < sinceMs) continue;
    all.push(entry);
  }
  // 倒序(最新在前)+ limit
  return all.reverse().slice(0, limit);
}

// === LogTail singleton ===

export class LogTail {
  public offset = 0;
  constructor(public readonly logPath: string) {}

  async readNew(): Promise<LogEntry[]> {
    let fileSize: number;
    try {
      fileSize = statSync(this.logPath).size;
    } catch {
      return [];
    }
    // 文件被 truncate,reset offset
    if (fileSize < this.offset) this.offset = 0;
    if (fileSize === this.offset) return [];

    const { open } = await import('fs/promises');
    const fh = await open(this.logPath, 'r');
    try {
      const len = fileSize - this.offset;
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, this.offset);
      const text = buf.toString('utf8');
      const lines = text.split('\n');
      const isComplete = text.endsWith('\n');
      // bug fix (review): 原来先 `offset = fileSize` 再处理不完整 line,
      // 导致 partial line 被 pop 丢弃后 offset 已经过掉了它 — 下次再
      // 读也不会再看到 (comment 说 "下次会重读",但 offset 已逝)。
      // 修正:不完整时只推到 "文件末尾 - 最后一段的长度",这样下次会从
      // 该前缀位置继续读,把不完整 line 拼上后续字节。
      if (!isComplete && lines.length > 0) {
        const lastLine = lines[lines.length - 1]!;
        this.offset = fileSize - Buffer.byteLength(lastLine, 'utf8');
        lines.pop();
      } else {
        this.offset = fileSize;
      }
      const entries: LogEntry[] = [];
      for (const line of lines) {
        if (!line) continue;
        const entry = parseLine(line);
        if (entry) entries.push(entry);
      }
      return entries;
    } finally {
      await fh.close();
    }
  }
}

let _tail: LogTail | null = null;
export function getTail(logPath: string): LogTail {
  if (!_tail || _tail.logPath !== logPath) _tail = new LogTail(logPath);
  return _tail;
}

/** 测试隔离用 */
export function resetLogTail(): void {
  _tail = null;
}