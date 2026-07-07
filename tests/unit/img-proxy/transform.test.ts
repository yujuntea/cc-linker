import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { stripImagesToPaths, DEFAULT_PROMPT_TEMPLATE } from '../../../src/img-proxy/transform';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const RED_DOT_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('stripImagesToPaths', () => {
  let cacheDir: string;
  beforeEach(() => { cacheDir = mkdtempSync(join(tmpdir(), 'img-proxy-cache-')); });
  afterEach(() => { rmSync(cacheDir, { recursive: true, force: true }); });

  it('returns messages unchanged when no image blocks', async () => {
    const messages = [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }];
    const result = await stripImagesToPaths(messages, { cacheDir, promptTemplate: 'img at {path}' });
    expect(result.strippedCount).toBe(0);
    expect(result.savedImages).toEqual([]);
    expect(result.messages).toEqual(messages);
  });

  it('strips one image block, saves png file, replaces with text block containing path', async () => {
    const messages = [{
      role: 'user',
      content: [
        { type: 'text', text: '看这张图' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: RED_DOT_PNG_B64 } },
      ],
    }];
    const result = await stripImagesToPaths(messages, { cacheDir, promptTemplate: '[img: {path}]' });
    expect(result.strippedCount).toBe(1);
    expect(result.savedImages).toHaveLength(1);
    const saved = result.savedImages[0]!;
    expect(saved.endsWith('.png')).toBe(true);
    expect(existsSync(saved)).toBe(true);
    expect(readFileSync(saved).length).toBeGreaterThan(0);
    const content = (result.messages[0] as any).content as any[];
    expect(content[1].type).toBe('text');
    expect(content[1].text).toContain(saved);
    expect(content[0]).toEqual({ type: 'text', text: '看这张图' });
  });

  it('handles content given as plain string', async () => {
    const messages = [{ role: 'user', content: 'plain string message' }];
    const result = await stripImagesToPaths(messages, { cacheDir, promptTemplate: '{path}' });
    expect(result.strippedCount).toBe(0);
    expect(result.messages).toEqual(messages);
  });

  it('correct extension for jpeg/webp', async () => {
    const messages = [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: RED_DOT_PNG_B64 } },
        { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: RED_DOT_PNG_B64 } },
      ],
    }];
    const result = await stripImagesToPaths(messages, { cacheDir, promptTemplate: '{path}' });
    expect(result.savedImages[0]!.endsWith('.jpg')).toBe(true);
    expect(result.savedImages[1]!.endsWith('.webp')).toBe(true);
  });

  it('leaves url-source image blocks untouched', async () => {
    const messages = [{
      role: 'user',
      content: [{ type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } }],
    }];
    const result = await stripImagesToPaths(messages, { cacheDir, promptTemplate: '{path}' });
    expect(result.strippedCount).toBe(0);
    expect(result.messages).toEqual(messages);
  });

  it('falls back to DEFAULT_PROMPT_TEMPLATE when template lacks {path}', async () => {
    const messages = [{
      role: 'user',
      content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: RED_DOT_PNG_B64 } }],
    }];
    const result = await stripImagesToPaths(messages, { cacheDir, promptTemplate: '没有占位符的模板' });
    expect(result.strippedCount).toBe(1);
    const text = (result.messages[0] as any).content[0].text;
    expect(text).toContain(result.savedImages[0]);  // 用默认模板,含路径
    expect(DEFAULT_PROMPT_TEMPLATE).toContain('{path}');
  });

  it('processes multiple messages independently', async () => {
    const messages = [
      { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: RED_DOT_PNG_B64 } }] },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: RED_DOT_PNG_B64 } }] },
    ];
    const result = await stripImagesToPaths(messages, { cacheDir, promptTemplate: '{path}' });
    expect(result.strippedCount).toBe(2);
    expect(readdirSync(cacheDir).length).toBe(2);
  });
});

describe('DEFAULT_PROMPT_TEMPLATE (2026-07-07 tool-agnostic)', () => {
  // 安全闸:防止以后再有人把单一 MCP 名 hardcode 进 default
  it('does NOT hardcode a specific image-recognition MCP tool', () => {
    expect(DEFAULT_PROMPT_TEMPLATE).not.toContain('mcp__MiniMax__understand_image');
    expect(DEFAULT_PROMPT_TEMPLATE).not.toMatch(/mcp__[A-Za-z0-9_]+__[A-Za-z_]+/);
  });

  it('仍含 {path} 占位符(不破坏 stripImagesToPaths fallback 逻辑)', () => {
    expect(DEFAULT_PROMPT_TEMPLATE).toContain('{path}');
  });

  it('含三条工具路径关键词:Read / MCP / mmx-cli', () => {
    expect(DEFAULT_PROMPT_TEMPLATE).toContain('Read 工具');
    expect(DEFAULT_PROMPT_TEMPLATE).toContain('MCP');
    expect(DEFAULT_PROMPT_TEMPLATE).toContain('mmx-cli');
  });

  it('与 config.ts DEFAULTS.img_proxy.prompt_template 字面一致', async () => {
    const { config } = await import('../../../src/utils/config');
    const cfgDefault = config.get<string>('img_proxy.prompt_template', '');
    expect(cfgDefault).toBe(DEFAULT_PROMPT_TEMPLATE);
  });
});
