import { describe, test, expect } from 'bun:test';
import { parsePsTimeToSeconds } from '../../../src/utils/process-info';

describe('parsePsTimeToSeconds', () => {
  test('纯秒数（< 1 分钟）', () => {
    expect(parsePsTimeToSeconds('12.34')).toBe(12.34);
    expect(parsePsTimeToSeconds('0.00')).toBe(0);
    expect(parsePsTimeToSeconds('59.99')).toBe(59.99);
  });

  test('MM:SS（< 1 小时）', () => {
    expect(parsePsTimeToSeconds('1:23')).toBe(83);
    expect(parsePsTimeToSeconds('1:23.45')).toBe(83.45);
    expect(parsePsTimeToSeconds('59:59')).toBe(3599);
  });

  test('HH:MM:SS（< 1 天）', () => {
    expect(parsePsTimeToSeconds('1:23:45')).toBe(5025);
    expect(parsePsTimeToSeconds('12:34:56')).toBe(45296);
    expect(parsePsTimeToSeconds('23:59:59')).toBe(86399);
    expect(parsePsTimeToSeconds('0:00:01')).toBe(1);
  });

  test('DD-HH:MM:SS（≥ 1 天，长任务场景）', () => {
    expect(parsePsTimeToSeconds('1-00:00:00')).toBe(86400);
    expect(parsePsTimeToSeconds('2-01:23:45')).toBe(2 * 86400 + 5025);
    expect(parsePsTimeToSeconds('10-12:00:00')).toBe(10 * 86400 + 43200);
  });

  test('边界：刚好 1 小时', () => {
    expect(parsePsTimeToSeconds('1:00:00')).toBe(3600);
  });

  test('边界：刚好 1 天（无 '-' 前缀）', () => {
    expect(parsePsTimeToSeconds('24:00:00')).toBe(86400);
  });

  test('带百分秒位', () => {
    expect(parsePsTimeToSeconds('1:23:45.67')).toBe(5025.67);
  });

  test('空字符串 → 0', () => {
    expect(parsePsTimeToSeconds('')).toBe(0);
  });
});
