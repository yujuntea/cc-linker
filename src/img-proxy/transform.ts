import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { TransformResult } from './types';

export const DEFAULT_PROMPT_TEMPLATE =
  '[用户粘贴的图片已保存到本地: {path}] 当前模型为纯文本模型,无法直接查看图片内容。' +
  '如需识别这张图片,请调用 mcp__MiniMax__understand_image 工具,image_source 参数传上述本地路径。';

export interface StripOptions {
  cacheDir: string;
  promptTemplate: string;  // 应含 {path};若不含,回退到 DEFAULT_PROMPT_TEMPLATE
}

const EXT_BY_MEDIA: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

function randomSuffix(len = 6): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function saveImage(cacheDir: string, mediaType: string, dataB64: string): string {
  mkdirSync(cacheDir, { recursive: true });
  const ext = EXT_BY_MEDIA[mediaType] ?? 'png';
  const name = `${Date.now()}-${randomSuffix()}.${ext}`;
  const path = join(cacheDir, name);
  writeFileSync(path, Buffer.from(dataB64, 'base64'), { mode: 0o600 });
  return path;
}

/**
 * 剥离 messages 里 inline base64 image block → 落盘 → 替换成含本地路径的 text block。
 * url-source 与非 image block 原样保留。单 block 异常时原样保留(不抛错,绝不阻塞)。
 */
export async function stripImagesToPaths(
  messages: unknown[],
  opts: StripOptions,
): Promise<TransformResult> {
  const template = opts.promptTemplate.includes('{path}')
    ? opts.promptTemplate
    : DEFAULT_PROMPT_TEMPLATE;
  const savedImages: string[] = [];
  let strippedCount = 0;

  const out = messages.map((msg: any) => {
    if (!msg || typeof msg !== 'object') return msg;
    const content = msg.content;
    if (!Array.isArray(content)) return msg;  // string content 原样

    const newContent = content.map((block: any) => {
      if (block?.type !== 'image') return block;
      const src = block.source;
      if (!src || src.type !== 'base64' || typeof src.data !== 'string' || typeof src.media_type !== 'string') {
        return block;
      }
      try {
        const path = saveImage(opts.cacheDir, src.media_type, src.data);
        savedImages.push(path);
        strippedCount++;
        return { type: 'text', text: template.replace('{path}', path) };
      } catch {
        return block;
      }
    });
    return { ...msg, content: newContent };
  });

  return { messages: out, savedImages, strippedCount };
}