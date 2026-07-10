import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { stripImagesToPaths, DEFAULT_PROMPT_TEMPLATE } from '../../../src/img-proxy/transform';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, statSync } from 'fs';
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
    // 同 base64 走 content-hash dedup:两次都写同一文件(2026-07-10 fix)
    expect(readdirSync(cacheDir).length).toBe(1);
    // 两次返回的 path 必须一致,模型才能识别"同一张图"避免反复 Read
    expect(result.savedImages[0]).toBe(result.savedImages[1]);
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

// === content-hash dedup (2026-07-10 fix) ===
// 修掉"Read tool result 反馈循环"导致的 cache 爆炸(实测 11 张唯一图涨到 1483 份)。
// 设计:filename = sha256(dataB64).slice(0,32) + ext。同一 base64 永远落同一文件。
describe('saveImage content-hash dedup', () => {
  let cacheDir: string;
  beforeEach(() => { cacheDir = mkdtempSync(join(tmpdir(), 'img-proxy-dedup-')); });
  afterEach(() => { rmSync(cacheDir, { recursive: true, force: true }); });

  it('filename is <32-hex>.<ext>, not Date.now()-random', async () => {
    const messages = [{
      role: 'user',
      content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: RED_DOT_PNG_B64 } }],
    }];
    const result = await stripImagesToPaths(messages, { cacheDir, promptTemplate: '{path}' });
    const path = result.savedImages[0]!;
    const base = path.slice(cacheDir.length + 1);  // 去掉 cacheDir + /
    expect(base).toMatch(/^[a-f0-9]{32}\.png$/);   // 32 hex + .png
  });

  it('same base64 across two separate requests → 1 file on disk, 2 strippedCount', async () => {
    // 模拟"Read tool 反馈循环":第一轮用户贴图,第二轮 tool_result 又带回同一张图
    const m1 = [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: RED_DOT_PNG_B64 } }] }];
    const m2 = [{
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'toolu_1',
        content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: RED_DOT_PNG_B64 } }],
      }],
    }];
    const r1 = await stripImagesToPaths(m1, { cacheDir, promptTemplate: '{path}' });
    const r2 = await stripImagesToPaths(m2, { cacheDir, promptTemplate: '{path}' });
    expect(r1.strippedCount).toBe(1);
    expect(r2.strippedCount).toBe(1);
    // 关键:disk 上仍是 1 份,模型在两轮里看到的是同一 path
    expect(readdirSync(cacheDir)).toHaveLength(1);
    expect(r1.savedImages[0]).toBe(r2.savedImages[0]);
  });

  it('different base64 → different files (no false dedup)', async () => {
    // 真实测试中需要 2 段不同 base64。RED_DOT_PNG_B64 是 1x1 红色 PNG,反向 aRGB
    // 加 1 字节让它不同。
    const variant = RED_DOT_PNG_B64.slice(0, -4) + 'AAAA';
    const messages = [
      { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: RED_DOT_PNG_B64 } }] },
      { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: variant } }] },
    ];
    const result = await stripImagesToPaths(messages, { cacheDir, promptTemplate: '{path}' });
    expect(result.strippedCount).toBe(2);
    expect(readdirSync(cacheDir)).toHaveLength(2);  // 不同的图不应被合并
    expect(result.savedImages[0]).not.toBe(result.savedImages[1]);
  });

  it('does not rewrite file when same data appears again (mtime unchanged)', async () => {
    const messages = [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: RED_DOT_PNG_B64 } }] }];
    const r1 = await stripImagesToPaths(messages, { cacheDir, promptTemplate: '{path}' });
    const path = r1.savedImages[0]!;
    const mtimeBefore = statSync(path).mtimeMs;
    // 跨请求间隔需要 > mtime 精度。1ms sleep 在大多数 fs 上足够让 mtime 变化,
    // 但要观察的是"第二次没有触发 write"——Bun.write 会刷新 mtime,如果 mtime 不变
    // 就证明没写。给 50ms 缓冲确保就算 mtime 变了也只可能是 1 次新写。
    await new Promise((r) => setTimeout(r, 50));
    await stripImagesToPaths(messages, { cacheDir, promptTemplate: '{path}' });
    const mtimeAfter = statSync(path).mtimeMs;
    expect(mtimeAfter).toBe(mtimeBefore);  // existsSync 命中,没 write
  });
});
