import { readdirSync, existsSync, readFileSync } from 'fs';
import { join, basename } from 'path';
import { CLAUDE_PROVIDERS_DIR } from '../utils/paths';
import type { ProviderFileInfo } from './types';

/**
 * 扫描 ~/.claude/providers/*.json,alias = 文件名 stem(不用 ProviderManager 短名)。
 * 读不到 env 的文件也会列出(baseUrl 为空),由调用方决定是否跳过。
 */
export function scanProviderFiles(dir: string = CLAUDE_PROVIDERS_DIR): ProviderFileInfo[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .sort()
    .map(f => {
      const path = join(dir, f);
      const alias = basename(f, '.json');
      let baseUrl = '';
      let model = '';
      try {
        const cfg = JSON.parse(readFileSync(path, 'utf8'));
        baseUrl = cfg?.env?.ANTHROPIC_BASE_URL ?? '';
        model = cfg?.env?.ANTHROPIC_MODEL ?? '';
      } catch {
        // 损坏文件:列出但 baseUrl 为空,调用方跳过
      }
      return { alias, path, baseUrl, model };
    });
}
