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

  // Bug fix (2026-07-09): 之前 transform 只扫 message.content 顶层 image 块,
  // 漏掉 tool_result.content 里嵌套的 image。Read tool 读 PNG 后 Claude Code 把图塞进
  // tool_result.content,proxy 透传给上游 → 纯文本模型报 400。
  // 复现链路:
  //   1. 用户贴图 → proxy stripped=1 替换为 text(指本地路径)
  //   2. model 调 Read(本地路径)
  //   3. 下一轮 user message 是 tool_result,content 嵌套 image → 必须递归 strip
  it('strips image block nested inside tool_result.content', async () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: '原消息' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/tmp/x.png' } }] },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: RED_DOT_PNG_B64 } },
          ],
        }],
      },
    ];
    const result = await stripImagesToPaths(messages, { cacheDir, promptTemplate: 'img: {path}' });
    expect(result.strippedCount).toBe(1);
    expect(result.savedImages).toHaveLength(1);
    // tool_result 块的嵌套 content 数组:原 image 块应被替换成 text 块
    const toolResult = (result.messages[2] as any).content[0];
    expect(toolResult.type).toBe('tool_result');
    expect(Array.isArray(toolResult.content)).toBe(true);
    expect(toolResult.content).toHaveLength(1);
    expect(toolResult.content[0].type).toBe('text');
    expect(toolResult.content[0].text).toContain(result.savedImages[0]!);
  });

  it('preserves text content in tool_result while stripping nested image', async () => {
    const messages = [{
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'toolu_1',
        content: [
          { type: 'text', text: '文件大小: 1KB' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: RED_DOT_PNG_B64 } },
        ],
      }],
    }];
    const result = await stripImagesToPaths(messages, { cacheDir, promptTemplate: 'img: {path}' });
    expect(result.strippedCount).toBe(1);
    const inner = (result.messages[0] as any).content[0].content;
    expect(inner).toHaveLength(2);
    expect(inner[0]).toEqual({ type: 'text', text: '文件大小: 1KB' });  // text 保留
    expect(inner[1].type).toBe('text');                                  // image → text
    expect(inner[1].text).toContain(result.savedImages[0]!);
  });

  it('leaves tool_result with only text content untouched', async () => {
    const messages = [{
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'toolu_1',
        content: [{ type: 'text', text: 'all text' }],
      }],
    }];
    const result = await stripImagesToPaths(messages, { cacheDir, promptTemplate: 'img: {path}' });
    expect(result.strippedCount).toBe(0);
    expect(result.messages).toEqual(messages);
  });
});

describe('DEFAULT_PROMPT_TEMPLATE (2026-07-07 tool-agnostic)', () => {
  // 防回归:防止以后再有人把单一 MCP tool 名 hardcode 进 default(template 由
  // config.ts DEFAULTS 用同名常量 import,避免两处漂移)。
  it('does NOT hardcode a specific image-recognition MCP tool', () => {
    expect(DEFAULT_PROMPT_TEMPLATE).not.toMatch(/mcp__[A-Za-z0-9_]+__[A-Za-z_]+/);
  });
});
