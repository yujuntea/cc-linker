import { join } from 'path';
import { existsSync, mkdirSync, readdirSync, unlinkSync, statSync, chmodSync } from 'fs';
import { IMAGES_DIR } from '../utils/paths';
import { config } from '../utils/config';
import { logger } from '../utils/logger';

const IMAGE_EXTENSION = '.png';

export function extractImageKey(content: string): string | null {
  try {
    const parsed = JSON.parse(content);
    return parsed.image_key ?? null;
  } catch {
    return null;
  }
}

export async function downloadMessageImage(
  client: any,
  messageId: string,
  imageKey: string,
): Promise<string> {
  if (!existsSync(IMAGES_DIR)) {
    mkdirSync(IMAGES_DIR, { recursive: true, mode: 0o700 });
  }

  const localPath = join(IMAGES_DIR, `${messageId}_${imageKey}${IMAGE_EXTENSION}`);

  let response: any;
  try {
    const apiPromise = client.im.v1.messageResource.get({
      params: { type: 'image' },
      path: { message_id: messageId, file_key: imageKey },
    });
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('API timeout after 15s')), 15000);
    });
    response = await Promise.race([apiPromise, timeoutPromise]);
  } catch (err: any) {
    const resp = err?.response;
    const respStatus = resp?.status;

    // SDK uses responseType: "stream", so err.response.data is a ReadableStream.
    let errorBody = '';
    try {
      const stream = resp?.data;
      if (stream && typeof stream === 'object') {
        const chunks: Buffer[] = [];
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        await new Promise<void>((resolve, reject) => {
          stream.on('end', resolve);
          stream.on('error', reject);
        });
        errorBody = Buffer.concat(chunks).toString('utf-8');
      }
    } catch (streamErr: any) {
      errorBody = `[Failed to read stream: ${streamErr.message}]`;
    }

    let errorJson = null;
    try {
      errorJson = JSON.parse(errorBody);
    } catch {
      // Not JSON
    }

    const errorCode = errorJson?.code ?? 'N/A';
    const errorMsg = errorJson?.msg ?? (errorBody.slice(0, 500) || 'N/A');

    logger.error(
      `图片下载 API 失败: ${err.message}, status=${respStatus}, errorCode=${errorCode}, errorMsg=${errorMsg}, message_id=${messageId}, file_key=${imageKey}`,
    );
    throw err;
  }

  await response.writeFile(localPath);
  chmodSync(localPath, 0o600);

  const maxSize = config.get<number>('images.max_size_bytes', 10 * 1024 * 1024);
  const stat = statSync(localPath);
  if (stat.size > maxSize) {
    unlinkSync(localPath);
    throw new Error(
      `图片大小 ${(stat.size / 1024 / 1024).toFixed(1)}MB 超过限制 ${(maxSize / 1024 / 1024).toFixed(0)}MB`,
    );
  }

  logger.info(`图片已下载: ${imageKey} → ${localPath} (${(stat.size / 1024).toFixed(1)}KB)`);
  return localPath;
}

export function buildPromptWithImages(text: string, imagePaths: string[]): string {
  if (imagePaths.length === 0) return text;

  const imageRefs = imagePaths
    .map((path, i) => `[用户发送了第${i + 1}张图片: ${path}]`)
    .join('\n');

  const instruction = '请查看以上图片文件，然后理解图片内容。';
  const body = text.trim() || '请描述这张图片的内容。';

  return `${imageRefs}\n${instruction}\n${body}`;
}

export function cleanupOldImages(maxAgeHours?: number): void {
  const maxAge = maxAgeHours ?? config.get<number>('images.cleanup_max_age_hours', 24);
  const maxAgeMs = maxAge * 60 * 60 * 1000;

  if (!existsSync(IMAGES_DIR)) return;

  const now = Date.now();
  let cleaned = 0;

  try {
    const files = readdirSync(IMAGES_DIR);
    for (const file of files) {
      const filePath = join(IMAGES_DIR, file);
      try {
        const stat = statSync(filePath);
        if (now - stat.mtimeMs > maxAgeMs) {
          unlinkSync(filePath);
          cleaned++;
        }
      } catch {
        // Single file cleanup failure is non-fatal
      }
    }
  } catch (err) {
    logger.warn(`图片清理失败: ${err}`);
  }

  if (cleaned > 0) {
    logger.info(`已清理 ${cleaned} 个过期图片文件`);
  }
}
