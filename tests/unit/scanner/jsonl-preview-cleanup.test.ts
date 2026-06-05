import { describe, it, expect } from 'bun:test';
import { JSONLScanner } from '../../../src/scanner/jsonl';

describe('JSONLScanner.stripMarkdownNoise', () => {
  // 用 (JSONLScanner as any) 访问 private static method
  const strip = (s: string) => (JSONLScanner as any).stripMarkdownNoise(s);

  it('strips line-start heading markers (##, ###, etc.) but keeps text', () => {
    expect(strip('## 0. 内存膨胀分析')).toBe('0. 内存膨胀分析');
    expect(strip('### 0.1 单个 queue item 真实大小')).toBe('0.1 单个 queue item 真实大小');
    expect(strip('# 完整最终 Review 修改意见（决策版）')).toBe('完整最终 Review 修改意见（决策版）');
  });

  it('strips bold markers (**) but keeps text', () => {
    expect(strip('这是 **加粗** 文字')).toBe('这是 加粗 文字');
    expect(strip('**完全加粗**')).toBe('完全加粗');
  });

  it('strips inline code markers (`) but keeps code content', () => {
    expect(strip('看 `traeScanner` 代码')).toBe('看 traeScanner 代码');
    expect(strip('调用 `getCurrentTask` 方法')).toBe('调用 getCurrentTask 方法');
  });

  it('strips code block boundary markers (```)', () => {
    expect(strip('```typescript\nconst x = 1;\n```')).toBe('typescript\nconst x = 1;\n');
  });

  it('preserves list markers (-) and links [text](url)', () => {
    expect(strip('- 第一项\n- 第二项')).toBe('- 第一项\n- 第二项');
    expect(strip('看 [文档](https://example.com) 了解')).toBe('看 [文档](https://example.com) 了解');
  });
});

describe('JSONLScanner.truncateByLine', () => {
  const trunc = (s: string, max: number) => (JSONLScanner as any).truncateByLine(s, max);

  it('returns text unchanged when shorter than maxLength', () => {
    expect(trunc('短文本', 240)).toBe('短文本');
  });

  it('appends ... when no newline in first maxLength chars', () => {
    const text = 'a'.repeat(250);
    expect(trunc(text, 240)).toBe('a'.repeat(240) + '...');
  });

  it('truncates at last newline when newline is in latter half (>50%)', () => {
    // 5 行，每行 50 字符，总长 250；maxLength=120
    // 累积到第 3 行（150 字符）超出 120，找最后一个 \n (位置 100)
    // 截到位置 100 + '...'
    const text = 'a'.repeat(50) + '\n' + 'b'.repeat(50) + '\n' + 'c'.repeat(50) + '\n' + 'd'.repeat(50) + '\n' + 'e'.repeat(50);
    const result = trunc(text, 120);
    // 期望：截到第二个 \n（位置 101 之后，但 slice 排除该位置），
    //       得到 'a*50\nb*50'（位置 0-100）+ '...'
    // 修正：实现用 slice(0, lastNewline) 不含尾随 \n
    expect(result).toMatch(/^a+\nb+\.\.\.$/);
  });

  it('falls back to character truncation when newline in first half (<50%)', () => {
    // 新行在 first half (<50% of maxLength)，按字符截断
    // 30 chars + \n + 120 chars = 151 total, maxLength=100
    // slice(0, 100) 的 \n 在位置 30 < 50（50% of 100）→ 走 fallback
    const text = 'a'.repeat(30) + '\n' + 'b'.repeat(120);
    const result = trunc(text, 100);
    // 字符截断：slice(0, 100) + '...'
    expect(result).toBe('a'.repeat(30) + '\n' + 'b'.repeat(69) + '...');
  });

  it('uses character truncation when maxLength=240 and text is 250 chars with no newline', () => {
    const text = 'a'.repeat(250);
    const result = trunc(text, 240);
    expect(result).toBe('a'.repeat(240) + '...');
    expect(result.length).toBe(243);
  });
});
