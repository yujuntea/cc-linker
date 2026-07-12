# cc-linker-proxy: cc-switch 驱动的 --settings 方案 - Design

**Date**: 2026-07-10
**Status**: Proposed
**Supersedes**: `2026-07-10-wrapper-bypass-fix-design.md` 的 wrapper 逻辑（isProxyUrl / idempotent resolve 保留，wrapper 4-branch 删除）

## Problem

`cc-linker-proxy` shell wrapper 设 shell env `ANTHROPIC_BASE_URL=proxy` 后 exec claude，但 claude 的 env 优先级是 **`--settings 文件` > `~/.claude/settings.json` env > shell env**。CC Switch 用户切换 provider 时把上游 URL 写进 `~/.claude/settings.json` 的 `env.ANTHROPIC_BASE_URL`，覆盖 wrapper 设的 shell env，导致 claude 直连上游、绕过 img-proxy、image block 触发 `400 Model only support text input`。

**实测确认**（2026-07-10）：
- `claude --settings <proxy文件>` -> proxy 收到请求、stripped 成功 ✅
- 设 shell env `ANTHROPIC_BASE_URL=proxy` + settings.json env=上游 -> proxy 零请求、claude 直连上游 ❌
- 把 settings.json env 改成 proxy URL -> proxy 收到请求 ✅

**结论**：wrapper 设 shell env 的机制对 CC Switch 用户无效（死代码）。必须改用 `--settings` 显式指定已替换成 proxy URL 的 provider 文件。

## Root Cause 机制

CC Switch 切换 provider 时：
1. 把该 provider 的 `settings_config`（含 `env.ANTHROPIC_BASE_URL=<上游>`）写进 `~/.claude/settings.json`
2. 在 `~/.cc-switch/settings.json` 记录 `currentProviderClaude=<provider id>`

`cc-linker img-proxy install` 时：
1. `syncCcSwitchToAutoProviders` 把 cc-switch 的 provider 同步到 `~/.cc-linker/auto-providers/<name>.json`（**上游 URL**，因为还没 install）
2. `installProvider` 把 `auto-providers/<name>.json` 的 `env.ANTHROPIC_BASE_URL` 改成 `http://127.0.0.1:<port>/<alias>`（**proxy URL**）+ 备份 `.bak`
3. `syncCcSwitchToAutoProviders` 有 `if (existsSync(filePath)) continue`，**不会**覆盖已 install 替换的 proxy URL

所以 `auto-providers/<name>.json` 在 install 后是 proxy URL，且 cc-switch 切换不会破坏它。`cc-linker-proxy` 只要实时读 cc-switch 当前 provider、找对应 auto-providers 文件、用 `--settings` 指定即可。

### 副问题：cc-switch 改 provider 配置后 auto-providers 不刷新

`syncCcSwitchToAutoProviders` 的 `if (existsSync(filePath)) continue` 保护了 proxy URL 不被覆盖，但副作用是：用户在 cc-switch 改了 token / model / 新增 env 字段后，auto-providers 文件不刷新 -> cc-linker-proxy 用旧配置 -> 上游 401 或行为异常。

`install` 对已装 provider 是"跳过"（`isProviderInstalled` 命中就 continue），也不能刷新。需要新增 `update` 命令处理"已装后 cc-switch 配置变了"。

## Goals

1. `cc-linker-proxy` 对 CC Switch 用户可靠走 img-proxy（image 被 strip）
2. CC Switch 切换 provider 后，`cc-linker-proxy` 自动跟随（实时读，不缓存）
3. 失败时明确报错 + 提示，绝不静默直连上游
4. 删除旧 wrapper 的死代码（4-branch env 检测 / resolve / fall-back-to-settings）
5. 不破坏用户现有 claude 配置（hooks / permissions / statusLine 等仍从 `~/.claude/settings.json` 读）
6. 提供 `update` 命令：cc-switch 改 provider 配置（token/model/新增字段）后，刷新 auto-providers 文件 + routes upstream，无需 uninstall+install

## `--settings` 语义（实测确认）

`claude --settings <file>` 是 **"load additional settings from"**（`claude --help` 原文），即**合并**而非 replace：
- `--settings` 文件的 `env` 块**覆盖** `~/.claude/settings.json` 的 env（这是本方案能 work 的关键 - 验证 4 实测：proxy 收到请求）
- `~/.claude/settings.json` 的 `hooks` / `permissions` / `statusLine` / `enabledPlugins` 等**继续生效**（`--settings` 文件没这些字段就不动）
- `--settings` 文件的未知字段（如 sync 写入的 `name` / `alias`）被 claude 忽略（验证 4 实测：claude 正常响应，未报错）

所以 `cc-linker-proxy` 用 `--settings` 指向 auto-providers 文件，用户不会丢 hooks/permissions，只 env.BASE_URL 被替换成 proxy URL。

## Non-Goals

- 不改 `cc-linker img-proxy install` 流程（auto-providers 替换机制已 work）
- 不改 `~/.claude/settings.json`（CC Switch 管它，cc-linker 不碰）
- 不回滚 `isProxyUrl` / `resolveProxyByUpstream` idempotent（其他 CLI 调用方仍用）
- 不处理 alias 冲突（`Name` vs `Name-2`，罕见，归入"文件不存在"报错分支）
- 不支持无 CC Switch 的用户（他们用 `claude --settings <provider文件>` 直走 proxy）

## Architecture

### 数据流

```
cc-linker-proxy [args]
  │
  ▼ shell function (generateWrapperBlock)
  │ exec: command cc-linker img-proxy cc-switch-settings
  │
  ▼ CLI 子命令 (组件 B)
  │ 调 getCurrentCcSwitchProvider() (组件 A)
  │
  ▼ 组件 A: 读 cc-switch 当前 provider
  │ 1. ~/.cc-switch/settings.json -> currentProviderClaude (id)
  │ 2. fallback: cc-switch.db WHERE is_current=1
  │ 3. id 查 db -> name
  │ 4. ~/.cc-linker/auto-providers/<name>.json existsSync?
  │ 5. 校验 BASE_URL 是 proxy URL (http://127.0.0.1:port/...)
  │
  ▼ 组件 B 输出
  │ 成功: stdout=<path>, exit 0
  │ 失败: stdout=空, stderr=<分类提示>, exit 2
  │
  ▼ shell function
  │ stdout 非空 + 文件存在 -> command claude --settings <path> "$@"
  │ stdout 空 -> 透传 stderr 提示, return 1
```

### 组件分解

#### 组件 A: `getCurrentCcSwitchProvider()` - 纯查询

`src/img-proxy/cc-switch-current.ts`（新建）

```typescript
export interface CcSwitchProvider {
  name: string;         // "Byte-glm-agent"
  settingsFile: string; // ~/.cc-linker/auto-providers/Byte-glm-agent.json
  baseUrl: string;      // 该文件 env.ANTHROPIC_BASE_URL
}

/**
 * 读 cc-switch 当前生效 claude provider。
 * 返回 CcSwitchLookupResult（见 Error Handling 节）:
 *  - { status: 'ok', provider } 成功
 *  - { status: 'no-ccswitch' } 无 ~/.cc-switch/
 *  - { status: 'no-current' } 无当前 provider / db 读失败
 *  - { status: 'no-file', name } auto-providers 文件不存在
 * 不抛错（让调用方决定怎么报错）。
 *
 * 查询顺序:
 *  1. ~/.cc-switch/settings.json 的 currentProviderClaude (provider id) - cc-switch 切换时写这里
 *  2. fallback: cc-switch.db WHERE app_type='claude' AND is_current=1
 *  3. 用 id 查 cc-switch.db 拿 name
 *  4. 拼 ~/.cc-linker/auto-providers/<name>.json, existsSync 校验
 *
 * 测试注入: ccSwitchDir / autoProvidersDir 可选参数, 默认真实路径。
 */
export function getCurrentCcSwitchProvider(
  ccSwitchDir?: string,
  autoProvidersDir?: string,
): CcSwitchLookupResult { ... }
```

**职责**：cc-switch DB 查询 + auto-providers 文件定位。不做 install 校验、不 exec claude、不抛错。

**依赖**：`bun:sqlite`（Database, readonly）、`~/.cc-switch/` 路径、`AUTO_PROVIDERS_DIR`。

#### 组件 B: `cc-switch-settings` CLI 子命令

`src/cli/commands/img-proxy.ts`（加 handler）+ `src/index.ts`（注册）

```typescript
export async function imgProxyCcSwitchSettings(): Promise<void> {
  const result = getCurrentCcSwitchProvider();
  switch (result.status) {
    case 'ok': {
      // 校验 BASE_URL 是 proxy URL (已 install)
      if (!isProxyUrl(result.provider.baseUrl)) {
        console.error(`cc-linker-proxy: 当前 provider "${result.provider.name}" 未装代理`);
        console.error(`  hint: cc-linker img-proxy install --providers ${result.provider.name}`);
        process.exit(2);
      }
      console.log(result.provider.settingsFile);  // stdout = path, exit 0
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

**职责**：调组件 A + install 校验（BASE_URL 是否 proxy）+ 输出。给 wrapper shell 调用。

**stdout 语义**：成功输出 path（单行），失败 stdout 空 + stderr 提示 + exit 2。

**错误分类**：组件 A 返回 `CcSwitchLookupResult`（见 Error Handling 节），组件 B switch status 选文案。

#### 组件 C: `generateWrapperBlock()` 重写

`src/img-proxy/wrapper.ts`

```sh
cc-linker-proxy() {
  local settings_file
  settings_file="$(command cc-linker img-proxy cc-switch-settings 2>/dev/null)"
  if [ -n "$settings_file" ] && [ -f "$settings_file" ]; then
    command claude --settings "$settings_file" "$@"
    return $?
  fi
  # stdout 空 -> 失败。重跑不吞 stderr, 让分类提示显示给用户
  command cc-linker img-proxy cc-switch-settings >/dev/null
  return 1
}
```

**职责**：调组件 B，根据 stdout 判断 exec claude 或报错。不读 env、不调 resolve、无 fallback。

**重跑拿 stderr 的代价**：失败路径子命令跑两次（~50ms × 2）。失败非热路径，可接受。

**template literal escaping**：所有 `$` 写 `\$`，`${WRAPPER_START_MARKER}` / `${WRAPPER_END_MARKER}` 例外（JS 插值）。

## Error Handling

### 组件 A 返回值细化

```typescript
export type CcSwitchLookupResult =
  | { status: 'ok'; provider: CcSwitchProvider }
  | { status: 'no-ccswitch' }      // ~/.cc-switch/ 不存在
  | { status: 'no-current' }       // 无 currentProviderClaude + 无 is_current=1
  | { status: 'no-file'; name: string }; // auto-providers/<name>.json 不存在

export function getCurrentCcSwitchProvider(...): CcSwitchLookupResult { ... }
```

### 组件 B 按 status 分支提示

| status | stderr | exit |
|---|---|---|
| ok + BASE_URL 是 proxy | (无, stdout=path) | 0 |
| ok + BASE_URL 是上游(没 install) | `当前 provider "<name>" 未装代理` + `hint: cc-linker img-proxy install --providers <name>` | 2 |
| no-ccswitch | `未检测到 CC Switch` + `hint: 装 CC Switch 或用 claude --settings <provider文件>` | 2 |
| no-current | `CC Switch 未选中 claude provider` + `hint: 在 CC Switch 里选一个 provider` | 2 |
| no-file | `当前 provider "<name>" 未同步` + `hint: cc-linker img-proxy install` | 2 |
| db 读失败 | `读 CC Switch 数据库失败` + `hint: 确认 CC Switch 在运行` | 2 |

### process.exit 契约

组件 B 是 CLI handler，按项目 `img-proxy-library-cli-process-exit` memory 规范：**library 函数 throw，CLI binding 负责 exit**。组件 B handler 应 throw `CCLinkerError`，`src/index.ts` 的 try/catch 统一 process.exit。不在 handler 里直接 process.exit（避免 wizard / programmatic caller 被杀）。

但这里有个特殊点：`cc-switch-settings` 的 exit code 2 是给 wrapper 判断的契约。CLI binding 的 try/catch 默认 exit 1。**方案**：handler throw 带 `code: 'E_IMG_PROXY_NO_CC_SWITCH_PROVIDER'` 的 CCLinkerError，CLI binding 识别该 code -> exit 2，其他 -> exit 1。或更简单：handler 直接 `process.exit(2)`（CLI 子命令本身就是 terminal，不像 wizard 会被嵌套调用）。

**Decision**：handler 直接 `process.exit(2)`。`cc-switch-settings` 是纯 CLI 子命令（无 library caller 场景），跟 `imgProxyCurrentUrl` / `imgProxyResolve`（已 library 化）不同。YAGNI - 不为想象中的 programmatic caller 过度设计。但需在注释里说明这个例外。

## `update` 命令：刷新 cc-switch 最新配置

### 定位

`install` 对已装 provider 是"跳过"，无法刷新 cc-switch 改过的配置（token/model/新增 env 字段）。`update` 填补这个缺口：**选择式 + 已装刷新/未装新装**，交互模式与 install 对齐，用户不用记"这个装过没"。

### 流程

```
cc-linker img-proxy update [--providers <name>] [--all] [--yes] [--mode smart|dumb]
  ↓
1. syncCcSwitchToAutoProviders() (拿最新 cc-switch provider 列表)
2. discoverCandidates() (跟 install 一样, manual + auto)
3. smart 模式过滤多模态 (跟 install 一样)
4. 列出 choices, 纯文本默认选中 (跟 install 一样), 用户可改
5. 对选中的逐个处理:
   - 已装 (isProviderInstalled=true) -> updateProvider: 刷新 env + routes upstream
   - 未装 -> installProvider: 完整装 (改 BASE_URL + 备份 + 加路由)
```

### 与 install 的区别

| 维度 | install | update |
|---|---|---|
| 已装 provider | 跳过（`⊘ 已 install,跳过`） | **刷新** env + routes upstream（`↻ 已刷新`） |
| 未装 provider | 装 | 装（同 install） |
| 选择流程 | smart 过滤 + 默认选中纯文本 | 同 install |
| 候选范围 | manual + auto | manual + auto（同 install） |

唯一区别：循环里对已装的处理。install `continue`，update 调 `updateProvider`。

### manual provider 的处理

`discoverCandidates` 返回 manual + auto 两类。manual provider（`~/.claude/providers/*.json`）不是 cc-switch 管的，`getCcSwitchProviderConfigByName` 查不到（返回 null）。处理：

- **manual provider + 已装**：`getCcSwitchProviderConfigByName` 返回 null。manual provider 的配置用户直接改文件，没有"从 cc-switch 刷新"的语义。**跳过 + 提示**：`⊘ <name>  manual provider, 直接改文件即可（update 只刷新 cc-switch 管的 provider）`。
- **manual provider + 未装**：走 `installProvider`（同 install，manual provider 首次装不依赖 cc-switch）。

即：update 的"刷新"只对 auto（cc-switch）provider 生效；manual provider 在 update 里：未装则装，已装则跳过（提示直接改文件）。

### `updateProvider` 函数

`src/img-proxy/provider-config.ts` 新增：

```typescript
export interface UpdateOpts {
  providerPath: string;   // auto-providers/<name>.json
  alias: string;
  routesPath: string;
  port: number;
  hostname: string;
  latestCfg: { env?: Record<string, string>; [k: string]: unknown };  // cc-switch.db 拉的最新 settings_config
}

/** 刷新已装 provider 的配置 (cc-switch 改了 token/model/新增字段后)。
 *  - env 整体替换为 cc-switch 最新值, 但 BASE_URL 保持 proxy URL (不回退上游)
 *  - routes.json 的 upstream 更新为 cc-switch 最新 BASE_URL (真实上游)
 *  - 不动 .bak (保留首次 install 的原始备份) */
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
    await addRoute(routesPath, alias, newUpstream, providerPath);  // addRoute 覆盖同 alias
  }
}
```

**env 整体替换语义**：用 cc-switch.db 最新 env 整体替换 auto-providers 文件的 env（BASE_URL 除外）。新增字段自动包含，删除的字段自动移除。不用逐字段 diff，最干净。

**routes upstream 更新**：cc-switch 改了上游 URL（如 ark 换 endpoint）时，routes.json 的 `upstream` 也要更新，proxy 才能转发到新上游。`addRoute` 覆盖同 alias，保留 `installed_at`。

### cc-switch 配置查询

update 需要按 name 从 cc-switch.db 拉最新 settings_config。新增辅助函数 `src/img-proxy/cc-switch-current.ts`:

```typescript
/** 按 name 查 cc-switch.db 的 settings_config (update 用)。
 *  返回 null 表示 cc-switch 无此 provider。 */
export function getCcSwitchProviderConfigByName(
  name: string,
  ccSwitchDir?: string,
): { settingsConfig: object } | null { ... }
```

update 循环里对每个 target 调它拿 `latestCfg`，传给 `updateProvider`。若返回 null（cc-switch 已删该 provider），提示用户 `uninstall`。

### 边界

- **update 一个 auto provider + cc-switch 已删**：`getCcSwitchProviderConfigByName` 返回 null -> 提示 "已从 cc-switch 删除，建议 `cc-linker img-proxy uninstall --providers <name>`"。（仅对已装的 auto provider 触发；未装的 cc-switch 没有 = 不在候选里，不会进此分支。）
- **update 一个 manual provider + 已装**：`getCcSwitchProviderConfigByName` 返回 null（manual 不在 cc-switch）-> 跳过 + 提示 "manual provider, 直接改文件"（见 manual provider 处理节）。
- **update 时 auto-providers 文件不存在**（被手动删）：`isProviderInstalled` 返 false -> 归入"未装"分支，走 `installProvider`（update 对未装就是 install）。
- **update --all**：遍历所有候选，已装的 auto provider 刷新、已装的 manual provider 跳过、未装的新装。cc-switch 已删的 auto provider 提示 uninstall。

## Testing

### 层 1: 组件 A 单测 `tests/unit/img-proxy/cc-switch-current.test.ts`

tmpDir 构造假 `~/.cc-switch/`（settings.json + cc-switch.db）+ `auto-providers/`。

覆盖：
- currentProviderClaude id -> 查 db -> name -> auto-providers 文件 -> status ok
- 无 ~/.cc-switch/ -> status no-ccswitch
- currentProviderClaude 空 -> fallback is_current=1 查询 -> status ok
- currentProviderClaude 空 + 无 is_current=1 -> status no-current
- id 在 db 找不到 -> status no-current
- auto-providers 文件不存在 -> status no-file (含 name)
- db 锁定/损坏（readonly 打开抛错）-> status no-current 或 no-ccswitch（保守归并，不抛）
- name 带空格 "Kimi For Coding" -> 正确拼路径

**db 失败统一归类**：db 打开/查询失败（锁定/损坏）统一归 `no-current`（"未选中"语义最接近"读不到当前 provider"），提示"确认 CC Switch 在运行"。不在组件 A 区分 db 失败 vs 无当前 provider，因为对用户的修法一样（开 CC Switch / 重选）。

**db 构造**：测试用 `bun:sqlite` 创建临时 db，插入 provider 行。或用 fixture db 文件。

### 层 2: 组件 B 单测 `tests/unit/cli/img-proxy-cc-switch-settings.test.ts`

直接调 handler（不 spawn），验证 stdout/stderr/exit。

覆盖：
- status ok + proxy URL -> stdout=path, exit 0
- status ok + 上游 URL -> stderr 含 "未装代理", exit 2
- status no-ccswitch -> stderr 含 "未检测到 CC Switch", exit 2
- status no-current -> stderr 含 "未选中", exit 2
- status no-file -> stderr 含 "未同步", exit 2

### 层 2b: `updateProvider` + `getCcSwitchProviderConfigByName` 单测

`tests/unit/img-proxy/provider-config.test.ts` 加 updateProvider 测试 + `tests/unit/img-proxy/cc-switch-current.test.ts` 加 getCcSwitchProviderConfigByName 测试。

updateProvider 覆盖：
- 已装 provider + cc-switch 改了 token -> auto-providers 文件 token 刷新, BASE_URL 保持 proxy
- cc-switch 改了上游 URL -> routes.json upstream 更新, auto-providers BASE_URL 仍 proxy
- cc-switch 新增 env 字段 -> auto-providers 文件包含新字段
- cc-switch 删除 env 字段 -> auto-providers 文件移除该字段
- .bak 不动（保留首次 install 备份）

getCcSwitchProviderConfigByName 覆盖：
- name 存在 -> 返回 settingsConfig
- name 不存在（cc-switch 已删）-> 返回 null
- name 带空格 "Kimi For Coding" -> 正确查询

### 层 2c: `update` CLI handler 单测 `tests/unit/cli/img-proxy-update.test.ts`

覆盖：
- 已装 auto provider + cc-switch 有最新配置 -> 调 updateProvider, 输出 "↻ 已刷新"
- 未装 provider -> 调 installProvider, 输出 "✅ 新装"
- 已装 auto provider + cc-switch 已删 -> 提示 uninstall（getCcSwitchProviderConfigByName 返 null）
- 已装 manual provider -> 跳过 + 提示 "manual provider, 直接改文件"
- smart 模式过滤多模态（跟 install 一致）
- --all / --providers / 交互选择 三种 targets 路径

### 层 3: wrapper bash 集成测试 `tests/integration/wrapper-bash.test.ts`（重写）

stub `cc-linker`（`img-proxy cc-switch-settings` 子命令）+ stub `claude`（捕获 `--settings`）。

测试矩阵（~4 个）：
- cc-switch-settings stdout=path -> claude 收到 `--settings <path>` + 原始 args
- cc-switch-settings stdout=空 + stderr=提示 -> claude 不被调用, stderr 透传, exit 1
- claude args 透传（`--version` / `-p "..."` / `--resume <id>`）
- 回归确认：wrapper 不再读 `ANTHROPIC_BASE_URL`（删旧逻辑）

**旧测试删除**：E7 / bug-scenario / fall-back / resolve 调用 / idempotent（这些路径已不存在）。

### 层 4: 端到端（手动，不进 CI）

```bash
cc-linker img-proxy install --all
cc-linker img-proxy wrapper install
source ~/.zshrc
cc-linker-proxy -p "reply OK"  # 验证走 proxy
# 粘贴图片验证 stripped
```

## Files Touched

| File | Change |
|---|---|
| `src/img-proxy/cc-switch-current.ts` | 新建，`getCurrentCcSwitchProvider` + `CcSwitchLookupResult` + `getCcSwitchProviderConfigByName` |
| `src/img-proxy/provider-config.ts` | 加 `updateProvider` 函数 + `UpdateOpts` |
| `src/cli/commands/img-proxy.ts` | 加 `imgProxyCcSwitchSettings` handler + `imgProxyUpdate` handler |
| `src/index.ts` | 注册 `img-proxy cc-switch-settings` + `img-proxy update` 子命令 |
| `src/img-proxy/wrapper.ts` | `generateWrapperBlock` 重写（单一路径，删 4-branch） |
| `tests/unit/img-proxy/cc-switch-current.test.ts` | 新建，组件 A + getCcSwitchProviderConfigByName 单测 |
| `tests/unit/img-proxy/provider-config.test.ts` | 加 updateProvider 单测 |
| `tests/unit/cli/img-proxy-cc-switch-settings.test.ts` | 新建，组件 B 单测 |
| `tests/unit/cli/img-proxy-update.test.ts` | 新建，update handler 单测 |
| `tests/unit/img-proxy/wrapper.test.ts` | 更新 generateWrapperBlock 断言（删 resolve/current-url，加 cc-switch-settings） |
| `tests/integration/wrapper-bash.test.ts` | 重写测试矩阵 |
| `docs/img-proxy.md` | 更新 wrapper 工作原理（--settings 机制）+ 加 update 命令说明 |
| `CHANGELOG.md` | 加 0.8.1 entry |

**不动**：
- `src/img-proxy/routes.ts`（isProxyUrl / resolveProxyByUpstream idempotent 保留）
- `tests/unit/img-proxy/routes.test.ts`
- `src/img-proxy/provider-scan.ts` / `discover.ts`（sync + install 候选流程不变）

## Risks

1. **cc-switch.db 并发读**：CC Switch app 运行时可能 lock db。`readonly: true` 打开 + try/catch 兜底 -> 归入 no-current/no-ccswitch 报错，不崩。SQLite readonly 共享锁一般不冲突。

2. **cc-switch 升级改 schema**：`providers` 表加字段 / 改 `is_current` 语义。当前只读 `id` / `name` / `settings_config` / `is_current` / `app_type`，都是基础字段，schema 变动风险低。如未来 cc-switch 大改，组件 A 失败 -> 报错，用户感知。

3. **auto-providers 文件被手动删**：用户清 `~/.cc-linker/` -> no-file 报错 -> 提示 install。可恢复。

4. **cc-switch 切到没 install 的 provider**：no-file 或 BASE_URL 是上游 -> 报错 + 提示 install。用户需对每个想用的 provider 跑一次 install。这是已知 UX 限制（Non-Goals 里接受）。

5. **wrapper 重跑拿 stderr 的两次 spawn**：失败路径 ~100ms。可接受。替代方案（stdout 输出提示）污染语义，不选。

6. **process.exit(2) 违反 library 契约**：`cc-switch-settings` 是纯 CLI 子命令，无 library caller 场景。注释说明例外。如未来被 wizard 调用再 library 化。

7. **cc-switch 改已存在 provider 的配置（如 token）不自动刷新 auto-providers**：`syncCcSwitchToAutoProviders` 的 `if (existsSync(filePath)) continue` 保护 proxy URL 不被覆盖，但副作用是用户在 cc-switch 改 token 后，auto-providers 文件仍是旧 token -> cc-linker-proxy 用旧 token -> 上游 401。**本 spec 加 `update` 命令解决**：用户改完 cc-switch 后跑 `cc-linker img-proxy update` 刷新。不自动触发（YAGNI，用户改完主动跑更可控）。

8. **依赖 claude 容忍 `--settings` 文件未知字段**：auto-providers 文件含 `name`/`alias` 字段（sync 写入，非 claude 原生）。实测 claude 忽略未知字段（验证 4）。如未来 claude 收紧 settings schema 校验，需改 sync 不写这些字段。

## Open Questions

无。