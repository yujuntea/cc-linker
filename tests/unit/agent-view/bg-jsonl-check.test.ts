// tests/unit/agent-view/bg-jsonl-check.test.ts
//
// v2.2.12 bg-jsonl-check 单测:给一个 sessionId,判定它的 JSONL 有没有
// user/assistant 真实对话条目(忽略 ai-title/agent-name/mode 等 metadata)。

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { bgJsonlHasConversation } from '../../../src/agent-view/bg-jsonl-check';

let realProjectsDir: string | undefined;

beforeEach(() => {
  // 把 CLAUDE_PROJECTS_DIR 重定向到 tmp 目录:用一个 env var
  // → 这里通过 setEnv + 模块的 dynamic path 注入不直接支持,所以
  // 我们用 module 级 const 重写的方式:CLAUDE_PROJECTS_DIR 是模块顶层 const,
  // 没法运行时改。所以测试直接用 /Users/wuyujun 的真实 CLAUDE_PROJECTS_DIR,
  // 用真实 sessionId 验真。
});

afterEach(() => {
  // no-op
});

describe('bgJsonlHasConversation', () => {
  test('returns false for a real bg session whose JSONL only has metadata (d78c8339)', () => {
    // d78c8339.jsonl 实测只有 2 行 (ai-title + agent-name)
    expect(bgJsonlHasConversation('d78c8339-18b0-4f53-8452-d4228d30f51f')).toBe(false);
  });

  test('returns true for a real parent session with real conversation (ab027020)', () => {
    // ab027020.jsonl 实测 51 行,有 user/assistant 真实对话
    expect(bgJsonlHasConversation('ab027020-95f6-4cd4-96a4-63d04fa5ebf8')).toBe(true);
  });

  test('returns false for a nonexistent sessionId', () => {
    expect(bgJsonlHasConversation('99999999-0000-0000-0000-000000000000')).toBe(false);
  });

  test('returns false for empty string', () => {
    expect(bgJsonlHasConversation('')).toBe(false);
  });
});
