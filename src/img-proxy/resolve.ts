import { readFileSync, existsSync } from 'fs';
import { CLAUDE_SETTINGS_PATH } from '../utils/paths';

/**
 * 读 ~/.claude/settings.json 拿 env.ANTHROPIC_BASE_URL。
 * 文件不存在 / 字段缺失 返回 null;JSON 损坏 返回 parseError。
 */
export function readCurrentUpstreamFromSettings(
  settingsPath: string = CLAUDE_SETTINGS_PATH,
): { url: string | null; parseError: Error | null } {
  if (!existsSync(settingsPath)) return { url: null, parseError: null };
  try {
    const cfg = JSON.parse(readFileSync(settingsPath, 'utf8'));
    const url = cfg?.env?.ANTHROPIC_BASE_URL;
    if (typeof url !== 'string' || url === '') return { url: null, parseError: null };
    return { url, parseError: null };
  } catch (err) {
    return { url: null, parseError: err instanceof Error ? err : new Error(String(err)) };
  }
}