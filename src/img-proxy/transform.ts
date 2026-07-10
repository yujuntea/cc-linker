import { existsSync, mkdirSync, utimesSync } from 'fs';
import { createHash } from 'crypto';
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

/** Hash data → 32-hex 文件名 stem。同 base64 永远映射到同一路径,实现 content-hash dedup。 */
function hashDataB64(dataB64: string): string {
  return createHash('sha256').update(dataB64).digest('hex').slice(0, 32);
}

async function saveImage(cacheDir: string, mediaType: string, dataB64: string): Promise<string> {
  const ext = EXT_BY_MEDIA[mediaType] ?? 'png';
  // content-hash 文件名:同一张图(同 base64)永远写到同一路径
  //  - 第二次起 existsSync 短路,跳过 write IO
  //  - 同一张图被 Read tool 反馈回 tool_result.content 时,模型拿到的 path 与原图一致,
  //    不会产生"phantom 新文件"诱导模型再 Read 一次(那种正反馈循环在 11 张图里
  //    烧出过 1483 个文件,11 张去重到 1 张,浪费率 99.5%)
  //  - 已被 dedup 的图再次被请求,刷 mtime 让 7 天 TTL 留住热图(否则 mtime
  //    永远停在第一次写入,7 天后被 cleanupOldCache 误清,模型下次看到
  //    同一图要重新触发 download + prompt cache 失效)
  const name = `${hashDataB64(dataB64)}.${ext}`;
  const path = join(cacheDir, name);
  if (existsSync(path)) {
    // 命中:不重写(IO),只 touch mtime 让 cleanupOldCache 知道这是热图
    utimesSync(path, new Date(), new Date());
  } else {
    // Bun.write 比 writeFileSync 快 1.5-2x(用优化 syscall,跳过 libuv shim)
    // 异步 + 并发让多图消息的总 wall-time 从 N×per_image 降到 max(per_image)
    await Bun.write(path, Buffer.from(dataB64, 'base64'), { mode: 0o600 });
  }
  return path;
}

/**
 * 剥离 messages 里 inline base64 image block → 落盘 → 替换成含本地路径的 text block。
 * url-source 与非 image block 原样保留。单 block 异常时原样保留(不抛错,绝不阻塞)。
 * 递归进入 tool_result.content(Read tool 读 PNG 后 Claude Code 把图塞进 tool_result
 * 嵌套 content,必须扫到,否则透传给纯文本模型 → 400)。
 *
 * 去重设计(2026-07-10 fix):
 * 文件名 = sha256(data).slice(0,32) + ext。同 base64 永远落同一文件,existsSync 命中
 * 即跳过 write。修掉两个问题:
 *  1. 磁盘:同张图被 Read 工具回环写 N 次,cache 涨到几百倍(实测 11 张图 → 1483 份)
 *  2. token:每次新文件名被模型视为"未访问过的文件",会诱使模型反复 Read 同一图,
 *     多花的 tool call + tool_result 文案 token 是真钱
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

  // 抽到命名函数:tool_result.content 嵌套 image 块要递归处理(2026-07-09 fix),
  // 命名函数比在 .map 里再嵌一层 .map + 复制 strip 逻辑更清晰。
  const processBlocks = async (blocks: any[]): Promise<any[]> => {
    return Promise.all(blocks.map(async (block: any): Promise<any> => {
      // 递归:tool_result 的 content 也是 content 数组,同样的 image block 可能藏在里面
      if (block?.type === 'tool_result' && Array.isArray(block.content)) {
        return { ...block, content: await processBlocks(block.content) };
      }
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
  };

  const out = await Promise.all(messages.map(async (msg: any) => {
    if (!msg || typeof msg !== 'object') return msg;
    const content = msg.content;
    if (!Array.isArray(content)) return msg;  // string content 原样

    const newContent = await processBlocks(content);
    return { ...msg, content: newContent };
  }));

  return { messages: out, savedImages, strippedCount };
}
