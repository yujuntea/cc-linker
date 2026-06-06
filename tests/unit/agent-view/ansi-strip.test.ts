import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { stripAnsi } from '../../../src/agent-view/ansi-strip';

const fixtureDir = join(import.meta.dir, '..', '..', 'fixtures', 'ansi-logs');

describe('stripAnsi', () => {
  test('plain text passes through unchanged', () => {
    const raw = readFileSync(join(fixtureDir, 'plain.txt'), 'utf8');
    expect(stripAnsi(raw)).toBe(raw);
  });

  test('removes color codes (CSI SGR)', () => {
    const raw = readFileSync(join(fixtureDir, 'color.txt'), 'utf8');
    const out = stripAnsi(raw);
    expect(out).toBe('Error: test failed\nOK: 3 tests passed\n');
    expect(out).not.toContain('\x1b');
  });

  test('removes clear-screen + cursor-position (CSI)', () => {
    const raw = readFileSync(join(fixtureDir, 'cursor.txt'), 'utf8');
    expect(stripAnsi(raw)).toBe('Welcome to claude\n$ _\n');
  });

  test('removes progress bar redraws (CSI + back-and-up)', () => {
    const raw = readFileSync(join(fixtureDir, 'progress.txt'), 'utf8');
    const out = stripAnsi(raw);
    expect(out).toContain('30%');
    expect(out).toContain('50%');
    expect(out).toContain('70%');
    expect(out).toContain('100% done');
    expect(out).not.toContain('\x1b');
  });

  test('preserves UTF-8 multi-byte characters adjacent to escapes', () => {
    const raw = readFileSync(join(fixtureDir, 'utf8.txt'), 'utf8');
    expect(stripAnsi(raw)).toBe('错误: 测试失败\n中文测试 通过\n');
  });

  test('handles empty input', () => {
    expect(stripAnsi('')).toBe('');
  });
});
