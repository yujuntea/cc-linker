# cc-linker img-proxy 智能安装 — 设计

> **日期:** 2026-07-04
> **状态:** 等待用户 review
> **分支:** `feat/cli-image-proxy`
> **补充:** 与 `docs/superpowers/plans/2026-07-04-img-proxy-wrapper.md` 配合使用(后者覆盖 wrapper 内部细节;本文档覆盖更广的 install + discovery 流程)

## 1. 目标 & 非目标

### 目标

- **新用户一条命令搞定**:`cc-linker img-proxy install` 对所有用户类型(CC Switch、自定义 alias、两者都有)都做正确的事,不需要 flag。
- **跳过多模态模型**:不要让有图片能力的模型(Claude 3+、GPT-4 等)走 proxy——会破坏它们的图片理解。通过 model name patterns 检测。
- **自动发现现有 shell alias**:扫描 `~/.zshrc` / `~/.bashrc` 里的 `cc-*` alias,在 install 列表里预选对应 provider。
- **CC Switch 用户自动装 wrapper**:检测到 CC Switch 后,提示装 `cc-linker-proxy` shell wrapper,让 `claude` 走 proxy。
- **向后兼容**:`install --providers X` 和 `install --all` 保持现有行为(不做 smart 过滤,不自动装 wrapper)。Smart 模式默认对 `install` 生效,但显式 flag 可以关闭。

### 非目标(v1)

- Shell rc 里的函数定义 `cc-X() { ... }`(只解析 `alias cc-X='...'`)
- 多行 shell 续行
- 条件 alias(`[[ ... ]] && alias cc-X='...'`)
- 递归扫描 sourced files
- argv 里检测 `--settings <file>` 参数
- fish shell 支持(只 zsh/bash)
- wrapper 状态的 Web 控制面板

## 2. 当前状态(回顾)

### 已 ship(在 `feat/cli-image-proxy`)

- `provider-scan.ts` 读 `~/.claude/providers/*.json` + 同步 `~/.cc-switch/cc-switch.db` → `~/.cc-linker/auto-providers/`
- `provider-config.ts` 有 `installProvider(opts)`(3 态机:真幂等 / 跨 port 重装 / 首次)
- `routes.ts` 有 `addRoute/removeRoute/loadRoutes/saveRoutes/listRoutes` + `resolveUpstream(path, alias)`(按 alias 查 upstream)
- `img-proxy` CLI 有:`install --providers|--all`, `uninstall --providers|--all`, `start [--daemon]`, `stop`, `status`, `daemon install|uninstall`

### 本次设计要加的

- 模型分类器(`src/img-proxy/classify.ts`)
- Shell alias 扫描(`src/img-proxy/aliases.ts`)
- 智能安装流程(替换当前 `imgProxyInstall` 里的 inquirer 流程)
- `resolve` 子命令(新,按 upstream 查 proxy URL)
- `wrapper-install` / `wrapper-uninstall` 子命令
- status 增强(显示 wrapper 状态)
- Config.toml 字段(`smart_mode`, `vision_model_patterns_extra`, `text_only_model_patterns_extra`)
- Docs(`docs/img-proxy.md` 新章节)

## 3. 命名清理

`src/img-proxy/routes.ts:41` 有 `resolveUpstream(path, alias)`,返回指定 alias 的 **upstream**。新 wrapper 功能需要相反:给定 upstream URL,找到 proxy URL。

**操作:重命名现有的 + 加新函数。**

```typescript
// src/img-proxy/routes.ts — 重命名(原来是 resolveUpstream):
export function getUpstreamByAlias(path: string, alias: string): string | null {
  return loadRoutes(path).routes[alias]?.upstream ?? null;
}

// src/img-proxy/routes.ts — 新增:
/**
 * 根据真实 upstream 查 proxy URL。
 * 被 `cc-linker img-proxy resolve <upstream>` 和 shell wrapper 调用。
 * 如果 routes 表里有匹配的,返回 `http://${hostname}:${port}/${alias}`,否则 null。
 */
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

全项目搜索 `resolveUpstream` 调用方,改成 `getUpstreamByAlias`。

## 4. 模型分类

### 模块:`src/img-proxy/classify.ts`

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
  /^qwen3\.\d+(\.\d+)?-plus/i,    // qwen3.6-plus, qwen3.7-plus 原生多模态

  // === Zhipu GLM(只有 -V 后缀变体是多模态;GLM-5 系列是文本) ===
  /^glm-.*-?v/i,                  // glm-4v, glm-4.5v, glm-5v

  // === Moonshot Kimi(全系列多模态) ===
  /^kimi/i,

  // === MiniMax ===
  /^MiniMax-M3/i,

  // === Xiaomi MiMo(只有 base,不带 pro) ===
  /^mimo-v\d+(\.\d+)?(?!-pro)/i,

  // === ByteDance ===
  /^doubao.*-vision/i, /^seed.*-vision/i,

  // === Stepfun / Hunyuan / ERNIE ===
  /^step-1v/i, /^step.*-vision/i,
  /^hunyuan.*-vision/i,
  /^ernie-.*-vision/i,

  // === 通用 vision 标记 ===
  /-vision$/i, /-vl-/i, /-vlm/i,
];

const TEXT_ONLY_PATTERNS: RegExp[] = [
  // === GLM(NOT 4v/4.5v/5.x —— 那些在上面 multimodal;GLM-5 系列是文本) ===
  /^glm-\d+(\.\d+)?$/i,           // glm-4.5, glm-4.6, glm-5, glm-5.1
  /^glm-4-(air|turbo)/i,

  // === DeepSeek ===
  /^deepseek/i,

  // === Qwen 文本变体(NOT -plus per research, NOT -vl) ===
  /^qwen-turbo/i, /^qwen-max/i, /^qwen-long/i, /^qwen-coder/i,
  /^qwen3.*-coder/i,
  /^qwen3\.\d+(\.\d+)?-max/i,    // qwen3.7-max (NOT -plus)

  // === Moonshot legacy ===
  /^moonshot-v1-/i,

  // === 国内 LLM 厂商(文本) ===
  /^baichuan/i, /^yi-/i,

  // === MiniMax M2(文本)+ 老 abab ===
  /^MiniMax-M2/i, /^MiniMax-Text-/i, /^abab/i,

  // === Xiaomi MiMo Pro(文本) ===
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

### Config

`src/utils/config.ts` 在 `ConfigData.img_proxy` 里加:

```typescript
smart_mode: boolean;                  // default true
vision_model_patterns_extra: string[];  // default []
text_only_model_patterns_extra: string[]; // default []
```

## 5. Shell Alias 发现

### 模块:`src/img-proxy/aliases.ts`

```typescript
export interface DiscoveredAlias {
  name: string;          // "cc-byte-agent"
  providerPath: string | null;  // ~/.claude/providers/byte-agent-glm.json
  providerAlias: string | null;  // "byte-agent-glm" (文件名 stem)
  command: string;        // 完整命令
}

const SHELL_RC_FILES = [
  '.zshrc',
  '.zprofile',      // macOS zsh login
  '.bashrc',
  '.bash_profile',  // bash login
];

const ALIAS_LINE_RE = /^alias\s+(cc-[\w-]+)\s*=\s*['"]?([^'"\n]*)['"]?\s*$/;
const SETTINGS_RE = /--settings\s+(\S+\.json)/;

export function discoverShellAliases(
  rcFiles?: string[]
): DiscoveredAlias[] {
  const files = (rcFiles ?? defaultRcFiles()).filter(existsSync);
  const seen = new Set<string>();
  const result: DiscoveredAlias[] = [];

  for (const file of files) {
    const lines = safeReadLines(file);
    for (const line of lines) {
      if (line.trim().startsWith('#')) continue;  // 注释
      const m = line.match(ALIAS_LINE_RE);
      if (!m) continue;
      const name = m[1]!;
      const cmd = m[2]!.trim();

      // 跳过重复(多个 rc 文件可能重复定义)
      if (seen.has(name)) continue;
      seen.add(name);

      const settingsMatch = cmd.match(SETTINGS_RE);
      const providerPath = settingsMatch ? settingsMatch[1]! : null;
      const providerAlias = providerPath
        ? providerPath.replace(/^.*\//, '').replace(/\.json$/, '')
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

### v1 范围:只解析 `alias cc-X='...'` 单行

- ✅ 单行 `alias cc-X='cmd'`
- ✅ `alias cc-X="cmd"`(双引号)
- ✅ 注释行(跳过)
- ❌ 函数定义 `cc-X() { ... }`(跳过,太复杂)
- ❌ 多行 `\` 续行(跳过)
- ❌ 条件 `[[ ... ]] && alias ...`(跳过)
- ❌ 递归扫描 sourced files

## 6. 智能安装流程

### 修改:`imgProxyInstall()` 在 `src/cli/commands/img-proxy.ts`

```typescript
export async function imgProxyInstall(opts: {
  providers?: string;       // 现有 —— 显式指定,dumb 模式
  all?: boolean;             // 现有 —— dumb 模式(全装,不过滤)
  yes?: boolean;             // 新增 —— 跳过交互,用默认预选
  mode?: 'smart' | 'dumb';   // 新增 —— 显式模式(无 flag 时 smart 优先)
}): Promise<void> {
  const port = config.get<number>('img_proxy.port', 8765);
  const hostname = config.get<string>('img_proxy.hostname', '127.0.0.1');
  const smartMode = config.get<boolean>('img_proxy.smart_mode', true);
  const isExplicit = !!opts.providers || !!opts.all;
  const mode = opts.mode ?? (isExplicit ? 'dumb' : 'smart');

  // 1. 从 4 个来源发现候选
  const candidates = await discoverCandidates({ port, hostname });
  // candidates: Array<{...ProviderFileInfo, source: 'manual'|'auto'|'alias'|'cc-switch', kind: ModelKind}>

  if (candidates.length === 0) {
    /* 现有 "no providers" 错误信息,带 CC Switch 提示 */
    throw new CCLinkerError('E_IMG_PROXY_NO_PROVIDERS', '未找到任何可用的 provider 配置');
  }

  // 2. 按模式 + 分类过滤
  const filtered = mode === 'smart' && smartMode
    ? candidates.filter(c => c.kind !== 'multimodal')
    : candidates;

  // 3. 构造 inquirer choices
  const choices = filtered.map(c => ({
    name: buildChoiceLabel(c),   // 见下方格式
    value: c.alias,
    short: c.alias,
    checked: c.kind !== 'multimodal',  // text-only + unknown 默认预选
  }));

  // 4. 解析显式 --providers(dumb 模式)或交互
  let targets: typeof filtered;
  if (opts.providers) {
    const wanted = new Set(opts.providers.split(',').map(s => s.trim()).filter(Boolean));
    targets = filtered.filter(c => wanted.has(c.alias));
    if (targets.length === 0) throw new CCLinkerError('E_IMG_PROXY_UNKNOWN_ALIAS', ...);
  } else if (opts.all || opts.yes) {
    targets = filtered;  // --all = dumb 全装;--yes = smart 默认预选
  } else {
    const { picks } = await inquirer.prompt([{
      type: 'checkbox',
      name: 'picks',
      message: '选择要启用图片代理的 provider:',
      choices,
      pageSize: 20,
    }]);
    if (picks.length === 0) { console.log('未选择'); return; }
    const pickedSet = new Set(picks);
    targets = filtered.filter(c => pickedSet.has(c.alias));
  }

  // 5. 装每个(沿用现有 installProvider 逻辑)
  for (const t of targets) {
    installProvider({
      providerPath: t.path,
      alias: t.alias,
      routesPath: IMG_PROXY_ROUTES_PATH,
      port, hostname,
    });
  }

  // 6. Smart 模式:检测到 CC Switch 时,问要不要装 wrapper
  if (mode === 'smart' && hasCcSwitch() && !isWrapperInstalled()) {
    const { wrap } = await inquirer.prompt([{
      type: 'confirm',
      name: 'wrap',
      message: '检测到 CC Switch。是否装 wrapper(让 cc-linker-proxy 命令替代 claude)?',
      default: true,
    }]);
    if (wrap) {
      await imgProxyWrapperInstall();
    }
  }

  // 7. 打 summary
  printInstallSummary(targets, mode);
}
```

### Inquirer choice label 格式

```typescript
function buildChoiceLabel(c: Candidate): string {
  const sourceTag = `[${c.source}]`.padEnd(11);  // [manual], [auto], [alias], [cc-switch]
  const kindTag = c.kind === 'multimodal' ? '⏭ multimodal-skip' : '✅ ' + c.kind;
  return `${sourceTag} ${c.alias.padEnd(20)} ${kindTag.padEnd(20)} ${c.model || '(no model)'}`;
}
```

示例输出:
```
? 选择要启用图片代理的 provider:
  ❯ ◯ [manual]     glm-5.2               ✅ text-only        glm-5.2[1m]
    ◯ [alias]      byte-agent-glm        ✅ text-only        glm-5.2[1m]
    ◯ [auto]       kimi-for-coding       ⏭ multimodal-skip  kimi-for-coding[256k]
    ◯ [auto]       qwen3.7-plus          ⏭ multimodal-skip  qwen3.7-plus[1m]
    ◯ [auto]       minimax-m2.7          ✅ text-only        MiniMax-M3[1m]
```

### 发现函数

```typescript
interface Candidate extends ProviderFileInfo {
  source: 'manual' | 'auto' | 'alias' | 'cc-switch';
  kind: ModelKind;
}

async function discoverCandidates(opts: { port: number; hostname: string }): Promise<Candidate[]> {
  const fromFiles = scanProviderFiles();  // manual + auto-synced cc-switch
  const fromAliases = discoverShellAliases();

  // 建 alias → file 映射(manual 优先,沿用 scanProviderFiles 逻辑)
  const fileByAlias = new Map<string, ProviderFileInfo>();
  for (const f of fromFiles) {
    if (!fileByAlias.has(f.alias)) fileByAlias.set(f.alias, f);
  }

  // 建 alias → alias-discovery 映射
  const aliasByShell = new Map<string, DiscoveredAlias>();
  for (const a of fromAliases) {
    if (a.providerAlias) aliasByShell.set(a.providerAlias, a);
  }

  // 合并:file 是真值,alias 是 hint
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  for (const [alias, file] of fileByAlias) {
    seen.add(alias);
    const shell = aliasByShell.get(alias);
    candidates.push({
      ...file,
      source: shell ? 'alias' : (file.path.includes('auto-providers') ? 'auto' : 'manual'),
      kind: classifyModel(file.model, getExtraPatterns()),
    });
  }
  // 包含指向不存在文件的 alias(罕见)
  for (const [alias, shell] of aliasByShell) {
    if (seen.has(alias)) continue;
    candidates.push({
      alias,
      path: shell.providerPath ?? '',
      baseUrl: '',
      model: '',
      source: 'alias',
      kind: 'unknown',  // 没读文件无法分类
    });
  }

  // 排序:按 source 优先级,然后 alias
  const sourcePriority: Record<Candidate['source'], number> = { manual: 0, cc_switch: 1, auto: 2, alias: 3 };
  candidates.sort((a, b) => {
    const dp = sourcePriority[a.source] - sourcePriority[b.source];
    if (dp !== 0) return dp;
    return a.alias.localeCompare(b.alias);
  });
  return candidates;
}

function getExtraPatterns(): { visionPatterns: string[]; textOnlyPatterns: string[] } {
  return {
    visionPatterns: config.get<string[]>('img_proxy.vision_model_patterns_extra', []),
    textOnlyPatterns: config.get<string[]>('img_proxy.text_only_model_patterns_extra', []),
  };
}
```

### 模式行为矩阵

| 命令 | 模式 | 行为 |
|------|------|------|
| `install` | smart | 4 路发现 + 分类,预选 text-only + unknown,交互(或 `--yes`) |
| `install --providers X` | dumb | 只装 X,不过滤 |
| `install --all` | dumb | 装所有,不过滤 |
| `install --yes` | smart | smart 预选,不交互 |
| `install --mode=dumb` | dumb | 同 `--all`,但显式 mode flag |
| `install --mode=smart` | smart | smart(本来就是默认) |

### Summary 输出

```
✅ 已装 4 个 (smart 模式):
   glm-5.2[1m]            ✅ text-only
   byte-agent-glm          ✅ text-only (from ~/.zshrc cc-byte-agent)
   minimax-m2.7            ✅ text-only
   qwen3.7-max             ✅ text-only

⏭ 跳过 2 个多模态(不会破坏图片能力):
   kimi-for-coding         ⏭ multimodal
   qwen3.7-plus            ⏭ multimodal

✅ wrapper 已装到 ~/.zshrc
   运行 source ~/.zshrc 或重开 shell 激活 cc-linker-proxy
```

## 7. Wrapper Install(已覆盖在旧 spec)

### `imgProxyWrapperInstall` — `src/cli/commands/img-proxy.ts`

```typescript
export async function imgProxyWrapperInstall(): Promise<void> {
  const shell = detectShell();
  if (!shell) {
    console.log(chalk.red('当前 shell 不支持(zsh/bash 之外)'));
    return;
  }
  const rcFile = getRcFilePath(shell);
  const content = readOrEmpty(rcFile);
  
  if (content.includes(WRAPPER_START_MARKER)) {
    console.log(chalk.yellow('wrapper 已装(idempotent)'));
    return;
  }
  
  // 备份
  mkdirSync(dirname(IMG_PROXY_WRAPPER_BACKUP_DIR), { recursive: true });
  const backup = join(IMG_PROXY_WRAPPER_BACKUP_DIR, `wrapper-backup-${Date.now()}`);
  if (content) copyFileSync(rcFile, backup);
  
  // 追加
  const block = generateWrapperBlock(shell);
  const newContent = content + (content.endsWith('\n') ? '' : '\n') + block + '\n';
  writeFileSync(rcFile, newContent, { mode: 0o644 });
  
  console.log(chalk.green(`✅ wrapper 已装到 ${rcFile}`));
  console.log(chalk.cyan('   运行 source ~/.zshrc 或重开 shell 激活 cc-linker-proxy'));
}
```

### Wrapper 函数(`src/img-proxy/wrapper.ts`)

旧 spec 已覆盖,核心部分:

```typescript
export const WRAPPER_START_MARKER = '# >>> cc-linker img-proxy wrapper (do not edit this block) >>>';
export const WRAPPER_END_MARKER = '# <<< cc-linker img-proxy wrapper <<<';

export function generateWrapperBlock(): string {
  return `${WRAPPER_START_MARKER}
cc-linker-proxy() {
  local real_url="\${ANTHROPIC_BASE_URL:-\$(command cc-linker img-proxy current-url)}"
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
```

### 新子命令:`cc-linker img-proxy wrapper-install|wrapper-uninstall|wrapper-status`

(以及 wrapper 函数调用的 `current-url` 和 `resolve`)

| 子命令 | 作用 | 输出 |
|--------|------|------|
| `wrapper-install` | 把 `cc-linker-proxy()` 加到 shell rc | 成功提示 |
| `wrapper-uninstall` | 从 shell rc 移除函数 | 成功提示 |
| `wrapper-status` | 检测是否已装 | 是/否 + rc 文件路径 |
| `resolve <upstream>` | 按真实 upstream 查 proxy URL | `http://...:port/alias` 或空 |
| `current-url` | 读 `~/.claude/settings.json` 的 `env.ANTHROPIC_BASE_URL` | URL 或空 |

成功都 exit 0(空 stdout = "没找到"),硬错误(文件读不到、JSON 解析失败)exit 1。所有错误/警告走 stderr。

## 8. Status 显示

`imgProxyStatus` 加 wrapper 状态段:

```
$ cc-linker img-proxy status
=== cc-linker img-proxy 状态 ===

✅ 运行中 (PID: 93092)
   监听: http://127.0.0.1:8765   日志: ~/.cc-linker/img-proxy/img-proxy.log

已 install 的 provider: 2
   byte-agent-glm  →  https://ark.cn-beijing.volces.com/api/plan
   glm-5.2         →  https://open.bigmodel.cn/api/anthropic

wrapper: ✅ 已装 (zsh, ~/.zshrc)
   提示: 跑 cc-linker-proxy 替代 claude

未纳入代理的 provider: 14
   · bailian-glm (text-only)
   · bailian-qwen3.6 (multimodal)
   · kimi-for-coding (multimodal)
   ...

开机自启: launchd 未配置
```

## 9. Config.toml

```toml
[img_proxy]
enabled = true
port = 8765
hostname = "127.0.0.1"
cache_max_age_hours = 168
prompt_template = "..."
console_enabled = false

# === P2 新增 ===
# 智能模式:跳过已知多模态模型,只 proxy 文本模型
smart_mode = true

# 追加自定义多模态 patterns(也会被跳过)
vision_model_patterns_extra = []

# 追加自定义文本 patterns(也会被 proxy)
text_only_model_patterns_extra = []
```

## 10. 实施顺序

1. **重命名 `resolveUpstream` → `getUpstreamByAlias`** + 加 `resolveProxyByUpstream` 在 `src/img-proxy/routes.ts`(15 min)
2. **`src/img-proxy/classify.ts`** — `classifyModel()` 带完整 pattern 列表(1 h)
3. **classify 单元测试** — 23+ cases 覆盖所有 pattern + 后缀剥离(1 h)
4. **`src/img-proxy/aliases.ts`** — `discoverShellAliases()` rc 文件解析(1 h)
5. **aliases 单元测试** — 8+ cases 各种 shell 语法(30 min)
6. **`src/img-proxy/wrapper.ts`** — `generateWrapperBlock()` + `isWrapperInstalled()`(30 min)
7. **新子命令在 `src/cli/commands/img-proxy.ts`**:
   - `imgProxyCurrentUrl`(15 min)
   - `imgProxyResolve`(15 min)
   - `imgProxyWrapperInstall` / `imgProxyWrapperUninstall` / `imgProxyWrapperStatus`(1 h)
   - 在 `src/index.ts` 注册(15 min)
8. **修改 `imgProxyInstall`** — 加 smart 流程、4 路发现、模型分类、wrapper 提示(1.5 h)
9. **修改 `imgProxyStatus`** — 加 wrapper 状态 + 分类(30 min)
10. **`src/utils/config.ts`** — 加 3 个新字段 + defaults(15 min)
11. **`docs/img-proxy.md`** — 新 "CC Switch 用户怎么用" 章节(30 min)
12. **手动 smoke** — 真实 shell wrapper 调用(30 min)
13. **Deploy + push**(15 min)

**总:约 9 小时**

## 11. 测试计划

### 单元测试

| 模块 | 测试 | 覆盖 |
|------|------|------|
| `classify.ts` | 23+ | 所有内置 pattern + 后缀剥离 + config extra patterns |
| `aliases.ts` | 8+ | 各种 shell 语法、注释、边界、文件缺失 |
| `wrapper.ts` | 5+ | 幂等、marker 检测、函数生成 |
| `routes.ts` | 3 | 重命名 `getUpstreamByAlias`、新 `resolveProxyByUpstream`、迁移 |

### 集成测试

| 测试 | 预期 |
|------|------|
| 真实子 shell 里跑 `cc-linker-proxy` | 设置 env var,调 claude(mock) |
| 多个 rc 文件存在 | 只往检测到的那个追加 wrapper |
| 并发 `install` 调用 | 锁或队列防 race |

### 手动 smoke(merge 后)

```bash
# Setup
cc-linker img-proxy install    # smart 模式
# 验证:显示表格、预选 text-only、问 wrapper
source ~/.zshrc
cc-linker-proxy "echo test"    # 应该设置 env var
```

## 12. 开放问题

1. **`--yes` flag 默认预选** — 如果所有 text-only + unknown,通常是大多数 provider。如果用户要严格(只要 text-only,不要 unknown),v2 加 `--strict` flag。
2. **`--all` / `--providers` 时是否自动装 wrapper** — 当前计划:不,只在 smart `install` 装。用户可以手动 `wrapper-install`。Trade-off:显式 vs 自动。决定:显式。
3. **CC Switch DB 读性能** — `syncCcSwitchToAutoProviders` 是同步的。50+ providers 的 DB 可能慢。Install 是低频操作,可接受。
4. **如果用户第一次跑时 `~/.claude/settings.json` 不存在?** wrapper 会报错 "no current provider"。如果用户不直接跑 `claude` 就忽略。
5. **shell alias 解析边界** — 用户用 `function cc-X { ... }` 而不是 `alias`?v1:静默跳过。v2:解析函数。
6. **其他 shell 文件像 `~/.config/fish/config.fish`?** v1:只 zsh/bash,fish 超出范围。
7. **`install` 输出冗长度** — 当前 `install` 打印 "✅ 已装 N, 跳过 M" + 详情。16+ providers 时输出可能长。可接受(一次性操作)。

## 13. 参考

- `docs/superpowers/plans/2026-07-04-cli-image-proxy.md` — Phase 1 实施 plan
- `docs/superpowers/plans/2026-07-04-img-proxy-wrapper.md` — Wrapper 内部(wrapper 函数生成、marker 常量、边界)
- `docs/img-proxy.md` — 用户使用 doc
- 现有 `src/img-proxy/provider-scan.ts` — 4 路扫描器(P0-1 cc-switch 支持)
- 现有 `src/img-proxy/provider-config.ts` — `installProvider` 3 态机
- 现有 `src/cli/commands/img-proxy.ts` — 当前 CLI 结构

---

## 14. 用户场景 & 验收测试标准(重要!)

**这是实施前必须明确的"什么算成功"。每个场景都有具体的输入/操作/预期/验证步骤,可直接转成自动化测试。**

### 14.1 用户画像

| 画像 | 描述 | 典型场景 |
|------|------|---------|
| **A. 纯 CC Switch 用户** | 只有 CC Switch,`~/.claude/providers/` 为空 | 多数中国 LLM 用户现状 |
| **B. 自定义 alias 用户** | `~/.claude/providers/` 有文件,`~/.zshrc` 有 `cc-X='claude --settings ...'` | 老 cc-linker 用户 |
| **C. 混合用户** | CC Switch + 自定义 alias 都有 | 重度用户 |
| **D. 全新 cold-start** | 刚装 cc-linker,没 CC Switch 也没 manual | 新用户 |
| **E. 官方 API 直连** | 不用 CC Switch,`~/.claude/settings.json` 指 `api.anthropic.com` | 少数派 |

---

### 14.2 场景 A:纯 CC Switch 用户(最常见)

#### 14.2.1 前置条件

```bash
# 用户的 ~/.claude/providers/ 不存在或为空
ls ~/.claude/providers/  # Empty or No such file
# CC Switch 已装
ls ~/.cc-switch/cc-switch.db  # exists
# CC Switch DB 含 glm-5.2 + kimi-for-coding + qwen3.6-plus 等
# 用户跑 cc-switch use glm-5.2 时,~/.claude/settings.json 被更新
```

#### 14.2.2 操作流程

```bash
# 用户跑(最简):
$ cc-linker img-proxy install

# 期望输出(简化):
🔍 发现 12 个 claude providers(来自 CC Switch):
  ❯ ◯ [auto]  glm-5.2           ✅ text-only        glm-5.2[1m]
    ◯ [auto]  kimi-for-coding   ⏭ multimodal-skip  kimi-for-coding[256k]
    ◯ [auto]  qwen3.6-plus      ⏭ multimodal-skip  qwen3.6-plus[1m]
    ◯ [auto]  minimax-m2.7      ✅ text-only        MiniMax-M3[1m]
    ... (8 more)

(已预选 4 个 text-only;multimodal 默认跳过)

> a (全选 text-only)
> enter

✅ 已装 4 个(smart 模式)
✅ 检测到 CC Switch,装 wrapper 到 ~/.zshrc?

> y
> enter

✅ wrapper 已装到 ~/.zshrc
   运行 source ~/.zshrc 或重开 shell 激活 cc-linker-proxy

完成: cc-linker img-proxy start --daemon
```

#### 14.2.3 验收标准

| # | 验证项 | 期望 |
|---|--------|------|
| A1 | `~/.cc-linker/auto-providers/` 存在并有 12 个 `.json` 文件(从 CC Switch 同步) | ✓ |
| A2 | 4 个 text-only 的 auto-providers 文件 BASE_URL 被改成 `http://127.0.0.1:8765/<alias>` | ✓ |
| A3 | 4 个 multimodal 的 auto-providers 文件**未被修改** | ✓ |
| A4 | `~/.cc-linker/img-proxy/routes.json` 有 4 个 entry,每个 `upstream` 是真实 CC Switch URL(不是 proxy URL) | ✓ |
| A5 | `~/.zshrc` 末尾追加了 `cc-linker-proxy()` 函数(在 marker 之间) | ✓ |
| A6 | `~/.zshrc` 的修改前内容备份到 `~/.cc-linker/img-proxy/wrapper-backup-<ts>` | ✓ |
| A7 | daemon 启动,PID 文件在 `~/.cc-linker/img-proxy/img-proxy.pid` | ✓ |
| A8 | `curl http://127.0.0.1:8765/<alias>/v1/models` 返回 401(代理转发,upstream 拒 auth,符合预期) | ✓ |

#### 14.2.4 日常使用流程

```bash
# 用户 source 一次
$ source ~/.zshrc

# 日常:用 CC Switch 切模型,跑 cc-linker-proxy
$ cc-switch use glm-5.2
$ cc-linker-proxy "看这个图"
# 期望:
# 1. 读 ~/.claude/settings.json → https://open.bigmodel.cn/api/anthropic
# 2. 调 cc-linker img-proxy resolve → http://127.0.0.1:8765/glm-5.2
# 3. ANTHROPIC_BASE_URL=http://127.0.0.1:8765/glm-5.2 command claude "看这个图"
# 4. claude 请求到 proxy
# 5. proxy 剥 image 块,落盘,替换成路径 text
# 6. 转发到 https://open.bigmodel.cn/api/anthropic/v1/messages
# 7. upstream 收到纯文本,处理

# 切到 kimi
$ cc-switch use kimi-for-coding
$ cc-linker-proxy "看图"
# 期望:cc-linker-proxy 报错"kimi-for-coding 没在 img-proxy 里,hint: cc-linker img-proxy install"
#  因为 kimi 是 multimodal,我们没装
```

#### 14.2.5 验收标准(日常使用)

| # | 验证项 | 期望 |
|---|--------|------|
| A9 | `cc-linker-proxy "echo test"` 设置 `ANTHROPIC_BASE_URL` 后 exec `claude` | exit code 0 |
| A10 | 切换 CC Switch 后 `cc-linker-proxy` 跟随,调不同的 proxy URL | ✓ |
| A11 | 切换到未装的 provider,kimi/multimodal → 报错,exit 1 | ✓ |
| A12 | `claude` 直跑(不用 `cc-linker-proxy`)走原 URL(不 proxy) | ✓(verify via env) |

---

### 14.3 场景 B:自定义 alias 用户

#### 14.3.1 前置条件

```bash
# 用户有 ~/.claude/providers/byte-agent-glm.json
cat ~/.claude/providers/byte-agent-glm.json
# {
#   "model": "opus",
#   "env": {
#     "ANTHROPIC_BASE_URL": "https://ark.cn-beijing.volces.com/api/plan",
#     ...
#   }
# }

# ~/.zshrc:
# alias cc-byte-agent='claude --settings ~/.claude/providers/byte-agent-glm.json'

# CC Switch 未装
ls ~/.cc-switch/cc-switch.db  # No such file
```

#### 14.3.2 操作流程

```bash
$ cc-linker img-proxy install

🔍 发现 1 个 provider(来自 manual + alias):
  ❯ ◯ [alias]  byte-agent-glm   ✅ text-only        glm-5.2[1m]

(1 个候选,已预选)

> enter

✅ 已装 1 个(smart 模式)

# 注意:没问 wrapper —— 因为没 CC Switch
# 用户继续用 cc-byte-agent alias,不需要 wrapper

完成
```

#### 14.3.3 验收标准

| # | 验证项 | 期望 |
|---|--------|------|
| B1 | `~/.claude/providers/byte-agent-glm.json` 的 `ANTHROPIC_BASE_URL` 被改成 `http://127.0.0.1:8765/byte-agent-glm` | ✓ |
| B2 | `byte-agent-glm.json.bak` 创建,内容是原始(ark URL) | ✓ |
| B3 | `routes.json` 有 `byte-agent-glm` entry,`upstream = ark URL`(不是 proxy URL) | ✓ |
| B4 | **不**追加 wrapper 到 `~/.zshrc`(因为没 CC Switch) | ✓ |
| B5 | `cc-byte-agent "看图"` 走 proxy(因为 alias 指向的文件 BASE_URL 已改) | ✓ |

---

### 14.4 场景 C:混合用户

#### 14.4.1 前置条件

```bash
# 既有 CC Switch 又有 manual 文件和 alias
ls ~/.claude/providers/  # 4 个文件
ls ~/.cc-switch/cc-switch.db  # exists
cat ~/.zshrc | grep "alias cc-"
# alias cc-byte-agent='claude --settings ~/.claude/providers/byte-agent-glm.json'
# alias cc-byte-glm='claude --settings ~/.claude/providers/byte-glm.json'
# alias cc-glm='claude --settings ~/.claude/providers/glm-5.2.json'
```

#### 14.4.2 操作流程

```bash
$ cc-linker img-proxy install

🔍 发现 16 个 candidate(4 manual + 12 auto + 3 alias → dedup by alias):
  ❯ ◯ [manual]  byte-agent-glm    ✅ text-only        glm-5.2[1m]
    ◯ [manual]  byte-glm         ✅ text-only        glm-5.2[1m]
    ◯ [manual]  glm-5.2          ✅ text-only        glm-5.2[1m]
    ◯ [alias]   kimi-for-coding   ✅ text-only        kimi-for-coding[256k]
    ◯ [auto]    MiniMax-m2.7     ✅ text-only        MiniMax-M3[1m]
    ◯ [auto]    qwen3.6-plus     ⏭ multimodal-skip  qwen3.6-plus[1m]
    ... (10 more, deduped)

# 注意:[manual] 和 [alias] 同 alias 时,manual 优先(sourcePriority: manual=0, alias=3)
# 但 dedup 后只剩一个 entry,source 显示 [manual] 或 [alias](取决于谁先被处理)

> a (全选 text-only)
> enter

✅ 已装 6 个
✅ 检测到 CC Switch,装 wrapper?

> y

✅ wrapper 已装
```

#### 14.4.3 验收标准

| # | 验证项 | 期望 |
|---|--------|------|
| C1 | dedup 后 unique candidate 数 = union(manual, auto) | 16 - dedup = 实际数 |
| C2 | source 列正确区分 manual/auto/alias | ✓ |
| C3 | 同 alias 多源时,只显示一个(优先级最高的) | ✓ |
| C4 | 安装数量 = 选中的 text-only | ✓ |

---

### 14.5 场景 D:全新 cold-start 用户

#### 14.5.1 前置条件

```bash
ls ~/.claude/providers/  # No such file
ls ~/.cc-switch/  # No such file or directory
```

#### 14.5.2 操作流程

```bash
$ cc-linker img-proxy install

❌ 未找到任何可用的 provider 配置

  已扫描的位置:
    • ~/.claude/providers/ (manual)
    • ~/.cc-switch/cc-switch.db (未安装)

  解决方案(任选其一):
    1. 装 CC Switch (https://github.com/farion1231/cc-switch)
       — GUI 管理 provider,装好后 Claude Code 自动可用,img-proxy 也会自动识别
    2. 手动创建 provider 文件:
       ~/.claude/providers/my-provider.json
       内容参考 docs/img-proxy.md "冷启动" 一节

错误 [E_IMG_PROXY_NO_PROVIDERS]
```

#### 14.5.3 验收标准

| # | 验证项 | 期望 |
|---|--------|------|
| D1 | exit code 1 | ✓ |
| D2 | stderr 给出可操作建议(装 CC Switch 或手写文件) | ✓ |
| D3 | 没有创建 routes.json / wrapper / daemon | ✓(no side effects) |

---

### 14.6 场景 E:官方 API 直连用户

#### 14.6.1 前置条件

```bash
cat ~/.claude/settings.json
# { "env": { "ANTHROPIC_BASE_URL": "https://api.anthropic.com" } }
```

#### 14.6.2 操作流程

```bash
$ cc-linker img-proxy install
# 同场景 D(没 CC Switch,没 manual)
# 报错:未找到任何可用的 provider 配置

# 或者用户装了 CC Switch 选了 ByteDance/Moonshot,但 settings.json 默认是 Anthropic
# 这种情况:用户在 CC Switch GUI 里选其他 provider 后,settings.json 才会更新
```

#### 14.6.3 验收标准

| # | 验证项 | 期望 |
|---|--------|------|
| E1 | 跑 `cc-linker-proxy` 时,settings.json 的 `https://api.anthropic.com` 在 routes.json 找不到匹配 | wrapper 报错 "未在 img-proxy 里" |
| E2 | 错误信息清晰:用户知道装什么或换 provider | ✓ |

---

### 14.7 边缘场景 + 验收标准(15 个)

| # | 场景 | 输入 | 操作 | 预期 |
|---|------|------|------|------|
| E1 | **Install 幂等** | 已装 glm-5.2 | 再跑 `install` | routes.json 不重复(还是 1 个 entry),provider 文件不被覆盖(token 保持),`已装 N, 跳过 M` 提示 |
| E2 | **跨 port 重装** | 装了 8765,config 改 8766 | 跑 `install` | BASE_URL 改成 8766,`.bak` 不变(原 upstream),routes.json 的 `upstream` 仍是原始 ark URL(不是 8765 proxy) |
| E3 | **Unknown model** | provider model `some-new-model[1m]` | 跑 `install` | 默认按 text-only 预选 + 安装(conservative default) |
| E4 | **Wrapper 幂等** | 已装 wrapper | 再跑 `wrapper-install` | 输出"wrapper 已装(idempotent)",rc 文件**不**重复 |
| E5 | **CC Switch 切换** | CC Switch 切到 glm-5.2 | 跑 `cc-linker-proxy` | 读 settings.json 拿新 URL,resolve 到 proxy,转发到新 provider 的 proxy URL |
| E6 | **Provider 未装** | CC Switch 切到没装过的 | 跑 `cc-linker-proxy` | stderr: "X 没在 img-proxy 里,hint: cc-linker img-proxy install",exit 1 |
| E7 | **递归 wrapper** | `cc` alias = `cc-linker-proxy` | 跑 `cc` | 检测 `ANTHROPIC_BASE_URL` 已是 proxy URL,跳过 resolve,直接 exec `claude` |
| E8 | **Model 带 bracket** | `glm-5.2[1m]` | classify | 剥 `[1m]` → `glm-5.2` → 匹配 text-only |
| E9 | **并发 install** | 两个 terminal 同时跑 | 跑 `install` | routes.json 写锁防 race(可选 v1;v1 接受 last-write-wins) |
| E10 | **Config extra patterns** | `vision_model_patterns_extra = ["my-vl-*"]` | 装 `my-vl-test` | 按 multimodal 跳过 |
| E11 | **wrapper-uninstall + 还在用** | 装好 wrapper,跑 `cc-linker-proxy`,然后 `wrapper-uninstall` | 跑 `cc-linker-proxy` | 当前 shell 仍能用(函数已 load),新 shell 不行(函数被移除) |
| E12 | **stale PID** | daemon 被 kill -9 | 跑 `status` | 检测 PID 文件 → dead,提示清理 |
| E13 | **CC Switch 加新 provider** | CC Switch GUI 加新 provider | 跑 `install` | mtime check 触发 re-sync,新 provider 出现在 install 列表 |
| E14 | **手动改 token** | install 后用户改 provider 文件的 `ANTHROPIC_AUTH_TOKEN` | 跑 `install` | token 保留(.bak 不动),`isProviderInstalled` 仍 true |
| E15 | **Multimodal 误判** | 模型名不在任何 pattern | 跑 `install` | 按 unknown → 默认 proxy(可能误判为可 proxy,但不崩) |

---

### 14.8 配置模板(给用户参考)

#### 14.8.1 默认 config(纯 CC Switch 用户)

```toml
# ~/.cc-linker/config.toml
[img_proxy]
enabled = true
port = 8765
hostname = "127.0.0.1"
cache_max_age_hours = 168
prompt_template = '[用户粘贴的图片已保存到本地: {path}] ...'
console_enabled = false
# smart_mode 默认 true
```

#### 14.8.2 自定义多模态 patterns(用户有特殊模型)

```toml
[img_proxy]
smart_mode = true
# 用户用某个特殊多模态模型,内置没覆盖
vision_model_patterns_extra = [
  "doubao-pro-vision",       # 假设有这个模型
  "my-custom-multimodal-*",
]
```

#### 14.8.3 关闭 smart(全装)

```toml
[img_proxy]
smart_mode = false  # 关闭智能模式,所有 model 都按 text-only 走
```

#### 14.8.4 换 wrapper 名字(如果 cc-linker-proxy 跟用户工具冲突)

```toml
[img_proxy]
# (wrapper 名字目前是硬编码 cc-linker-proxy,config 不支持改)
# 如果用户想换名字,需要手动编辑 ~/.zshrc,删我们的 wrapper 后手动加
```

---

### 14.9 实施后必须跑的烟测(5 个)

实施完成后,按顺序跑这 5 个烟测:

| # | 烟测 | 命令 | 预期 |
|---|------|------|------|
| S1 | 纯 CC Switch 用户 install | `cc-linker img-proxy install` | 看输出符合 14.2.2 流程,文件状态符合 14.2.3 表格 |
| S2 | Wrapper daily use | `source ~/.zshrc; cc-linker-proxy "echo test"` | ANTHROPIC_BASE_URL 设置,claude 被 exec |
| S3 | Unknown model default | 临时在 provider 文件改 model 名到不存在的,跑 install | 装成功,按 text-only |
| S4 | Wrapper idempotency | 连跑 2 次 `wrapper-install` | 第二次输出"已装",rc 文件不重复 |
| S5 | E1 验证(已装后 reinstall) | install 装 glm-5.2 → 再 install | routes.json 还是 1 个 entry,文件 token 不变 |

---

### 14.10 失败模式汇总

实施时必须考虑这些失败模式,每个都有兜底:

| 失败 | 兜底 |
|------|------|
| `~/.claude/settings.json` 读不到 | `current-url` 输出空,wrapper 报错 "no current provider" |
| `~/.claude/settings.json` JSON 损坏 | `current-url` exit 1 + stderr,wrapper 报错 |
| `routes.json` 读不到 | `resolve` 输出空,wrapper 报错 "未在 img-proxy 里" |
| `routes.json` 写失败(权限) | `install` 报错,daemon 不启动 |
| rc 文件写失败(权限) | `wrapper-install` 报错,提示手动编辑 |
| `cc-linker` binary 不在 PATH | wrapper 函数报错 "command not found" |
| CC Switch DB 锁/损坏 | `syncCcSwitchToAutoProviders` 静默忽略,manual 路径仍可用 |
| inquirer prompt 用户 Ctrl+C | process exit,已装部分保留(不 rollback) |
| 并发 `install`(两个 terminal) | v1 接受 last-write-wins;v2 加 lock |

---

## 15. (原 §13) 参考

- `docs/superpowers/plans/2026-07-04-cli-image-proxy.md` — Phase 1 实施 plan
- `docs/superpowers/plans/2026-07-04-img-proxy-wrapper.md` — Wrapper 内部(wrapper 函数生成、marker 常量、边界)
- `docs/img-proxy.md` — 用户使用 doc
- 现有 `src/img-proxy/provider-scan.ts` — 4 路扫描器(P0-1 cc-switch 支持)
- 现有 `src/img-proxy/provider-config.ts` — `installProvider` 3 态机
- 现有 `src/cli/commands/img-proxy.ts` — 当前 CLI 结构
