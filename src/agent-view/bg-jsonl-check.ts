// src/agent-view/bg-jsonl-check.ts
//
// v2.2.12 新增:判断一个 bg sessionId 的 JSONL 有没有真实对话条目。
// 给 handleStopAndSend 用 —— bg worker killed 后,bg 自己的 JSONL 通常
// 只有 ai-title + agent-name 两条 metadata(worker 把对话 state 全
// 留在内存,没写盘),需要 fallback 到 parent。

import { existsSync, readFileSync, statSync } from 'fs';
import { readdirSync } from 'fs';
import { join } from 'path';
import { CLAUDE_PROJECTS_DIR } from '../utils/paths';

const FULL_READ_THRESHOLD_BYTES = 500_000;
const TAIL_READ_BYTES = 64 * 1024;

/**
 * 给定 full sessionId,找到它的 JSONL 文件,扫描前 N 行看有没有 user / assistant
 * 条目(忽略 ai-title / agent-name / file-history-snapshot / mode 等 metadata)。
 *
 * 返回 true = JSONL 里有真实对话(worker 把对话写回去了),可以 resume 拿历史
 * 返回 false = 只有 metadata(worker 内存里跑,JSONL 空白),需要 fallback 到 parent
 */
export function bgJsonlHasConversation(sessionId: string): boolean {
  const jsonlPath = findJsonlForSessionId(sessionId);
  if (!jsonlPath) return false;

  let raw: string;
  try {
    const st = statSync(jsonlPath);
    if (st.size > FULL_READ_THRESHOLD_BYTES) {
      const fs = require('fs');
      const fd = fs.openSync(jsonlPath, 'r');
      try {
        const len = Math.min(TAIL_READ_BYTES, st.size);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, st.size - len);
        raw = buf.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    } else {
      raw = readFileSync(jsonlPath, 'utf8');
    }
  } catch {
    return false;
  }

  for (const line of raw.split('\n')) {
    if (!line) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const t = entry?.type;
    if (t === 'user' || t === 'assistant') {
      // 进一步:有真实 content 吗?排除 isMeta / 空 content 的"假" user 条目
      const c = entry?.message?.content;
      if (typeof c === 'string' && c.trim()) return true;
      if (Array.isArray(c) && c.some((b: any) => b?.type === 'text' && b.text?.trim())) return true;
    }
  }
  return false;
}

function findJsonlForSessionId(sessionId: string): string | null {
  if (!sessionId || !existsSync(CLAUDE_PROJECTS_DIR)) return null;
  const target = sessionId + '.jsonl';
  try {
    for (const proj of readdirSync(CLAUDE_PROJECTS_DIR)) {
      const projDir = join(CLAUDE_PROJECTS_DIR, proj);
      let projStat;
      try {
        projStat = statSync(projDir);
      } catch {
        continue;
      }
      if (!projStat.isDirectory()) continue;
      for (const fname of readdirSync(projDir)) {
        if (fname === target) return join(projDir, fname);
      }
    }
  } catch {
    return null;
  }
  return null;
}
