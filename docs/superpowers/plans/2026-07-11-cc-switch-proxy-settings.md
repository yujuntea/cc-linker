# cc-linker-proxy cc-switch 驱动 --settings 方案 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `cc-linker-proxy` 从"设 shell env"机制改成"读 cc-switch 当前 provider + `claude --settings` 指向已替换 proxy URL 的 auto-providers 文件"，并新增 `update` 命令刷新 cc-switch 改过的配置。

**Architecture:** 三组件：A（`getCurrentCcSwitchProvider` 纯查询 cc-switch.db + 定位 auto-providers 文件）、B（`cc-switch-settings` CLI 子命令，调 A + 校验已 install + 输出 path）、C（`generateWrapperBlock` 重写为单一路径调 B）。新增 `update` 命令复用 install 的选择流程，已装 provider 调 `updateProvider` 刷新 env + routes upstream，未装走 `installProvider`。

**Tech Stack:** TypeScript (Bun), `bun:sqlite`, bash (zsh-compatible), bun:test, Commander.js。

**Spec:** `docs/superpowers/specs/2026-07-10-cc-switch-proxy-settings-design.md`

## Global Constraints

- Bun runtime only - never Node.js tools
- Bash/zsh only (wrapper target); fish 不支持
- `bun:sqlite` Database 用 `{ readonly: true }` 打开 cc-switch.db
- 所有 `$` 在 JS template literal 里写 `\$`（除 `${WRAPPER_START_MARKER}` / `${WRAPPER_END_MARKER}` 是 JS 插值）
- ASCII `->` 在 shell warn 输出（避免 locale 乱码）
- library 函数 throw 不 process.exit（除 `cc-switch-settings` / `update` 是纯 CLI 子命令，例外允许 process.exit，注释说明）
- Conventional Commits: `feat/fix/test/docs/refactor(scope): message`
- cc-switch.db 路径 `~/.cc-switch/cc-switch.db`；cc-switch settings `~/.cc-switch/settings.json`；auto-providers `~/.cc-linker/auto-providers/`
- `CcSwitchLookupResult` 是组件 A 的返回类型：`{ status: 'ok'; provider } | { status: 'no-ccswitch' } | { status: 'no-current' } | { status: 'no-file'; name }`

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/img-proxy/cc-switch-current.ts` | 查 cc-switch 当前 provider + 按 name 查配置 | 新建 |
| `src/img-proxy/provider-config.ts` | install/uninstall/update provider 文件 | 加 `updateProvider` |
| `src/cli/commands/img-proxy.ts` | CLI handlers | 加 `imgProxyCcSwitchSettings` + `imgProxyUpdate` |
| `src/index.ts` | Commander 注册 | 注册 `cc-switch-settings` + `update` 子命令 |
| `src/img-proxy/wrapper.ts` | 生成 shell wrapper | 重写 `generateWrapperBlock` |
| `tests/unit/img-proxy/cc-switch-current.test.ts` | 组件 A 单测 | 新建 |
| `tests/unit/img-proxy/provider-config.test.ts` | updateProvider 单测 | 加测试 |
| `tests/integration/img-proxy-cc-switch-settings.test.ts` | 组件 B e2e | 新建 |
| `tests/integration/img-proxy-update.test.ts` | update handler e2e | 新建 |
| `tests/unit/img-proxy/wrapper.test.ts` | wrapper 断言 | 更新 |
| `tests/integration/wrapper-bash.test.ts` | bash 集成测试 | 重写矩阵 |
| `docs/img-proxy.md` | 用户文档 | 更新 wrapper 原理 + update 命令 |
| `CHANGELOG.md` | 版本日志 | 加 0.8.1 entry |

**不动**：`src/img-proxy/routes.ts`（isProxyUrl / resolveProxyByUpstream idempotent 保留）、`tests/unit/img-proxy/routes.test.ts`、`src/img-proxy/provider-scan.ts`、`src/img-proxy/discover.ts`。

---

## Task 1: 组件 A `getCurrentCcSwitchProvider` + `getCcSwitchProviderConfigByName`（TDD）

**Files:**
- Create: `src/img-proxy/cc-switch-current.ts`
- Test: `tests/unit/img-proxy/cc-switch-current.test.ts`

**Interfaces:**
- Consumes: `AUTO_PROVIDERS_DIR` from `src/utils/paths.ts`；`bun:sqlite` Database
- Produces:
  - `CcSwitchProvider { name: string; settingsFile: string; baseUrl: string }`
  - `CcSwitchLookupResult`（union type，见 Global Constraints）
  - `getCurrentCcSwitchProvider(ccSwitchDir?: string, autoProvidersDir?: string): CcSwitchLookupResult`
  - `getCcSwitchProviderConfigByName(name: string, ccSwitchDir?: string): { settingsConfig: object } | null`

- [ ] **Step 1: Write failing tests for `getCurrentCcSwitchProvider`**

Create `tests/unit/img-proxy/cc-switch-current.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Database } from 'bun:sqlite';
import { getCurrentCcSwitchProvider, getCcSwitchProviderConfigByName } from '../../../src/img-proxy/cc-switch-current';

let tmpHome: string;
let ccSwitchDir: string;
let autoProvidersDir: string;
let dbPath: string;
let ccSwitchSettingsPath: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'ccs-current-'));
  ccSwitchDir = join(tmpHome, '.cc-switch');
  autoProvidersDir = join(tmpHome, '.cc-linker', 'auto-providers');
  dbPath = join(ccSwitchDir, 'cc-switch.db');
  ccSwitchSettingsPath = join(ccSwitchDir, 'settings.json');
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

/** 建 cc-switch.db，插入一个 provider 行。返回插入的 id。 */
function setupDb(providers: Array<{ id: string; name: string; app_type?: string; is_current?: 0 | 1; settings_config?: object }>): void {
  mkdirSync(ccSwitchDir, { recursive: true });
  const db = new Database(dbPath);
  db.run(`CREATE TABLE providers (
    id TEXT NOT NULL, app_type TEXT NOT NULL, name TEXT NOT NULL,
    settings_config TEXT NOT NULL, is_current BOOLEAN NOT NULL DEFAULT 0,
    sort_index INTEGER, PRIMARY KEY (id, app_type)
  )`);
  for (const p of providers) {
    db.run(
      `INSERT INTO providers (id, app_type, name, settings_config, is_current, sort_index) VALUES (?, ?, ?, ?, ?, ?)`,
      [p.id, p.app_type ?? 'claude', p.name, JSON.stringify(p.settings_config ?? { env: { ANTHROPIC_BASE_URL: 'https://x.com' } }), p.is_current ?? 0, 0],
    );
  }
  db.close();
}

function writeAutoProvider(name: string, baseUrl: string): void {
  mkdirSync(autoProvidersDir, { recursive: true });
  writeFileSync(
    join(autoProvidersDir, `${name}.json`),
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: baseUrl }, name, alias: name }, null, 2),
  );
}

describe('getCurrentCcSwitchProvider', () => {
  test('ok: currentProviderClaude id -> name -> auto-providers 文件 -> status ok', () => {
    setupDb([{ id: 'id-1', name: 'Byte-glm-agent', is_current: 1 }]);
    writeFileSync(ccSwitchSettingsPath, JSON.stringify({ currentProviderClaude: 'id-1' }));
    writeAutoProvider('Byte-glm-agent', 'http://127.0.0.1:8765/Byte-glm-agent');
    const result = getCurrentCcSwitchProvider(ccSwitchDir, autoProvidersDir);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.provider.name).toBe('Byte-glm-agent');
      expect(result.provider.settingsFile).toBe(join(autoProvidersDir, 'Byte-glm-agent.json'));
      expect(result.provider.baseUrl).toBe('http://127.0.0.1:8765/Byte-glm-agent');
    }
  });

  test('no-ccswitch: ~/.cc-switch/ 不存在', () => {
    const result = getCurrentCcSwitchProvider(ccSwitchDir, autoProvidersDir);
    expect(result).toEqual({ status: 'no-ccswitch' });
  });

  test('no-current: currentProviderClaude 空且无 is_current=1', () => {
    setupDb([{ id: 'id-1', name: 'X', is_current: 0 }]);
    writeFileSync(ccSwitchSettingsPath, JSON.stringify({ currentProviderClaude: '' }));
    const result = getCurrentCcSwitchProvider(ccSwitchDir, autoProvidersDir);
    expect(result).toEqual({ status: 'no-current' });
  });

  test('no-current: currentProviderClaude 空 + 无 settings.json -> fallback is_current=1 命中', () => {
    setupDb([{ id: 'id-1', name: 'X', is_current: 1 }]);
    // 无 cc-switch/settings.json
    writeAutoProvider('X', 'http://127.0.0.1:8765/X');
    const result = getCurrentCcSwitchProvider(ccSwitchDir, autoProvidersDir);
    expect(result.status).toBe('ok');
  });

  test('no-current: id 在 db 找不到', () => {
    setupDb([{ id: 'id-1', name: 'X', is_current: 1 }]);
    writeFileSync(ccSwitchSettingsPath, JSON.stringify({ currentProviderClaude: 'nonexistent-id' }));
    const result = getCurrentCcSwitchProvider(ccSwitchDir, autoProvidersDir);
    expect(result).toEqual({ status: 'no-current' });
  });

  test('no-file: auto-providers/<name>.json 不存在', () => {
    setupDb([{ id: 'id-1', name: 'Byte-glm-agent', is_current: 1 }]);
    writeFileSync(ccSwitchSettingsPath, JSON.stringify({ currentProviderClaude: 'id-1' }));
    // 不写 auto-providers 文件
    const result = getCurrentCcSwitchProvider(ccSwitchDir, autoProvidersDir);
    expect(result).toEqual({ status: 'no-file', name: 'Byte-glm-agent' });
  });

  test('no-current: db 损坏(非 sqlite 文件)统一归并', () => {
    mkdirSync(ccSwitchDir, { recursive: true });
    writeFileSync(dbPath, 'not a sqlite file');
    writeFileSync(ccSwitchSettingsPath, JSON.stringify({ currentProviderClaude: 'id-1' }));
    const result = getCurrentCcSwitchProvider(ccSwitchDir, autoProvidersDir);
    expect(result).toEqual({ status: 'no-current' });
  });

  test('name 带空格 "Kimi For Coding" -> 正确拼路径', () => {
    setupDb([{ id: 'id-1', name: 'Kimi For Coding', is_current: 1 }]);
    writeFileSync(ccSwitchSettingsPath, JSON.stringify({ currentProviderClaude: 'id-1' }));
    writeAutoProvider('Kimi For Coding', 'http://127.0.0.1:8765/Kimi For Coding');
    const result = getCurrentCcSwitchProvider(ccSwitchDir, autoProvidersDir);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.provider.settingsFile).toBe(join(autoProvidersDir, 'Kimi For Coding.json'));
    }
  });
});

describe('getCcSwitchProviderConfigByName', () => {
  test('name 存在 -> 返回 settingsConfig', () => {
    const cfg = { env: { ANTHROPIC_BASE_URL: 'https://ark.com', ANTHROPIC_AUTH_TOKEN: 'new-token' } };
    setupDb([{ id: 'id-1', name: 'Byte-glm-agent', is_current: 1, settings_config: cfg }]);
    const result = getCcSwitchProviderConfigByName('Byte-glm-agent', ccSwitchDir);
    expect(result).not.toBeNull();
    expect(result!.settingsConfig).toEqual(cfg);
  });

  test('name 不存在 -> 返回 null', () => {
    setupDb([{ id: 'id-1', name: 'X', is_current: 1 }]);
    const result = getCcSwitchProviderConfigByName('Nonexistent', ccSwitchDir);
    expect(result).toBeNull();
  });

  test('无 cc-switch -> 返回 null', () => {
    const result = getCcSwitchProviderConfigByName('X', ccSwitchDir);
    expect(result).toBeNull();
  });

  test('name 带空格 -> 正确查询', () => {
    const cfg = { env: { ANTHROPIC_BASE_URL: 'https://kimi.com' } };
    setupDb([{ id: 'id-1', name: 'Kimi For Coding', is_current: 1, settings_config: cfg }]);
    const result = getCcSwitchProviderConfigByName('Kimi For Coding', ccSwitchDir);
    expect(result).not.toBeNull();
    expect(result!.settingsConfig).toEqual(cfg);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/img-proxy/cc-switch-current.test.ts`
Expected: FAIL - `Module not found`（`cc-switch-current.ts` 还没建）

- [ ] **Step 3: Implement `cc-switch-current.ts`**

Create `src/img-proxy/cc-switch-current.ts`:

```typescript
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { Database } from 'bun:sqlite';
import { HOME, AUTO_PROVIDERS_DIR } from '../utils/paths';

const CC_SWITCH_DB = join(HOME, '.cc-switch', 'cc-switch.db');
const CC_SWITCH_SETTINGS = join(HOME, '.cc-switch', 'settings.json');

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

  // 2+3. 查 db 拿 name (优先按 id, fallback is_current=1)
  let name: string | null = null;
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    if (providerId) {
      const row = db.query<{ name: string }, [string]>(
        `SELECT name FROM providers WHERE app_type = 'claude' AND id = ?`,
      ).get(providerId);
      name = row?.name ?? null;
    }
    if (!name) {
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
): { settingsConfig: object } | null {
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/img-proxy/cc-switch-current.test.ts`
Expected: PASS - 12/12

- [ ] **Step 5: Run typecheck**

Run: `bun run typecheck`
Expected: clean

- [ ] **Step 6: Commit**

```bash
git add src/img-proxy/cc-switch-current.ts tests/unit/img-proxy/cc-switch-current.test.ts
git commit -m "feat(img-proxy): add getCurrentCcSwitchProvider + getCcSwitchProviderConfigByName"
```

---

## Task 2: `updateProvider` 函数（TDD）

**Files:**
- Modify: `src/img-proxy/provider-config.ts`（加 `updateProvider` + `UpdateOpts`，在 `uninstallProvider` 后）
- Test: `tests/unit/img-proxy/provider-config.test.ts`（加测试）

**Interfaces:**
- Consumes: `addRoute` from `./routes`；`writeFileSync` / `renameSync` from `fs`
- Produces: `updateProvider(opts: UpdateOpts): Promise<void>` + `UpdateOpts`

- [ ] **Step 1: Write failing tests for `updateProvider`**

Check existing test file path + imports first:

```bash
ls tests/unit/img-proxy/provider-config.test.ts 2>/dev/null && echo "exists" || echo "not found"
```

If `tests/unit/img-proxy/provider-config.test.ts` exists, add to it. Otherwise create it. Add this test block:

```typescript
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { updateProvider } from '../../../src/img-proxy/provider-config';
import { loadRoutes } from '../../../src/img-proxy/routes';

let tmpDir: string;
let providerPath: string;
let routesPath: string;
let bakPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'update-provider-'));
  providerPath = join(tmpDir, 'Byte-glm-agent.json');
  routesPath = join(tmpDir, 'routes.json');
  bakPath = providerPath + '.bak';
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('updateProvider', () => {
  test('刷新 token, BASE_URL 保持 proxy URL', async () => {
    // 已装状态: BASE_URL=proxy, .bak 存在
    writeFileSync(providerPath, JSON.stringify({
      env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8765/Byte-glm-agent', ANTHROPIC_AUTH_TOKEN: 'old-token' },
      name: 'Byte-glm-agent', alias: 'Byte-glm-agent',
    }));
    writeFileSync(bakPath, readFileSync(providerPath));

    const latestCfg = {
      env: { ANTHROPIC_BASE_URL: 'https://ark.cn-beijing.volces.com/api/plan', ANTHROPIC_AUTH_TOKEN: 'new-token' },
    };

    await updateProvider({
      providerPath, alias: 'Byte-glm-agent', routesPath,
      port: 8765, hostname: '127.0.0.1', latestCfg,
    });

    const updated = JSON.parse(readFileSync(providerPath, 'utf8'));
    expect(updated.env.ANTHROPIC_AUTH_TOKEN).toBe('new-token');
    // BASE_URL 保持 proxy URL (不回退上游)
    expect(updated.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8765/Byte-glm-agent');
  });

  test('cc-switch 改了上游 URL -> routes.json upstream 更新', async () => {
    writeFileSync(providerPath, JSON.stringify({
      env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8765/Byte-glm-agent' },
      name: 'Byte-glm-agent', alias: 'Byte-glm-agent',
    }));
    // routes.json 已有该 alias (installed_at 保留)
    writeFileSync(routesPath, JSON.stringify({
      version: 1,
      routes: { 'Byte-glm-agent': { alias: 'Byte-glm-agent', upstream: 'https://old-ark.com', provider_path: providerPath, original_base_url: 'https://old-ark.com', installed_at: '2026-01-01T00:00:00.000Z' } },
    }));

    const latestCfg = { env: { ANTHROPIC_BASE_URL: 'https://new-ark.com' } };

    await updateProvider({
      providerPath, alias: 'Byte-glm-agent', routesPath,
      port: 8765, hostname: '127.0.0.1', latestCfg,
    });

    const routes = loadRoutes(routesPath);
    expect(routes.routes['Byte-glm-agent']?.upstream).toBe('https://new-ark.com');
    // installed_at 保留 (addRoute 覆盖同 alias 时保留)
    expect(routes.routes['Byte-glm-agent']?.installed_at).toBe('2026-01-01T00:00:00.000Z');
  });

  test('cc-switch 新增 env 字段 -> auto-providers 文件包含新字段', async () => {
    writeFileSync(providerPath, JSON.stringify({
      env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8765/X' },
      name: 'X', alias: 'X',
    }));

    const latestCfg = { env: { ANTHROPIC_BASE_URL: 'https://x.com', ANTHROPIC_MODEL: 'glm-5.2', API_TIMEOUT_MS: '3000000' } };

    await updateProvider({
      providerPath, alias: 'X', routesPath,
      port: 8765, hostname: '127.0.0.1', latestCfg,
    });

    const updated = JSON.parse(readFileSync(providerPath, 'utf8'));
    expect(updated.env.ANTHROPIC_MODEL).toBe('glm-5.2');
    expect(updated.env.API_TIMEOUT_MS).toBe('3000000');
    expect(updated.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8765/X');
  });

  test('cc-switch 删除 env 字段 -> auto-providers 文件移除该字段', async () => {
    writeFileSync(providerPath, JSON.stringify({
      env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8765/X', STALE_FIELD: 'x' },
      name: 'X', alias: 'X',
    }));

    const latestCfg = { env: { ANTHROPIC_BASE_URL: 'https://x.com' } };  // 无 STALE_FIELD

    await updateProvider({
      providerPath, alias: 'X', routesPath,
      port: 8765, hostname: '127.0.0.1', latestCfg,
    });

    const updated = JSON.parse(readFileSync(providerPath, 'utf8'));
    expect(updated.env.STALE_FIELD).toBeUndefined();
  });

  test('.bak 不动 (保留首次 install 备份)', async () => {
    writeFileSync(providerPath, JSON.stringify({
      env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8765/X' },
      name: 'X', alias: 'X',
    }));
    const originalBak = JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://original-upstream.com' } });
    writeFileSync(bakPath, originalBak);

    const latestCfg = { env: { ANTHROPIC_BASE_URL: 'https://new-upstream.com' } };

    await updateProvider({
      providerPath, alias: 'X', routesPath,
      port: 8765, hostname: '127.0.0.1', latestCfg,
    });

    // .bak 内容不变
    expect(readFileSync(bakPath, 'utf8')).toBe(originalBak);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/img-proxy/provider-config.test.ts --test-name-pattern="updateProvider"`
Expected: FAIL - `updateProvider` not exported

- [ ] **Step 3: Implement `updateProvider`**

In `src/img-proxy/provider-config.ts`, add imports if missing (`writeFileSync`, `renameSync` already imported per existing code). Add after `uninstallProvider` function (before `readUpstreamFromBak`):

```typescript
export interface UpdateOpts {
  providerPath: string;
  alias: string;
  routesPath: string;
  port: number;
  hostname: string;
  latestCfg: { env?: Record<string, string>; [k: string]: unknown };
}

/** 刷新已装 provider 的配置 (cc-switch 改了 token/model/新增字段后)。
 *  - env 整体替换为 cc-switch 最新值, 但 BASE_URL 保持 proxy URL (不回退上游)
 *  - routes.json 的 upstream 更新为 cc-switch 最新 BASE_URL (真实上游)
 *  - 不动 .bak (保留首次 install 的原始备份)
 *
 *  env 整体替换语义: 新增字段自动包含, 删除字段自动移除, 不用逐字段 diff。 */
export async function updateProvider(opts: UpdateOpts): Promise<void> {
  const { providerPath, alias, routesPath, port, hostname, latestCfg } = opts;
  const proxyUrl = `http://${hostname}:${port}/${alias}`;
  const newEnv = { ...(latestCfg.env ?? {}), ANTHROPIC_BASE_URL: proxyUrl };
  const newCfg = { ...latestCfg, env: newEnv, name: alias, alias };
  const tmp = providerPath + '.tmp';
  writeFileSync(tmp, JSON.stringify(newCfg, null, 2), { mode: 0o600 });
  renameSync(tmp, providerPath);

  const newUpstream = latestCfg.env?.ANTHROPIC_BASE_URL;
  if (typeof newUpstream === 'string' && newUpstream) {
    await addRoute(routesPath, alias, newUpstream, providerPath);  // addRoute 覆盖同 alias, 保留 installed_at
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/img-proxy/provider-config.test.ts --test-name-pattern="updateProvider"`
Expected: PASS - 5/5

- [ ] **Step 5: Run typecheck**

Run: `bun run typecheck`
Expected: clean

- [ ] **Step 6: Commit**

```bash
git add src/img-proxy/provider-config.ts tests/unit/img-proxy/provider-config.test.ts
git commit -m "feat(img-proxy): add updateProvider to refresh cc-switch config"
```

---

## Task 3: 组件 B `cc-switch-settings` CLI 子命令（实现 + e2e）

> **测试策略**：handler 调 `getCurrentCcSwitchProvider()`（无参数，用 HOME 常量），无法用 `mock.module` 单测（会污染其他测试文件，见 `tests/unit/feishu/activity.test.ts:7-8` 警告；HOME 是模块加载常量，env 注入无效）。按项目已有模式（`img-proxy-launchd-prompt.test.ts` 注释 + `cli-commands.test.ts` 的 `execSync('bun run src/index.ts ...')` + tmpDir env），handler 用 **e2e 子进程隔离测试**。

**Files:**
- Modify: `src/cli/commands/img-proxy.ts`（加 `imgProxyCcSwitchSettings` handler + import）
- Modify: `src/index.ts`（注册 `cc-switch-settings` 子命令）
- Test: `tests/integration/img-proxy-cc-switch-settings.test.ts`（新建，e2e）

**Interfaces:**
- Consumes: `getCurrentCcSwitchProvider` from Task 1；`isProxyUrl` from `src/img-proxy/routes`
- Produces: `imgProxyCcSwitchSettings(): Promise<void>` (stdout=path 成功 / exit 2 失败)

- [ ] **Step 1: Implement handler in `src/cli/commands/img-proxy.ts`**

Add import at top. Find the existing routes import line:
```typescript
import { loadRoutes, removeRoute, resolveProxyByUpstream } from '../../img-proxy/routes';
```
Change to:
```typescript
import { loadRoutes, removeRoute, resolveProxyByUpstream, isProxyUrl } from '../../img-proxy/routes';
```

Add new import (place after the `provider-config` import line `import { installProvider, uninstallProvider, isProviderInstalled } from '../../img-proxy/provider-config';`):
```typescript
import { getCurrentCcSwitchProvider } from '../../img-proxy/cc-switch-current';
```

Add handler (place after `imgProxyResolve` function, before `imgProxyWrapperInstall`):

```typescript
// ---------- cc-switch-settings ----------
// 给 cc-linker-proxy wrapper 调用: 输出当前 cc-switch provider 对应的 auto-providers 文件路径。
// 成功 stdout=path exit 0; 失败 stdout 空 + stderr 提示 + exit 2。
//
// process.exit 例外说明: 这是纯 CLI 子命令 (wrapper 通过 subprocess 调), 无 library caller 场景,
// 与 imgProxyCurrentUrl/imgProxyResolve (已 library 化) 不同。YAGNI - 不为想象的 programmatic caller 过度设计。
export async function imgProxyCcSwitchSettings(): Promise<void> {
  const result = getCurrentCcSwitchProvider();
  switch (result.status) {
    case 'ok': {
      if (!isProxyUrl(result.provider.baseUrl)) {
        console.error(`cc-linker-proxy: 当前 provider "${result.provider.name}" 未装代理`);
        console.error(`  hint: cc-linker img-proxy install --providers ${result.provider.name}`);
        process.exit(2);
      }
      console.log(result.provider.settingsFile);
      return;
    }
    case 'no-ccswitch':
      console.error('cc-linker-proxy: 未检测到 CC Switch');
      console.error('  hint: 装 CC Switch 并选一个 provider, 或用 claude --settings <provider文件>');
      process.exit(2);
    case 'no-current':
      console.error('cc-linker-proxy: CC Switch 未选中 claude provider');
      console.error('  hint: 在 CC Switch 里选一个 provider');
      process.exit(2);
    case 'no-file':
      console.error(`cc-linker-proxy: 当前 provider "${result.name}" 未同步`);
      console.error('  hint: cc-linker img-proxy install');
      process.exit(2);
  }
}
```

- [ ] **Step 2: Register subcommand in `src/index.ts`**

Add `imgProxyCcSwitchSettings` to the import from `./cli/commands/img-proxy` (find the existing multi-line import block starting `imgProxyInstall, imgProxyUninstall,`). Add after `imgProxyResolve,`:

```typescript
  imgProxyCcSwitchSettings,
```

Register after the `resolve` command registration (find `imgProxyCmd.command('resolve <upstream>')...`):

```typescript
imgProxyCmd.command('cc-switch-settings').description('输出当前 cc-switch provider 的代理 settings 文件路径 (给 cc-linker-proxy wrapper 用)').action(() => imgProxyCcSwitchSettings());
```

- [ ] **Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: clean

- [ ] **Step 4: Write e2e test**

Create `tests/integration/img-proxy-cc-switch-settings.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import { Database } from 'bun:sqlite';

// e2e: 子进程跑 `bun run src/index.ts img-proxy cc-switch-settings`,
// env 注入 HOME/CC_LINKER_DIR 到 tmpDir (子进程加载 paths.ts 前注入, 绕过模块常量固化)。
// 不用 mock.module (会污染其他测试文件 - 见 activity.test.ts 警告)。

let tmpHome: string;
let ccSwitchDir: string;
let ccLinkerDir: string;
let autoProvidersDir: string;
let dbPath: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'ccs-e2e-'));
  ccSwitchDir = join(tmpHome, '.cc-switch');
  ccLinkerDir = join(tmpHome, '.cc-linker');
  autoProvidersDir = join(ccLinkerDir, 'auto-providers');
  dbPath = join(ccSwitchDir, 'cc-switch.db');
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

function setupDb(providers: Array<{ id: string; name: string; is_current?: 0 | 1; settings_config?: object }>): void {
  mkdirSync(ccSwitchDir, { recursive: true });
  const db = new Database(dbPath);
  db.run(`CREATE TABLE providers (
    id TEXT NOT NULL, app_type TEXT NOT NULL, name TEXT NOT NULL,
    settings_config TEXT NOT NULL, is_current BOOLEAN NOT NULL DEFAULT 0,
    sort_index INTEGER, PRIMARY KEY (id, app_type)
  )`);
  for (const p of providers) {
    db.run(
      `INSERT INTO providers (id, app_type, name, settings_config, is_current, sort_index) VALUES (?, ?, ?, ?, ?, ?)`,
      [p.id, 'claude', p.name, JSON.stringify(p.settings_config ?? { env: { ANTHROPIC_BASE_URL: 'https://x.com' } }), p.is_current ?? 0, 0],
    );
  }
  db.close();
}

function writeCcSwitchSettings(currentProviderClaude: string): void {
  writeFileSync(join(ccSwitchDir, 'settings.json'), JSON.stringify({ currentProviderClaude }));
}

function writeAutoProvider(name: string, baseUrl: string): void {
  mkdirSync(autoProvidersDir, { recursive: true });
  writeFileSync(
    join(autoProvidersDir, `${name}.json`),
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: baseUrl }, name, alias: name }, null, 2),
  );
}

function runCli(): { stdout: string; stderr: string; exitCode: number } {
  let result: { stdout: string; stderr: string; exitCode: number };
  try {
    const out = execSync('bun run src/index.ts img-proxy cc-switch-settings', {
      cwd: '/Users/wuyujun/Git/cc-linker',
      env: { ...process.env, HOME: tmpHome, CC_LINKER_DIR: ccLinkerDir },
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    result = { stdout: out.trim(), stderr: '', exitCode: 0 };
  } catch (err: any) {
    result = {
      stdout: (err.stdout ?? '').trim(),
      stderr: (err.stderr ?? '').trim(),
      exitCode: err.status ?? -1,
    };
  }
  return result;
}

describe('img-proxy cc-switch-settings (e2e)', () => {
  test('ok + proxy URL -> stdout=path, exit 0', () => {
    setupDb([{ id: 'id-1', name: 'Byte-glm-agent', is_current: 1 }]);
    writeCcSwitchSettings('id-1');
    writeAutoProvider('Byte-glm-agent', 'http://127.0.0.1:8765/Byte-glm-agent');
    const { stdout, stderr, exitCode } = runCli();
    expect(exitCode).toBe(0);
    expect(stdout).toBe(join(autoProvidersDir, 'Byte-glm-agent.json'));
    expect(stderr).toBe('');
  });

  test('ok + 上游 URL (没 install) -> stderr 含 "未装代理", exit 2', () => {
    setupDb([{ id: 'id-1', name: 'Byte-glm-agent', is_current: 1 }]);
    writeCcSwitchSettings('id-1');
    writeAutoProvider('Byte-glm-agent', 'https://ark.cn-beijing.volces.com/api/plan');
    const { stdout, stderr, exitCode } = runCli();
    expect(exitCode).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toContain('未装代理');
    expect(stderr).toContain('install');
  });

  test('no-ccswitch -> stderr 含 "未检测到 CC Switch", exit 2', () => {
    // 不建 cc-switch 目录
    const { stderr, exitCode } = runCli();
    expect(exitCode).toBe(2);
    expect(stderr).toContain('未检测到 CC Switch');
  });

  test('no-current -> stderr 含 "未选中", exit 2', () => {
    setupDb([{ id: 'id-1', name: 'X', is_current: 0 }]);
    writeCcSwitchSettings('');
    const { stderr, exitCode } = runCli();
    expect(exitCode).toBe(2);
    expect(stderr).toContain('未选中');
  });

  test('no-file -> stderr 含 "未同步", exit 2', () => {
    setupDb([{ id: 'id-1', name: 'Byte-glm-agent', is_current: 1 }]);
    writeCcSwitchSettings('id-1');
    // 不写 auto-providers 文件
    const { stderr, exitCode } = runCli();
    expect(exitCode).toBe(2);
    expect(stderr).toContain('未同步');
    expect(stderr).toContain('Byte-glm-agent');
  });
});
```

- [ ] **Step 5: Run e2e test**

Run: `bun test tests/integration/img-proxy-cc-switch-settings.test.ts`
Expected: PASS - 5/5

- [ ] **Step 6: Run full suite to verify no mock pollution**

Run: `bun test`
Expected: PASS - all tests (no mock.module, so no cross-file pollution)

- [ ] **Step 7: Commit**

```bash
git add src/cli/commands/img-proxy.ts src/index.ts tests/integration/img-proxy-cc-switch-settings.test.ts
git commit -m "feat(img-proxy): add cc-switch-settings subcommand for wrapper"
```

---

## Task 4: `update` CLI 命令（实现 + e2e）

> **测试策略**：同 Task 3，handler 调 `discoverCandidates`/`installProvider`/`isProviderInstalled`/`updateProvider`/`getCcSwitchProviderConfigByName`/`syncCcSwitchToAutoProviders`，无法用 `mock.module` 单测（污染 + HOME 常量固化）。用 e2e 子进程隔离 + 真实 tmpDir 构造假 cc-switch.db + auto-providers 文件，测 `--all --yes --mode dumb` 路径（绕过 inquirer）。

**Files:**
- Modify: `src/cli/commands/img-proxy.ts`（加 `imgProxyUpdate` handler）
- Modify: `src/index.ts`（注册 `update` 子命令）
- Test: `tests/integration/img-proxy-update.test.ts`（新建，e2e）

**Interfaces:**
- Consumes: `discoverCandidates` from `../../img-proxy/discover`；`installProvider` / `isProviderInstalled` / `updateProvider` from `../../img-proxy/provider-config`；`getCcSwitchProviderConfigByName` from Task 1；`syncCcSwitchToAutoProviders` / `hasCcSwitch` from `../../img-proxy/provider-scan`；`buildChoiceLabel` / `Candidate`（现有）
- Produces: `imgProxyUpdate(opts): Promise<{ updatedCount, installedCount, failedCount }>`

- [ ] **Step 1: Implement `imgProxyUpdate` handler in `src/cli/commands/img-proxy.ts`**

Add imports at top (place after the `provider-config` import and the `cc-switch-current` import added in Task 3):

```typescript
import { updateProvider } from '../../img-proxy/provider-config';
import { getCcSwitchProviderConfigByName } from '../../img-proxy/cc-switch-current';
import { syncCcSwitchToAutoProviders } from '../../img-proxy/provider-scan';
```

注意：`installProvider` / `isProviderInstalled` 已在现有 import 行（`import { installProvider, uninstallProvider, isProviderInstalled } from '../../img-proxy/provider-config';`），需把它改成同时 import `updateProvider`：
```typescript
import { installProvider, uninstallProvider, isProviderInstalled, updateProvider } from '../../img-proxy/provider-config';
```
（不要留两行重复 import `provider-config`）

Add handler (place after `imgProxyInstall` function, before `imgProxyUninstall`):

```typescript
// ---------- update ----------
// 刷新已装 provider 的 cc-switch 最新配置 (token/model/新增字段)。
// 选择流程跟 install 一致; 区别: 已装的调 updateProvider 刷新, 未装的走 installProvider。
// manual provider 已装 -> 跳过 (直接改文件); 未装 -> install。
export async function imgProxyUpdate(opts: {
  providers?: string;
  all?: boolean;
  yes?: boolean;
  mode?: 'smart' | 'dumb';
}): Promise<{ updatedCount: number; installedCount: number; failedCount: number }> {
  const port = config.get<number>('img_proxy.port', 8765);
  const hostname = config.get<string>('img_proxy.hostname', '127.0.0.1');
  const smartModeConfig = config.get<boolean>('img_proxy.smart_mode', true);
  const extraPatterns = {
    visionPatterns: config.get<string[]>('img_proxy.vision_model_patterns_extra', []),
    textOnlyPatterns: config.get<string[]>('img_proxy.text_only_model_patterns_extra', []),
  };

  const isExplicit = !!opts.providers || !!opts.all;
  const mode = opts.mode ?? (isExplicit ? 'dumb' : 'smart');
  const useClassification = mode === 'smart' && smartModeConfig;

  syncCcSwitchToAutoProviders();

  const candidates = discoverCandidates({
    manualDir: CLAUDE_PROVIDERS_DIR,
    autoDir: AUTO_PROVIDERS_DIR,
    extraPatterns,
  });

  if (candidates.length === 0) {
    console.log(chalk.red('❌ 未找到任何可用的 provider 配置'));
    throw new CCLinkerError('E_IMG_PROXY_NO_PROVIDERS', '未找到任何可用的 provider 配置');
  }

  const filtered = useClassification
    ? candidates.filter(c => c.kind !== 'multimodal')
    : candidates;

  if (useClassification) {
    const skippedMultimodal = candidates.length - filtered.length;
    if (skippedMultimodal > 0) {
      console.log(chalk.gray(`  ℹ  Smart 模式:跳过 ${skippedMultimodal} 个 multimodal provider\n`));
    }
  }

  const choices = filtered.map(c => ({
    name: buildChoiceLabel(c),
    value: c.alias,
    short: c.alias,
    checked: c.kind !== 'multimodal',
  }));

  let targets: Candidate[];
  if (opts.providers) {
    const wanted = new Set(opts.providers.split(',').map(s => s.trim()).filter(Boolean));
    targets = candidates.filter(c => wanted.has(c.alias));
    if (targets.length === 0) {
      throw new CCLinkerError('E_IMG_PROXY_UNKNOWN_ALIAS', `未找到 provider 文件 ${opts.providers}`);
    }
  } else if (opts.all || opts.yes) {
    targets = filtered;
  } else {
    const { picks } = await inquirer.prompt([{
      type: 'checkbox', name: 'picks',
      message: '选择要刷新/安装的 provider (空格勾选,回车确认):',
      choices, pageSize: 20,
    }]);
    if (picks.length === 0) {
      console.log(chalk.gray('未选择'));
      return { updatedCount: 0, installedCount: 0, failedCount: 0 };
    }
    const pickedSet = new Set(picks as string[]);
    targets = filtered.filter(c => pickedSet.has(c.alias));
  }

  console.log(chalk.blue(`\n刷新/安装 ${targets.length} 个 provider...\n`));
  let updated = 0, installed = 0, failed = 0;
  for (const t of targets) {
    const isInstalled = isProviderInstalled(t.path, port, hostname);
    if (isInstalled && t.source === 'manual') {
      // manual provider 已装 -> 直接改文件, 不走 cc-switch 刷新
      console.log(chalk.gray(`  ⊘ ${t.alias}  manual provider, 直接改文件即可`));
      continue;
    }
    if (isInstalled) {
      // auto provider 已装 -> 从 cc-switch 拉最新配置 -> updateProvider 刷新
      const latest = getCcSwitchProviderConfigByName(t.alias);
      if (!latest) {
        console.log(chalk.yellow(`  ⚠ ${t.alias}  已从 cc-switch 删除, 建议 cc-linker img-proxy uninstall --providers ${t.alias}`));
        continue;
      }
      try {
        await updateProvider({
          providerPath: t.path, alias: t.alias, routesPath: IMG_PROXY_ROUTES_PATH,
          port, hostname, latestCfg: latest.settingsConfig as any,
        });
        console.log(chalk.green(`  ↻ ${t.alias}  已刷新`));
        updated++;
      } catch (err) {
        console.log(chalk.red(`  ❌ ${t.alias}  ${err}`));
        failed++;
      }
    } else {
      // 未装 -> installProvider (跟 install 一样)
      try {
        await installProvider({ providerPath: t.path, alias: t.alias, routesPath: IMG_PROXY_ROUTES_PATH, port, hostname });
        console.log(chalk.green(`  ✅ ${t.alias}  新装`));
        installed++;
      } catch (err) {
        console.log(chalk.red(`  ❌ ${t.alias}  ${err}`));
        failed++;
      }
    }
  }

  console.log(chalk.green(`\n完成: ${updated} 刷新, ${installed} 新装${failed > 0 ? `, ${failed} 失败` : ''}。`));
  return { updatedCount: updated, installedCount: installed, failedCount: failed };
}
```

- [ ] **Step 2: Register subcommand in `src/index.ts`**

Add `imgProxyUpdate` to the import from `./cli/commands/img-proxy`. Register after `uninstall` command:

```typescript
imgProxyCmd.command('update')
  .description('刷新已装 provider 的 cc-switch 最新配置 (token/model/新增字段); 未装的会新装')
  .option('-p, --providers <aliases>', '逗号分隔的 provider 文件名 stem')
  .option('--all', '全部 provider')
  .option('--yes', 'smart 默认预选,不交互')
  .addOption(
    new Option('--mode <mode>', 'smart 或 dumb').choices(['smart', 'dumb'] as const),
  )
  .action((opts) => { imgProxyUpdate(opts); });
```

- [ ] **Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: clean

- [ ] **Step 4: Write e2e test**

Create `tests/integration/img-proxy-update.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import { Database } from 'bun:sqlite';

// e2e: 子进程跑 `bun run src/index.ts img-proxy update --all --yes --mode dumb`,
// env 注入 HOME/CC_LINKER_DIR 到 tmpDir。构造假 cc-switch.db + auto-providers 文件。
// --all --yes --mode dumb 绕过 inquirer (见 imgProxyInstall 的 targets 选择逻辑)。

let tmpHome: string;
let ccSwitchDir: string;
let ccLinkerDir: string;
let autoProvidersDir: string;
let routesPath: string;
let dbPath: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'update-e2e-'));
  ccSwitchDir = join(tmpHome, '.cc-switch');
  ccLinkerDir = join(tmpHome, '.cc-linker');
  autoProvidersDir = join(ccLinkerDir, 'auto-providers');
  routesPath = join(ccLinkerDir, 'img-proxy', 'routes.json');
  dbPath = join(ccSwitchDir, 'cc-switch.db');
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

function setupDb(providers: Array<{ id: string; name: string; settings_config: object }>): void {
  mkdirSync(ccSwitchDir, { recursive: true });
  const db = new Database(dbPath);
  db.run(`CREATE TABLE providers (
    id TEXT NOT NULL, app_type TEXT NOT NULL, name TEXT NOT NULL,
    settings_config TEXT NOT NULL, is_current BOOLEAN NOT NULL DEFAULT 0,
    sort_index INTEGER, PRIMARY KEY (id, app_type)
  )`);
  providers.forEach((p, i) => {
    db.run(
      `INSERT INTO providers (id, app_type, name, settings_config, is_current, sort_index) VALUES (?, ?, ?, ?, ?, ?)`,
      [p.id, 'claude', p.name, JSON.stringify(p.settings_config), 0, i],
    );
  });
  db.close();
}

/** 写 auto-providers 文件。baseUrl='proxy' 表示已装, 'upstream' 表示未装。 */
function writeAutoProvider(name: string, baseUrl: string): void {
  mkdirSync(autoProvidersDir, { recursive: true });
  writeFileSync(
    join(autoProvidersDir, `${name}.json`),
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: baseUrl }, name, alias: name }, null, 2),
  );
}

function runUpdate(): { stdout: string; exitCode: number } {
  try {
    const out = execSync('bun run src/index.ts img-proxy update --all --yes --mode dumb', {
      cwd: '/Users/wuyujun/Git/cc-linker',
      env: { ...process.env, HOME: tmpHome, CC_LINKER_DIR: ccLinkerDir },
      encoding: 'utf-8',
    });
    return { stdout: out, exitCode: 0 };
  } catch (err: any) {
    return { stdout: err.stdout ?? '', exitCode: err.status ?? -1 };
  }
}

describe('img-proxy update (e2e)', () => {
  test('未装 auto provider + cc-switch 有配置 -> 新装 (BASE_URL 改成 proxy)', () => {
    setupDb([{ id: 'id-1', name: 'X', settings_config: { env: { ANTHROPIC_BASE_URL: 'https://x.com' } } }]);
    writeAutoProvider('X', 'https://x.com');  // 未装 (上游 URL)

    const { stdout, exitCode } = runUpdate();
    expect(exitCode).toBe(0);
    expect(stdout).toContain('新装');

    // 验证 auto-providers 文件 BASE_URL 改成 proxy
    const updated = JSON.parse(readFileSync(join(autoProvidersDir, 'X.json'), 'utf8'));
    expect(updated.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8765/X');
  });

  test('已装 auto provider + cc-switch 改了 token -> 刷新 token, BASE_URL 保持 proxy', () => {
    setupDb([{ id: 'id-1', name: 'X', settings_config: { env: { ANTHROPIC_BASE_URL: 'https://x.com', ANTHROPIC_AUTH_TOKEN: 'new-token' } } }]);
    writeAutoProvider('X', 'http://127.0.0.1:8765/X');  // 已装 (proxy URL)
    // 备份 .bak (install 时会建, 这里手动建模拟)
    writeFileSync(join(autoProvidersDir, 'X.json.bak'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://x.com' } }));

    const { stdout, exitCode } = runUpdate();
    expect(exitCode).toBe(0);
    expect(stdout).toContain('已刷新');

    const updated = JSON.parse(readFileSync(join(autoProvidersDir, 'X.json'), 'utf8'));
    expect(updated.env.ANTHROPIC_AUTH_TOKEN).toBe('new-token');
    expect(updated.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8765/X');
  });

  test('已装 auto provider + cc-switch 已删 -> 提示 uninstall, 不改文件', () => {
    // cc-switch db 无 X, 但 auto-providers 有 X (已装)
    setupDb([]);  // 空 db
    writeAutoProvider('X', 'http://127.0.0.1:8765/X');

    const { stdout, exitCode } = runUpdate();
    expect(exitCode).toBe(0);
    expect(stdout).toContain('uninstall');

    // 文件不变
    const unchanged = JSON.parse(readFileSync(join(autoProvidersDir, 'X.json'), 'utf8'));
    expect(unchanged.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8765/X');
  });
});
```

- [ ] **Step 5: Run e2e test**

Run: `bun test tests/integration/img-proxy-update.test.ts`
Expected: PASS - 3/3

- [ ] **Step 6: Run full suite to verify no mock pollution**

Run: `bun test`
Expected: PASS - all tests

- [ ] **Step 7: Commit**

```bash
git add src/cli/commands/img-proxy.ts src/index.ts tests/integration/img-proxy-update.test.ts
git commit -m "feat(img-proxy): add update command to refresh cc-switch config"
```

---

## Task 5: 重写 `generateWrapperBlock`（TDD）

**Files:**
- Modify: `src/img-proxy/wrapper.ts:22-48`（重写 `generateWrapperBlock`）
- Test: `tests/unit/img-proxy/wrapper.test.ts:29-52`（更新断言）

**Interfaces:**
- Consumes: `WRAPPER_START_MARKER` / `WRAPPER_END_MARKER`（现有）
- Produces: 重写后的 `generateWrapperBlock(): string`（单一路径调 `cc-switch-settings`）

- [ ] **Step 1: Update unit test assertions**

In `tests/unit/img-proxy/wrapper.test.ts`, replace the `describe('generateWrapperBlock')` block tests (lines ~29-52). Replace the 4 tests inside with:

```typescript
describe('generateWrapperBlock', () => {
  test('包含 start + end markers', () => {
    const block = generateWrapperBlock();
    expect(block).toContain(WRAPPER_START_MARKER);
    expect(block).toContain(WRAPPER_END_MARKER);
  });

  test('包含 cc-linker-proxy 函数定义', () => {
    const block = generateWrapperBlock();
    expect(block).toContain('cc-linker-proxy()');
  });

  test('调 cc-linker img-proxy cc-switch-settings 子命令', () => {
    const block = generateWrapperBlock();
    expect(block).toContain('cc-linker img-proxy cc-switch-settings');
  });

  test('用 claude --settings 指定 provider 文件', () => {
    const block = generateWrapperBlock();
    expect(block).toContain('--settings');
    expect(block).toContain('command claude');
  });

  test('失败时重跑子命令透传 stderr + return 1', () => {
    const block = generateWrapperBlock();
    expect(block).toContain('>/dev/null');
    expect(block).toContain('return 1');
  });

  test('不再读 ANTHROPIC_BASE_URL (删旧 4-branch 死代码)', () => {
    const block = generateWrapperBlock();
    expect(block).not.toContain('ANTHROPIC_BASE_URL');
  });

  test('不再调 current-url / resolve (旧路径)', () => {
    const block = generateWrapperBlock();
    expect(block).not.toContain('current-url');
    expect(block).not.toContain('img-proxy resolve');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/img-proxy/wrapper.test.ts --test-name-pattern="generateWrapperBlock"`
Expected: FAIL - 旧 wrapper 含 ANTHROPIC_BASE_URL / current-url / resolve，新断言不通过

- [ ] **Step 3: Rewrite `generateWrapperBlock`**

In `src/img-proxy/wrapper.ts`, replace the entire `generateWrapperBlock` function (lines 22-48) with:

```typescript
/**
 * 生成 wrapper 函数代码块(含 markers),可直接追加到 shell rc 文件。
 *
 * 单一路径: 调 cc-linker img-proxy cc-switch-settings 拿当前 cc-switch provider
 * 对应的 auto-providers 文件路径 (BASE_URL 已替换成 proxy URL), 用 claude --settings 指定。
 * 失败(stdout 空) -> 透传子命令 stderr 提示 + return 1。
 *
 * 不读 ANTHROPIC_BASE_URL (旧 4-branch 设 env 机制被 settings.json env 覆盖, 是死代码)。
 * 不调 current-url/resolve (旧路径)。
 */
export function generateWrapperBlock(): string {
  return `${WRAPPER_START_MARKER}
cc-linker-proxy() {
  local settings_file
  settings_file="\$(command cc-linker img-proxy cc-switch-settings 2>/dev/null)"
  if [ -n "\$settings_file" ] && [ -f "\$settings_file" ]; then
    command claude --settings "\$settings_file" "\$@"
    return \$?
  fi
  # stdout 空 -> 失败。重跑不吞 stderr, 让分类提示显示给用户
  command cc-linker img-proxy cc-switch-settings >/dev/null
  return 1
}
${WRAPPER_END_MARKER}
`;
}
```

- [ ] **Step 4: Run wrapper unit tests to verify they pass**

Run: `bun test tests/unit/img-proxy/wrapper.test.ts`
Expected: PASS - all assertions pass

- [ ] **Step 5: Run full img-proxy unit suite to verify no regression**

Run: `bun test tests/unit/img-proxy/`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/img-proxy/wrapper.ts tests/unit/img-proxy/wrapper.test.ts
git commit -m "refactor(img-proxy): rewrite wrapper to use cc-switch-settings + claude --settings"
```

---

## Task 6: 重写 wrapper bash 集成测试

**Files:**
- Modify: `tests/integration/wrapper-bash.test.ts`（重写测试矩阵）

**Interfaces:**
- Consumes: `generateWrapperBlock` from Task 5；stub `cc-linker` + stub `claude`

- [ ] **Step 1: Rewrite the integration test file**

Replace entire content of `tests/integration/wrapper-bash.test.ts` with:

```typescript
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { generateWrapperBlock } from '../../src/img-proxy/wrapper';

let tmpDir: string;
let rcFile: string;
let fakeClaudeLog: string;

// Stub `cc-linker`: 只处理 `img-proxy cc-switch-settings` 子命令
// FAKE_SETTINGS_FILE env var 非空 -> stdout 输出该路径 (成功)
// FAKE_SETTINGS_FILE 空 -> stdout 空 + stderr 提示 (失败)
const STUB_CCLINKER = `#!/bin/bash
if [ "$1 $2" = "img-proxy cc-switch-settings" ]; then
  if [ -n "$FAKE_SETTINGS_FILE" ]; then
    echo "$FAKE_SETTINGS_FILE"
  else
    echo "cc-linker-proxy: 未检测到 CC Switch" >&2
    echo "  hint: 装 CC Switch" >&2
    exit 2
  fi
fi
`;

// Stub `claude`: 捕获 --settings 参数 + 原始 args
const STUB_CLAUDE = `#!/bin/bash
{
  echo "ARGS:$@"
  echo "---"
} >> "$FAKE_CLAUDE_LOG"
`;

function runWrapper(env: Record<string, string>, fakeSettingsFile: string): { stdout: string; stderr: string; exitCode: number; claudeLog: string } {
  const result = spawnSync('bash', ['-c', `source ${rcFile} && cc-linker-proxy --version`], {
    env: {
      ...process.env,
      ...env,
      FAKE_SETTINGS_FILE: fakeSettingsFile,
      FAKE_CLAUDE_LOG: fakeClaudeLog,
      PATH: `${tmpDir}:${process.env.PATH}`,
    },
    encoding: 'utf-8',
  });
  let claudeLog = '';
  try {
    claudeLog = readFileSync(fakeClaudeLog, 'utf-8').trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? -1,
    claudeLog,
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'wrapper-int-'));
  rcFile = join(tmpDir, '.zshrc');
  fakeClaudeLog = join(tmpDir, 'claude.log');

  writeFileSync(join(tmpDir, 'cc-linker'), STUB_CCLINKER);
  chmodSync(join(tmpDir, 'cc-linker'), 0o755);
  writeFileSync(join(tmpDir, 'claude'), STUB_CLAUDE);
  chmodSync(join(tmpDir, 'claude'), 0o755);

  writeFileSync(rcFile, generateWrapperBlock());
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('cc-linker-proxy integration (cc-switch-settings 路径)', () => {
  test('成功: cc-switch-settings 返 path -> claude 收到 --settings <path> + args', () => {
    const fakeFile = join(tmpDir, 'provider.json');
    writeFileSync(fakeFile, '{}');
    const { exitCode, claudeLog } = runWrapper({}, fakeFile);
    expect(exitCode).toBe(0);
    expect(claudeLog).toContain(`--settings ${fakeFile}`);
    expect(claudeLog).toContain('--version');
  });

  test('失败: cc-switch-settings 返空 -> claude 不被调用, stderr 透传提示, exit 1', () => {
    const { exitCode, stderr, claudeLog } = runWrapper({}, '');
    expect(exitCode).toBe(1);
    expect(claudeLog).toBe('');
    expect(stderr).toContain('未检测到 CC Switch');
  });

  test('claude args 透传 (-p "reply OK")', () => {
    const fakeFile = join(tmpDir, 'provider.json');
    writeFileSync(fakeFile, '{}');
    // 改 wrapper 调用参数
    const result = spawnSync('bash', ['-c', `source ${rcFile} && cc-linker-proxy -p "reply OK"`], {
      env: { ...process.env, FAKE_SETTINGS_FILE: fakeFile, FAKE_CLAUDE_LOG: fakeClaudeLog, PATH: `${tmpDir}:${process.env.PATH}` },
      encoding: 'utf-8',
    });
    const log = readFileSync(fakeClaudeLog, 'utf-8');
    expect(log).toContain('--settings');
    expect(log).toContain('-p');
    expect(log).toContain('reply OK');
  });

  test('回归: wrapper 不读 ANTHROPIC_BASE_URL (设了也忽略, 走 cc-switch-settings)', () => {
    const fakeFile = join(tmpDir, 'provider.json');
    writeFileSync(fakeFile, '{}');
    const { exitCode, claudeLog } = runWrapper({ ANTHROPIC_BASE_URL: 'https://stale.com' }, fakeFile);
    expect(exitCode).toBe(0);
    expect(claudeLog).toContain(`--settings ${fakeFile}`);
  });
});
```

- [ ] **Step 2: Run integration tests**

Run: `bun test tests/integration/wrapper-bash.test.ts`
Expected: PASS - 4/4

- [ ] **Step 3: Run full test suite to verify no regression**

Run: `bun test tests/unit/img-proxy/ tests/integration/wrapper-bash.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add tests/integration/wrapper-bash.test.ts
git commit -m "test(img-proxy): rewrite wrapper integration tests for cc-switch-settings path"
```

---

## Task 7: 更新文档

**Files:**
- Modify: `docs/img-proxy.md`（wrapper 工作原理 + update 命令）
- Modify: `CHANGELOG.md`（0.8.1 entry）

- [ ] **Step 1: Update `docs/img-proxy.md` wrapper section**

Find the "它怎么工作" section (the 4-step diagram) + "关键行为" section. Replace the diagram and "递归防护" bullet. First read current content:

```bash
grep -n "它怎么工作\|cc-linker-proxy()\|递归防护\|cc-linker img-proxy current-url\|cc-linker img-proxy resolve" docs/img-proxy.md | head -20
```

Replace the 4-step diagram block (the `cc-linker-proxy "看这个图"` diagram) with:

```bash
$ cc-linker-proxy "看这个图"
  ↓
shell 函数 cc-linker-proxy() (在 ~/.zshrc)
  ① 调 cc-linker img-proxy cc-switch-settings  -> 读 cc-switch 当前 provider
     -> 找 ~/.cc-linker/auto-providers/<name>.json (BASE_URL 已替换成 proxy)
  ② claude --settings <该文件> "看这个图"  (claude 的 --settings 覆盖 settings.json env)
  ↓
img-proxy (127.0.0.1:8765) 剥 image block -> 上游纯文本模型
```

Replace the "递归防护(幂等)" bullet with:

```markdown
- **cc-switch 驱动**:读 cc-switch 当前 provider,用 `claude --settings` 指向已替换 proxy URL 的 auto-providers 文件。CC Switch 切换 provider 后 `cc-linker-proxy` 自动跟随(实时读,不缓存)。
- **失败明确报错**:无 CC Switch / 未选 provider / 未装代理时,stderr 提示 + exit 1,绝不静默直连上游。
```

Add a new subsection for `update` command. Find the "子命令" section. Add after the existing install/uninstall description:

```markdown
### 刷新配置 (cc-switch 改了 token/model 后)

CC Switch 里改了 provider 的 token / model / 新增 env 字段后,auto-providers 文件不会自动刷新。
跑 update 刷新:

```bash
cc-linker img-proxy update            # 交互选择
cc-linker img-proxy update --all      # 全部
cc-linker img-proxy update -p glm-5.2 # 指定
```

- 已装的 provider:刷新 env(token/model/新增字段)+ 更新 routes upstream,BASE_URL 保持 proxy URL
- 未装的 provider:新装(跟 install 一样)
- manual provider 已装:跳过(直接改文件即可)
- cc-switch 已删的 provider:提示 uninstall
```

- [ ] **Step 2: Update `CHANGELOG.md`**

Add 0.8.1 entry at top (before 0.8.0):

```markdown
## [0.8.1] - 2026-07-11

### Fixed
- `cc-linker-proxy` 不再静默绕过 img-proxy:CC Switch 用户的 `~/.claude/settings.json` env 会覆盖 shell env,旧 wrapper 设 env 的机制失效。改为读 cc-switch 当前 provider + `claude --settings` 指向已替换 proxy URL 的 auto-providers 文件,可靠走代理。

### Added
- `cc-linker img-proxy update` 命令:CC Switch 改了 provider 配置(token/model/新增字段)后刷新 auto-providers 文件 + routes upstream。已装刷新、未装新装、manual 跳过、cc-switch 已删提示 uninstall。
- `cc-linker img-proxy cc-switch-settings` 子命令:输出当前 cc-switch provider 的代理 settings 文件路径(给 wrapper 用)。

### Changed
- wrapper 函数重写:单一路径(cc-switch-settings + `claude --settings`),删除旧 4-branch(env 检测/resolve/fall-back)死代码。

### Upgrade
- 跑过 `cc-linker img-proxy install` 的用户:`cc-linker img-proxy wrapper uninstall && wrapper install && source ~/.zshrc`(或重开 shell)更新 wrapper 函数。
```

- [ ] **Step 3: Commit**

```bash
git add docs/img-proxy.md CHANGELOG.md
git commit -m "docs(img-proxy): update wrapper docs + add update command + 0.8.1 changelog"
```

---

## Self-Review

### 1. Spec coverage

| Spec requirement | Task |
|---|---|
| 组件 A `getCurrentCcSwitchProvider` + `CcSwitchLookupResult` | Task 1 |
| 组件 A `getCcSwitchProviderConfigByName` | Task 1 |
| 组件 B `cc-switch-settings` CLI 子命令 + status 分支提示 | Task 3 |
| 组件 B process.exit(2) 例外 | Task 3 (注释说明) |
| 组件 C `generateWrapperBlock` 重写单一路径 | Task 5 |
| wrapper 删除旧 4-branch 死代码 | Task 5 + Task 6 (回归测试) |
| `updateProvider` 函数(env 整体替换 + BASE_URL 保持 proxy + routes upstream + 不动 .bak) | Task 2 |
| `update` 命令(选择式 + 已装刷新/未装新装) | Task 4 |
| update manual provider 处理(已装跳过/未装 install) | Task 4 |
| update cc-switch 已删提示 uninstall | Task 4 |
| 组件 A 单测(8 场景) | Task 1 |
| getCcSwitchProviderConfigByName 单测(4 场景) | Task 1 |
| updateProvider 单测(5 场景) | Task 2 |
| 组件 B e2e(5 status 分支,子进程隔离) | Task 3 |
| update handler e2e(3 场景,子进程隔离) | Task 4 |
| wrapper 单测(7 断言) | Task 5 |
| wrapper bash 集成测试(4 场景) | Task 6 |
| docs/img-proxy.md 更新 | Task 7 |
| CHANGELOG 0.8.1 | Task 7 |

All spec requirements covered. ✓

### 2. Placeholder scan

No "TBD" / "TODO" / "implement later" / "similar to Task N". Every code step shows actual code. ✓

### 3. Type/signature consistency

- `CcSwitchLookupResult` - defined Task 1, used Task 3. Consistent (4 status variants match). ✓
- `getCurrentCcSwitchProvider(ccSwitchDir?, autoProvidersDir?)` - Task 1 defines, Task 3 calls with no args (uses defaults). ✓
- `getCcSwitchProviderConfigByName(name, ccSwitchDir?)` - Task 1 defines, Task 4 calls with `t.alias`. ✓
- `updateProvider(opts: UpdateOpts)` - Task 2 defines `UpdateOpts`, Task 4 calls with matching fields. ✓
- `imgProxyCcSwitchSettings()` - Task 3 defines, Task 5 wrapper calls via subprocess (not direct import). ✓
- `imgProxyUpdate(opts)` - Task 4 defines, index.ts registers. opts shape `{providers?, all?, yes?, mode?}` matches install. ✓
- `buildChoiceLabel` / `Candidate` / `discoverCandidates` - existing in img-proxy.ts, Task 4 reuses. ✓

### 4. Task dependency ordering

- Task 1 (组件 A) must complete before Task 3 (组件 B imports it) and Task 4 (update imports getCcSwitchProviderConfigByName)
- Task 2 (updateProvider) must complete before Task 4 (update calls it)
- Task 3 (cc-switch-settings) must complete before Task 5 (wrapper calls it via subprocess) and Task 6 (integration test stubs it)
- Task 5 (wrapper rewrite) must complete before Task 6 (integration test uses new wrapper)

Plan order enforces this. ✓

### 5. Commit hygiene

Each task ends with a single commit. Conventional Commits format. ✓

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-11-cc-switch-proxy-settings.md`. Two execution options:

1. **Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?