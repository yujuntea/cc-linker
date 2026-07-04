import { readdirSync, existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, statSync, unlinkSync } from 'fs';
import { join, basename } from 'path';
import { Database } from 'bun:sqlite';
import { CLAUDE_PROVIDERS_DIR, HOME, AUTO_PROVIDERS_DIR } from '../utils/paths';
import type { ProviderFileInfo } from './types';

const CC_SWITCH_DB = join(HOME, '.cc-switch', 'cc-switch.db');

/**
 * 扫所有可用的 provider,合并两路:
 *  1. ~/.claude/providers/*.json — manual 配置(用户手写 / img-proxy install 改写后)
 *  2. ~/.cc-switch/cc-switch.db — CC Switch 的 SQLite,首次调用时同步到 auto-providers/
 *     (cold-start 用户没有 manual 文件时,这条路径就是唯一来源)
 *
 * 两路都按"文件名 stem"作 alias。manual 优先(同名时 manual 覆盖 auto)。
 */
export function scanProviderFiles(dir: string = CLAUDE_PROVIDERS_DIR): ProviderFileInfo[] {
  if (existsSync(CC_SWITCH_DB)) {
    syncCcSwitchToAutoProviders();
  }
  const manual = scanDirectory(dir);
  const auto = scanDirectory(AUTO_PROVIDERS_DIR);
  // manual 覆盖 auto(同名 alias 时 manual 赢)
  const byAlias = new Map<string, ProviderFileInfo>();
  for (const p of auto) byAlias.set(p.alias, p);
  for (const p of manual) byAlias.set(p.alias, p);
  return Array.from(byAlias.values()).sort((a, b) => a.alias.localeCompare(b.alias));
}

/** 给 status / docs 显示 cc-switch 是否启用。 */
export function hasCcSwitch(ccSwitchDbPath: string = CC_SWITCH_DB): boolean {
  return existsSync(ccSwitchDbPath);
}

function scanDirectory(dir: string): ProviderFileInfo[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => readProviderFile(join(dir, f)))
    .filter((p): p is ProviderFileInfo => p !== null)
    .sort((a, b) => a.alias.localeCompare(b.alias));
}

// 测试 hook:导出供单测覆盖路径参数(默认用 HOME/CC_LINKER_DIR 真实路径)
export const _testHooks = {
  syncCcSwitchToAutoProviders,
  AUTO_PROVIDERS_DIR,
};

function readProviderFile(path: string): ProviderFileInfo | null {
  try {
    const cfg = JSON.parse(readFileSync(path, 'utf8'));
    return {
      alias: basename(path, '.json'),
      path,
      baseUrl: cfg?.env?.ANTHROPIC_BASE_URL ?? '',
      model: cfg?.env?.ANTHROPIC_MODEL ?? '',
    };
  } catch {
    // 损坏文件:跳过
    return null;
  }
}

/**
 * 从 CC Switch DB 同步 provider 到 auto-providers/。幂等:DB 没变就不重写。
 * 共享 ProviderManager 的目录(`~/.cc-linker/auto-providers/`),Bot 那边也能用。
 *
 * DB schema(从 ProviderManager 那里 mirror):`providers` 表有
 * `name`(显示名)、`settings_config`(JSON 字符串,含 env.ANTHROPIC_BASE_URL 等)、
 * `app_type='claude'` 过滤。
 */
export function syncCcSwitchToAutoProviders(
  ccSwitchDbPath: string = CC_SWITCH_DB,
  autoProvidersDir: string = AUTO_PROVIDERS_DIR,
): void {
  // mtime check:DB 没更新就跳过
  try {
    const dbStat = statSync(ccSwitchDbPath);
    if (existsSync(autoProvidersDir)) {
      try {
        const dirStat = statSync(autoProvidersDir);
        if (dirStat.mtimeMs >= dbStat.mtimeMs) return;
      } catch { /* dirStat 失败 → 重写 */ }
    }
  } catch { /* dbStat 失败 → 跳过整个同步 */ return; }

  let db: Database | null = null;
  try {
    db = new Database(ccSwitchDbPath, { readonly: true });
    const rows = db.query<{ name: string; settings_config: string }, []>(
      `SELECT name, settings_config FROM providers WHERE app_type = 'claude' ORDER BY sort_index ASC`,
    ).all();

    mkdirSync(autoProvidersDir, { recursive: true, mode: 0o700 });

    // First pass: compute every alias that *should* exist (handles collisions),
    // so the cleanup pass can match against DB reality even before any writes.
    const seenAliasesInDb = new Set<string>();
    const resolvedRows: Array<{ alias: string; cfg: any; rowName: string }> = [];
    for (const row of rows) {
      try {
        const cfg = JSON.parse(row.settings_config);
        let baseAlias = String(cfg.alias ?? row.name).trim() || row.name;
        let alias = baseAlias;
        let counter = 2;
        while (seenAliasesInDb.has(alias)) {
          alias = `${baseAlias}-${counter}`;
          counter++;
        }
        seenAliasesInDb.add(alias);
        resolvedRows.push({ alias, cfg, rowName: row.name });
      } catch {
        // 单条记录损坏就跳过,不影响其他
      }
    }

    // Cleanup stale entries:删除 auto-providers 中已不在当前 DB 里的 alias。
    // 之前 existsSync(filePath) continue 会保留旧文件 → 用户从 CC Switch 删 provider 后
    // auto-providers 残留 stale 条目,这次顺手清掉。
    if (existsSync(autoProvidersDir)) {
      for (const file of readdirSync(autoProvidersDir)) {
        if (!file.endsWith('.json')) continue;
        const alias = basename(file, '.json');
        if (!seenAliasesInDb.has(alias)) {
          try { unlinkSync(join(autoProvidersDir, file)); } catch { /* ignore */ }
        }
      }
    }

    // Second pass: write/refresh current entries (skip if already up to date).
    for (const { alias, cfg, rowName } of resolvedRows) {
      const filePath = join(autoProvidersDir, `${alias}.json`);
      if (existsSync(filePath)) continue;  // 已存在就不覆盖
      const tmpPath = filePath + '.tmp';
      writeFileSync(
        tmpPath,
        JSON.stringify({ ...cfg, name: rowName, alias }, null, 2),
        { mode: 0o600 },
      );
      renameSync(tmpPath, filePath);
    }
  } catch {
    // DB 损坏 / 锁定 / 不可读 → 静默忽略,manual 路径仍可用
  } finally {
    if (db) db.close();
  }
}