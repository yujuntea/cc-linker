# cc-linker img-proxy Smart Install — Design

> **Date:** 2026-07-04
> **Status:** Awaiting user review
> **Branch:** `feat/cli-image-proxy`
> **Supersedes:** Complements `docs/superpowers/plans/2026-07-04-img-proxy-wrapper.md` (which covers wrapper internals; this design covers the broader install + discovery flow)

## 1. Goals & Non-Goals

### Goals

- **One command for new users**: `cc-linker img-proxy install` does the right thing for all user types (CC Switch, custom aliases, both) without flags.
- **Skip multimodal models**: Don't run image-capable models (Claude 3+, GPT-4, etc.) through proxy — would lose their image understanding. Detect via model name patterns.
- **Auto-discover existing shell aliases**: Detect user's `cc-*` aliases in `~/.zshrc` / `~/.bashrc`, pre-select corresponding providers in install list.
- **Auto-install wrapper for CC Switch users**: When CC Switch is detected, offer to install the `cc-linker-proxy` shell wrapper so `claude` invocations go through proxy.
- **Backwards compatible**: `install --providers X` and `install --all` keep current behavior (no smart filtering, no wrapper auto-install). Smart mode is opt-in by default, but it's the new default for `install` (no flags).

### Non-Goals (v1)

- Function definition `cc-X() { ... }` in shell rc (only `alias cc-X='...'` parsed)
- Multi-line shell continuations
- Conditional aliases (`[[ ... ]] && alias cc-X='...'`)
- Recursive scanning of sourced files
- Detection of `--settings <file>` arg in argv
- Fish shell support (zsh/bash only)
- Web control panel for wrapper state

## 2. Current State (recap)

### Already shipped (in `feat/cli-image-proxy`)

- `provider-scan.ts` reads `~/.claude/providers/*.json` + syncs `~/.cc-switch/cc-switch.db` → `~/.cc-linker/auto-providers/`
- `provider-config.ts` has `installProvider(opts)` with 3-state machine (idempotent / port-rotation / first-time)
- `routes.ts` has `addRoute/removeRoute/loadRoutes/saveRoutes/listRoutes` + `resolveUpstream(path, alias)` (alias-based lookup, returns real upstream)
- `img-proxy` CLI has: `install --providers|--all`, `uninstall --providers|--all`, `start [--daemon]`, `stop`, `status`, `daemon install|uninstall`

### To add (this design)

- Model classifier (`src/img-proxy/classify.ts`)
- Shell alias scanner (`src/img-proxy/aliases.ts`)
- Smart install flow (replaces current inquirer flow in `imgProxyInstall`)
- `resolve` subcommand (new, upstream-based lookup)
- `wrapper-install` / `wrapper-uninstall` subcommands
- Status enhancement (show wrapper state)
- Config.toml fields (smart_mode, vision_model_patterns_extra, text_only_model_patterns_extra)
- Docs (`docs/img-proxy.md` new section)

## 3. Naming Cleanup

`src/img-proxy/routes.ts:41` has `resolveUpstream(path, alias)` that returns the **upstream** for a given alias. The new wrapper feature needs the **opposite**: given an upstream URL, find the proxy URL.

**Action: Rename existing + add new function.**

```typescript
// src/img-proxy/routes.ts — RENAMED (was resolveUpstream):
export function getUpstreamByAlias(path: string, alias: string): string | null {
  return loadRoutes(path).routes[alias]?.upstream ?? null;
}

// src/img-proxy/routes.ts — NEW:
/**
 * Look up proxy URL for a given real upstream.
 * Used by `cc-linker img-proxy resolve <upstream>` and the shell wrapper.
 * Returns `http://${hostname}:${port}/${alias}` if a route matches, null otherwise.
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

Update all callers of `resolveUpstream` → `getUpstreamByAlias` (search the codebase for usages).

## 4. Model Classification

### Module: `src/img-proxy/classify.ts`

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
  /^qwen3\.\d+(\.\d+)?-plus/i,    // qwen3.6-plus, qwen3.7-plus native multimodal

  // === Zhipu GLM (vision variants + GLM-5 series is text) ===
  /^glm-.*-?v/i,                  // glm-4v, glm-4.5v, glm-5v

  // === Moonshot Kimi (all multimodal) ===
  /^kimi/i,

  // === MiniMax ===
  /^MiniMax-M3/i,

  // === Xiaomi MiMo (base only, NOT pro) ===
  /^mimo-v\d+(\.\d+)?(?!-pro)/i,

  // === ByteDance ===
  /^doubao.*-vision/i, /^seed.*-vision/i,

  // === Stepfun / Hunyuan / ERNIE ===
  /^step-1v/i, /^step.*-vision/i,
  /^hunyuan.*-vision/i,
  /^ernie-.*-vision/i,

  // === Generic vision markers ===
  /-vision$/i, /-vl-/i, /-vlm/i,
];

const TEXT_ONLY_PATTERNS: RegExp[] = [
  // === GLM (NOT 4v/4.5v/5.x — those are multimodal above; GLM-5 series is TEXT) ===
  /^glm-\d+(\.\d+)?$/i,           // glm-4.5, glm-4.6, glm-5, glm-5.1
  /^glm-4-(air|turbo)/i,

  // === DeepSeek ===
  /^deepseek/i,

  // === Qwen text variants (NOT -plus per research, NOT -vl) ===
  /^qwen-turbo/i, /^qwen-max/i, /^qwen-long/i, /^qwen-coder/i,
  /^qwen3.*-coder/i,
  /^qwen3\.\d+(\.\d+)?-max/i,    // qwen3.7-max (NOT -plus)

  // === Moonshot legacy ===
  /^moonshot-v1-/i,

  // === Chinese LLM families ===
  /^baichuan/i, /^yi-/i,

  // === MiniMax M2 (text) + older abab ===
  /^MiniMax-M2/i, /^MiniMax-Text-/i, /^abab/i,

  // === Xiaomi MiMo Pro (text) ===
  /^mimo-.*-pro/i,

  // === OpenAI older ===
  /^(gpt-3|gpt-3\.5)/i,
];

export function classifyModel(
  modelName: string,
  extra?: { visionPatterns?: string[]; textOnlyPatterns?: string[] }
): ModelKind {
  // Strip trailing [quantifier]: [1m], [256k], etc.
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

`src/utils/config.ts` adds to `ConfigData.img_proxy`:

```typescript
smart_mode: boolean;                  // default true
vision_model_patterns_extra: string[];  // default []
text_only_model_patterns_extra: string[]; // default []
```

## 5. Shell Alias Discovery

### Module: `src/img-proxy/aliases.ts`

```typescript
export interface DiscoveredAlias {
  name: string;          // "cc-byte-agent"
  providerPath: string | null;  // ~/.claude/providers/byte-agent-glm.json
  providerAlias: string | null;  // "byte-agent-glm" (filename stem)
  command: string;        // full command
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
      if (line.trim().startsWith('#')) continue;  // comment
      const m = line.match(ALIAS_LINE_RE);
      if (!m) continue;
      const name = m[1]!;
      const cmd = m[2]!.trim();

      // Skip self-referencing (wrapper would be called cc-linker-proxy)
      // Skip if already seen across files
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

### v1 scope: only `alias cc-X='...'` lines

- ✅ Single-line `alias cc-X='cmd'`
- ✅ `alias cc-X="cmd"` (double quotes)
- ✅ Comment lines (skipped)
- ❌ Function definitions `cc-X() { ... }` (skipped, too complex)
- ❌ Multi-line `\` continuations (skipped)
- ❌ Conditional `[[ ... ]] && alias ...` (skipped)
- ❌ Sourced files recursively (not followed)

## 6. Smart Install Flow

### Modified: `imgProxyInstall()` in `src/cli/commands/img-proxy.ts`

```typescript
export async function imgProxyInstall(opts: {
  providers?: string;       // existing — explicit, dumb mode
  all?: boolean;             // existing — dumb mode (all detected, no classification)
  yes?: boolean;             // NEW — skip interactive, use defaults
  mode?: 'smart' | 'dumb';   // NEW — explicit mode (default: smart when no flags)
}): Promise<void> {
  const port = config.get<number>('img_proxy.port', 8765);
  const hostname = config.get<string>('img_proxy.hostname', '127.0.0.1');
  const smartMode = config.get<boolean>('img_proxy.smart_mode', true);
  const isExplicit = !!opts.providers || !!opts.all;
  const mode = opts.mode ?? (isExplicit ? 'dumb' : 'smart');

  // 1. Discover all candidates from 4 sources
  const candidates = await discoverCandidates({ port, hostname });
  // candidates: Array<{...ProviderFileInfo, source: 'manual'|'auto'|'alias'|'cc-switch', kind: ModelKind}>

  if (candidates.length === 0) {
    /* existing "no providers" error message with CC Switch hint */
    throw new CCLinkerError('E_IMG_PROXY_NO_PROVIDERS', '未找到任何可用的 provider 配置');
  }

  // 2. Filter based on mode + classification
  const filtered = mode === 'smart' && smartMode
    ? candidates.filter(c => c.kind !== 'multimodal')
    : candidates;

  // 3. Build display choices for inquirer
  const choices = filtered.map(c => ({
    name: buildChoiceLabel(c),   // see format below
    value: c.alias,             // or composite key
    short: c.alias,
    checked: c.kind !== 'multimodal',  // pre-check text-only
  }));

  // 4. Resolve explicit --providers (dumb mode) or interactive
  let targets: typeof filtered;
  if (opts.providers) {
    const wanted = new Set(opts.providers.split(',').map(s => s.trim()).filter(Boolean));
    targets = filtered.filter(c => wanted.has(c.alias));
    if (targets.length === 0) throw new CCLinkerError('E_IMG_PROXY_UNKNOWN_ALIAS', ...);
  } else if (opts.all || opts.yes) {
    targets = filtered;  // all (--all = dumb, --yes = smart pre-selected)
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

  // 5. Install each (existing installProvider logic)
  for (const t of targets) {
    installProvider({
      providerPath: t.path,
      alias: t.alias,
      routesPath: IMG_PROXY_ROUTES_PATH,
      port, hostname,
    });
  }

  // 6. Smart mode: offer wrapper if CC Switch detected
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

  // 7. Print summary
  printInstallSummary(targets, mode);
}
```

### Inquirer choice label format

```typescript
function buildChoiceLabel(c: Candidate): string {
  const sourceTag = `[${c.source}]`.padEnd(11);  // [manual], [auto], [alias], [cc-switch]
  const kindTag = c.kind === 'multimodal' ? '⏭ multimodal-skip' : '✅ ' + c.kind;
  return `${sourceTag} ${c.alias.padEnd(20)} ${kindTag.padEnd(20)} ${c.model || '(no model)'}`;
}
```

Example output:
```
? 选择要启用图片代理的 provider:
  ❯ ◯ [manual]     glm-5.2               ✅ text-only        glm-5.2[1m]
    ◯ [alias]      byte-agent-glm        ✅ text-only        glm-5.2[1m]
    ◯ [auto]       kimi-for-coding       ⏭ multimodal-skip  kimi-for-coding[256k]
    ◯ [auto]       qwen3.7-plus          ⏭ multimodal-skip  qwen3.7-plus[1m]
    ◯ [auto]       minimax-m2.7          ✅ text-only        MiniMax-M3[1m]
```

### Discovery function

```typescript
interface Candidate extends ProviderFileInfo {
  source: 'manual' | 'auto' | 'alias' | 'cc-switch';
  kind: ModelKind;
}

async function discoverCandidates(opts: { port: number; hostname: string }): Promise<Candidate[]> {
  const fromFiles = scanProviderFiles();  // manual + auto-synced cc-switch
  const fromAliases = discoverShellAliases();

  // Build alias → file map for cross-referencing
  const fileByAlias = new Map<string, ProviderFileInfo>();
  for (const f of fromFiles) {
    // Dedup: manual wins over auto (existing scanProviderFiles does this)
    if (!fileByAlias.has(f.alias)) fileByAlias.set(f.alias, f);
  }

  // Build alias → alias-discovery map
  const aliasByShell = new Map<string, DiscoveredAlias>();
  for (const a of fromAliases) {
    if (a.providerAlias) aliasByShell.set(a.providerAlias, a);
  }

  // Merge: file-based is source of truth, alias is hint
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
  // Also include aliases that point to non-existent files (rare)
  for (const [alias, shell] of aliasByShell) {
    if (seen.has(alias)) continue;
    candidates.push({
      alias,
      path: shell.providerPath ?? '',
      baseUrl: '',
      model: '',
      source: 'alias',
      kind: 'unknown',  // can't classify without reading the file
    });
  }

  // Sort: by source priority, then by alias
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

### Mode behavior matrix

| Invocation | Mode | Behavior |
|-----------|------|----------|
| `install` | smart | 4-source + classify, pre-select text-only + unknown, interactive (or `--yes`) |
| `install --providers X` | dumb | Just X, no classification |
| `install --all` | dumb | All detected, no classification |
| `install --yes` | smart | Smart pre-selection, no interactive |
| `install --mode=dumb` | dumb | Same as `--all` but with explicit mode flag |
| `install --mode=smart` | smart | Smart (default anyway) |

### Summary output

```
✅ 已装 4 个 (smart 模式):
   glm-5.2[1m]            ✅ text-only
   byte-agent-glm          ✅ text-only (from ~/.zshrc cc-byte-agent)
   minimax-m2.7            ✅ text-only
   qwen3.7-max             ✅ text-only

⏭ 跳过 2 个多模态 (不会破坏图片能力):
   kimi-for-coding         ⏭ multimodal
   qwen3.7-plus            ⏭ multimodal

✅ wrapper 已装到 ~/.zshrc
   运行 source ~/.zshrc 或重开 shell 激活 cc-linker-proxy
```

## 7. Wrapper Install (covered in old spec, refresh)

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
  
  // Backup
  mkdirSync(dirname(IMG_PROXY_WRAPPER_BACKUP_DIR), { recursive: true });
  const backup = join(IMG_PROXY_WRAPPER_BACKUP_DIR, `wrapper-backup-${Date.now()}`);
  if (content) copyFileSync(rcFile, backup);
  
  // Append
  const block = generateWrapperBlock(shell);
  const newContent = content + (content.endsWith('\n') ? '' : '\n') + block + '\n';
  writeFileSync(rcFile, newContent, { mode: 0o644 });
  
  console.log(chalk.green(`✅ wrapper 已装到 ${rcFile}`));
  console.log(chalk.cyan('   运行 source ~/.zshrc 或重开 shell 激活 cc-linker-proxy'));
}
```

### Wrapper function (`src/img-proxy/wrapper.ts`)

Already in the existing wrapper spec, but core parts:

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

### New subcommands: `cc-linker img-proxy wrapper-install|wrapper-uninstall|wrapper-status`

(Plus `current-url` and `resolve` for wrapper function to call.)

| Subcommand | Purpose | Output |
|------------|---------|--------|
| `wrapper-install` | Add `cc-linker-proxy()` to shell rc | Success msg |
| `wrapper-uninstall` | Remove the function from shell rc | Success msg |
| `wrapper-status` | Check if installed | Yes/no + rc file path |
| `resolve <upstream>` | Look up proxy URL by real upstream | `http://...:port/alias` or empty |
| `current-url` | Read `~/.claude/settings.json` `env.ANTHROPIC_BASE_URL` | URL or empty |

All exit 0 on success (empty stdout = "not found"), exit 1 on hard error (file read failure, JSON parse error). stderr for all error/warning messages.

## 8. Status Display

`imgProxyStatus` adds wrapper state section:

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

## 10. Implementation Order

1. **Rename `resolveUpstream` → `getUpstreamByAlias`** + add `resolveProxyByUpstream` in `src/img-proxy/routes.ts` (15 min)
2. **`src/img-proxy/classify.ts`** — `classifyModel()` with full pattern list (1 h)
3. **Unit tests for classify** — 23+ cases covering all patterns + suffix stripping (1 h)
4. **`src/img-proxy/aliases.ts`** — `discoverShellAliases()` with rc file parsing (1 h)
5. **Unit tests for aliases** — 8+ cases for various shell syntaxes (30 min)
6. **`src/img-proxy/wrapper.ts`** — `generateWrapperBlock()` + `isWrapperInstalled()` (30 min)
7. **New subcommands in `src/cli/commands/img-proxy.ts`**:
   - `imgProxyCurrentUrl` (15 min)
   - `imgProxyResolve` (15 min)
   - `imgProxyWrapperInstall` / `imgProxyWrapperUninstall` / `imgProxyWrapperStatus` (1 h)
   - Register in `src/index.ts` (15 min)
8. **Modify `imgProxyInstall`** — add smart flow, 4-source discovery, model classification, wrapper offer (1.5 h)
9. **Modify `imgProxyStatus`** — add wrapper state + classification (30 min)
10. **`src/utils/config.ts`** — add 3 new fields + defaults (15 min)
11. **`docs/img-proxy.md`** — new "CC Switch 用户怎么用" section (30 min)
12. **Manual smoke** — real shell wrapper invocation (30 min)
13. **Deploy + push** (15 min)

**Total: ~9 hours**

## 11. Test Plan

### Unit tests

| Module | Tests | Coverage |
|--------|-------|----------|
| `classify.ts` | 23+ | All built-in patterns + suffix stripping + extra patterns config |
| `aliases.ts` | 8+ | Various shell syntaxes, comments, edge cases, missing files |
| `wrapper.ts` | 5+ | Idempotency, marker detection, function generation |
| `routes.ts` | 3 | Renamed `getUpstreamByAlias`, new `resolveProxyByUpstream`, migration |

### Integration tests

| Test | Expected |
|------|----------|
| Real `cc-linker-proxy` invocation in subshell | Sets env var, calls claude (mock) |
| Multiple rc files exist | Wrapper appended to detected one only |
| Concurrent `install` calls | Lock or queue to prevent race |

### Manual smoke (post-merge)

```bash
# Setup
cc-linker img-proxy install    # smart mode
# verify: shows table, pre-selected text-only, asks wrapper
source ~/.zshrc
cc-linker-proxy "echo test"    # should set env var
```

## 12. Open Questions

1. **`--yes` flag default pre-selection** — if all text-only + unknown, that's typically most providers. If user wants strict (only text-only, no unknown), add `--strict` flag in v2.
2. **Wrapper auto-install on `--all` / `--providers`** — current plan: no, only on smart `install`. User can manually run `wrapper-install`. Trade-off: explicit vs auto. Decision: explicit (let user opt-in for non-smart mode).
3. **CC Switch DB read performance** — `syncCcSwitchToAutoProviders` is sync. For DBs with 50+ providers, might be slow. Acceptable for an install operation (rare).
4. **What if `~/.claude/settings.json` doesn't exist on user's first run?** Wrapper would error "no current provider". User can ignore if they don't use `claude` directly.
5. **shell alias parsing edge cases** — what if user has `function cc-X { ... }` instead of `alias cc-X='...'`? v1: skip silently. v2: parse functions.
6. **What about other shell files like `~/.config/fish/config.fish`?** v1: zsh/bash only, fish out of scope.
7. **`install` output verbosity** — current `install` prints "✅ 已装 N, 跳过 M" + details. For 16+ providers, output could be long. Acceptable for a one-time operation.

## 13. References

- `docs/superpowers/plans/2026-07-04-cli-image-proxy.md` — Phase 1 implementation plan
- `docs/superpowers/plans/2026-07-04-img-proxy-wrapper.md` — Wrapper internals (function generation, marker constants, edge cases)
- `docs/img-proxy.md` — User-facing usage doc
- Existing `src/img-proxy/provider-scan.ts` — 4-source scanner (P0-1 cc-switch support)
- Existing `src/img-proxy/provider-config.ts` — `installProvider` with 3-state machine
- Existing `src/cli/commands/img-proxy.ts` — Current CLI structure
