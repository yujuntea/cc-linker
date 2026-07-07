import { mkdirSync } from 'fs';
import { join } from 'path';
import type { TransformResult } from './types';

export const DEFAULT_PROMPT_TEMPLATE =
  '[用户粘贴的图片已保存到本地文件: {path}]\n' +
  '当前模型为纯文本模型,请用以下方式之一查看该图片内容:\n' +
  '1. 调用 Read 工具读取该本地路径(若 Read 支持图片)\n' +
  '2. 调用你已注册的任何图片识别 MCP 工具(参数名视工具而定,常见如 image_source/image_url/image_path)\n' +
  '3. 用 Bash 调用本地图片识别 CLI(如 mmx-cli 等,具体命令与参数名以工具文档为准)';

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

async function saveImage(cacheDir: string, mediaType: string, dataB64: string): Promise<string> {
  const ext = EXT_BY_MEDIA[mediaType] ?? 'png';
  const name = `${Date.now()}-${randomSuffix()}.${ext}`;
  const path = join(cacheDir, name);
  // Bun.write 比 writeFileSync 快 1.5-2x(用优化 syscall,跳过 libuv shim)
  // 异步 + 并发让多图消息的总 wall-time 从 N×per_image 降到 max(per_image)
  await Bun.write(path, Buffer.from(dataB64, 'base64'), { mode: 0o600 });
  return path;
}

/**
 * 剥离 messages 里 inline base64 image block → 落盘 → 替换成含本地路径的 text block。
 * url-source 与非 image block 原样保留。单 block 异常时原样保留(不抛错,绝不阻塞)。
 *
 * 性能说明:
 * - mkdirSync 一次性提升到函数顶层(以前每张图都调一次,冗余)
 * - saveImage 改 async + Bun.write(取代 writeFileSync,快 1.5-2x)
 * - 多图并发落盘(Promise.all),多图消息的 wall-time 从 N×t 降到 max(t)
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

  // 顶层一次性 mkdirSync,取代之前每张图都调用
  mkdirSync(opts.cacheDir, { recursive: true });

  const out = await Promise.all(messages.map(async (msg: any) => {
    if (!msg || typeof msg !== 'object') return msg;
    const content = msg.content;
    if (!Array.isArray(content)) return msg;  // string content 原样

    const newContent = await Promise.all(content.map(async (block: any): Promise<any> => {
      if (block?.type !== 'image') return block;
      const src = block.source;
      if (!src || src.type !== 'base64' || typeof src.data !== 'string' || typeof src.media_type !== 'string') {
        return block;
      }
      try {
        const path = await saveImage(opts.cacheDir, src.media_type, src.data);
        savedImages.push(path);
        strippedCount++;
        return { type: 'text', text: template.replace('{path}', path) };
      } catch {
        return block;
      }
    }));
    return { ...msg, content: newContent };
  }));

  return { messages: out, savedImages, strippedCount };
}
