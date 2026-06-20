import { test, expect } from 'bun:test';
import { StreamParser } from '../../../src/proxy/stream-parser';

test('filters system lines', () => {
  const parser = new StreamParser();
  expect(parser.parseLine('{"type":"system","subtype":"hook_started"}')).toEqual([]);
});

test('filters user lines (tool_result 等用户侧事件)', () => {
  // PR 6.22: user 类型也忽略 (防止 tool_result 误派发)
  const parser = new StreamParser();
  const line = JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] },
  });
  expect(parser.parseLine(line)).toEqual([]);
});

test('extracts thinking content from assistant', () => {
  const parser = new StreamParser();
  const line = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'thinking', thinking: 'Let me think...' }] }
  });
  const result = parser.parseLine(line);
  expect(result).toHaveLength(1);
  expect(result[0].type).toBe('thinking');
  expect((result[0] as any).content).toBe('Let me think...');
});

test('extracts text content from assistant', () => {
  const parser = new StreamParser();
  const line = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'Hello world' }] }
  });
  const result = parser.parseLine(line);
  expect(result).toHaveLength(1);
  expect(result[0].type).toBe('text');
  expect((result[0] as any).content).toBe('Hello world');
});

test('PR 6.21: extracts tool_use block from assistant', () => {
  const parser = new StreamParser();
  const line = JSON.stringify({
    type: 'assistant',
    message: { content: [{
      type: 'tool_use',
      id: 'toolu_abc123',
      name: 'Bash',
      input: { command: 'ls -la /tmp' },
    }]},
  });
  const result = parser.parseLine(line);
  expect(result).toHaveLength(1);
  expect(result[0].type).toBe('tool_use');
  expect((result[0] as any).name).toBe('Bash');
  expect((result[0] as any).input).toEqual({ command: 'ls -la /tmp' });
});

test('returns empty array for assistant with no content', () => {
  const parser = new StreamParser();
  expect(parser.parseLine(JSON.stringify({ type: 'assistant', message: {} }))).toEqual([]);
});

test('returns empty array for unknown type', () => {
  const parser = new StreamParser();
  expect(parser.parseLine(JSON.stringify({ type: 'unknown' }))).toEqual([]);
});

test('returns result chunk wrapped in array when type=result', () => {
  const parser = new StreamParser();
  const line = JSON.stringify({
    type: 'result', subtype: 'success', result: 'Final answer',
    session_id: 'abc-123', total_cost_usd: 0.05, duration_ms: 2000,
    stop_reason: 'end_turn',
  });
  const result = parser.parseLine(line);
  expect(result).toHaveLength(1);
  expect(result[0].type).toBe('result');
  expect((result[0] as any).result).toBe('Final answer');
  expect((result[0] as any).session_id).toBe('abc-123');
  expect((result[0] as any).total_cost_usd).toBe(0.05);
});

test('PR 6.22: 多 block assistant message 全部 emit (不是只 emit 第一个)', () => {
  // 关键测试: Claude extended thinking 模式 message.content = [thinking, tool_use, text]
  //   旧版 for-loop return 只 emit thinking, tool_use + text 都丢
  //   新版返回数组, 全部 emit 让 caller 累积
  const parser = new StreamParser();
  const line = JSON.stringify({
    type: 'assistant',
    message: { content: [
      { type: 'thinking', thinking: '我应该读文件' },
      { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { path: '/etc/hostname' } },
      { type: 'text', text: '让我读一下' },
    ]},
  });
  const result = parser.parseLine(line);
  expect(result).toHaveLength(3);
  expect(result[0].type).toBe('thinking');
  expect(result[1].type).toBe('tool_use');
  expect(result[2].type).toBe('text');
  // 验证每个 chunk 内容
  expect((result[0] as any).content).toBe('我应该读文件');
  expect((result[1] as any).name).toBe('Read');
  expect((result[2] as any).content).toBe('让我读一下');
});

test('PR 6.22: 单一 thinking block 仍然 emit 数组', () => {
  // 回归: 单 block 不能 emit 多个相同 chunk
  const parser = new StreamParser();
  const line = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'thinking', thinking: 'single' }] }
  });
  const result = parser.parseLine(line);
  expect(result).toHaveLength(1);
});

test('handles invalid JSON gracefully', () => {
  const parser = new StreamParser();
  expect(parser.parseLine('not json')).toEqual([]);
});

test('handles empty lines', () => {
  const parser = new StreamParser();
  expect(parser.parseLine('')).toEqual([]);
  expect(parser.parseLine('   ')).toEqual([]);
});