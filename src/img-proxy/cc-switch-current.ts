import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { Database } from 'bun:sqlite';
import { HOME, AUTO_PROVIDERS_DIR } from '../utils/paths';

export interface CcSwitchProvider {
  name: string;
  settingsFile: string;
  baseUrl: string;
}

export type CcSwitchLookupResult =
  | { status: 'ok'; provider: CcSwitchProvider }
  | { status: 'no-ccswitch' }
  | { status: 'no-current' }
  | { status: 'no-file'; name: string };

/**
 * 读 cc-switch 当前生效 claude provider。
 * 不抛错 - 失败返 no-current / no-ccswitch, 让调用方决定怎么报错。
 *
 * 查询顺序:
 *  1. ~/.cc-switch/settings.json 的 currentProviderClaude (provider id)
 *  2. fallback: cc-switch.db WHERE app_type='claude' AND is_current=1
 *  3. 用 id 查 cc-switch.db 拿 name
 *  4. ~/.cc-linker/auto-providers/<name>.json existsSync 校验
 *
 * db 打开/查询失败统一归 no-current (对用户修法一样: 开 CC Switch / 重选)。
 */
export function getCurrentCcSwitchProvider(
  ccSwitchDir: string = join(HOME, '.cc-switch'),
  autoProvidersDir: string = AUTO_PROVIDERS_DIR,
): CcSwitchLookupResult {
  if (!existsSync(ccSwitchDir)) return { status: 'no-ccswitch' };

  // 1. 读 currentProviderClaude id
  const settingsPath = join(ccSwitchDir, 'settings.json');
  let providerId: string | null = null;
  if (existsSync(settingsPath)) {
    try {
      const cfg = JSON.parse(readFileSync(settingsPath, 'utf8'));
      if (typeof cfg?.currentProviderClaude === 'string' && cfg.currentProviderClaude) {
        providerId = cfg.currentProviderClaude;
      }
    } catch { /* 损坏 -> 走 fallback */ }
  }

  const dbPath = join(ccSwitchDir, 'cc-switch.db');
  if (!existsSync(dbPath)) return { status: 'no-current' };

  // 2+3. 查 db 拿 name
  // 严格语义: settings.json 给的 id 找不到 -> no-current (用户的选择已失效,
  // 不静默 fallback 到 is_current=1, 否则可能切换到一个用户并没选的 provider)。
  // 仅当 settings.json 没给 id (缺/空) 时才 fallback is_current=1。
  let name: string | null = null;
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    if (providerId) {
      const row = db.query<{ name: string }, [string]>(
        `SELECT name FROM providers WHERE app_type = 'claude' AND id = ?`,
      ).get(providerId);
      if (!row) return { status: 'no-current' };
      name = row.name;
    } else {
      // fallback: is_current=1
      const row = db.query<{ name: string }, []>(
        `SELECT name FROM providers WHERE app_type = 'claude' AND is_current = 1 LIMIT 1`,
      ).get();
      name = row?.name ?? null;
    }
  } catch {
    return { status: 'no-current' };
  } finally {
    if (db) db.close();
  }

  if (!name) return { status: 'no-current' };

  // 4. auto-providers/<name>.json existsSync
  const filePath = join(autoProvidersDir, `${name}.json`);
  if (!existsSync(filePath)) return { status: 'no-file', name };

  // 读 baseUrl (用于组件 B 校验是否已 install)
  let baseUrl = '';
  try {
    const cfg = JSON.parse(readFileSync(filePath, 'utf8'));
    baseUrl = typeof cfg?.env?.ANTHROPIC_BASE_URL === 'string' ? cfg.env.ANTHROPIC_BASE_URL : '';
  } catch { /* 损坏 -> baseUrl 空, 组件 B 会判未装 */ }

  return { status: 'ok', provider: { name, settingsFile: filePath, baseUrl } };
}

/**
 * 按 name 查 cc-switch.db 的 settings_config (update 命令用)。
 * 返回 null 表示: 无 cc-switch / db 读失败 / name 不存在。
 */
export function getCcSwitchProviderConfigByName(
  name: string,
  ccSwitchDir: string = join(HOME, '.cc-switch'),
): { settingsConfig: { env?: Record<string, string>; [k: string]: unknown } } | null {
  const dbPath = join(ccSwitchDir, 'cc-switch.db');
  if (!existsSync(dbPath)) return null;
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const row = db.query<{ settings_config: string }, [string]>(
      `SELECT settings_config FROM providers WHERE app_type = 'claude' AND name = ? LIMIT 1`,
    ).get(name);
    if (!row) return null;
    return { settingsConfig: JSON.parse(row.settings_config) };
  } catch {
    return null;
  } finally {
    if (db) db.close();
  }
}