# cc-linker img-proxy 智能安装 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `cc-linker img-proxy install` 一条命令适配所有用户类型(纯 CC Switch / 自定义 alias / 混合),自动跳过 multimodal 模型,自动装 wrapper。

**Architecture:** 新增 `classify.ts`(模型分类)+ `aliases.ts`(shell alias 发现)+ `wrapper.ts`(wrapper 函数生成),改造 `imgProxyInstall` 走 smart 流程(4 路发现 → 分类 → inquirer → 装),setup wizard 调 smart install。

**Tech Stack:** Bun + bun:test + inquirer + chalk。沿用现有 `routes.ts` 3 态 install 机器。

**Spec reference:** `docs/superpowers/specs/2026-07-04-img-proxy-smart-install-design.md`(1225 行,权威设计)

**工作目录:** `/Users/wuyujun/Git/cc-linker`(分支 `feat/cli-image-proxy`)

---

## Phase A: 基础模块(可独立测试)

### Task 1: 实现 `src/img-proxy/classify.ts`

**Files:**
- Create: `src/img-proxy/classify.ts`
- Test: `tests/unit/img-proxy/classify.test.ts`

**依赖:** 无

- [ ] **Step 1: 写失败的测试**

创建 `tests/unit/img-proxy/classify.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test';
import { classifyModel } from '../../../src/img-proxy/classify';

describe('classifyModel — 内置 patterns', () => {
  // Multimodal
  test('claude-3-5-sonnet 是 multimodal', () => {
    expect(classifyModel('claude-3-5-sonnet-20241022')).toBe('multimodal');
  });
  test('claude-opus-4 是 multimodal', () => {
    expect(classifyModel('claude-opus-4[1m]')).toBe('multimodal');
  });
  test('gpt-4o 是 multimodal', () => {
    expect(classifyModel('gpt-4o')).toBe('multimodal');
  });
  test('qwen-vl-plus 是 multimodal', () => {
    expect(classifyModel('qwen-vl-plus')).toBe('multimodal');
  });
  test('qwen3.6-plus[1m] 是 multimodal', () => {
    expect(classifyModel('qwen3.6-plus[1m]')).toBe('multimodal');
  });
  test('qwen3.7-plus[1m] 是 multimodal', () => {
    expect(classifyModel('qwen3.7-plus[1m]')).toBe('multimodal');
  });
  test('glm-4v-plus 是 multimodal', () => {
    expect(classifyModel('glm-4v-plus')).toBe('multimodal');
  });
  test('glm-4.5v 是 multimodal', () => {
    expect(classifyModel('glm-4.5v')).toBe('multimodal');
  });
  test('kimi-for-coding[256k] 是 multimodal', () => {
    expect(classifyModel('kimi-for-coding[256k]')).toBe('multimodal');
  });
  test('MiniMax-M3[1m] 是 multimodal', () => {
    expect(classifyModel('MiniMax-M3[1m]')).toBe('multimodal');
  });
  test('mimo-v2.5[1m] 是 multimodal(base 不带 pro)', () => {
    expect(classifyModel('mimo-v2.5[1m]')).toBe('multimodal');
  });
  test('mimo-v2.5-pro[1m] 是 text-only(负向 lookahead)', () => {
    expect(classifyModel('mimo-v2.5-pro[1m]')).toBe('text-only');
  });

  // Text-only
  test('glm-5.2[1m] 是 text-only', () => {
    expect(classifyModel('glm-5.2[1m]')).toBe('text-only');
  });
  test('glm-5.1 是 text-only', () => {
    expect(classifyModel('glm-5.1')).toBe('text-only');
  });
  test('glm-4.5 是 text-only', () => {
    expect(classifyModel('glm-4.5')).toBe('text-only');
  });
  test('deepseek-v4-pro[1m] 是 text-only', () => {
    expect(classifyModel('deepseek-v4-pro[1m]')).toBe('text-only');
  });
  test('qwen3.7-max[1m] 是 text-only(NOT -plus)', () => {
    expect(classifyModel('qwen3.7-max[1m]')).toBe('text-only');
  });
  test('MiniMax-M2.5[1m] 是 text-only', () => {
    expect(classifyModel('MiniMax-M2.5[1m]')).toBe('text-only');
  });

  // Unknown
  test('some-new-model[1m] 是 unknown', () => {
    expect(classifyModel('some-new-model[1m]')).toBe('unknown');
  });
  test('空字符串 是 unknown', () => {
    expect(classifyModel('')).toBe('unknown');
  });
});

describe('classifyModel — extra patterns(config override)', () => {
  test('visionPatterns_extra 把 my-vl-test 标 multimodal', () => {
    expect(classifyModel('my-vl-test', { visionPatterns: ['my-vl-.*'] })).toBe('multimodal');
  });
  test('textOnlyPatterns_extra 把 my-text 标 text-only', () => {
    expect(classifyModel('my-text-1', { textOnlyPatterns: ['my-text-.*'] })).toBe('text-only');
  });
});

describe('classifyModel — 后缀剥离', () => {
  test('[1m] 后缀被剥掉', () => {
    expect(classifyModel('glm-5.2[1m]')).toBe('text-only');  // 等同 glm-5.2
  });
  test('[256k] 后缀被剥掉', () => {
    expect(classifyModel('kimi-for-coding[256k]')).toBe('multimodal');
  });
  test('[128k] 后缀被剥掉', () => {
    expect(classifyModel('glm-4.5[128k]')).toBe('text-only');
  });
  test('大小写不敏感', () => {
    expect(classifyModel('GLM-5.2[1M]')).toBe('text-only');
  });
});
```

- [ ] **Step 2: 跑测试,确认失败**

```bash
bun test tests/unit/img-proxy/classify.test.ts
```

Expected: FAIL with "Cannot find module '../../../src/img-proxy/classify'"(模块不存在)

- [ ] **Step 3: 实现 classify.ts**

创建 `src/img-proxy/classify.ts`,内容**完全照搬** spec §4:

```typescript
export type ModelKind = 'multimodal' | 'text-only' | 'unknown';

const MULTIMODAL_PATTERNS: RegExp[] = [
  // === Anthropic Claude ===
  /^claude-3/i, /^claude-opus/i, /^claude-sonnet/i, /^claude-haiku/i,
  // === OpenAI GPT-4 ===
  /^gpt-4/i,
  // === Google Gemini ===
  /^gemini-.*vision/i, /^gemini-1\.5-pro/i,
  // === Alibaba Qwen ===
  /^qwen.*-vl/i, /^qwen.*-omni/i,
  /^qwen3\.\d+(\.\d+)?-plus/i,
  // === Zhipu GLM(只有 -V 后缀变体)===
  /^glm-.*-?v/i,
  // === Moonshot Kimi ===
  /^kimi/i,
  // === MiniMax ===
  /^MiniMax-M3/i,
  // === Xiaomi MiMo(只有 base,不带 pro)===
  /^mimo-v\d+(\.\d+)?(?!-pro)/i,
  // === ByteDance ===
  /^doubao.*-vision/i, /^seed.*-vision/i,
  // === Stepfun / Hunyuan / ERNIE ===
  /^step-1v/i, /^step.*-vision/i,
  /^hunyuan.*-vision/i, /^ernie-.*-vision/i,
  // === 通用 vision 标记 ===
  /-vision$/i, /-vl-/i, /-vlm/i,
];

const TEXT_ONLY_PATTERNS: RegExp[] = [
  // === GLM(NOT 4v/4.5v)===
  /^glm-\d+(\.\d+)?$/i,
  /^glm-4-(air|turbo)/i,
  // === DeepSeek ===
  /^deepseek/i,
  // === Qwen 文本变体 ===
  /^qwen-turbo/i, /^qwen-max/i, /^qwen-long/i, /^qwen-coder/i,
  /^qwen3.*-coder/i,
  /^qwen3\.\d+(\.\d+)?-max/i,
  // === Moonshot legacy ===
  /^moonshot-v1-/i,
  // === 国内 LLM 厂商(文本)===
  /^baichuan/i, /^yi-/i,
  // === MiniMax M2 ===
  /^MiniMax-M2/i, /^MiniMax-Text-/i, /^abab/i,
  // === Xiaomi MiMo Pro ===
  /^mimo-.*-pro/i,
  // === OpenAI 老版本 ===
  /^(gpt-3|gpt-3\.5)/i,
];

export function classifyModel(
  modelName: string,
  extra?: { visionPatterns?: string[]; textOnlyPatterns?: string[] }
): ModelKind {
  // 先剥掉尾部的 [quantifier]:[1m]、[256k] 等
  const baseName = modelName.replace(/\[[^\]]*\]\s*$/, '').trim();

  const multimodal = [
    ...MULTIMODAL_PATTERNS,
    ...(extra?.visionPatterns ?? []).map(p => new RegExp(p, 'i')),
  ];
  const textOnly = [
    ...TEXT_ONLY_PATTERNS,
    ...(extra?.textOnlyPatterns ?? []).map(p => new RegExp(p, 'i')),
  ];

  if (multimodal.some(p => p.test(baseName))) return 'multimodal';
  if (textOnly.some(p => p.test(baseName))) return 'text-only';
  return 'unknown';
}
```

- [ ] **Step 4: 跑测试,确认通过**

```bash
bun test tests/unit/img-proxy/classify.test.ts
```

Expected: PASS(30+ tests)

- [ ] **Step 5: 跑全量测试,确保没破坏其它**

```bash
bun test
```

Expected: PASS(spec §11 列的所有现有 test)

- [ ] **Step 6: Commit**

```bash
git add src/img-proxy/classify.ts tests/unit/img-proxy/classify.test.ts
git commit -m "feat(img-proxy): add classifyModel with 23+ built-in patterns"
```

---

### Task 2: 实现 `src/img-proxy/aliases.ts`

**Files:**
- Create: `src/img-proxy/aliases.ts`
- Test: `tests/unit/img-proxy/aliases.test.ts`

**依赖:** 无

- [ ] **Step 1: 写失败的测试**

创建 `tests/unit/img-proxy/aliases.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test';
import { discoverShellAliases } from '../../../src/img-proxy/aliases';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function makeTmpRc(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'aliases-test-'));
  const file = join(dir, '.zshrc');
  writeFileSync(file, content);
  return file;
}

describe('discoverShellAliases', () => {
  test('空 rc 文件返回 []', () => {
    const file = makeTmpRc('');
    expect(discoverShellAliases([file])).toEqual([]);
  });

  test('单个 alias 单引号,带 --settings', () => {
    const file = makeTmpRc(`alias cc-byte-agent='claude --settings ~/.claude/providers/byte-agent-glm.json'`);
    const result = discoverShellAliases([file]);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('cc-byte-agent');
    expect(result[0]!.providerAlias).toBe('byte-agent-glm');
  });

  test('单个 alias 双引号', () => {
    const file = makeTmpRc(`alias cc-x="claude --settings /tmp/foo.json"`);
    const result = discoverShellAliases([file]);
    expect(result[0]!.providerAlias).toBe('foo');
  });

  test('无 --settings 的 alias,providerPath=null', () => {
    const file = makeTmpRc(`alias cc-y='echo hi'`);
    const result = discoverShellAliases([file]);
    expect(result[0]!.providerAlias).toBeNull();
    expect(result[0]!.providerPath).toBeNull();
  });

  test('注释行跳过', () => {
    const file = makeTmpRc(`# alias cc-z='should be ignored'`);
    expect(discoverShellAliases([file])).toEqual([]);
  });

  test('非 cc- prefix 的 alias 跳过', () => {
    const file = makeTmpRc(`alias ls='ls -la'\nalias cc-good='claude --settings /tmp/g.json'`);
    const result = discoverShellAliases([file]);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('cc-good');
  });

  test('rc 文件不存在静默跳过', () => {
    expect(discoverShellAliases(['/tmp/does-not-exist-xyz'])).toEqual([]);
  });

  test('多个 rc 文件取并集,重复去重', () => {
    const file1 = makeTmpRc(`alias cc-a='claude --settings /tmp/a.json'`);
    const file2 = makeTmpRc(`alias cc-a='claude --settings /tmp/a.json'\nalias cc-b='echo'`);
    const result = discoverShellAliases([file1, file2]);
    expect(result).toHaveLength(2);
    const names = result.map(r => r.name).sort();
    expect(names).toEqual(['cc-a', 'cc-b']);
  });
});
```

- [ ] **Step 2: 跑测试,确认失败**

```bash
bun test tests/unit/img-proxy/aliases.test.ts
```

Expected: FAIL("Cannot find module")

- [ ] **Step 3: 实现 aliases.ts**

创建 `src/img-proxy/aliases.ts`(完全照搬 spec §5):

```typescript
import { existsSync, readFileSync } from 'fs';
import { join, basename } from 'path';
import { HOME } from '../utils/paths';

export interface DiscoveredAlias {
  name: string;
  providerPath: string | null;
  providerAlias: string | null;
  command: string;
}

const SHELL_RC_FILES = ['.zshrc', '.zprofile', '.bashrc', '.bash_profile'];
const ALIAS_LINE_RE = /^alias\s+(cc-[\w-]+)\s*=\s*['"]?([^'"\n]*)['"]?\s*$/;
const SETTINGS_RE = /--settings\s+(\S+\.json)/;

export function discoverShellAliases(rcFiles?: string[]): DiscoveredAlias[] {
  const files = (rcFiles ?? defaultRcFiles()).filter(existsSync);
  const seen = new Set<string>();
  const result: DiscoveredAlias[] = [];

  for (const file of files) {
    const lines = safeReadLines(file);
    for (const line of lines) {
      if (line.trim().startsWith('#')) continue;
      const m = line.match(ALIAS_LINE_RE);
      if (!m) continue;
      const name = m[1]!;
      const cmd = m[2]!.trim();

      if (seen.has(name)) continue;
      seen.add(name);

      const settingsMatch = cmd.match(SETTINGS_RE);
      const providerPath = settingsMatch ? settingsMatch[1]! : null;
      const providerAlias = providerPath
        ? basename(providerPath, '.json')
        : null;

      result.push({ name, command: cmd, providerPath, providerAlias });
    }
  }
  return result;
}

function defaultRcFiles(): string[] {
  return SHELL_RC_FILES.map(f => join(HOME, f));
}

function safeReadLines(file: string): string[] {
  try { return readFileSync(file, 'utf8').split('\n'); }
  catch { return []; }
}
```

- [ ] **Step 4: 跑测试,确认通过**

```bash
bun test tests/unit/img-proxy/aliases.test.ts
```

Expected: PASS(8 tests)

- [ ] **Step 5: Commit**

```bash
git add src/img-proxy/aliases.ts tests/unit/img-proxy/aliases.test.ts
git commit -m "feat(img-proxy): add discoverShellAliases for cc-* aliases"
```

---

## Phase B: Routes 重构(基础设施)

### Task 3: 重命名 + 加新函数 in `routes.ts`

**Files:**
- Modify: `src/img-proxy/routes.ts:41-43`
- Test: `tests/unit/img-proxy/routes.test.ts`

**依赖:** 无

- [ ] **Step 1: 先 grep 确认无其它调用方**

```bash
grep -rn "resolveUpstream" src/ tests/
```

Expected: 只有 `src/img-proxy/routes.ts:41`(定义)和无其它调用。如果有调用方,先记录下来再继续。

- [ ] **Step 2: 写失败的测试**

创建 `tests/unit/img-proxy/routes.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { addRoute, getUpstreamByAlias, resolveProxyByUpstream } from '../../../src/img-proxy/routes';

let tmpDir: string;
let routesPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'routes-test-'));
  routesPath = join(tmpDir, 'routes.json');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true });
});

describe('getUpstreamByAlias(重命名后)', () => {
  test('找到 alias 的 upstream', () => {
    addRoute(routesPath, 'glm-5.2', 'https://open.bigmodel.cn/api/anthropic', '/tmp/glm-5.2.json');
    expect(getUpstreamByAlias(routesPath, 'glm-5.2')).toBe('https://open.bigmodel.cn/api/anthropic');
  });

  test('alias 不存在返回 null', () => {
    expect(getUpstreamByAlias(routesPath, 'nope')).toBeNull();
  });

  test('空 routes 文件返回 null', () => {
    expect(getUpstreamByAlias(routesPath, 'any')).toBeNull();
  });
});

describe('resolveProxyByUpstream(新函数)', () => {
  test('按 upstream 找到 proxy URL', () => {
    addRoute(routesPath, 'glm-5.2', 'https://open.bigmodel.cn/api/anthropic', '/tmp/glm-5.2.json');
    const result = resolveProxyByUpstream(routesPath, 8765, '127.0.0.1', 'https://open.bigmodel.cn/api/anthropic');
    expect(result).toBe('http://127.0.0.1:8765/glm-5.2');
  });

  test('upstream 不匹配返回 null', () => {
    addRoute(routesPath, 'glm-5.2', 'https://open.bigmodel.cn/api/anthropic', '/tmp/glm-5.2.json');
    const result = resolveProxyByUpstream(routesPath, 8765, '127.0.0.1', 'https://unknown.com');
    expect(result).toBeNull();
  });

  test('多个 routes 找正确的那个', () => {
    addRoute(routesPath, 'glm-5.2', 'https://open.bigmodel.cn', '/tmp/glm-5.2.json');
    addRoute(routesPath, 'kimi', 'https://api.moonshot.cn', '/tmp/kimi.json');
    expect(resolveProxyByUpstream(routesPath, 8765, '127.0.0.1', 'https://api.moonshot.cn')).toBe('http://127.0.0.1:8765/kimi');
  });

  test('空 routes 返回 null', () => {
    expect(resolveProxyByUpstream(routesPath, 8765, '127.0.0.1', 'https://any.com')).toBeNull();
  });
});
```

- [ ] **Step 3: 跑测试,确认失败**

```bash
bun test tests/unit/img-proxy/routes.test.ts
```

Expected: FAIL(`getUpstreamByAlias` 和 `resolveProxyByUpstream` 不存在)

- [ ] **Step 4: 改 routes.ts**

修改 `src/img-proxy/routes.ts`,替换第 41-43 行:

```typescript
// 重命名:resolveUpstream → getUpstreamByAlias(语义更清晰)
export function getUpstreamByAlias(path: string, alias: string): string | null {
  return loadRoutes(path).routes[alias]?.upstream ?? null;
}

// 新加:按 upstream 查 proxy URL(wrapper 调用)
export function resolveProxyByUpstream(
  routesPath: string,
  port: number,
  hostname: string,
  upstream: string
): string | null {
  const table = loadRoutes(routesPath);
  for (const [alias, entry] of Object.entries(table.routes)) {
    if (entry.upstream === upstream) {
      return `http://${hostname}:${port}/${alias}`;
    }
  }
  return null;
}
```

- [ ] **Step 5: 跑测试,确认通过**

```bash
bun test tests/unit/img-proxy/routes.test.ts
```

Expected: PASS(7 tests)

- [ ] **Step 6: 跑全量测试**

```bash
bun test
```

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/img-proxy/routes.ts tests/unit/img-proxy/routes.test.ts
git commit -m "refactor(img-proxy): rename resolveUpstream → getUpstreamByAlias + add resolveProxyByUpstream"
```

---

## Phase C: Wrapper 模块 + 路径

### Task 4: paths.ts 加新常量(WRAPPER_BACKUP_DIR + AUTO_PROVIDERS_DIR)

**Files:**
- Modify: `src/utils/paths.ts`

**依赖:** 无

- [ ] **Step 1: 加常量**

在 `src/utils/paths.ts` 末尾加:

```typescript
// Wrapper 安装时的 rc 文件备份目录
export const IMG_PROXY_WRAPPER_BACKUP_DIR = join(IMG_PROXY_DIR, 'wrapper-backups');

// CC Switch 同步出来的 provider 文件目录(共享 ProviderManager)
export const AUTO_PROVIDERS_DIR = join(CC_LINKER_DIR, 'auto-providers');
```

注:当前 `AUTO_PROVIDERS_DIR` 在 `provider-scan.ts` 里是私有 const,smart install 跨模块需要它所以提到 paths.ts。

- [ ] **Step 2: 验证编译**

```bash
bun run typecheck
```

Expected: 无 error

- [ ] **Step 3: Commit**

```bash
git add src/utils/paths.ts
git commit -m "feat(img-proxy): add IMG_PROXY_WRAPPER_BACKUP_DIR + AUTO_PROVIDERS_DIR path constants"
```

---

### Task 5: 实现 `src/img-proxy/wrapper.ts`

**Files:**
- Create: `src/img-proxy/wrapper.ts`
- Test: `tests/unit/img-proxy/wrapper.test.ts`

**依赖:** Task 4

- [ ] **Step 1: 写失败的测试**

创建 `tests/unit/img-proxy/wrapper.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  generateWrapperBlock,
  isWrapperInstalled,
  installWrapper,
  uninstallWrapper,
  WRAPPER_START_MARKER,
  WRAPPER_END_MARKER,
} from '../../../src/img-proxy/wrapper';

let tmpDir: string;
let rcFile: string;
let backupDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'wrapper-test-'));
  rcFile = join(tmpDir, '.zshrc');
  backupDir = join(tmpDir, 'backups');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true });
});

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

  test('包含递归防护(ANTHROPIC_BASE_URL 已设 → 直 exec)', () => {
    const block = generateWrapperBlock();
    expect(block).toMatch(/ANTHROPIC_BASE_URL/);
    expect(block).toContain('command claude');
  });

  test('包含调 cc-linker img-proxy current-url 和 resolve', () => {
    const block = generateWrapperBlock();
    expect(block).toContain('cc-linker img-proxy current-url');
    expect(block).toContain('cc-linker img-proxy resolve');
  });
});

describe('isWrapperInstalled', () => {
  test('rc 文件不存在返回 false', () => {
    expect(isWrapperInstalled(rcFile)).toBe(false);
  });

  test('rc 文件无 marker 返回 false', () => {
    writeFileSync(rcFile, 'alias ls="ls -la"');
    expect(isWrapperInstalled(rcFile)).toBe(false);
  });

  test('rc 文件含 start marker 返回 true', () => {
    writeFileSync(rcFile, generateWrapperBlock());
    expect(isWrapperInstalled(rcFile)).toBe(true);
  });
});

describe('installWrapper', () => {
  test('空 rc 文件写入 wrapper', () => {
    const result = installWrapper(rcFile, backupDir);
    expect(result.installed).toBe(true);
    expect(readFileSync(rcFile, 'utf8')).toContain(WRAPPER_START_MARKER);
    expect(result.backupPath).toBeUndefined();  // 没备份(原文件空)
  });

  test('非空 rc 文件:先备份后追加', () => {
    const original = 'alias ls="ls -la"\n';
    writeFileSync(rcFile, original);
    const result = installWrapper(rcFile, backupDir);
    expect(result.installed).toBe(true);
    expect(result.backupPath).toBeDefined();
    expect(existsSync(result.backupPath!)).toBe(true);
    expect(readFileSync(rcFile, 'utf8')).toContain(original);
    expect(readFileSync(rcFile, 'utf8')).toContain(WRAPPER_START_MARKER);
  });

  test('幂等:已装再装返回 installed:false', () => {
    writeFileSync(rcFile, generateWrapperBlock());
    const result = installWrapper(rcFile, backupDir);
    expect(result.installed).toBe(false);
    expect(result.reason).toContain('已装');
  });
});

describe('uninstallWrapper', () => {
  test('未装时返回 removed:false', () => {
    writeFileSync(rcFile, 'alias ls="ls -la"');
    const result = uninstallWrapper(rcFile, backupDir);
    expect(result.removed).toBe(false);
  });

  test('已装时移除 block', () => {
    writeFileSync(rcFile, 'alias ls="ls -la"\n' + generateWrapperBlock() + '\nalias la="ls -A"');
    const result = uninstallWrapper(rcFile, backupDir);
    expect(result.removed).toBe(true);
    const content = readFileSync(rcFile, 'utf8');
    expect(content).toContain('alias ls');
    expect(content).toContain('alias la');
    expect(content).not.toContain(WRAPPER_START_MARKER);
  });

  test('幂等:已移除再移除 no-op', () => {
    writeFileSync(rcFile, 'alias ls');
    uninstallWrapper(rcFile, backupDir);
    const result = uninstallWrapper(rcFile, backupDir);
    expect(result.removed).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试,确认失败**

```bash
bun test tests/unit/img-proxy/wrapper.test.ts
```

Expected: FAIL

- [ ] **Step 3: 实现 wrapper.ts**

创建 `src/img-proxy/wrapper.ts`:

```typescript
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';

export const WRAPPER_START_MARKER = '# >>> cc-linker img-proxy wrapper (do not edit this block) >>>';
export const WRAPPER_END_MARKER = '# <<< cc-linker img-proxy wrapper <<<';

const WRAPPER_BLOCK_RE = new RegExp(
  `^${escapeRegex(WRAPPER_START_MARKER)}[\\s\\S]*?${escapeRegex(WRAPPER_END_MARKER)}\\n?`,
  'm',
);

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 生成 wrapper 函数代码块(含 markers),可直接追加到 shell rc 文件。
 * 含递归防护:`ANTHROPIC_BASE_URL` 已设则直接 exec claude(避免 alias 链 + 多余 sub-shell)。
 */
export function generateWrapperBlock(): string {
  return `${WRAPPER_START_MARKER}
cc-linker-proxy() {
  # === 递归防护(验收 §14.7 E7) ===
  if [ -n "\${ANTHROPIC_BASE_URL:-}" ]; then
    command claude "\$@"
    return \$?
  fi

  local real_url="\$(command cc-linker img-proxy current-url)"
  if [ -z "\$real_url" ]; then
    echo "cc-linker-proxy: 找不到当前 provider URL" >&2
    echo "  检查 ~/.claude/settings.json 是否含 env.ANTHROPIC_BASE_URL" >&2
    return 1
  fi
  local proxy_url
  proxy_url="\$(command cc-linker img-proxy resolve "\$real_url")"
  if [ -z "\$proxy_url" ]; then
    echo "cc-linker-proxy: \$real_url 没在 img-proxy 里" >&2
    echo "  hint: cc-linker img-proxy install" >&2
    return 1
  fi
  ANTHROPIC_BASE_URL="\$proxy_url" command claude "\$@"
}
${WRAPPER_END_MARKER}
`;
}

/** 检测 rc 文件是否含 wrapper(start marker 出现)。 */
export function isWrapperInstalled(rcFile: string): boolean {
  if (!existsSync(rcFile)) return false;
  try {
    return readFileSync(rcFile, 'utf8').includes(WRAPPER_START_MARKER);
  } catch {
    return false;
  }
}

/**
 * 把 wrapper 追加到 rc 文件。幂等:已装直接返回 installed:false。
 * 返回 { installed, reason?, backupPath? }。
 */
export function installWrapper(
  rcFile: string,
  backupDir: string,
): { installed: boolean; reason?: string; rcFile: string; backupPath?: string } {
  const content = existsSync(rcFile) ? readFileSync(rcFile, 'utf8') : '';
  if (content.includes(WRAPPER_START_MARKER)) {
    return { installed: false, reason: 'wrapper 已装(idempotent)', rcFile };
  }

  let backupPath: string | undefined;
  if (content) {
    mkdirSync(backupDir, { recursive: true });
    backupPath = join(backupDir, `wrapper-backup-${Date.now()}`);
    copyFileSync(rcFile, backupPath);
  }

  const block = generateWrapperBlock();
  const newContent = content + (content.endsWith('\n') ? '' : '\n') + block + '\n';
  mkdirSync(dirname(rcFile), { recursive: true });
  writeFileSync(rcFile, newContent, { mode: 0o644 });

  return { installed: true, rcFile, backupPath };
}

/**
 * 从 rc 文件移除 wrapper。幂等:没找到 marker 返回 removed:false。
 */
export function uninstallWrapper(
  rcFile: string,
  backupDir: string,
): { removed: boolean; rcFile: string; backupPath?: string } {
  if (!existsSync(rcFile)) return { removed: false, rcFile };
  const content = readFileSync(rcFile, 'utf8');
  const match = content.match(WRAPPER_BLOCK_RE);
  if (!match) return { removed: false, rcFile };

  mkdirSync(backupDir, { recursive: true });
  const backupPath = join(backupDir, `wrapper-backup-removed-${Date.now()}`);
  copyFileSync(rcFile, backupPath);

  const newContent = content.replace(WRAPPER_BLOCK_RE, '');
  writeFileSync(rcFile, newContent, { mode: 0o644 });
  return { removed: true, rcFile, backupPath };
}

/** 检测用户当前 shell(zsh/bash)。返回 null 表示不支持。 */
export function detectShell(): 'zsh' | 'bash' | null {
  if (process.env.ZSH_VERSION) return 'zsh';
  if (process.env.BASH_VERSION) return 'bash';
  return null;
}

/** 获取指定 shell 的 rc 文件路径。 */
export function getRcFilePath(shell: 'zsh' | 'bash', home?: string): string {
  const h = home ?? process.env.HOME ?? '';
  return join(h, shell === 'zsh' ? '.zshrc' : '.bashrc');
}
```

- [ ] **Step 4: 跑测试,确认通过**

```bash
bun test tests/unit/img-proxy/wrapper.test.ts
```

Expected: PASS(~13 tests)

- [ ] **Step 5: Commit**

```bash
git add src/img-proxy/wrapper.ts tests/unit/img-proxy/wrapper.test.ts
git commit -m "feat(img-proxy): add wrapper generate/install/uninstall/isInstalled"
```

---

## Phase D: Config 扩展

### Task 6: config.ts 加 3 个新字段

**Files:**
- Modify: `src/utils/config.ts:83-90, 187-194, 312-316`

**依赖:** 无

- [ ] **Step 1: 加 ConfigData 类型字段**

修改 `src/utils/config.ts` 第 83-90 行,`img_proxy` interface 加 3 个字段:

```typescript
img_proxy: {
  enabled: boolean;
  port: number;
  hostname: string;
  cache_max_age_hours: number;
  prompt_template: string;
  console_enabled: boolean;
  // v2 smart install:
  smart_mode: boolean;
  vision_model_patterns_extra: string[];
  text_only_model_patterns_extra: string[];
};
```

- [ ] **Step 2: 加 DEFAULTS**

修改第 187-194 行,`DEFAULTS.img_proxy` 加:

```typescript
img_proxy: {
  enabled: true,
  port: 8765,
  hostname: '127.0.0.1',
  cache_max_age_hours: 24 * 7,
  prompt_template: '[用户粘贴的图片已保存到本地: {path}] 当前模型为纯文本模型,无法直接查看图片内容。如需识别这张图片,请调用 mcp__MiniMax__understand_image 工具,image_source 参数传上述本地路径。',
  console_enabled: false,
  // v2 smart install defaults:
  smart_mode: true,
  vision_model_patterns_extra: [],
  text_only_model_patterns_extra: [],
},
```

- [ ] **Step 3: 加 env mappings**

修改第 312-316 行附近,在 mappings 数组里加(注意:smart_mode 走 generic,数组走 split(',')特殊路径):

```typescript
// 在 mappings 数组里加:
['CC_LINKER_IMG_PROXY_SMART_MODE', 'img_proxy', 'smart_mode'],

// 在 loadEnv() 的特殊处理区(line 320-327 附近)加:
const visionPatternsEnv = process.env.CC_LINKER_IMG_PROXY_VISION_PATTERNS_EXTRA;
if (visionPatternsEnv !== undefined) {
  this.data.img_proxy.vision_model_patterns_extra =
    visionPatternsEnv.split(',').map(s => s.trim()).filter(Boolean);
}
const textOnlyPatternsEnv = process.env.CC_LINKER_IMG_PROXY_TEXT_ONLY_PATTERNS_EXTRA;
if (textOnlyPatternsEnv !== undefined) {
  this.data.img_proxy.text_only_model_patterns_extra =
    textOnlyPatternsEnv.split(',').map(s => s.trim()).filter(Boolean);
}
```

- [ ] **Step 4: 验证编译**

```bash
bun run typecheck
```

Expected: 无 error

- [ ] **Step 5: 跑现有 config 测试**

```bash
bun test tests/unit/utils/config 2>/dev/null || bun test --test-name-pattern="config"
```

Expected: PASS(如果没 config test,跳过此步)

- [ ] **Step 6: Commit**

```bash
git add src/utils/config.ts
git commit -m "feat(img-proxy): add smart_mode + extra patterns to config + env mappings"
```

---

## Phase E: CLI 子命令(resolve / current-url / wrapper)

### Task 7: `imgProxyCurrentUrl` 子命令

**Files:**
- Modify: `src/cli/commands/img-proxy.ts`(新增 import + handler)

**依赖:** 无

- [ ] **Step 1: 在 img-proxy.ts 顶部加 import**

在 `src/cli/commands/img-proxy.ts` line 9 附近(`getExecutablePath` 旁边)加:

```typescript
import { readCurrentUpstreamFromSettings } from '../../img-proxy/resolve';
```

- [ ] **Step 2: 创建 `src/img-proxy/resolve.ts`**

新建文件 `src/img-proxy/resolve.ts`:

```typescript
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
```

- [ ] **Step 3: 加 handler**

在 `src/cli/commands/img-proxy.ts` line 209(`imgProxyInstall` 上方)插入:

```typescript
// ---------- current-url ----------
export async function imgProxyCurrentUrl(): Promise<void> {
  const { url, parseError } = readCurrentUpstreamFromSettings();
  if (parseError) {
    console.error(chalk.red(`❌ settings.json 解析失败: ${parseError.message}`));
    process.exit(1);
  }
  if (url) console.log(url);
  // 空 stdout = "没找到" — wrapper 检测用
}
```

- [ ] **Step 4: 注册到 src/index.ts**

在 `src/index.ts` line 23-27 的 import 块加 `imgProxyCurrentUrl`,在 line 207-208 之间加:

```typescript
imgProxyCmd.command('current-url').description('读 ~/.claude/settings.json 的 ANTHROPIC_BASE_URL').action(() => imgProxyCurrentUrl());
```

- [ ] **Step 5: 跑通**

```bash
bun run dev img-proxy current-url
```

Expected: 打印 settings.json 的 BASE_URL 或空(然后 exit 0)

- [ ] **Step 6: Commit**

```bash
git add src/img-proxy/resolve.ts src/cli/commands/img-proxy.ts src/index.ts
git commit -m "feat(img-proxy): add current-url subcommand for wrapper"
```

---

### Task 8: `imgProxyResolve` 子命令

**Files:**
- Modify: `src/cli/commands/img-proxy.ts`
- Modify: `src/index.ts`

**依赖:** Task 7(Task 7 加了 resolve.ts 路径;resolve 子命令用它)

- [ ] **Step 1: 加 import**

在 `src/cli/commands/img-proxy.ts` line 9 附近加:

```typescript
import { resolveProxyByUpstream } from '../../img-proxy/routes';
```

- [ ] **Step 2: 加 handler**

在 img-proxy.ts `imgProxyCurrentUrl` 后面加:

```typescript
// ---------- resolve ----------
export async function imgProxyResolve(opts: { upstream?: string }): Promise<void> {
  const upstream = opts.upstream ?? '';
  if (!upstream) {
    console.error(chalk.red('❌ upstream 参数必填'));
    process.exit(1);
  }
  const port = config.get<number>('img_proxy.port', 8765);
  const hostname = config.get<string>('img_proxy.hostname', '127.0.0.1');
  const proxyUrl = resolveProxyByUpstream(IMG_PROXY_ROUTES_PATH, port, hostname, upstream);
  if (proxyUrl) console.log(proxyUrl);
  // 空 stdout = "没找到" — wrapper 检测用
}
```

- [ ] **Step 3: 修改 index.ts 注册**

修改 `src/index.ts` line 207-208,把 `resolve` 子命令注册为接受 upstream 参数的形式:

```typescript
imgProxyCmd.command('resolve <upstream>').description('按真实 upstream URL 查 proxy URL').action((upstream) => imgProxyResolve({ upstream }));
```

- [ ] **Step 4: 跑通**

先确保至少一个 provider 装了:
```bash
bun run dev img-proxy install --providers byte-agent-glm 2>/dev/null || echo "跳(未装)"
bun run dev img-proxy resolve https://ark.cn-beijing.volces.com/api/plan
```

Expected: 打印 `http://127.0.0.1:8765/byte-agent-glm` 或空

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/img-proxy.ts src/index.ts
git commit -m "feat(img-proxy): add resolve subcommand for wrapper"
```

---

### Task 9: `imgProxyWrapperInstall/Uninstall/Status` 子命令

**Files:**
- Modify: `src/cli/commands/img-proxy.ts`
- Modify: `src/index.ts`

**依赖:** Task 5(wrapper.ts)

- [ ] **Step 1: 加 imports**

在 `src/cli/commands/img-proxy.ts` 顶部加:

```typescript
import {
  detectShell, getRcFilePath, isWrapperInstalled,
  installWrapper, uninstallWrapper,
} from '../../img-proxy/wrapper';
import { IMG_PROXY_WRAPPER_BACKUP_DIR } from '../../utils/paths';
```

- [ ] **Step 2: 加三个 handler**

在 imgProxyResolve 后面加:

```typescript
// ---------- wrapper-install ----------
export async function imgProxyWrapperInstall(): Promise<void> {
  const shell = detectShell();
  if (!shell) {
    console.log(chalk.red('当前 shell 不支持(zsh/bash 之外)'));
    return;
  }
  const rcFile = getRcFilePath(shell);
  const result = installWrapper(rcFile, IMG_PROXY_WRAPPER_BACKUP_DIR);
  if (!result.installed) {
    console.log(chalk.yellow(`✅ ${result.reason}`));
    console.log(chalk.gray(`   (${result.rcFile})`));
    return;
  }
  console.log(chalk.green(`✅ wrapper 已装到 ${result.rcFile}`));
  if (result.backupPath) console.log(chalk.gray(`   备份: ${result.backupPath}`));
  console.log(chalk.cyan('   运行 source ~/.zshrc 或重开 shell 激活 cc-linker-proxy'));
}

// ---------- wrapper-uninstall ----------
export async function imgProxyWrapperUninstall(): Promise<void> {
  const shell = detectShell();
  if (!shell) {
    console.log(chalk.red('当前 shell 不支持(zsh/bash 之外)'));
    return;
  }
  const rcFile = getRcFilePath(shell);
  const result = uninstallWrapper(rcFile, IMG_PROXY_WRAPPER_BACKUP_DIR);
  if (!result.removed) {
    console.log(chalk.yellow('⚠️ wrapper 未装(无 marker)'));
    return;
  }
  console.log(chalk.green(`✅ 已从 ${result.rcFile} 移除 wrapper`));
  if (result.backupPath) console.log(chalk.gray(`   备份: ${result.backupPath}`));
}

// ---------- wrapper-status ----------
export async function imgProxyWrapperStatus(): Promise<void> {
  const shell = detectShell();
  if (!shell) {
    console.log(chalk.red('当前 shell 不支持'));
    return;
  }
  const rcFile = getRcFilePath(shell);
  if (isWrapperInstalled(rcFile)) {
    console.log(chalk.green(`✅ wrapper 已装`));
    console.log(chalk.gray(`   shell: ${shell}`));
    console.log(chalk.gray(`   rc:    ${rcFile}`));
  } else {
    console.log(chalk.yellow('⚠️ wrapper 未装'));
    console.log(chalk.gray('   hint: cc-linker img-proxy wrapper-install'));
  }
}
```

- [ ] **Step 3: 注册到 index.ts**

修改 `src/index.ts` line 23-27 的 import 块加这三个。在 line 209-210 之间加:

```typescript
const wrapperCmd = imgProxyCmd.command('wrapper').description('管理 shell wrapper (cc-linker-proxy)');
wrapperCmd.command('install').description('装 wrapper 到 ~/.zshrc').action(() => imgProxyWrapperInstall());
wrapperCmd.command('uninstall').description('从 ~/.zshrc 移除 wrapper').action(() => imgProxyWrapperUninstall());
wrapperCmd.command('status').description('查看 wrapper 状态').action(() => imgProxyWrapperStatus());
```

- [ ] **Step 4: 跑通**

```bash
bun run dev img-proxy wrapper-status
bun run dev img-proxy wrapper-install
bun run dev img-proxy wrapper-status
bun run dev img-proxy wrapper-uninstall
```

Expected: 第二次 status 显示"已装",uninstall 成功

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/img-proxy.ts src/index.ts
git commit -m "feat(img-proxy): add wrapper-install/uninstall/status subcommands"
```

---

## Phase F: Smart Install 流程

### Task 10: `discoverCandidates` 函数 + 单元测试

**Files:**
- Create: `src/img-proxy/discover.ts`
- Test: `tests/unit/img-proxy/discover.test.ts`

**依赖:** Task 1(classify)、Task 2(aliases)

- [ ] **Step 1: 写失败的测试**

创建 `tests/unit/img-proxy/discover.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { discoverCandidates } from '../../../src/img-proxy/discover';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'discover-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true });
});

describe('discoverCandidates', () => {
  test('manual provider file 出现', () => {
    const manualDir = join(tmpDir, 'providers');
    mkdirSync(manualDir, { recursive: true });
    writeFileSync(join(manualDir, 'glm-5.2.json'), JSON.stringify({
      env: { ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic', ANTHROPIC_MODEL: 'glm-5.2' }
    }));
    const result = discoverCandidates({ manualDir, autoDir: join(tmpDir, 'auto'), aliasRcFiles: [] });
    expect(result).toHaveLength(1);
    expect(result[0]!.alias).toBe('glm-5.2');
    expect(result[0]!.source).toBe('manual');
    expect(result[0]!.kind).toBe('text-only');
  });

  test('空 baseUrl 被过滤(🔴 fix #4)', () => {
    const manualDir = join(tmpDir, 'providers');
    mkdirSync(manualDir, { recursive: true });
    writeFileSync(join(manualDir, 'empty.json'), JSON.stringify({
      env: { ANTHROPIC_MODEL: 'glm-5.2' }  // 无 BASE_URL
    }));
    const result = discoverCandidates({ manualDir, autoDir: join(tmpDir, 'auto'), aliasRcFiles: [] });
    expect(result).toHaveLength(0);
  });

  test('multimodal model kind=multimodal', () => {
    const manualDir = join(tmpDir, 'providers');
    mkdirSync(manualDir, { recursive: true });
    writeFileSync(join(manualDir, 'kimi.json'), JSON.stringify({
      env: { ANTHROPIC_BASE_URL: 'https://api.moonshot.cn', ANTHROPIC_MODEL: 'kimi-for-coding[256k]' }
    }));
    const result = discoverCandidates({ manualDir, autoDir: join(tmpDir, 'auto'), aliasRcFiles: [] });
    expect(result[0]!.kind).toBe('multimodal');
  });

  test('manual + alias 同 alias 时 source=manual(file 是 source of truth)', () => {
    const manualDir = join(tmpDir, 'providers');
    mkdirSync(manualDir, { recursive: true });
    writeFileSync(join(manualDir, 'glm-5.2.json'), JSON.stringify({
      env: { ANTHROPIC_BASE_URL: 'https://x', ANTHROPIC_MODEL: 'glm-5.2' }
    }));
    const rc = join(tmpDir, '.zshrc');
    writeFileSync(rc, `alias cc-glm='claude --settings ${join(manualDir, 'glm-5.2.json')}'`);
    const result = discoverCandidates({ manualDir, autoDir: join(tmpDir, 'auto'), aliasRcFiles: [rc] });
    expect(result).toHaveLength(1);
    expect(result[0]!.source).toBe('manual');
  });

  test('排序:manual 先于 auto', () => {
    const manualDir = join(tmpDir, 'providers');
    const autoDir = join(tmpDir, 'auto');
    mkdirSync(manualDir, { recursive: true });
    mkdirSync(autoDir, { recursive: true });
    writeFileSync(join(manualDir, 'a-manual.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'x' } }));
    writeFileSync(join(autoDir, 'z-auto.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'x' } }));
    const result = discoverCandidates({ manualDir, autoDir, aliasRcFiles: [] });
    expect(result.map(r => r.alias)).toEqual(['a-manual', 'z-auto']);
  });
});
```

- [ ] **Step 2: 跑测试,确认失败**

```bash
bun test tests/unit/img-proxy/discover.test.ts
```

Expected: FAIL("Cannot find module")

- [ ] **Step 3: 实现 discover.ts**

创建 `src/img-proxy/discover.ts`:

```typescript
import { readFileSync, readdirSync, existsSync, mkdirSync } from 'fs';
import { join, basename } from 'path';
import { classifyModel, type ModelKind } from './classify';
import { discoverShellAliases } from './aliases';
import type { ProviderFileInfo } from './types';

export interface Candidate extends ProviderFileInfo {
  source: 'manual' | 'auto' | 'alias' | 'cc-switch';
  kind: ModelKind;
}

export interface DiscoverOpts {
  manualDir: string;
  autoDir: string;
  aliasRcFiles?: string[];
  extraPatterns?: { visionPatterns?: string[]; textOnlyPatterns?: string[] };
}

/**
 * 4 路发现 + dedup by alias + baseUrl 过滤 + 分类。
 * 🔴 Fix #4:末尾 .filter(c => c.baseUrl) — 同现有 install 语义
 * 🔴 Fix #5:source 类型统一 'cc-switch'(连字符)
 */
export function discoverCandidates(opts: DiscoverOpts): Candidate[] {
  const { manualDir, autoDir, aliasRcFiles, extraPatterns } = opts;

  const manualFiles = scanDir(manualDir);
  const autoFiles = scanDir(autoDir);

  // alias → file hint
  const aliases = discoverShellAliases(aliasRcFiles);
  const aliasByProvider = new Map<string, string>();  // providerAlias → alias name (cc-x)
  for (const a of aliases) {
    if (a.providerAlias) aliasByProvider.set(a.providerAlias, a.name);
  }

  // file dedup:manual 覆盖 auto
  const byAlias = new Map<string, ProviderFileInfo>();
  for (const f of autoFiles) if (!byAlias.has(f.alias)) byAlias.set(f.alias, f);
  for (const f of manualFiles) byAlias.set(f.alias, f);

  // 合并成 Candidate
  const candidates: Candidate[] = [];
  for (const [alias, file] of byAlias) {
    const isAuto = !manualFiles.some(m => m.alias === alias);
    const shellName = aliasByProvider.get(alias);
    candidates.push({
      ...file,
      source: isAuto ? 'auto' : 'manual',
      kind: classifyModel(file.model, extraPatterns),
    });
  }

  // 🔴 过滤无 BASE_URL(同现有 install 语义,line 213-214)
  const withBaseUrl = candidates.filter(c => c.baseUrl);

  // 排序:manual(0) < cc-switch(1) < auto(2) < alias(3)
  const sourcePriority: Record<Candidate['source'], number> = {
    manual: 0,
    'cc-switch': 1,
    auto: 2,
    alias: 3,
  };
  withBaseUrl.sort((a, b) => {
    const dp = sourcePriority[a.source] - sourcePriority[b.source];
    if (dp !== 0) return dp;
    return a.alias.localeCompare(b.alias);
  });
  return withBaseUrl;
}

function scanDir(dir: string): ProviderFileInfo[] {
  if (!existsSync(dir)) return [];
  mkdirSync(dir, { recursive: true });
  return readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => readProviderFile(join(dir, f)))
    .filter((p): p is ProviderFileInfo => p !== null);
}

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
    return null;
  }
}
```

- [ ] **Step 4: 跑测试,确认通过**

```bash
bun test tests/unit/img-proxy/discover.test.ts
```

Expected: PASS(6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/img-proxy/discover.ts tests/unit/img-proxy/discover.test.ts
git commit -m "feat(img-proxy): add discoverCandidates with 4-source merge + baseUrl filter"
```

---

### Task 11: 改造 `imgProxyInstall` 为 smart 模式

**Files:**
- Modify: `src/cli/commands/img-proxy.ts:210-275`

**依赖:** Task 10(discover)+ Task 6(config)+ Task 5(wrapper)+ Task 1(classify)

- [ ] **Step 1: 备份现有 imgProxyInstall**

```bash
cp src/cli/commands/img-proxy.ts src/cli/commands/img-proxy.ts.bak
```

(后面 commit 时记得删 .bak)

- [ ] **Step 2: 重写 imgProxyInstall**

**完全替换** `src/cli/commands/img-proxy.ts:210-275` 的 `imgProxyInstall` 函数。新代码:

```typescript
export async function imgProxyInstall(opts: {
  providers?: string;
  all?: boolean;
  yes?: boolean;
  mode?: 'smart' | 'dumb';
}): Promise<{ installedCount: number; wrapperInstalled: boolean; wrapperSkipped: boolean }> {
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

  const candidates = discoverCandidates({
    manualDir: CLAUDE_PROVIDERS_DIR,
    autoDir: AUTO_PROVIDERS_DIR,
    extraPatterns,
  });

  if (candidates.length === 0) {
    const ccSwitch = hasCcSwitch();
    console.log(chalk.red('❌ 未找到任何可用的 provider 配置\n'));
    console.log(chalk.yellow('  已扫描的位置:'));
    console.log(chalk.gray(`    • ${CLAUDE_PROVIDERS_DIR}/ (manual)`));
    if (ccSwitch) {
      console.log(chalk.gray(`    • ~/.cc-switch/cc-switch.db (已检测到,但 app_type='claude' 的 provider 都没有 ANTHROPIC_BASE_URL)`));
    } else {
      console.log(chalk.gray(`    • ~/.cc-switch/cc-switch.db (未安装)`));
    }
    console.log('');
    console.log(chalk.yellow('  解决方案(任选其一):'));
    console.log(chalk.gray('    1. 装 CC Switch (https://github.com/farion1231/cc-switch)'));
    console.log(chalk.gray('       — GUI 管理 provider,装好后 Claude Code 自动可用,img-proxy 也会自动识别'));
    console.log(chalk.gray('    2. 手动创建 provider 文件:'));
    console.log(chalk.gray(`       ${CLAUDE_PROVIDERS_DIR}/my-provider.json`));
    console.log(chalk.gray('       内容参考 docs/img-proxy.md "冷启动" 一节'));
    console.log('');
    throw new CCLinkerError('E_IMG_PROXY_NO_PROVIDERS', '未找到任何可用的 provider 配置');
  }

  // Smart 模式:过滤 multimodal
  const filtered = useClassification
    ? candidates.filter(c => c.kind !== 'multimodal')
    : candidates;

  // 构造 inquirer choices
  const choices = filtered.map(c => ({
    name: buildChoiceLabel(c),
    value: c.alias,
    short: c.alias,
    checked: c.kind !== 'multimodal',
  }));

  let targets: Candidate[];
  if (opts.providers) {
    const wanted = new Set(opts.providers.split(',').map(s => s.trim()).filter(Boolean));
    targets = filtered.filter(c => wanted.has(c.alias));
    if (targets.length === 0) {
      throw new CCLinkerError('E_IMG_PROXY_UNKNOWN_ALIAS', `未找到 provider 文件 ${opts.providers}`);
    }
  } else if (opts.all || opts.yes) {
    targets = filtered;
  } else {
    const { picks } = await inquirer.prompt([{
      type: 'checkbox', name: 'picks',
      message: '选择要启用图片代理的 provider (空格勾选,回车确认):',
      choices, pageSize: 20,
    }]);
    if (picks.length === 0) { console.log(chalk.gray('未选择')); return { installedCount: 0, wrapperInstalled: false, wrapperSkipped: false }; }
    const pickedSet = new Set(picks as string[]);
    targets = filtered.filter(c => pickedSet.has(c.alias));
  }

  // 装每个
  let installed = 0, skipped = 0;
  for (const t of targets) {
    if (isProviderInstalled(t.path, port, hostname)) {
      console.log(chalk.gray(`  ⊘ ${t.alias}  已 install,跳过`));
      skipped++;
      continue;
    }
    try {
      installProvider({ providerPath: t.path, alias: t.alias, routesPath: IMG_PROXY_ROUTES_PATH, port, hostname });
      console.log(chalk.green(`  ✅ ${t.alias}  ${t.baseUrl}  →  http://${hostname}:${port}/${t.alias}`));
      installed++;
    } catch (err) {
      console.log(chalk.red(`  ❌ ${t.alias}  ${err}`));
    }
  }

  // Smart 模式:检测到 CC Switch 时问 wrapper
  let wrapperInstalled = false;
  let wrapperSkipped = false;
  if (mode === 'smart' && hasCcSwitch()) {
    const shell = detectShell();
    if (shell) {
      const rcFile = getRcFilePath(shell);
      if (!isWrapperInstalled(rcFile)) {
        const { wrap } = await inquirer.prompt([{
          type: 'confirm', name: 'wrap',
          message: '检测到 CC Switch。是否装 wrapper(让 cc-linker-proxy 命令替代 claude)?',
          default: true,
        }]);
        if (wrap) {
          await imgProxyWrapperInstall();
          wrapperInstalled = true;
        } else {
          wrapperSkipped = true;
        }
      } else {
        wrapperInstalled = true;  // 已装
      }
    }
  }

  console.log(chalk.green(`\n完成: ${installed} 新装, ${skipped} 已存在。启动: cc-linker img-proxy start --daemon`));
  return { installedCount: installed + skipped, wrapperInstalled, wrapperSkipped };
}

function buildChoiceLabel(c: Candidate): string {
  const sourceTag = `[${c.source}]`.padEnd(11);
  const kindTag = c.kind === 'multimodal' ? '⏭ multimodal-skip' : `✅ ${c.kind}`;
  return `${sourceTag} ${c.alias.padEnd(22)} ${kindTag.padEnd(20)} ${c.model || '(no model)'}`;
}
```

- [ ] **Step 3: 删 .bak**

```bash
rm src/cli/commands/img-proxy.ts.bak
```

- [ ] **Step 4: 加 imports**

在 img-proxy.ts 顶部加:

```typescript
import { AUTO_PROVIDERS_DIR } from '../../utils/paths';
import { discoverCandidates, type Candidate } from '../../img-proxy/discover';
```

- [ ] **Step 5: 跑 typecheck**

```bash
bun run typecheck
```

Expected: 无 error

- [ ] **Step 6: 跑全量测试**

```bash
bun test
```

Expected: PASS

- [ ] **Step 7: 手动跑 smart install**

```bash
bun run dev img-proxy install --yes
```

Expected: 装 text-only provider,kimi/multimodal 跳过,可能问 wrapper

- [ ] **Step 8: Commit**

```bash
git add src/cli/commands/img-proxy.ts
git commit -m "feat(img-proxy): smart install with classification + wrapper prompt"
```

---

### Task 12: `imgProxyStatus` 加 wrapper 段

**Files:**
- Modify: `src/cli/commands/img-proxy.ts:182-207`

**依赖:** Task 5

- [ ] **Step 1: 加 wrapper 段**

修改 `imgProxyStatus`(line 182-207),在 launchd 段之前加:

```typescript
// Wrapper 状态
const shell = detectShell();
if (shell) {
  const rcFile = getRcFilePath(shell);
  console.log(chalk.cyan('\nwrapper:'));
  if (isWrapperInstalled(rcFile)) {
    console.log(chalk.green(`   ✅ 已装 (${shell}, ${rcFile})`));
    console.log(chalk.gray(`   提示: 跑 cc-linker-proxy 替代 claude`));
  } else {
    console.log(chalk.gray(`   ⚠️ 未装 (cc-linker img-proxy wrapper-install)`));
  }
}
```

- [ ] **Step 2: 加 import**

在 img-proxy.ts 顶部确认已 import `detectShell, getRcFilePath, isWrapperInstalled`(从 Task 9 来,可能已经在了)

- [ ] **Step 3: 跑通**

```bash
bun run dev img-proxy status
```

Expected: 看到 wrapper 段

- [ ] **Step 4: Commit**

```bash
git add src/cli/commands/img-proxy.ts
git commit -m "feat(img-proxy): add wrapper section to status"
```

---

## Phase G: Setup Wizard 集成

### Task 13: setup.ts 全 8 项修改

**Files:**
- Modify: `src/cli/commands/setup.ts`

**依赖:** Task 11(smart install)+ Task 12(wrapper status)

- [ ] **Step 1: 扩 ImgProxyWizardResult interface**

修改 `src/cli/commands/setup.ts:54-60`:

```typescript
interface ImgProxyWizardResult {
  configured: boolean;
  installedCount: number;
  started: boolean;
  autoStart: boolean;
  wrapperInstalled: boolean;
  wrapperSkipped: boolean;
}
```

- [ ] **Step 2: step description 增强**

修改 line 79-80:

```typescript
console.log(chalk.gray(`  ${stepNum}. 启用图片代理 (img-proxy,自动识别纯文本模型 / 多模态 / CC Switch)`));
```

- [ ] **Step 3: 空状态文案精确化**

修改 `runImgProxyWizard` 内的空状态分支(line 231-237):

```typescript
if (allProviders.length === 0) {
  const ccSwitch = hasCcSwitch();
  if (ccSwitch) {
    console.log(chalk.yellow('  ⚠️ 检测到 CC Switch 但没找到 claude provider'));
    console.log(chalk.gray('     检查 cc-switch.db 里是否有 app_type=claude 的记录'));
  } else {
    console.log(chalk.yellow('  ⚠️ 未扫描到任何 provider 配置'));
    console.log(chalk.gray('     装 CC Switch 或手写 ~/.claude/providers/*.json 后再跑 setup'));
  }
  return result;
}
```

- [ ] **Step 4: 删 multi-select inquirer,改调 smart install**

修改 `runImgProxyWizard` line 258-282(把整个 picks inquirer + install 调用替换):

```typescript
// 删除 line 258-275(整个 picks inquirer 段)
// 替换 line 277-286 的 imgProxyInstall 调用为:
const { imgProxyInstall } = await import('./img-proxy');
try {
  const installResult = await imgProxyInstall({});
  result.installedCount = installResult.installedCount;
  result.configured = true;
  result.wrapperInstalled = installResult.wrapperInstalled;
  result.wrapperSkipped = installResult.wrapperSkipped;
} catch (err) {
  console.log(chalk.red(`  ❌ 安装失败: ${err}`));
  return result;
}
```

- [ ] **Step 5: printSummary 扩展**

修改 `printSummary` 内 img-proxy 段(line 582-590):

```typescript
if (imgProxy) {
  if (imgProxy.configured) {
    console.log(chalk.gray(`  图片代理:     ✅ 已启用 (${imgProxy.installedCount} 个 provider)`));
    console.log(chalk.gray(`  img-proxy 状态: ${imgProxy.started ? '✅ 运行中' : '⏸️  未启动 (cc-linker img-proxy start --daemon)'}`));
    if (imgProxy.autoStart) console.log(chalk.gray('  开机自启:     ✅ launchd 已配置'));
    if (imgProxy.wrapperInstalled) {
      console.log(chalk.gray('  img-proxy wrapper: ✅ 已装 (用 cc-linker-proxy 替代 claude)'));
    } else if (imgProxy.wrapperSkipped) {
      console.log(chalk.gray('  img-proxy wrapper: ⏭️  跳过(用户拒绝 — cc-linker-proxy 不可用)'));
    }
  } else {
    console.log(chalk.gray('  图片代理:     ⏸️  未启用（可稍后 cc-linker img-proxy install）'));
  }
}
```

- [ ] **Step 6: 加 imports**

setup.ts **不需要新加 imports**——`imgProxyInstall` 内部已经处理了 routes.json 读写和 wrapper 检测,通过返回值传出。setup.ts 只用 `installResult.installedCount` / `wrapperInstalled` / `wrapperSkipped` 即可。

- [ ] **Step 7: 跑通**

```bash
bun run dev setup --skip-feishu --skip-hook
```

Expected: 看到 smart install 的 inquirer(带 [auto] tag 和 multimodal ⏭ 标记),summary 显示 wrapper 状态

- [ ] **Step 8: 跑全量测试**

```bash
bun test
```

Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/cli/commands/setup.ts
git commit -m "feat(img-proxy): setup wizard integrates smart install + wrapper status"
```

---

## Phase H: 文档 + Smoke + Deploy

### Task 14: docs/img-proxy.md 新章节

**Files:**
- Modify: `docs/img-proxy.md`

**依赖:** 所有 code tasks

- [ ] **Step 1: 加 "升级 / 迁移" 章节**

在 `docs/img-proxy.md` 末尾加(spec §10 step 9 "迁移说明" 内容):

```markdown
## 升级 / 迁移 (v2 智能安装)

从 v1 dumb install 升级到 v2 smart install:

### 轻量迁移

\`\`\`bash
cc-linker img-proxy install
\`\`\`

smart 模式会跳过 multimodal、可能装 wrapper。**已装的 multimodal 不会被自动卸载**。

### 严格迁移(推荐)

\`\`\`bash
cc-linker img-proxy uninstall --all
cc-linker img-proxy install
\`\`\`

`uninstall --all` 还原所有 provider 的 BASE_URL 到原始 upstream,清 routes.json。`install`(smart)重新挑选。

### 回滚

如果新行为有问题:

\`\`\`bash
cc-linker img-proxy uninstall --all
cc-linker img-proxy install --all   # dumb 模式(旧行为)
\`\`\`
```

- [ ] **Step 2: 加 "智能模式" 章节**

加:

```markdown
## 智能模式 (smart_mode)

v2 默认 smart 模式:`install` 自动分类模型,跳过 multimodal(避免破坏图片能力)。

### 配置自定义 patterns

\`\`\`toml
[img_proxy]
smart_mode = true

# 额外标 multimodal(也会被跳过)
vision_model_patterns_extra = [
  "my-custom-vl-*",
]

# 额外标 text-only(也会被 proxy)
text_only_model_patterns_extra = [
  "my-custom-text-*",
]
\`\`\`

### 关闭 smart(全装)

\`\`\`toml
[img_proxy]
smart_mode = false
\`\`\`

或 CLI:`cc-linker img-proxy install --all`(dumb 模式,不过滤)。
```

- [ ] **Step 3: Commit**

```bash
git add docs/img-proxy.md
git commit -m "docs(img-proxy): add upgrade + smart_mode sections"
```

---

### Task 15: 手动 smoke test(spec §14.9 S1-S5)

**Files:** 无

**依赖:** 所有 code tasks

- [ ] **Step 1: S1 — 纯 CC Switch 用户 install**

```bash
# 准备:确保 ~/.claude/providers/ 空,~/.cc-switch/ 存在
bun run dev img-proxy install --yes
```

Expected: 看到分类后的列表,multimodal 跳过,text-only 装上

- [ ] **Step 2: S2 — Wrapper daily use**

```bash
bun run dev img-proxy wrapper-install
source ~/.zshrc  # 或新开 shell
# 模拟:在 shell 里跑 cc-linker-proxy,确认 ANTHROPIC_BASE_URL 设置
cc-linker-proxy --version 2>&1 | head -1 || echo "(claude 二进制不在)"
```

Expected: wrapper 函数被 source 后能跑

- [ ] **Step 3: S3 — Unknown model default**

```bash
# 临时把某个 provider 文件的 ANTHROPIC_MODEL 改成 'some-new-model-test'
bun run dev img-proxy install --providers <那个 alias>
```

Expected: 装成功,按 text-only(默认行为)

- [ ] **Step 4: S4 — Wrapper idempotency**

```bash
bun run dev img-proxy wrapper-install   # 第一次
bun run dev img-proxy wrapper-install   # 第二次
```

Expected: 第二次输出"已装(idempotent)",rc 文件 wrapper 只一份

- [ ] **Step 5: S5 — E1 验证(已装后 reinstall)**

```bash
bun run dev img-proxy install --providers glm-5.2  # 第一次
bun run dev img-proxy install --providers glm-5.2  # 第二次
```

Expected: routes.json 还是 1 个 entry,provider 文件 token 不变

- [ ] **Step 6: 跑全量测试**

```bash
bun test
```

Expected: PASS

---

### Task 16: Deploy + push

**Files:** 无

- [ ] **Step 1: 跑 typecheck + 全量 test**

```bash
bun run typecheck
bun test
```

Expected: 都 PASS

- [ ] **Step 2: 用 bun run deploy 部署**

```bash
bun run deploy
```

Expected: 部署成功,`cc-linker` 二进制更新到 ~/bin/cc-linker

- [ ] **Step 3: 真实跑一次 img-proxy install 看效果**

```bash
cc-linker img-proxy install --yes
cc-linker img-proxy status
```

Expected: 看实际效果,有问题记录

- [ ] **Step 4: commit + push**

```bash
git status
git add -A  # 如果有未提交的修改
git commit -m "chore(img-proxy): final smoke + deploy verification"
git push origin feat/cli-image-proxy
```

---

## 📊 总览

| Phase | Tasks | 估算 |
|-------|-------|------|
| A. 基础模块 | 1-2 | 2.5h |
| B. Routes 重构 | 3 | 1h |
| C. Wrapper + 路径 | 4-5 | 1.5h |
| D. Config 扩展 | 6 | 30min |
| E. CLI 子命令 | 7-9 | 1.5h |
| F. Smart Install | 10-12 | 2h |
| G. Setup Wizard | 13 | 30min |
| H. Docs + Smoke + Deploy | 14-16 | 1h |
| **总计** | **16 tasks / ~80 steps** | **~10.5h** |

## 🔑 验收参考

实施完成后,跑 spec §14.9 的 S1-S5 烟测 + §14.7 的 15 个边缘场景。