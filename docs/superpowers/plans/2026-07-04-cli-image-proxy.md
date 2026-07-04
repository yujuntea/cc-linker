# CLI Image Proxy (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让纯文本模型(如 glm-5.2)在 Claude Code CLI 里也能接受粘贴的图片——在 `ANTHROPIC_BASE_URL` 链路上插一层本地反向代理,拦截出站请求里的 inline `image` content block,落盘成本地文件,替换成"图片路径 + 引导调 MCP 识别"的 text block,再转发给真实上游。

**Architecture:** 在 cc-linker 里新增 `src/img-proxy/` 模块。一个常驻 `Bun.serve` 进程按 path 前缀(`/<文件名stem>` 如 `/byte-agent-glm`)路由到各 provider 真实上游。**alias = provider 文件名 stem(不用 ProviderManager 的短名,因它会截断/冲突——实测 `byte-agent-glm`→`byte`、`opencode-qwen3.6/3.7`→冲突)**。`cc-linker img-proxy install` 自动备份并改写 provider 的 `ANTHROPIC_BASE_URL` 为 `http://127.0.0.1:<port>/<alias>`,`uninstall` 用 `.bak` 还原 BASE_URL(保留当前 token)并删除 `.bak`。launchd 自启用 **env 注入 `CC_LINKER_IMG_PROXY_DAEMON=1`** 让 launchd 直接起 child(不双重 fork),`KeepAlive` 保证存活。**本计划是 Phase 1(核心代理 + CLI),不含 Web 控制台**;Phase 2 控制台在验收合并后另起 plan,但 `server.ts` 已把控制台路由判断前置到 alias 解析之前,预留挂载点。

**Tech Stack:** Bun、TypeScript、`Bun.serve`(HTTP 反向代理 + SSE 流式透传)、`bun:test`、commander(CLI)、inquirer(交互式多选)、launchd(开机自启)。

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/utils/paths.ts` | Modify | 加 img-proxy 路径常量 + `CLAUDE_PROVIDERS_DIR` |
| `src/utils/config.ts` | Modify | 加 `[img_proxy]` section + defaults + env override |
| `src/utils/errors.ts` | Modify | 加 `E_IMG_PROXY_*` 错误码与建议 |
| `src/utils/executable.ts` | Create | 共享 `getExecutablePath()`(从 start.ts 抽完善版,避免 dev 模式起旧二进制) |
| `src/img-proxy/types.ts` | Create | 类型:`RouteEntry`、`RouteTable`、`TransformResult`、`ProviderFileInfo` |
| `src/img-proxy/transform.ts` | Create | 纯函数 `stripImagesToPaths()`:剥离 image block、落盘、替换成 text block;`DEFAULT_PROMPT_TEMPLATE` 常量 |
| `src/img-proxy/provider-scan.ts` | Create | 扫 `~/.claude/providers/*.json`,alias=文件名 stem,返回 `{alias, path, baseUrl, model}` |
| `src/img-proxy/routes.ts` | Create | 路由表 load/save/resolve(原子写) |
| `src/img-proxy/provider-config.ts` | Create | provider 配置改写:install/uninstall(`.bak` 备份、幂等、还原后删 `.bak`) |
| `src/img-proxy/server.ts` | Create | `Bun.serve` 反向代理:控制台路由前置、alias 路由、transform、SSE 流式、内存计数、缓存清理 |
| `src/cli/commands/img-proxy.ts` | Create | CLI:install/uninstall/start/stop/status/daemon(三分支 start + launchd 不双重 fork) |
| `src/index.ts` | Modify | 注册 `cc-linker img-proxy` 子命令树 |
| `tests/unit/img-proxy/transform.test.ts` | Create | transform 纯函数单测 |
| `tests/unit/img-proxy/routes.test.ts` | Create | 路由表单测 |
| `tests/unit/img-proxy/provider-config.test.ts` | Create | provider 改写/还原单测(含 `.bak` 删除语义) |
| `tests/integration/img-proxy-server.test.ts` | Create | server 集成测(mock upstream,验证 transform/路由/流式/GET透传/502) |
| `CLAUDE.md` | Modify | 加 img-proxy 模块说明 |
| `CHANGELOG.md` | Modify | 加 `[Unreleased]` 条目 |

---

## 设计约定(所有 task 共享)

- **alias = 文件名 stem**:`byte-agent-glm.json` → alias `byte-agent-glm` → path `/byte-agent-glm`。稳定、唯一、与用户 shell alias(`cc-byte-agent` → `byte-agent-glm.json`)心智对齐。**绝不使用 `ProviderManager.generateShortAlias`**(它会截断 `byte-agent-glm`→`byte`、制造 `opencode-2`/`qwen3.7-2` 冲突)。
- **路由表**:`~/.cc-linker/img-proxy/routes.json`,key=文件名 stem,value 含真实上游 + provider 文件路径。
- **缓存**:`~/.cc-linker/img-proxy/cache/`,`<ts>-<rand>.<ext>`,启动时 + 每小时清过期。
- **`.bak` 生命周期**:install 首次写(若不存在);uninstall 还原 BASE_URL 后**删除** `.bak`(避免过期备份回退字段)。token 永远从当前文件读、不被 `.bak` 覆盖。
- **daemon 三分支**:`CC_LINKER_IMG_PROXY_DAEMON==='1'` 是 child(重写 console 到日志);`opts.daemon && !child` 是 parent(spawn child 后退出);否则前台(console 输出到终端)。
- **launchd**:`ProgramArguments=[exe, img-proxy, start]`(不带 `--daemon`)+ `EnvironmentVariables` 注入 `CC_LINKER_IMG_PROXY_DAEMON=1` → launchd 直接起 child,不双重 fork。
- **错误处理**:用 `CCLinkerError(code, msg, details)` + `handleError`;库代码不直接 `console.log`,命令代码可用 `chalk`。
- **安全**:server 绑 `127.0.0.1`,`Authorization` 原样透传。

---

## Task 1: 基础设施(paths + config + errors + executable.ts + 分支)

**Files:**
- Modify: `src/utils/paths.ts`
- Modify: `src/utils/config.ts`
- Modify: `src/utils/errors.ts`
- Create: `src/utils/executable.ts`

- [ ] **Step 1: 开发分支**

```bash
cd ~/Git/cc-linker
git checkout master
git pull --ff-only
git checkout -b feat/cli-image-proxy
```

- [ ] **Step 2: paths.ts 加常量**

在 `src/utils/paths.ts` 末尾(`CLAUDE_JOBS_DIR` 之后)追加:

```typescript
// Claude providers 目录(用于 img-proxy 扫描)
export const CLAUDE_PROVIDERS_DIR = join(HOME, '.claude', 'providers');

// Image Proxy (CLI image-block stripping reverse proxy)
export const IMG_PROXY_DIR = join(CC_LINKER_DIR, 'img-proxy');
export const IMG_PROXY_CACHE_DIR = join(IMG_PROXY_DIR, 'cache');
export const IMG_PROXY_ROUTES_PATH = join(IMG_PROXY_DIR, 'routes.json');
export const IMG_PROXY_PID_FILE = join(IMG_PROXY_DIR, 'img-proxy.pid');
export const IMG_PROXY_LOG_FILE = join(IMG_PROXY_DIR, 'img-proxy.log');
```

- [ ] **Step 3: config.ts 加 `[img_proxy]` section**

在 `src/utils/config.ts` 的 `ConfigData` interface(`agent_view: AgentViewConfig;` 那行之前)加:

```typescript
  img_proxy: {
    enabled: boolean;
    port: number;
    hostname: string;
    cache_max_age_hours: number;
    prompt_template: string;
    console_enabled: boolean;
  };
```

在 `DEFAULTS`(对应位置,`images` 之后、`agent_view` 之前)加:

```typescript
  img_proxy: {
    enabled: true,
    port: 8765,
    hostname: '127.0.0.1',
    cache_max_age_hours: 24 * 7,
    prompt_template: '[用户粘贴的图片已保存到本地: {path}] 当前模型为纯文本模型,无法直接查看图片内容。如需识别这张图片,请调用 mcp__MiniMax__understand_image 工具,image_source 参数传上述本地路径。',
    console_enabled: false, // Phase 2: Web 控制台
  },
```

在 `cloneDefaults()` 返回对象(`images: { ...DEFAULTS.images },` 之后)加:

```typescript
    img_proxy: { ...DEFAULTS.img_proxy },
```

在 `loadEnv()` 的 `mappings` 数组末尾加:

```typescript
      ['CC_LINKER_IMG_PROXY_ENABLED', 'img_proxy', 'enabled'],
      ['CC_LINKER_IMG_PROXY_PORT', 'img_proxy', 'port'],
      ['CC_LINKER_IMG_PROXY_HOSTNAME', 'img_proxy', 'hostname'],
      ['CC_LINKER_IMG_PROXY_CACHE_HOURS', 'img_proxy', 'cache_max_age_hours'],
      ['CC_LINKER_IMG_PROXY_PROMPT_TEMPLATE', 'img_proxy', 'prompt_template'],
```

- [ ] **Step 4: errors.ts 加错误码**

在 `src/utils/errors.ts` 的 `handleError` 的 `suggestions` 字典中追加:

```typescript
      'E_IMG_PROXY_RUNNING': ['代理已在运行,如需重启先执行 cc-linker img-proxy stop'],
      'E_IMG_PROXY_NOT_RUNNING': ['代理未运行,执行 cc-linker img-proxy start --daemon'],
      'E_IMG_PROXY_NO_PROVIDERS': ['未扫描到 provider (~/.claude/providers/*.json)'],
      'E_IMG_PROXY_UNKNOWN_ALIAS': ['该 alias 未 install,执行 cc-linker img-proxy install'],
```

- [ ] **Step 5: 抽 getExecutablePath 到 utils/executable.ts**

创建 `src/utils/executable.ts`(从 `start.ts` 的完善版抽取,处理 compiled binary / node_modules / dev 三种情况):

```typescript
import { existsSync } from 'fs';
import { dirname, join } from 'path';

/**
 * 解析 cc-linker 可执行文件路径,用于 spawn daemon child / launchd plist。
 * 处理三种运行形态:
 * - compiled binary(argv[0] 以 cc-linker 结尾)
 * - 全局 npm 安装(argv[1] 含 node_modules,或 symlink)
 * - 开发模式(bun run src/index.ts → 用 dist/cc-linker 或 PATH 里的 cc-linker)
 */
export function getExecutablePath(): string {
  const argv0 = process.argv[0];
  if (argv0.endsWith('cc-linker')) return argv0;

  const scriptPath = process.argv[1] || '';

  // 全局 npm 包(node_modules/cc-linker/dist/cli.js)→ 用 PATH 里的 cc-linker
  if (scriptPath.includes('node_modules')) return 'cc-linker';

  // 全局 symlink(/usr/local/bin/cc-linker 解析后)
  if (scriptPath.endsWith('/cc-linker') || scriptPath === 'cc-linker') return 'cc-linker';

  // 开发模式(bun run src/index.ts):优先 dist 编译产物,否则用 PATH
  const scriptDir = dirname(scriptPath);
  const distPath = join(scriptDir, '..', 'dist', 'cc-linker');
  if (existsSync(distPath)) return distPath;

  return 'cc-linker';
}
```

> 注:本步只新增 `executable.ts`,**不改 `start.ts`/`daemon.ts`**(降低回归风险;它们的本地 `getExecutablePath` 保持原样,后续可统一迁移)。img-proxy 模块用新的共享版本。

- [ ] **Step 6: typecheck + 现有测试无回归**

Run: `cd ~/Git/cc-linker && bun run typecheck && bun test`
Expected: 0 typecheck 报错,全部现有测试通过。

- [ ] **Step 7: Commit**

```bash
git add src/utils/paths.ts src/utils/config.ts src/utils/errors.ts src/utils/executable.ts
git commit -m "feat(img-proxy): add paths/config/errors scaffolding and shared getExecutablePath"
```

---

## Task 2: image→path 转换纯函数 `transform.ts` (TDD)

**Files:**
- Create: `src/img-proxy/types.ts`
- Create: `src/img-proxy/transform.ts`
- Test: `tests/unit/img-proxy/transform.test.ts`

- [ ] **Step 1: 写 types.ts**

创建 `src/img-proxy/types.ts`:

```typescript
export interface RouteEntry {
  alias: string;              // 文件名 stem
  upstream: string;           // 真实上游 base URL
  provider_path: string;      // provider 文件绝对路径
  original_base_url: string;  // 改写前的 BASE_URL(仅展示/审计;还原读 .bak)
  installed_at: string;       // ISO 时间戳
}

export interface RouteTable {
  version: 1;
  routes: Record<string, RouteEntry>;  // key = 文件名 stem
}

export interface TransformResult {
  messages: unknown[];
  savedImages: string[];
  strippedCount: number;
}

export interface ProviderFileInfo {
  alias: string;    // 文件名 stem
  path: string;     // 绝对路径
  baseUrl: string;  // env.ANTHROPIC_BASE_URL
  model: string;    // env.ANTHROPIC_MODEL(展示用)
}
```

- [ ] **Step 2: 写失败测试**

创建 `tests/unit/img-proxy/transform.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { stripImagesToPaths, DEFAULT_PROMPT_TEMPLATE } from '../../../src/img-proxy/transform';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const RED_DOT_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('stripImagesToPaths', () => {
  let cacheDir: string;
  beforeEach(() => { cacheDir = mkdtempSync(join(tmpdir(), 'img-proxy-cache-')); });
  afterEach(() => { rmSync(cacheDir, { recursive: true, force: true }); });

  it('returns messages unchanged when no image blocks', async () => {
    const messages = [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }];
    const result = await stripImagesToPaths(messages, { cacheDir, promptTemplate: 'img at {path}' });
    expect(result.strippedCount).toBe(0);
    expect(result.savedImages).toEqual([]);
    expect(result.messages).toEqual(messages);
  });

  it('strips one image block, saves png file, replaces with text block containing path', async () => {
    const messages = [{
      role: 'user',
      content: [
        { type: 'text', text: '看这张图' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: RED_DOT_PNG_B64 } },
      ],
    }];
    const result = await stripImagesToPaths(messages, { cacheDir, promptTemplate: '[img: {path}]' });
    expect(result.strippedCount).toBe(1);
    expect(result.savedImages).toHaveLength(1);
    const saved = result.savedImages[0]!;
    expect(saved.endsWith('.png')).toBe(true);
    expect(existsSync(saved)).toBe(true);
    expect(readFileSync(saved).length).toBeGreaterThan(0);
    const content = (result.messages[0] as any).content as any[];
    expect(content[1].type).toBe('text');
    expect(content[1].text).toContain(saved);
    expect(content[0]).toEqual({ type: 'text', text: '看这张图' });
  });

  it('handles content given as plain string', async () => {
    const messages = [{ role: 'user', content: 'plain string message' }];
    const result = await stripImagesToPaths(messages, { cacheDir, promptTemplate: '{path}' });
    expect(result.strippedCount).toBe(0);
    expect(result.messages).toEqual(messages);
  });

  it('correct extension for jpeg/webp', async () => {
    const messages = [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: RED_DOT_PNG_B64 } },
        { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: RED_DOT_PNG_B64 } },
      ],
    }];
    const result = await stripImagesToPaths(messages, { cacheDir, promptTemplate: '{path}' });
    expect(result.savedImages[0]!.endsWith('.jpg')).toBe(true);
    expect(result.savedImages[1]!.endsWith('.webp')).toBe(true);
  });

  it('leaves url-source image blocks untouched', async () => {
    const messages = [{
      role: 'user',
      content: [{ type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } }],
    }];
    const result = await stripImagesToPaths(messages, { cacheDir, promptTemplate: '{path}' });
    expect(result.strippedCount).toBe(0);
    expect(result.messages).toEqual(messages);
  });

  it('falls back to DEFAULT_PROMPT_TEMPLATE when template lacks {path}', async () => {
    const messages = [{
      role: 'user',
      content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: RED_DOT_PNG_B64 } }],
    }];
    const result = await stripImagesToPaths(messages, { cacheDir, promptTemplate: '没有占位符的模板' });
    expect(result.strippedCount).toBe(1);
    const text = (result.messages[0] as any).content[0].text;
    expect(text).toContain(result.savedImages[0]);  // 用默认模板,含路径
    expect(DEFAULT_PROMPT_TEMPLATE).toContain('{path}');
  });

  it('processes multiple messages independently', async () => {
    const messages = [
      { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: RED_DOT_PNG_B64 } }] },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: RED_DOT_PNG_B64 } }] },
    ];
    const result = await stripImagesToPaths(messages, { cacheDir, promptTemplate: '{path}' });
    expect(result.strippedCount).toBe(2);
    expect(readdirSync(cacheDir).length).toBe(2);
  });
});
```

- [ ] **Step 3: 运行测试,确认失败**

Run: `cd ~/Git/cc-linker && bun test tests/unit/img-proxy/transform.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 4: 实现 transform.ts**

创建 `src/img-proxy/transform.ts`:

```typescript
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
```

- [ ] **Step 5: 运行测试,确认通过**

Run: `cd ~/Git/cc-linker && bun test tests/unit/img-proxy/transform.test.ts`
Expected: PASS,7/7。

- [ ] **Step 6: typecheck + commit**

```bash
cd ~/Git/cc-linker && bun run typecheck
git add src/img-proxy/types.ts src/img-proxy/transform.ts tests/unit/img-proxy/transform.test.ts
git commit -m "feat(img-proxy): add stripImagesToPaths transform to save inline images and emit path text"
```

---

## Task 3: provider 扫描 `provider-scan.ts` + 路由表 `routes.ts` (TDD)

**Files:**
- Create: `src/img-proxy/provider-scan.ts`
- Create: `src/img-proxy/routes.ts`
- Test: `tests/unit/img-proxy/routes.test.ts`

- [ ] **Step 1: 实现 provider-scan.ts(alias = 文件名 stem,不依赖 ProviderManager)**

创建 `src/img-proxy/provider-scan.ts`:

```typescript
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
```

- [ ] **Step 2: 写 routes.ts 失败测试**

创建 `tests/unit/img-proxy/routes.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { loadRoutes, saveRoutes, addRoute, removeRoute, resolveUpstream } from '../../../src/img-proxy/routes';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('routes', () => {
  let routesPath: string;
  beforeEach(() => { routesPath = join(mkdtempSync(join(tmpdir(), 'img-proxy-routes-')), 'routes.json'); });
  afterEach(() => { rmSync(routesPath, { recursive: true, force: true }); });

  it('loadRoutes returns empty table when file missing', () => {
    expect(loadRoutes(routesPath)).toEqual({ version: 1, routes: {} });
  });

  it('addRoute persists and resolveUpstream finds it', () => {
    addRoute(routesPath, 'byte-agent-glm', 'https://ark.cn-beijing.volces.com/api/plan', '/home/u/.claude/providers/byte-agent-glm.json');
    expect(resolveUpstream(routesPath, 'byte-agent-glm')).toBe('https://ark.cn-beijing.volces.com/api/plan');
    expect(resolveUpstream(routesPath, 'unknown')).toBeNull();
  });

  it('saveRoute is atomic', () => {
    saveRoutes(routesPath, {
      version: 1,
      routes: {
        'byte-glm': {
          alias: 'byte-glm', upstream: 'https://ark.cn-beijing.volces.com/api/coding',
          provider_path: '/p.json', original_base_url: 'https://ark.cn-beijing.volces.com/api/coding',
          installed_at: '2026-07-04T00:00:00.000Z',
        },
      },
    });
    expect(existsSync(routesPath)).toBe(true);
    expect(loadRoutes(routesPath).routes['byte-glm']).toBeDefined();
  });

  it('addRoute overwrites same alias, keeps others (idempotent on same key)', () => {
    addRoute(routesPath, 'a', 'https://a/', '/pa');
    addRoute(routesPath, 'b', 'https://b/', '/pb');
    addRoute(routesPath, 'a', 'https://a2/', '/pa');
    const table = loadRoutes(routesPath);
    expect(Object.keys(table.routes).sort()).toEqual(['a', 'b']);
    expect(table.routes['a']!.upstream).toBe('https://a2/');
  });

  it('removeRoute deletes only the named alias', () => {
    addRoute(routesPath, 'a', 'https://a/', '/pa');
    addRoute(routesPath, 'b', 'https://b/', '/pb');
    removeRoute(routesPath, 'a');
    const table = loadRoutes(routesPath);
    expect(table.routes['a']).toBeUndefined();
    expect(table.routes['b']).toBeDefined();
  });

  it('removeRoute on missing alias is a no-op', () => {
    expect(() => removeRoute(routesPath, 'nope')).not.toThrow();
  });
});
```

- [ ] **Step 3: 运行测试,确认失败**

Run: `cd ~/Git/cc-linker && bun test tests/unit/img-proxy/routes.test.ts`
Expected: FAIL —— `routes.ts` 不存在。

- [ ] **Step 4: 实现 routes.ts**

创建 `src/img-proxy/routes.ts`:

```typescript
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import { dirname } from 'path';
import { IMG_PROXY_ROUTES_PATH } from '../utils/paths';
import type { RouteTable, RouteEntry } from './types';

export function loadRoutes(path: string = IMG_PROXY_ROUTES_PATH): RouteTable {
  if (!existsSync(path)) return { version: 1, routes: {} };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    if (raw && typeof raw === 'object' && raw.version === 1 && raw.routes) return raw as RouteTable;
  } catch {
    // 损坏当空表
  }
  return { version: 1, routes: {} };
}

export function saveRoutes(path: string, table: RouteTable): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(table, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

export function addRoute(path: string, alias: string, upstream: string, providerPath: string): void {
  const table = loadRoutes(path);
  table.routes[alias] = {
    alias, upstream, provider_path: providerPath,
    original_base_url: upstream, installed_at: new Date().toISOString(),
  };
  saveRoutes(path, table);
}

export function removeRoute(path: string, alias: string): void {
  const table = loadRoutes(path);
  if (table.routes[alias]) {
    delete table.routes[alias];
    saveRoutes(path, table);
  }
}

export function resolveUpstream(path: string, alias: string): string | null {
  return loadRoutes(path).routes[alias]?.upstream ?? null;
}

export function listRoutes(path: string = IMG_PROXY_ROUTES_PATH): RouteEntry[] {
  return Object.values(loadRoutes(path).routes);
}
```

- [ ] **Step 5: 运行测试,确认通过**

Run: `cd ~/Git/cc-linker && bun test tests/unit/img-proxy/routes.test.ts`
Expected: PASS,6/6。

- [ ] **Step 6: typecheck + commit**

```bash
cd ~/Git/cc-linker && bun run typecheck
git add src/img-proxy/provider-scan.ts src/img-proxy/routes.ts tests/unit/img-proxy/routes.test.ts
git commit -m "feat(img-proxy): add provider-scan (filename-stem alias) and route table"
```

---

## Task 4: provider 配置改写 `provider-config.ts` (TDD)

**Files:**
- Create: `src/img-proxy/provider-config.ts`
- Test: `tests/unit/img-proxy/provider-config.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `tests/unit/img-proxy/provider-config.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { installProvider, uninstallProvider, isProviderInstalled } from '../../../src/img-proxy/provider-config';
import { loadRoutes } from '../../../src/img-proxy/routes';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function makeProviderFile(dir: string, alias: string, baseUrl: string): string {
  const path = join(dir, `${alias}.json`);
  writeFileSync(path, JSON.stringify({
    model: 'opus',
    env: { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: 'sk-secret', ANTHROPIC_MODEL: 'glm-5.2[1m]' },
  }, null, 2), { mode: 0o600 });
  return path;
}

describe('provider-config', () => {
  let workDir: string, routesPath: string;
  beforeEach(() => { workDir = mkdtempSync(join(tmpdir(), 'img-proxy-prov-')); routesPath = join(workDir, 'routes.json'); });
  afterEach(() => { rmSync(workDir, { recursive: true, force: true }); });

  it('install rewrites BASE_URL to 127.0.0.1/<alias>, keeps token and other fields', () => {
    const p = makeProviderFile(workDir, 'byte-agent-glm', 'https://ark.cn-beijing.volces.com/api/plan');
    installProvider({ providerPath: p, alias: 'byte-agent-glm', routesPath, port: 8765, hostname: '127.0.0.1' });
    const after = JSON.parse(readFileSync(p, 'utf8'));
    expect(after.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8765/byte-agent-glm');
    expect(after.env.ANTHROPIC_AUTH_TOKEN).toBe('sk-secret');
    expect(after.env.ANTHROPIC_MODEL).toBe('glm-5.2[1m]');
    expect(after.model).toBe('opus');
  });

  it('install writes .bak with original content', () => {
    const p = makeProviderFile(workDir, 'glm-5.2', 'https://open.bigmodel.cn/api/anthropic');
    installProvider({ providerPath: p, alias: 'glm-5.2', routesPath, port: 8765, hostname: '127.0.0.1' });
    const bak = JSON.parse(readFileSync(p + '.bak', 'utf8'));
    expect(bak.env.ANTHROPIC_BASE_URL).toBe('https://open.bigmodel.cn/api/anthropic');
  });

  it('install registers route', () => {
    const p = makeProviderFile(workDir, 'glm-5.2', 'https://open.bigmodel.cn/api/anthropic');
    installProvider({ providerPath: p, alias: 'glm-5.2', routesPath, port: 8765, hostname: '127.0.0.1' });
    const r = loadRoutes(routesPath).routes['glm-5.2'];
    expect(r).toBeDefined();
    expect(r!.upstream).toBe('https://open.bigmodel.cn/api/anthropic');
    expect(r!.provider_path).toBe(p);
  });

  it('install is idempotent: second install does NOT overwrite .bak', () => {
    const p = makeProviderFile(workDir, 'glm-5.2', 'https://open.bigmodel.cn/api/anthropic');
    installProvider({ providerPath: p, alias: 'glm-5.2', routesPath, port: 8765, hostname: '127.0.0.1' });
    // 改 token 后再 install(幂等分支)
    const cur = JSON.parse(readFileSync(p, 'utf8'));
    cur.env.ANTHROPIC_AUTH_TOKEN = 'sk-rotated';
    writeFileSync(p, JSON.stringify(cur, null, 2), { mode: 0o600 });
    installProvider({ providerPath: p, alias: 'glm-5.2', routesPath, port: 8765, hostname: '127.0.0.1' });
    const bak = JSON.parse(readFileSync(p + '.bak', 'utf8'));
    expect(bak.env.ANTHROPIC_AUTH_TOKEN).toBe('sk-secret');  // 原始备份未被覆盖
    // 当前文件的 token 保留(幂等分支不写文件)
    expect(JSON.parse(readFileSync(p, 'utf8')).env.ANTHROPIC_AUTH_TOKEN).toBe('sk-rotated');
  });

  it('isProviderInstalled detects installed state', () => {
    const p = makeProviderFile(workDir, 'glm-5.2', 'https://open.bigmodel.cn/api/anthropic');
    expect(isProviderInstalled(p, 8765, '127.0.0.1')).toBe(false);
    installProvider({ providerPath: p, alias: 'glm-5.2', routesPath, port: 8765, hostname: '127.0.0.1' });
    expect(isProviderInstalled(p, 8765, '127.0.0.1')).toBe(true);
  });

  it('uninstall restores BASE_URL, keeps current token, removes route, deletes .bak', () => {
    const p = makeProviderFile(workDir, 'glm-5.2', 'https://open.bigmodel.cn/api/anthropic');
    installProvider({ providerPath: p, alias: 'glm-5.2', routesPath, port: 8765, hostname: '127.0.0.1' });
    // install 后用户轮换 token
    const cur = JSON.parse(readFileSync(p, 'utf8'));
    cur.env.ANTHROPIC_AUTH_TOKEN = 'sk-rotated';
    writeFileSync(p, JSON.stringify(cur, null, 2), { mode: 0o600 });
    uninstallProvider({ providerPath: p, alias: 'glm-5.2', routesPath });
    const after = JSON.parse(readFileSync(p, 'utf8'));
    expect(after.env.ANTHROPIC_BASE_URL).toBe('https://open.bigmodel.cn/api/anthropic');  // 从 .bak 还原
    expect(after.env.ANTHROPIC_AUTH_TOKEN).toBe('sk-rotated');  // 当前 token 保留
    expect(loadRoutes(routesPath).routes['glm-5.2']).toBeUndefined();
    expect(existsSync(p + '.bak')).toBe(false);  // .bak 删除
  });

  it('uninstall when BASE_URL already upstream (looksProxied=false) cleans route+bak, leaves file', () => {
    const p = makeProviderFile(workDir, 'glm-5.2', 'https://open.bigmodel.cn/api/anthropic');
    installProvider({ providerPath: p, alias: 'glm-5.2', routesPath, port: 8765, hostname: '127.0.0.1' });
    // 用户手动把 BASE_URL 改回上游
    const cur = JSON.parse(readFileSync(p, 'utf8'));
    cur.env.ANTHROPIC_BASE_URL = 'https://open.bigmodel.cn/api/anthropic';
    writeFileSync(p, JSON.stringify(cur, null, 2), { mode: 0o600 });
    uninstallProvider({ providerPath: p, alias: 'glm-5.2', routesPath });
    const after = JSON.parse(readFileSync(p, 'utf8'));
    expect(after.env.ANTHROPIC_BASE_URL).toBe('https://open.bigmodel.cn/api/anthropic');  // 不动
    expect(loadRoutes(routesPath).routes['glm-5.2']).toBeUndefined();  // 清路由
    expect(existsSync(p + '.bak')).toBe(false);  // 清 .bak
  });

  it('uninstall on never-installed provider is a no-op', () => {
    const p = makeProviderFile(workDir, 'glm-5.2', 'https://open.bigmodel.cn/api/anthropic');
    expect(() => uninstallProvider({ providerPath: p, alias: 'glm-5.2', routesPath })).not.toThrow();
    expect(JSON.parse(readFileSync(p, 'utf8')).env.ANTHROPIC_BASE_URL).toBe('https://open.bigmodel.cn/api/anthropic');
    expect(existsSync(p + '.bak')).toBe(false);
  });

  it('install idempotent branch throws if .bak missing (prevents self-referential upstream)', () => {
    const p = makeProviderFile(workDir, 'glm-5.2', 'https://open.bigmodel.cn/api/anthropic');
    installProvider({ providerPath: p, alias: 'glm-5.2', routesPath, port: 8765, hostname: '127.0.0.1' });
    rmSync(p + '.bak');  // 模拟 .bak 丢失
    expect(() => installProvider({ providerPath: p, alias: 'glm-5.2', routesPath, port: 8765, hostname: '127.0.0.1' }))
      .toThrow(/\.bak 丢失/);
  });
});
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `cd ~/Git/cc-linker && bun test tests/unit/img-proxy/provider-config.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现 provider-config.ts**

创建 `src/img-proxy/provider-config.ts`:

```typescript
import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } from 'fs';
import { addRoute, removeRoute } from './routes';

export interface InstallOpts {
  providerPath: string;
  alias: string;       // 文件名 stem
  routesPath: string;
  port: number;
  hostname: string;
}

export interface UninstallOpts {
  providerPath: string;
  alias: string;
  routesPath: string;
}

function proxyBaseUrl(port: number, hostname: string, alias: string): string {
  return `http://${hostname}:${port}/${alias}`;
}

function isProxyUrl(url: unknown, port: number, hostname: string): boolean {
  return typeof url === 'string' && url.startsWith(`http://${hostname}:${port}/`);
}

/** 当前 BASE_URL 是否指向代理 */
export function isProviderInstalled(providerPath: string, port: number, hostname: string): boolean {
  if (!existsSync(providerPath)) return false;
  try {
    return isProxyUrl(JSON.parse(readFileSync(providerPath, 'utf8'))?.env?.ANTHROPIC_BASE_URL, port, hostname);
  } catch {
    return false;
  }
}

export function installProvider(opts: InstallOpts): void {
  const { providerPath, alias, routesPath, port, hostname } = opts;
  if (!existsSync(providerPath)) throw new Error(`provider 文件不存在: ${providerPath}`);
  const cfg = JSON.parse(readFileSync(providerPath, 'utf8'));
  const env = cfg.env ?? (cfg.env = {});
  const currentUrl = env.ANTHROPIC_BASE_URL;

  // 幂等:已 install → 只确保路由存在,不写文件、不覆盖 .bak
  if (isProxyUrl(currentUrl, port, hostname)) {
    const upstream = readUpstreamFromBak(providerPath);
    if (!upstream) {
      // .bak 丢失时不能回退到 currentUrl(那是代理地址,会让路由自指循环)
      throw new Error(
        `${alias}: .bak 丢失,无法恢复 upstream。请先 cc-linker img-proxy uninstall --providers ${alias} 再 install`,
      );
    }
    addRoute(routesPath, alias, upstream, providerPath);
    return;
  }

  // 首次:备份(不覆盖已有 .bak)→ 改 BASE_URL → 原子写 → 加路由
  const bakPath = providerPath + '.bak';
  if (!existsSync(bakPath)) {
    writeFileSync(bakPath, readFileSync(providerPath), { mode: 0o600 });
  }
  env.ANTHROPIC_BASE_URL = proxyBaseUrl(port, hostname, alias);
  const tmp = providerPath + '.tmp';
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  renameSync(tmp, providerPath);
  addRoute(routesPath, alias, currentUrl, providerPath);
}

export function uninstallProvider(opts: UninstallOpts): void {
  const { providerPath, alias, routesPath } = opts;
  const bakPath = providerPath + '.bak';

  // 文件不存在:只清路由
  if (!existsSync(providerPath)) {
    removeRoute(routesPath, alias);
    return;
  }

  const cfg = JSON.parse(readFileSync(providerPath, 'utf8'));
  const env = cfg.env ?? (cfg.env = {});
  const currentUrl = typeof env.ANTHROPIC_BASE_URL === 'string' ? env.ANTHROPIC_BASE_URL : '';

  // looksProxied:BASE_URL 是否形如 .../<alias>(/...|结尾)
  const looksProxied = currentUrl.includes(`/${alias}/`) || currentUrl.endsWith(`/${alias}`);

  if (looksProxied) {
    // 从 .bak 还原 BASE_URL,保留当前其它字段(如已轮换的 token)
    const restored = readUpstreamFromBak(providerPath);
    if (restored) {
      env.ANTHROPIC_BASE_URL = restored;
      const tmp = providerPath + '.tmp';
      writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
      renameSync(tmp, providerPath);
    }
  }
  // 无论 looksProxied 与否:清路由 + 删 .bak(清理代理痕迹,避免过期备份)
  removeRoute(routesPath, alias);
  try { if (existsSync(bakPath)) unlinkSync(bakPath); } catch {}
}

function readUpstreamFromBak(providerPath: string): string | null {
  const bakPath = providerPath + '.bak';
  if (!existsSync(bakPath)) return null;
  try {
    return JSON.parse(readFileSync(bakPath, 'utf8'))?.env?.ANTHROPIC_BASE_URL ?? null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: 运行测试,确认通过**

Run: `cd ~/Git/cc-linker && bun test tests/unit/img-proxy/provider-config.test.ts`
Expected: PASS,8/8。

- [ ] **Step 5: typecheck + commit**

```bash
cd ~/Git/cc-linker && bun run typecheck
git add src/img-proxy/provider-config.ts tests/unit/img-proxy/provider-config.test.ts
git commit -m "feat(img-proxy): add provider config install/uninstall with .bak lifecycle"
```

---

## Task 5: 反向代理 server `server.ts` (集成 TDD)

**Files:**
- Create: `src/img-proxy/server.ts`
- Test: `tests/integration/img-proxy-server.test.ts`

- [ ] **Step 1: 写失败集成测试**

创建 `tests/integration/img-proxy-server.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { startProxyServer, parseAliasFromPath } from '../../src/img-proxy/server';
import { saveRoutes } from '../../src/img-proxy/routes';
import { mkdtempSync, rmSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const RED_DOT_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('img-proxy server', () => {
  let cacheDir: string, routesPath: string;
  let upstreamPort: number, upstreamServer: any;
  let proxyPort: number, proxyServer: any;
  let lastMethod: string, lastHeaders: any, lastBody: any, lastPath: string;

  beforeAll(async () => {
    cacheDir = mkdtempSync(join(tmpdir(), 'img-proxy-srv-cache-'));
    const workDir = mkdtempSync(join(tmpdir(), 'img-proxy-srv-'));
    routesPath = join(workDir, 'routes.json');

    upstreamServer = Bun.serve({
      port: 0, hostname: '127.0.0.1',
      async fetch(req) {
        lastPath = new URL(req.url).pathname;
        lastMethod = req.method;
        lastHeaders = Object.fromEntries(req.headers.entries());
        lastBody = req.method === 'POST' ? await req.json() : null;
        const sseBody =
          'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1"}}\n\n' +
          'event: message_stop\ndata: {"type":"message_stop"}\n\n';
        return new Response(sseBody, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      },
    });
    upstreamPort = upstreamServer.port;

    saveRoutes(routesPath, {
      version: 1,
      routes: {
        'glm-5.2': {
          alias: 'glm-5.2', upstream: `http://127.0.0.1:${upstreamPort}`,
          provider_path: '/fake/glm-5.2.json',
          original_base_url: `http://127.0.0.1:${upstreamPort}`,
          installed_at: '2026-07-04T00:00:00.000Z',
        },
      },
    });

    proxyServer = await startProxyServer({
      port: 0, hostname: '127.0.0.1', cacheDir, routesPath,
      promptTemplate: '[img: {path}]', consoleEnabled: false, cacheMaxAgeHours: 1,
    });
    proxyPort = proxyServer.port;
  });

  afterAll(() => {
    proxyServer?.stop(true);
    upstreamServer?.stop(true);
    rmSync(cacheDir, { recursive: true, force: true });
  });

  beforeEach(() => { lastMethod = ''; lastHeaders = undefined; lastBody = undefined; lastPath = ''; });

  it('parseAliasFromPath extracts first segment', () => {
    expect(parseAliasFromPath('/glm-5.2/v1/messages')).toBe('glm-5.2');
    expect(parseAliasFromPath('/v1/messages')).toBeNull();
  });

  it('POST /<alias>/v1/messages strips image, forwards text block, passes SSE through, forwards Authorization', async () => {
    const body = {
      model: 'glm-5.2[1m]', stream: true,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: '看图' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: RED_DOT_PNG_B64 } },
        ],
      }],
    };
    const resp = await fetch(`http://127.0.0.1:${proxyPort}/glm-5.2/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer sk-test' },
      body: JSON.stringify(body),
    });
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toContain('text/event-stream');
    expect((await resp.text()).length).toBeGreaterThan(0);
    // 上游收到的 body 不含 image block,含路径 text block
    expect(lastBody).toBeTruthy();
    const fwd = lastBody.messages[0].content;
    expect(fwd.find((b: any) => b.type === 'image')).toBeUndefined();
    expect(fwd.find((b: any) => b.type === 'text' && b.text.startsWith('[img: '))).toBeDefined();
    expect(lastHeaders['authorization']).toBe('Bearer sk-test');
    expect(readdirSync(cacheDir).length).toBe(1);  // 落盘 1 张
  });

  it('GET /<alias>/v1/models passes through: method GET, no body mutation', async () => {
    const resp = await fetch(`http://127.0.0.1:${proxyPort}/glm-5.2/v1/models`);
    expect(resp.status).toBe(200);
    expect(lastMethod).toBe('GET');
    expect(lastPath).toBe('/v1/models');
    expect(lastBody).toBeNull();
  });

  it('POST with no image forwards body unchanged', async () => {
    const body = { model: 'glm-5.2[1m]', messages: [{ role: 'user', content: '纯文本' }] };
    await fetch(`http://127.0.0.1:${proxyPort}/glm-5.2/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    expect(lastBody.messages[0].content).toBe('纯文本');
  });

  it('unknown alias returns 502 mentioning the alias', async () => {
    const resp = await fetch(`http://127.0.0.1:${proxyPort}/whoever/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(resp.status).toBe(502);
    expect((await resp.text())).toContain('whoever');
  });

  it('POST with malformed JSON body passes raw bytes through (no crash)', async () => {
    const resp = await fetch(`http://127.0.0.1:${proxyPort}/glm-5.2/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not-json{',
    });
    // 上游 mock 会对非 JSON body 的 req.json() 抛错 → 它的 fetch 抛 → 返回 500。
    // 我们只断言"代理没崩、回了响应"。上游 500 是 mock 副作用,真实上游会自行处理。
    expect([200, 500]).toContain(resp.status);
  });
});
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `cd ~/Git/cc-linker && bun test tests/integration/img-proxy-server.test.ts`
Expected: FAIL —— `startProxyServer`/`parseAliasFromPath` 不存在。

- [ ] **Step 3: 实现 server.ts**

创建 `src/img-proxy/server.ts`:

```typescript
import { existsSync, appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';
import { resolveUpstream } from './routes';
import { stripImagesToPaths } from './transform';
import { IMG_PROXY_LOG_FILE } from '../utils/paths';

export interface ProxyServerOptions {
  port: number;
  hostname: string;
  cacheDir: string;
  routesPath: string;
  promptTemplate: string;
  consoleEnabled: boolean;
  cacheMaxAgeHours: number;
}

export interface ProxyServer {
  port: number;
  hostname: string;
  stop: (force?: boolean) => void;
  stats: { totalRequests: number; strippedImages: number };  // 内存计数(Phase 2 控制台读)
}

/** 从 pathname 提取第一段作 alias。无段或为保留前缀返回 null。 */
export function parseAliasFromPath(pathname: string): string | null {
  const seg = pathname.replace(/^\/+/, '').split('/')[0];
  return seg && seg.length > 0 ? seg : null;
}

function appendLog(line: string): void {
  try {
    mkdirSync(dirname(IMG_PROXY_LOG_FILE), { recursive: true });
    appendFileSync(IMG_PROXY_LOG_FILE, `[${new Date().toISOString()}] ${line}\n`);
  } catch {}
}

/** 清理 cacheDir 里超过 maxAgeHours 的文件。返回清理数。 */
export function cleanupOldCache(cacheDir: string, maxAgeHours: number): number {
  if (!existsSync(cacheDir)) return 0;
  const maxAgeMs = maxAgeHours * 3_600_000;
  const now = Date.now();
  let cleaned = 0;
  for (const f of readdirSync(cacheDir)) {
    const p = join(cacheDir, f);
    try {
      if (now - statSync(p).mtimeMs > maxAgeMs) { unlinkSync(p); cleaned++; }
    } catch {}
  }
  return cleaned;
}

export async function startProxyServer(opts: ProxyServerOptions): Promise<ProxyServer> {
  const { port, hostname, cacheDir, routesPath, promptTemplate, consoleEnabled } = opts;
  const stats = { totalRequests: 0, strippedImages: 0 };

  // 启动清一次过期缓存 + 每小时清
  cleanupOldCache(cacheDir, opts.cacheMaxAgeHours);
  const cleanupTimer = setInterval(() => {
    const n = cleanupOldCache(cacheDir, opts.cacheMaxAgeHours);
    if (n > 0) appendLog(`INFO cleanup removed ${n} cached images`);
  }, 3_600_000);

  const server = Bun.serve({
    port, hostname,
    async fetch(req) {
      const url = new URL(req.url);

      // 控制台路由前置(Phase 1 consoleEnabled=false 不触发;Phase 2 在此挂 / 和 /admin/api/*)
      if (consoleEnabled && (url.pathname === '/' || url.pathname.startsWith('/admin'))) {
        return new Response('console not implemented (Phase 2)', { status: 501 });
      }

      const alias = parseAliasFromPath(url.pathname);
      if (!alias) {
        return new Response('cc-linker img-proxy: missing provider alias in path', { status: 502 });
      }
      const upstream = resolveUpstream(routesPath, alias);
      if (!upstream) {
        appendLog(`WARN alias=${alias} path=${url.pathname} unresolved`);
        return new Response(
          `cc-linker img-proxy: 未知 provider alias "${alias}"。执行 cc-linker img-proxy install --providers ${alias} 后重试。`,
          { status: 502 },
        );
      }

      // 目标 URL = upstream + 去掉 alias 段后的 path + search
      const rest = url.pathname.replace(/^\/+/, '').split('/').slice(1).join('/');
      const targetUrl = `${upstream.replace(/\/+$/, '')}/${rest}${url.search}`;
      const startedAt = Date.now();

      const isMessagesPost = req.method === 'POST' && /\/v1\/messages(\/|$|\?)/.test(url.pathname);

      // 决定转发 body
      let outBody: BodyInit | null | undefined;
      let stripped = 0;
      if (isMessagesPost) {
        // 先 buffer 原始字节,再 parse;失败用原始字节透传(req.arrayBuffer 只能调一次)
        const rawBytes = new Uint8Array(await req.arrayBuffer());
        try {
          const payload = JSON.parse(new TextDecoder().decode(rawBytes));
          const result = await stripImagesToPaths(payload.messages ?? [], { cacheDir, promptTemplate });
          payload.messages = result.messages;
          stripped = result.strippedCount;
          outBody = JSON.stringify(payload);
          stats.strippedImages += stripped;
        } catch {
          outBody = rawBytes;  // 原始字节透传,绝不阻塞
        }
      } else if (req.method === 'GET' || req.method === 'HEAD') {
        outBody = undefined;
      } else {
        outBody = req.body;  // 其它方法 stream 透传(未消费)
      }

      // 转发:透传 headers,删 host / content-length(让 fetch 重算)
      const headers = new Headers(req.headers);
      headers.delete('host');
      headers.delete('content-length');

      let upstreamResp: Response;
      try {
        upstreamResp = await fetch(targetUrl, { method: req.method, headers, body: outBody });
      } catch (err) {
        appendLog(`ERROR alias=${alias} upstream=${upstream} ${err}`);
        return new Response(`cc-linker img-proxy: 上游不可达 (${upstream}): ${err}`, { status: 502 });
      }

      stats.totalRequests++;
      appendLog(`INFO ${JSON.stringify({
        time: new Date().toISOString(), alias, method: req.method, path: url.pathname,
        stripped, upstream_status: upstreamResp.status, duration_ms: Date.now() - startedAt,
      })}`);

      // 流式透传响应(SSE 等)
      return new Response(upstreamResp.body, {
        status: upstreamResp.status,
        headers: new Headers(upstreamResp.headers),
      });
    },
  });

  appendLog(`INFO img-proxy listening on http://${hostname}:${server.port}`);
  return {
    port: server.port,
    hostname,
    stop: (force?: boolean) => { clearInterval(cleanupTimer); server.stop(force); },
    stats,
  };
}
```

- [ ] **Step 4: 运行测试,确认通过**

Run: `cd ~/Git/cc-linker && bun test tests/integration/img-proxy-server.test.ts`
Expected: PASS,6/6。

- [ ] **Step 5: typecheck + commit**

```bash
cd ~/Git/cc-linker && bun run typecheck
git add src/img-proxy/server.ts tests/integration/img-proxy-server.test.ts
git commit -m "feat(img-proxy): add reverse proxy server with image stripping, SSE passthrough, cache cleanup"
```

---

## Task 6: CLI 命令 `img-proxy.ts` + index.ts 注册

**Files:**
- Create: `src/cli/commands/img-proxy.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: 实现 CLI 命令**

创建 `src/cli/commands/img-proxy.ts`:

```typescript
import chalk from 'chalk';
import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { homedir, platform } from 'os';
import { spawnSync } from 'child_process';
import inquirer from 'inquirer';
import { config } from '../../utils/config';
import { CCLinkerError } from '../../utils/errors';
import { getExecutablePath } from '../../utils/executable';
import {
  IMG_PROXY_DIR, IMG_PROXY_CACHE_DIR, IMG_PROXY_ROUTES_PATH,
  IMG_PROXY_PID_FILE, IMG_PROXY_LOG_FILE,
} from '../../utils/paths';
import { installProvider, uninstallProvider, isProviderInstalled } from '../../img-proxy/provider-config';
import { loadRoutes, removeRoute } from '../../img-proxy/routes';
import { scanProviderFiles } from '../../img-proxy/provider-scan';
import { startProxyServer } from '../../img-proxy/server';
import { DEFAULT_PROMPT_TEMPLATE } from '../../img-proxy/transform';

// ---------- 运行状态 ----------
function isRunning(): boolean {
  if (!existsSync(IMG_PROXY_PID_FILE)) return false;
  try {
    process.kill(parseInt(readFileSync(IMG_PROXY_PID_FILE, 'utf8').trim(), 10), 0);
    return true;
  } catch { return false; }
}
function readPid(): number { return parseInt(readFileSync(IMG_PROXY_PID_FILE, 'utf8').trim(), 10); }

// ---------- start ----------
export async function imgProxyStart(opts: { daemon?: boolean }): Promise<void> {
  if (!config.get<boolean>('img_proxy.enabled', true)) {
    console.log(chalk.yellow('⚠️  img_proxy.enabled = false,请在 config.toml 开启'));
    process.exit(1);
  }
  const port = config.get<number>('img_proxy.port', 8765);
  const hostname = config.get<string>('img_proxy.hostname', '127.0.0.1');
  const isChild = process.env.CC_LINKER_IMG_PROXY_DAEMON === '1';

  // 分支 1:parent(用户带 --daemon 且当前不是 child)→ spawn child 后退出
  if (opts.daemon && !isChild) {
    if (isRunning()) {
      console.log(chalk.yellow(`⚠️  代理已在运行 (PID: ${readPid()})`));
      return;
    }
    const { spawn } = await import('child_process');
    const child = spawn(getExecutablePath(), ['img-proxy', 'start'], {
      detached: true, stdio: 'ignore',
      env: { ...process.env, CC_LINKER_IMG_PROXY_DAEMON: '1' },
    });
    child.unref();
    await new Promise(r => setTimeout(r, 1200));
    if (!existsSync(IMG_PROXY_PID_FILE)) {
      console.log(chalk.red('❌ 后台启动失败,查看日志: ' + IMG_PROXY_LOG_FILE));
      process.exit(1);
    }
    console.log(chalk.green(`✅ img-proxy 已在后台启动 (PID: ${readPid()})`));
    console.log(chalk.cyan(`   监听: http://${hostname}:${port}`));
    console.log(chalk.cyan(`   日志: ${IMG_PROXY_LOG_FILE}   停止: cc-linker img-proxy stop`));
    process.exit(0);
  }

  // 分支 2/3:child 或前台 → 起 server
  if (isRunning()) {
    console.error(chalk.yellow(`⚠️  代理已在运行 (PID: ${readPid()})`));
    process.exit(0);
  }
  mkdirSync(dirname(IMG_PROXY_PID_FILE), { recursive: true });
  writeFileSync(IMG_PROXY_PID_FILE, String(process.pid), { mode: 0o600 });

  // 仅 child 重写 console 到日志;前台保留终端输出
  let logWriter: any = null;
  if (isChild) {
    logWriter = Bun.file(IMG_PROXY_LOG_FILE).writer();
    const flush = (level: string, msg: string) => {
      logWriter.write(`[${new Date().toISOString()}] [${level}] ${msg}\n`);
      logWriter.flush();
    };
    console.log = (...a: any[]) => flush('INFO', a.join(' '));
    console.error = (...a: any[]) => flush('ERROR', a.join(' '));
    console.warn = (...a: any[]) => flush('WARN', a.join(' '));
  }

  const routes = loadRoutes(IMG_PROXY_ROUTES_PATH).routes;
  if (Object.keys(routes).length === 0) {
    (isChild ? console.log : console.warn)(
      isChild ? 'WARN 路由表为空,代理会转发失败。先 cc-linker img-proxy install' : chalk.yellow('⚠️  路由表为空,代理会转发失败。先 cc-linker img-proxy install'),
    );
  }

  let server;
  try {
    server = await startProxyServer({
      port, hostname,
      cacheDir: IMG_PROXY_CACHE_DIR,
      routesPath: IMG_PROXY_ROUTES_PATH,
      promptTemplate: config.get<string>('img_proxy.prompt_template', DEFAULT_PROMPT_TEMPLATE),
      consoleEnabled: config.get<boolean>('img_proxy.console_enabled', false),
      cacheMaxAgeHours: config.get<number>('img_proxy.cache_max_age_hours', 168),
    });
  } catch (err) {
    console.error(chalk.red(`❌ 启动失败: ${err}`));
    console.error(chalk.gray(`   常见原因: 端口 ${port} 被占用 → cc-linker img-proxy stop,或改 config.toml [img_proxy].port`));
    try { if (existsSync(IMG_PROXY_PID_FILE)) unlinkSync(IMG_PROXY_PID_FILE); } catch {}
    process.exit(1);
  }

  console.log(chalk.green(`✅ img-proxy 监听 http://${hostname}:${server.port} (PID ${process.pid})`));

  const cleanup = (sig: string) => {
    try { server.stop(true); } catch {}
    try { if (existsSync(IMG_PROXY_PID_FILE)) unlinkSync(IMG_PROXY_PID_FILE); } catch {}
    process.exit(0);
  };
  process.on('SIGTERM', () => cleanup('SIGTERM'));
  process.on('SIGINT', () => cleanup('SIGINT'));
  process.on('SIGHUP', () => {});

  // child 定期 flush;前台靠 server 监听保活
  if (isChild) setInterval(() => { try { logWriter.flush(); } catch {} }, 5000);
}
```

install / uninstall / status / daemon 部分(接在同一文件):

```typescript
// ---------- stop ----------
export async function imgProxyStop(): Promise<void> {
  const plistPath = launchdPlistPath();
  if (existsSync(plistPath)) { try { spawnSync('launchctl', ['unload', plistPath]); } catch {} }
  if (existsSync(IMG_PROXY_PID_FILE)) {
    const pid = readPid();
    console.log(chalk.cyan(`正在停止 img-proxy (PID: ${pid})...`));
    try {
      process.kill(pid, 'SIGTERM');
      for (let i = 0; i < 20; i++) {
        try { process.kill(pid, 0); await new Promise(r => setTimeout(r, 300)); }
        catch { break; }
      }
      try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } catch {}
      console.log(chalk.green(`✅ img-proxy (PID: ${pid}) 已停止`));
    } catch { console.log(chalk.yellow('⚠️  进程不存在,清理 PID 文件')); }
    try { if (existsSync(IMG_PROXY_PID_FILE)) unlinkSync(IMG_PROXY_PID_FILE); } catch {}
  } else {
    console.log(chalk.yellow('⚠️  img-proxy 未在运行'));
  }
}

// ---------- status ----------
export async function imgProxyStatus(): Promise<void> {
  console.log(chalk.blue('=== cc-linker img-proxy 状态 ===\n'));
  console.log(isRunning() ? chalk.green(`✅ 运行中 (PID: ${readPid()})`) : chalk.yellow('⚠️  未运行 (cc-linker img-proxy start --daemon)'));
  const port = config.get<number>('img_proxy.port', 8765);
  const hostname = config.get<string>('img_proxy.hostname', '127.0.0.1');
  console.log(chalk.gray(`   监听: http://${hostname}:${port}   日志: ${IMG_PROXY_LOG_FILE}`));

  const routes = Object.values(loadRoutes(IMG_PROXY_ROUTES_PATH).routes);
  console.log(chalk.cyan(`\n已 install 的 provider (${routes.length}):`));
  for (const r of routes) console.log(`   • ${chalk.green(r.alias)}  →  ${chalk.gray(r.upstream)}`);
  if (routes.length === 0) console.log(chalk.gray('   (无) —— 执行 cc-linker img-proxy install'));

  // 未纳入代理的 provider(有 .json 但没 install)
  const all = scanProviderFiles();
  const installed = new Set(routes.map(r => r.alias));
  const missing = all.filter(p => !installed.has(p.alias) && p.baseUrl);
  if (missing.length > 0) {
    console.log(chalk.cyan(`\n未纳入代理的 provider (${missing.length}):`));
    for (const p of missing) console.log(chalk.gray(`   · ${p.alias}`));
  }

  if (platform() === 'darwin') {
    console.log(chalk.cyan('\n开机自启:'));
    console.log(existsSync(launchdPlistPath()) ? chalk.green('   ✅ launchd 已配置') : chalk.gray('   未配置 (cc-linker img-proxy daemon install)'));
  }
}

// ---------- install / uninstall ----------
export async function imgProxyInstall(opts: { providers?: string; all?: boolean }): Promise<void> {
  const port = config.get<number>('img_proxy.port', 8765);
  const hostname = config.get<string>('img_proxy.hostname', '127.0.0.1');
  const all = scanProviderFiles().filter(p => p.baseUrl);  // 没 BASE_URL 的跳过
  if (all.length === 0) throw new CCLinkerError('E_IMG_PROXY_NO_PROVIDERS', '未扫描到带 ANTHROPIC_BASE_URL 的 provider');

  let targets: { alias: string; path: string; baseUrl: string }[];
  if (opts.all) {
    targets = all.map(p => ({ alias: p.alias, path: p.path, baseUrl: p.baseUrl }));
  } else if (opts.providers) {
    const wanted = opts.providers.split(',').map(s => s.trim()).filter(Boolean);
    targets = wanted.map(a => {
      const p = all.find(x => x.alias === a);
      if (!p) throw new CCLinkerError('E_IMG_PROXY_UNKNOWN_ALIAS', `未找到 provider 文件 ${a}.json`);
      return { alias: p.alias, path: p.path, baseUrl: p.baseUrl };
    });
  } else {
    const choices = all.map(p => ({
      name: `${p.alias}  ${isProviderInstalled(p.path, port, hostname) ? chalk.green('(已 install)') : chalk.gray(p.baseUrl)}`,
      value: p.alias, short: p.alias,
    }));
    const { picks } = await inquirer.prompt([{ type: 'checkbox', name: 'picks', message: '选择要启用图片剥离代理的 provider (空格勾选):', choices, pageSize: 20 }]);
    if (picks.length === 0) { console.log(chalk.gray('未选择')); return; }
    targets = (picks as string[]).map(a => { const p = all.find(x => x.alias === a)!; return { alias: p.alias, path: p.path, baseUrl: p.baseUrl }; });
  }

  console.log(chalk.blue(`\n安装图片代理到 ${targets.length} 个 provider...\n`));
  let installed = 0, skipped = 0;
  for (const t of targets) {
    if (isProviderInstalled(t.path, port, hostname)) {
      console.log(chalk.gray(`  ⊘ ${t.alias}  已 install,跳过`)); skipped++; continue;
    }
    try {
      installProvider({ providerPath: t.path, alias: t.alias, routesPath: IMG_PROXY_ROUTES_PATH, port, hostname });
      console.log(chalk.green(`  ✅ ${t.alias}  ${t.baseUrl}  →  http://${hostname}:${port}/${t.alias}`));
      installed++;
    } catch (err) {
      console.log(chalk.red(`  ❌ ${t.alias}  ${err}`));
    }
  }
  console.log(chalk.green(`\n完成: ${installed} 新装, ${skipped} 已存在。启动: cc-linker img-proxy start --daemon`));
}

export async function imgProxyUninstall(opts: { providers?: string; all?: boolean }): Promise<void> {
  const installedRoutes = Object.values(loadRoutes(IMG_PROXY_ROUTES_PATH).routes);
  let targets: { alias: string; path: string }[];
  if (opts.all) {
    targets = installedRoutes.map(r => ({ alias: r.alias, path: r.provider_path }));
  } else if (opts.providers) {
    targets = opts.providers.split(',').map(s => s.trim()).filter(Boolean).map(a => {
      const r = installedRoutes.find(x => x.alias === a);
      return { alias: a, path: r?.provider_path ?? '' };
    });
  } else {
    if (installedRoutes.length === 0) { console.log(chalk.gray('没有已 install 的 provider')); return; }
    const { picks } = await inquirer.prompt([{ type: 'checkbox', name: 'picks', message: '选择要还原的 provider:', choices: installedRoutes.map(r => ({ name: r.alias, value: r.alias })) }]);
    targets = (picks as string[]).map(a => { const r = installedRoutes.find(x => x.alias === a)!; return { alias: a, path: r?.provider_path ?? '' }; });
  }
  for (const t of targets) {
    try {
      uninstallProvider({ providerPath: t.path, alias: t.alias, routesPath: IMG_PROXY_ROUTES_PATH });
      console.log(chalk.green(`  ✅ 还原 ${t.alias}`));
    } catch (err) {
      removeRoute(IMG_PROXY_ROUTES_PATH, t.alias);
      console.log(chalk.yellow(`  ⚠ ${t.alias}  ${err} (已清理路由)`));
    }
  }
  console.log(chalk.green('\n完成。'));
}

// ---------- launchd daemon ----------
function launchdPlistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', 'com.cclinker.img-proxy.plist');
}

export async function imgProxyDaemonInstall(): Promise<void> {
  if (platform() !== 'darwin') { console.log(chalk.red('目前仅支持 macOS launchd 自启')); process.exit(1); }
  const exe = getExecutablePath();
  // ProgramArguments 不带 --daemon,改用 env 注入 CC_LINKER_IMG_PROXY_DAEMON=1
  // → launchd 直接起 child,不双重 fork,KeepAlive 崩溃重拉的也是 child
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.cclinker.img-proxy</string>
  <key>ProgramArguments</key>
  <array>
    <string>${exe}</string>
    <string>img-proxy</string>
    <string>start</string>
  </array>
  <key>WorkingDirectory</key><string>${homedir()}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${IMG_PROXY_LOG_FILE}</string>
  <key>StandardErrorPath</key><string>${IMG_PROXY_LOG_FILE}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CC_LINKER_IMG_PROXY_DAEMON</key><string>1</string>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:${process.env.PATH ?? ''}</string>
  </dict>
</dict>
</plist>`;
  mkdirSync(dirname(launchdPlistPath()), { recursive: true });
  if (existsSync(launchdPlistPath())) spawnSync('launchctl', ['unload', launchdPlistPath()]);
  writeFileSync(launchdPlistPath(), plist, { mode: 0o644 });
  spawnSync('launchctl', ['load', launchdPlistPath()]);
  spawnSync('launchctl', ['start', 'com.cclinker.img-proxy']);
  console.log(chalk.green('✅ img-proxy 开机自启已配置 (KeepAlive,崩溃 10s 内自拉起)'));
  console.log(chalk.cyan(`   ${launchdPlistPath()}`));
  console.log(chalk.gray('   卸载: cc-linker img-proxy daemon uninstall'));
}

export async function imgProxyDaemonUninstall(): Promise<void> {
  if (!existsSync(launchdPlistPath())) { console.log(chalk.yellow('未配置 launchd')); return; }
  spawnSync('launchctl', ['unload', launchdPlistPath()]);
  unlinkSync(launchdPlistPath());
  console.log(chalk.green('✅ img-proxy 开机自启已卸载'));
}
```

> 写入 `src/cli/commands/img-proxy.ts` 时,把上面的 start 段和下面的 install/uninstall/status/daemon 段合并为单文件,确保 import 只在顶部出现一次、无重复声明。

- [ ] **Step 2: 在 index.ts 注册子命令树**

在 `src/index.ts` 顶部 import 区(其它 command import 附近)加:

```typescript
import {
  imgProxyStart, imgProxyStop, imgProxyStatus,
  imgProxyInstall, imgProxyUninstall,
  imgProxyDaemonInstall, imgProxyDaemonUninstall,
} from './cli/commands/img-proxy';
```

在 `daemonCmd` 定义**之后**、`program.command('setup')` **之前**加:

```typescript
const imgProxyCmd = program.command('img-proxy').description('管理图片剥离代理 (让纯文本模型接受粘贴图片)');
imgProxyCmd.command('install')
  .description('把选定 provider 的 BASE_URL 改写为指向本地代理')
  .option('-p, --providers <aliases>', '逗号分隔的 provider 文件名 stem')
  .option('--all', '全部 provider')
  .action((opts) => imgProxyInstall(opts));
imgProxyCmd.command('uninstall')
  .description('还原 provider 的 BASE_URL')
  .option('-p, --providers <aliases>', '逗号分隔的 provider 文件名 stem')
  .option('--all', '全部已 install 的 provider')
  .action((opts) => imgProxyUninstall(opts));
imgProxyCmd.command('start')
  .description('启动代理 (前台;加 --daemon 后台)')
  .option('-d, --daemon', '后台运行')
  .action((opts) => imgProxyStart(opts));
imgProxyCmd.command('stop').description('停止代理').action(() => imgProxyStop());
imgProxyCmd.command('status').description('查看代理状态').action(() => imgProxyStatus());
const imgProxyDaemonCmd = imgProxyCmd.command('daemon').description('开机自启管理 (macOS launchd)');
imgProxyDaemonCmd.command('install').description('配置开机自启').action(() => imgProxyDaemonInstall());
imgProxyDaemonCmd.command('uninstall').description('卸载开机自启').action(() => imgProxyDaemonUninstall());
```

- [ ] **Step 3: typecheck**

Run: `cd ~/Git/cc-linker && bun run typecheck`
Expected: 0 报错。

- [ ] **Step 4: 跑全部测试确认无回归**

Run: `cd ~/Git/cc-linker && bun test`
Expected: 全部通过(含新 img-proxy 测试)。

- [ ] **Step 5: 手动冒烟**

Run: `cd ~/Git/cc-linker && bun run dev img-proxy --help && bun run dev img-proxy status`
Expected: `--help` 列出 install/uninstall/start/stop/status/daemon;`status` 打印面板(未运行 / 路由为空 / 未纳入代理的 provider 列表)。

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/img-proxy.ts src/index.ts
git commit -m "feat(img-proxy): add cc-linker img-proxy CLI (3-way start, launchd no-double-fork)"
```

---

## Task 7: 端到端验收 + 文档

**Files:**
- Modify: `CLAUDE.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: 安全端到端验收(不动真实 provider,手写 routes.json)**

```bash
cd ~/Git/cc-linker

# 1. 手写 routes.json 指向真实上游(ARK /api/plan)
mkdir -p ~/.cc-linker/img-proxy
cat > ~/.cc-linker/img-proxy/routes.json <<'EOF'
{
  "version": 1,
  "routes": {
    "byte-agent-glm": {
      "alias": "byte-agent-glm",
      "upstream": "https://ark.cn-beijing.volces.com/api/plan",
      "provider_path": "/dev/null",
      "original_base_url": "https://ark.cn-beijing.volces.com/api/plan",
      "installed_at": "2026-07-04T00:00:00.000Z"
    }
  }
}
EOF

# 2. 前台起代理(终端会显示监听日志,说明 console 没被吞 —— 验证 M2 修正)
bun run dev img-proxy start
# 看到 "✅ img-proxy 监听 http://127.0.0.1:8765 ..." → 另开终端跑下面 curl
```

另开终端,**go/no-go 检查点**——验证 Claude Code 风格的 path 拼接 + image 剥离:

```bash
TOKEN=$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.claude/providers/byte-agent-glm.json')))['env']['ANTHROPIC_AUTH_TOKEN'])")
B64="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

curl -sS -X POST "http://127.0.0.1:8765/byte-agent-glm/v1/messages" \
  -H "content-type: application/json" \
  -H "authorization: Bearer ${TOKEN}" \
  -d "{\"model\":\"glm-5.2[1m]\",\"max_tokens\":64,\"stream\":false,\"messages\":[{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"这张图里有什么\"},{\"type\":\"image\",\"source\":{\"type\":\"base64\",\"media_type\":\"image/png\",\"data\":\"${B64}\"}}]}]}" \
  | python3 -m json.tool 2>/dev/null | head -40
```

Expected(全部满足才算 Phase 1 验收通过):
- 不再返回 image-unsupported / 4xx。
- 响应是模型的正常文本输出。
- 代理日志 `~/.cc-linker/img-proxy/img-proxy.log` 出现 `"stripped":1`。
- `~/.cc-linker/img-proxy/cache/` 出现 1 个 `.png` 文件。

**4. 再测 `stream:true`(SSE 透传 —— 真实 Claude Code 默认 stream)**

```bash
curl -sS -N -X POST "http://127.0.0.1:8765/byte-agent-glm/v1/messages" \
  -H "content-type: application/json" \
  -H "authorization: Bearer ${TOKEN}" \
  -d "{\"model\":\"glm-5.2[1m]\",\"max_tokens\":64,\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":\"你好\"}]}" \
  | head -20
```
Expected: 打印 `event: message_start` / `content_block_delta` / `message_stop` 的 SSE 流,无 4xx(确认流式透传对真实上游工作)。

> **若 502 unknown alias**:说明 Claude Code 发请求时 BASE_URL 的 path 段被丢弃了(path 路由前提不成立)——这是 go/no-go 点。需改用"子路径不依赖"方案(超出本 plan 范围,需重新设计)。但现有 ARK provider URL 带 `/api/plan` path 能正常工作,已强烈佐证 Claude Code 保留 path,此分支几乎不会触发。

Ctrl-C 停前台代理。清理验收 routes.json:

```bash
rm ~/.cc-linker/img-proxy/routes.json
```

- [ ] **Step 2: 更新 CLAUDE.md**

在 `~/Git/cc-linker/CLAUDE.md` 的 "Important Files" 表格追加:

```markdown
| `src/img-proxy/server.ts` | Image-block stripping reverse proxy (Bun.serve) — lets text-only models accept pasted images |
| `src/cli/commands/img-proxy.ts` | `cc-linker img-proxy install/uninstall/start/stop/status/daemon` |
```

在 "High-Level Architecture" 末尾("Agent View" 段之后)追加:

```markdown
### CLI Image Proxy

`cc-linker img-proxy` runs a local reverse proxy on `ANTHROPIC_BASE_URL` that strips inline `image` content blocks from Claude Code requests, saves them to `~/.cc-linker/img-proxy/cache/`, and replaces each with a text block containing the local path (so text-only models like glm-5.2 don't 4xx and can call an image-recognition MCP tool themselves).

- **Routing key = provider filename stem** (`byte-agent-glm.json` → `/byte-agent-glm`), NOT `ProviderManager.generateShortAlias` (which truncates/conflicts). Scan via `src/img-proxy/provider-scan.ts`.
- **Survivability**: launchd `KeepAlive` (Label `com.cclinker.img-proxy`) restarts on crash. Plist injects `CC_LINKER_IMG_PROXY_DAEMON=1` so launchd starts the child directly — no double-fork. `install` writes a `.bak`; `uninstall` restores BASE_URL (keeping current token) and deletes `.bak`.
- Phase 1 (this) ships proxy + CLI. Phase 2 adds the web monitoring console (`/` + `/admin/api/*`, judgment already hoisted above alias parsing in `server.ts`).
```

- [ ] **Step 3: 更新 CHANGELOG.md**

在 `~/Git/cc-linker/CHANGELOG.md` 顶部(`## [0.7.5]` 之上)插入:

```markdown
## [Unreleased]

### Added

- **CLI Image Proxy (`cc-linker img-proxy`)** — 让纯文本模型(glm-5.2 等)也能在
  Claude Code CLI 里接受粘贴的图片。在 `ANTHROPIC_BASE_URL` 链路上插一层本地反向
  代理,拦截出站请求里的 inline `image` content block,落盘到
  `~/.cc-linker/img-proxy/cache/`,替换成"图片本地路径 + 引导调 MCP 识别"的 text
  block,再转发给真实上游。
  - 路由键 = **provider 文件名 stem**(`byte-agent-glm.json` → `/byte-agent-glm`),
    不用 `ProviderManager.generateShortAlias`(它会截断/冲突)。
  - `src/img-proxy/server.ts` — `Bun.serve` 反向代理,SSE 流式透传,启动+定时清缓存,
    内存计数(Phase 2 控制台读)。
  - `src/img-proxy/transform.ts` — 剥离 base64 image block 落盘的纯函数;`{path}`
    模板缺失时回退默认文案(避免空 text block)。
  - `src/img-proxy/provider-config.ts` — install/uninstall 改写 BASE_URL,`.bak`
    生命周期:install 写、uninstall 还原后删除(token 永远从当前文件读)。
  - `cc-linker img-proxy install [--providers|--all] / uninstall / start [--daemon] /
    stop / status / daemon install|uninstall`。daemon 三分支(child/parent/前台),
    launchd 用 env 注入避免双重 fork。
  - Phase 2(后续 plan)将叠加 Web 监控控制台。
```

- [ ] **Step 4: 最终全量测试 + typecheck**

Run: `cd ~/Git/cc-linker && bun run typecheck && bun test`
Expected: 0 typecheck 报错,全部测试通过。

- [ ] **Step 5: Commit**

```bash
cd ~/Git/cc-linker
git add CLAUDE.md CHANGELOG.md
git commit -m "docs(img-proxy): document CLI image proxy module and changelog entry"
```

- [ ] **Step 6: 部署到全局**

```bash
cd ~/Git/cc-linker && bun run build:npm && node scripts/deploy-local.js
cc-linker img-proxy status   # 验证全局可用
```

---

## Self-Review(修订版)

**对照 11 条修订:**
1. ✅ alias=文件名 stem:Task 3 `provider-scan.ts`(`alias = basename(f, '.json')`),CLI/path/路由/文档全部用 stem。
2. ✅ launchd 不双重 fork:Task 6 plist `ProgramArguments=[exe,img-proxy,start]` + `EnvironmentVariables` 注入 `CC_LINKER_IMG_PROXY_DAEMON=1`。
3. ✅ `.bak` 还原后删:Task 4 `uninstallProvider` 末尾 `unlinkSync(bakPath)`,测试 `'deletes .bak'` + `'cleans route+bak'` 覆盖。
4. ✅ 缓存清理:Task 5 `cleanupOldCache` 启动 + 每 1h `setInterval`,`stop()` 时 `clearInterval`。
5. ✅ arrayBuffer body:Task 5 `const rawBytes = new Uint8Array(await req.arrayBuffer())`,catch 用 `rawBytes`;测试 `'malformed JSON'` 覆盖。
6. ✅ console 仅 child 重写:Task 6 `if (isChild) { 重写 console }`,前台保留;测试靠 Task 7 Step 1 冒烟(前台看到 `✅ 监听`)。
7. ✅ getExecutablePath 抽共享:Task 1 `src/utils/executable.ts`,Task 6 import;start.ts/daemon.ts 暂不动(降低回归)。
8. ✅ 内存计数:Task 5 `stats = {totalRequests, strippedImages}`,无 state.json 读写(paths.ts 未加 STATE 常量)。
9. ✅ 控制台路由前置:Task 5 `if (consoleEnabled && pathname=='/'||startsWith('/admin'))` 在 alias 解析之前。
10. ✅ 测试 GET/HEAD + 重置:Task 5 `beforeEach` 重置 lastMethod/lastBody/lastHeaders;`'GET ... passes through'` 断言 method=GET、path、body=null。
11. ✅ 文档/示例一致:Task 7 CLAUDE.md/CHANGELOG 用 `byte-agent-glm`(stem)。

**Placeholder scan:** 无 TBD/TODO/shim。每个代码步骤完整可跑。

**Type consistency:** `scanProviderFiles()→ProviderFileInfo[]`、`installProvider(opts)`/`uninstallProvider(opts)`/`isProviderInstalled()`、`startProxyServer(opts)→{port,hostname,stop,stats}`、`stripImagesToPaths(msgs,opts)→TransformResult`——跨 task 签名一致。

**遗留风险(执行时注意):**
- Task 6 Step 1 的 `img-proxy.ts` 因长度分两段展示(start 段 + install/uninstall/status/daemon 段),合并为单文件时确保 import 只在顶部一份、无重复声明。
- Task 7 Step 1 是 go/no-go:path 拼接前提。若 502 unknown alias,需停下重新设计。

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-04-cli-image-proxy.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — 每个 task 派 fresh subagent,task 间 review。适合本计划(task 边界清晰 + TDD 自验证)。

**2. Inline Execution** — 当前会话批量执行带检查点。

**哪种?**

> Task 7 Step 1 验收会真实发请求到 ARK(消耗少量 token),但用"手写 routes.json"安全路径,不动真实 provider 文件。Phase 2(控制台)在本计划合并后再起。
