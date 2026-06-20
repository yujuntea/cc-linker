/**
 * WecomImageHandler — 企微图片消息下载 + 缓存
 *
 * PR 6 Task 6.1: 把 aibot-client emit 的 images 数组 (fileKey + url) 下载到本地缓存,
 *   让 handleChat 把图片作为上下文喂给 Claude。
 *
 * 设计要点:
 * - 复用 platform 层 PlatformMessage.images 数组字段 (spec §10.1 第 1 项约束)
 * - data: URL 直接解析 base64 (企微 SDK 小图内联常见)
 * - 远程 URL 用 fetch 下载 + 大小限制 (默认 10MB, 防 OOM)
 * - 按 messageId 缓存到磁盘, mode 0o600 (防 world-readable 泄露)
 * - 文件名 sanitize (只允许 [a-zA-Z0-9_-]), 防止 ../ 注入
 */
import { join } from 'path';
import { mkdirSync, writeFileSync } from 'fs';
import { logger } from '../utils/logger';

export type ImageHandlerConfig = {
  cacheDir: string;
  maxSizeBytes?: number;
};

export class WecomImageHandler {
  private readonly cacheDir: string;
  private readonly maxSizeBytes: number;

  constructor(config: ImageHandlerConfig) {
    this.cacheDir = config.cacheDir;
    this.maxSizeBytes = config.maxSizeBytes ?? 10 * 1024 * 1024;
    mkdirSync(this.cacheDir, { recursive: true, mode: 0o700 });
  }

  /**
   * 把 URL (data: 或 https://) 解析成 base64 字符串。
   * data: URL 不走 fetch — 减少 IO + 跳过 maxSizeBytes 限制 (内联图片一般很小)。
   */
  async fetchAsBase64(url: string): Promise<string> {
    if (url.startsWith('data:')) {
      const match = url.match(/^data:[^;]+;base64,(.+)$/);
      if (!match) throw new Error('Invalid data: URL');
      return match[1];
    }
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Image fetch failed: ${response.status}`);
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > this.maxSizeBytes) {
      throw new Error(`Image too large: ${buffer.byteLength} > ${this.maxSizeBytes}`);
    }
    return Buffer.from(buffer).toString('base64');
  }

  /**
   * 按 messageId 缓存 base64 到磁盘, 返回缓存文件路径。
   * 文件名 sanitize: 只允许 [a-zA-Z0-9_-], 防止 messageId 包含 ../ 路径注入。
   */
  cacheToDisk(messageId: string, base64: string): string {
    const safeId = messageId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const path = join(this.cacheDir, `${safeId}.bin`);
    writeFileSync(path, base64, { mode: 0o600 });
    logger.info(`[wecom-image] cached image: messageId=${messageId} path=${path}`);
    return path;
  }
}