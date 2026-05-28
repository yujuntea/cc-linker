import { describe, it, expect } from 'bun:test';
import {
  extractImageKey,
  buildPromptWithImages,
  cleanupOldImages,
} from '../../../src/feishu/image';

describe('extractImageKey', () => {
  it('extracts image_key from valid content', () => {
    const result = extractImageKey('{"image_key":"img_v3_abc123"}');
    expect(result).toBe('img_v3_abc123');
  });

  it('returns null for empty content', () => {
    expect(extractImageKey('')).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    expect(extractImageKey('not-json')).toBeNull();
  });

  it('returns null when image_key is missing', () => {
    expect(extractImageKey('{}')).toBeNull();
  });
});

describe('buildPromptWithImages', () => {
  it('returns original text when no images', () => {
    expect(buildPromptWithImages('hello', [])).toBe('hello');
  });

  it('builds prompt for single image with text', () => {
    const result = buildPromptWithImages('What is this?', ['/path/to/img.png']);
    expect(result).toContain('[用户发送了第1张图片: /path/to/img.png]');
    expect(result).toContain('What is this?');
  });

  it('builds prompt for image without text', () => {
    const result = buildPromptWithImages('', ['/path/to/img.png']);
    expect(result).toContain('[用户发送了第1张图片: /path/to/img.png]');
    expect(result).toContain('请描述这张图片的内容。');
  });

  it('builds prompt for multiple images', () => {
    const result = buildPromptWithImages('Compare these', ['/a.png', '/b.png']);
    expect(result).toContain('[用户发送了第1张图片: /a.png]');
    expect(result).toContain('[用户发送了第2张图片: /b.png]');
    expect(result).toContain('Compare these');
  });
});

describe('cleanupOldImages', () => {
  it('does not throw when directory does not exist', () => {
    expect(() => cleanupOldImages(24)).not.toThrow();
  });
});
