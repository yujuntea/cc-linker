import { describe, test, expect } from 'bun:test';
import { classifyModel } from '../../../src/img-proxy/classify';

describe('classifyModel — 内置 patterns', () => {
  // Multimodal
  test('claude-3-5-sonnet 是 multimodal', () => {
    expect(classifyModel('claude-3-5-sonnet-20241022')).toBe('multimodal');
  });
  test('claude-opus-4 是 multimodal', () => {
    expect(classifyModel('claude-opus-4[1m]')).toBe('multimodal');
  });
  test('gpt-4o 是 multimodal', () => {
    expect(classifyModel('gpt-4o')).toBe('multimodal');
  });
  test('qwen-vl-plus 是 multimodal', () => {
    expect(classifyModel('qwen-vl-plus')).toBe('multimodal');
  });
  test('qwen3.6-plus[1m] 是 multimodal', () => {
    expect(classifyModel('qwen3.6-plus[1m]')).toBe('multimodal');
  });
  test('qwen3.7-plus[1m] 是 multimodal', () => {
    expect(classifyModel('qwen3.7-plus[1m]')).toBe('multimodal');
  });
  test('glm-4v-plus 是 multimodal', () => {
    expect(classifyModel('glm-4v-plus')).toBe('multimodal');
  });
  test('glm-4.5v 是 multimodal', () => {
    expect(classifyModel('glm-4.5v')).toBe('multimodal');
  });
  test('kimi-for-coding[256k] 是 multimodal', () => {
    expect(classifyModel('kimi-for-coding[256k]')).toBe('multimodal');
  });
  test('MiniMax-M3[1m] 是 multimodal', () => {
    expect(classifyModel('MiniMax-M3[1m]')).toBe('multimodal');
  });
  test('mimo-v2.5[1m] 是 multimodal(base 不带 pro)', () => {
    expect(classifyModel('mimo-v2.5[1m]')).toBe('multimodal');
  });
  test('mimo-v2.5-pro[1m] 是 text-only(负向 lookahead)', () => {
    expect(classifyModel('mimo-v2.5-pro[1m]')).toBe('text-only');
  });

  // Text-only
  test('glm-5.2[1m] 是 text-only', () => {
    expect(classifyModel('glm-5.2[1m]')).toBe('text-only');
  });
  test('glm-5.1 是 text-only', () => {
    expect(classifyModel('glm-5.1')).toBe('text-only');
  });
  test('glm-4.5 是 text-only', () => {
    expect(classifyModel('glm-4.5')).toBe('text-only');
  });
  test('deepseek-v4-pro[1m] 是 text-only', () => {
    expect(classifyModel('deepseek-v4-pro[1m]')).toBe('text-only');
  });
  test('qwen3.7-max[1m] 是 text-only(NOT -plus)', () => {
    expect(classifyModel('qwen3.7-max[1m]')).toBe('text-only');
  });
  test('MiniMax-M2.5[1m] 是 text-only', () => {
    expect(classifyModel('MiniMax-M2.5[1m]')).toBe('text-only');
  });

  // Unknown
  test('some-new-model[1m] 是 unknown', () => {
    expect(classifyModel('some-new-model[1m]')).toBe('unknown');
  });
  test('空字符串 是 unknown', () => {
    expect(classifyModel('')).toBe('unknown');
  });
});

describe('classifyModel — extra patterns(config override)', () => {
  test('visionPatterns_extra 把 my-vl-test 标 multimodal', () => {
    expect(classifyModel('my-vl-test', { visionPatterns: ['my-vl-.*'] })).toBe('multimodal');
  });
  test('textOnlyPatterns_extra 把 my-text 标 text-only', () => {
    expect(classifyModel('my-text-1', { textOnlyPatterns: ['my-text-.*'] })).toBe('text-only');
  });
});

describe('classifyModel — 后缀剥离', () => {
  test('[1m] 后缀被剥掉', () => {
    expect(classifyModel('glm-5.2[1m]')).toBe('text-only');
  });
  test('[256k] 后缀被剥掉', () => {
    expect(classifyModel('kimi-for-coding[256k]')).toBe('multimodal');
  });
  test('[128k] 后缀被剥掉', () => {
    expect(classifyModel('glm-4.5[128k]')).toBe('text-only');
  });
  test('大小写不敏感', () => {
    expect(classifyModel('GLM-5.2[1M]')).toBe('text-only');
  });
});
