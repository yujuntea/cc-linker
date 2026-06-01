import { describe, test, expect } from 'bun:test';
import { parsePsTimeToSeconds } from '../../../src/utils/process-info';

describe('parsePsTimeToSeconds', () => {
  test('SS.hh 格式（< 1 分钟）', () => {
    expect(parsePsTimeToSeconds('12.34')).toBe(12.34);
  });

  test('MM:SS 格式（< 1 小时）', () => {
    expect(parsePsTimeToSeconds('1:23.45')).toBe(83.45);
  });

  test('HH:MM:SS 格式（< 1 天）', () => {
    expect(parsePsTimeToSeconds('1:23:45')).toBe(5025);
    expect(parsePsTimeToSeconds('12:34:56')).toBe(45296);
  });

  test('DD-HH:MM:SS 格式（长任务，>= 1 天）', () => {
    expect(parsePsTimeToSeconds('2-01:23:45')).toBe(2 * 86400 + 5025);
  });

  test('空字符串', () => {
    expect(parsePsTimeToSeconds('')).toBe(0);
  });
});
