# cc-linker 飞书一键配置 Skill 设计规格

> 版本: v1.1
> 日期: 2026-06-17
> 状态: v1.1 已修复 11 项 review 问题（架构分层、gstack spike、二维码、重构路径、域识别、多 bot 冲突、截图策略、CI 测试、估算、selector 维护、init-feishu 去留），待最终评审

---

## 1. 背景

### 1.1 当前痛点

cc-linker 当前通过 `init-feishu` / `setup` 命令引导用户配置飞书机器人。但用户在飞书开放平台（https://open.feishu.cn/app）必须手动完成 6 步操作：

1. 创建"企业自建应用"（填名称、描述、图标）
2. 开通 5 类权限（`im:message:readonly`、`im:message.p2p_msg:readonly`、`im:message`、`im:message:send_as_bot`、`im:resource`）
3. 在"事件订阅"中订阅 `im.message.receive_v1`（选择"长连接"模式）
4. 在"回调配置"中订阅 `card.action.trigger`（选择"长连接"模式）
5. 启用 Bot 能力
6. 创建并发布应用版本

每一步都在飞书开发者后台，跨 4-5 个菜单页面，新手平均耗时 20-40 分钟，且极易遗漏关键步骤（如 p2p 权限陷阱见 MEMORY `feishu-p2p-permission-trap`）。

### 1.2 飞书平台能力研究结论

通过研究飞书 OpenAPI 文档及 SDK 源码（详见附录 A），我们得到以下事实：

| 步骤 | 平台是否提供 API | 备注 |
|------|----------------|------|
| 创建企业自建应用 | ❌ 无 | 鸡生蛋问题；无 token 无法调 API |
| 开通权限 | ❌ 无 | 仅有 `GET scope-list` 读 API |
| 订阅事件 URL | ❌ 无 | Verification Token 由平台自动生成 |
| 启用 Bot 能力 | ✅ v7 | `PATCH /open-apis/application/v7/applications/{app_id}/ability` |
| 提交版本 | ✅ v7 | `POST /open-apis/application/v7/applications/{app_id}/publish` |
| 自动批准版本 | ✅ v6（受限）| `PATCH /open-apis/application/v6/applications/{app_id}/app_versions/{version_id}` 仅限旗舰/企业版租户或自建应用自审 |

**结论**：纯 API 自动化不可能。杠杆点在**浏览器自动化**。

### 1.3 用户场景假设

基于用户反馈，本次设计基于以下假设：

- **大多数用户 = 自己租户的管理员**（自己注册企业、自己管的租户）
- **自建应用版本发布 = 自审自批**（无其他审批环节）
- 若用户非 admin，自动降级到"打印精确手动指引"模式

---

## 2. 目标

### 2.1 主要目标

提供一个 Claude Code skill（`/setup-feishu`），帮助用户**一键完成飞书机器人的完整配置**，把"6 步菜单 + 20-40 分钟"压到"1 步扫码 + 3-5 分钟"。

### 2.2 体验目标

- **零新增依赖到 cc-linker 主包**：复用 gstack（Claude Code 原生）或 Playwright（按需下载）
- **智能后端选择**：自动检测 gstack 可用性，缺失时降级 Playwright
- **可恢复**：失败时保存 state 到 `~/.cc-linker/setup-state.json`，下次可续跑
- **优雅降级**：UI 改版、selector 失效、Verification Token 抓不到等异常路径都有兜底

### 2.3 非目标

- ❌ 转型 SaaS + ISV 上架（cc-linker 是 CLI 工具非 SaaS）
- ❌ 等飞书出"自助创建应用" API（无 roadmap 信号）
- ❌ 替代飞书工作台/IM 功能（仅做配置引导，不重新实现 IM 桥）
- ❌ 支持飞书海外版（larksuite.com）的差异化（接口相同，但本期不做专门适配）

---

## 3. 核心约束

### 3.1 双后端约束

- **gstack 优先**：gstack 是项目已确立的浏览器入口（CLAUDE.md 明确），零下载、Claude 原生
- **Playwright 兜底**：gstack 未装时使用，要求按需下载浏览器（~150MB）
- **统一抽象**：业务层不感知后端差异，通过 `BrowserBackend` 接口对接

### 3.2 平台流程约束

- **Verification Token 必须从 DOM 读取**：不能猜测，不能 OCR，不能让用户复制（除非降级）
- **App ID / App Secret 必须从创建成功页读取**：同样不能 OCR
- **owner_open_id 必须从用户实际发消息的事件中抓取**：不能从飞书通讯录查（权限要求不同）

### 3.3 安全约束

- App Secret 在内存中明文存在（必须），但**绝不写入日志或截图**
- Cookie 持久化文件 `~/.cc-linker/feishu-cookies.json` 设置 `0o600` 权限
- 截图保存到 `~/.cc-linker/setup-screenshots/`，仅本地保留

### 3.4 兼容约束

- 必须兼容 macOS / Linux，Windows 尽力而为（Playwright 跨平台，gstack 用户多为 macOS/Linux）
- cc-linker 主版本保持不变，本次仅新增 `cc-linker feishu` 子命令族

---

## 4. 架构

### 4.1 整体架构

**三层架构：SKILL.md（Claude 读）→ helper 脚本（Claude 调）→ cc-linker CLI（helper 调）**

```
┌─────────────────────────────────────────────────────────────┐
│  Claude Code 客户端                                          │
│                                                              │
│  ┌────────────────────────────────────────────────────┐     │
│  │ /setup-feishu Skill (SKILL.md)                      │     │
│  │  - 自然语言步骤描述                                   │     │
│  │  - 通过 Bash tool 调 helper 脚本                     │     │
│  │  - 不直接执行 TypeScript 代码                         │     │
│  └────────────────────┬───────────────────────────────┘     │
│                       │ Bash tool (Claude 自发调用)          │
└───────────────────────┼──────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────────┐
│  cc-linker-feishu-skill/helper/ (Bun 脚本)                   │
│                                                              │
│  ┌─────────────────────────────────────────────┐           │
│  │ 入口: helper/setup.ts (CLI)                  │           │
│  │  $ bun run helper setup --phase=login        │           │
│  │  $ bun run helper setup --phase=create-app   │           │
│  │  $ bun run helper setup --phase=...          │           │
│  │  $ bun run helper state --show               │           │
│  └────────────────┬────────────────────────────┘           │
│                   ↓                                           │
│  ┌─────────────────────────────────────────────┐           │
│  │ BrowserBackend 接口（仅 helper 内部使用）       │           │
│  │ GStackBackend | PlaywrightBackend            │           │
│  └────────────────┬────────────────────────────┘           │
│                   ↓                                           │
│  ┌─────────────────────────────────────────────┐           │
│  │ 业务编排（每个 phase 一个函数）                  │           │
│  │  login() / createApp() / grantScopes() / ...  │           │
│  └────────────────┬────────────────────────────┘           │
│                   ↓                                           │
│  ┌─────────────────────────────────────────────┐           │
│  │ 状态管理                                        │           │
│  │  ~/.cc-linker/setup-state.json (续跑)          │           │
│  │  ~/.cc-linker/feishu-cookies.json (免登录)     │           │
│  └─────────────────────────────────────────────┘           │
│                   ↓                                           │
│  通过 child_process.spawn 调 cc-linker CLI                   │
└───────────────────────┼──────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────────┐
│  cc-linker CLI (既有 + 新增)                                  │
│                                                              │
│  ┌──────────────────────────────────────────────┐            │
│  │ 重构后 src/feishu/ 公共模块                     │            │
│  │  - getTenantToken()   (从 init-feishu.ts 抽出) │            │
│  │  - saveConfig()       (从 init-feishu.ts 抽出) │            │
│  │  - captureOpenId()    (从 init-feishu.ts 抽出) │            │
│  │  - v7-ability.ts (新增)                        │            │
│  │    - getAppAbility / enableBotCapability / ... │            │
│  └──────────────────────────────────────────────┘            │
│  ┌──────────────────────────────────────────────┐            │
│  │ 新增 src/cli/commands/feishu/                  │            │
│  │  - enable-bot / publish-version / approve /    │            │
│  │    set-config / feishu-stop-daemon (新增)      │            │
│  └──────────────────────────────────────────────┘            │
│  ┌──────────────────────────────────────────────┐            │
│  │ 既有 src/runtime/state-coordinator.ts (复用)   │            │
│  │  - isDaemonRunning() 用于检测多 bot 冲突       │            │
│  └──────────────────────────────────────────────┘            │
└─────────────────────────────────────────────────────────────┘
```

### 4.2 仓库分布

| 仓库 | 范围 |
|------|------|
| `cc-linker`（既有） | 1. 重构 `init-feishu.ts` 内部函数到 `src/feishu/utils.ts`<br>2. 新增 v7 API 库（`src/feishu/v7-ability.ts`）<br>3. 新增 `cc-linker feishu <action>` 顶级子命令族<br>4. **保留** `cc-linker init-feishu`（手动模式，向后兼容无 skill 用户）<br>5. **保留** `cc-linker setup`（既有 setup wizard 流程，printPermissionGuide 升级为精确检测）|
| `cc-linker-feishu-skill`（新建） | 1. `SKILL.md`（Claude 读的步骤化指令）<br>2. `helper/` Bun 脚本（含 BrowserBackend 抽象 + 业务编排 + 状态管理）<br>3. Playwright 浏览器 driver |

**为什么保留 init-feishu**：
- 无 Claude Code 的 cc-linker 用户仍需手动模式
- init-feishu 现在升级为"半自动"：用 v7 API 做精确权限检测 + 调 v7 API 开 Bot + 发版本，但创建应用 + 开通权限 + 订阅事件仍手动
- skill 和 init-feishu 共享 `src/feishu/utils.ts` 和 `src/feishu/v7-ability.ts`，**单一来源真相**

---

## 5. 组件设计

### 5.1 cc-linker 侧 — `src/feishu/v7-ability.ts`

封装飞书 v7 application API，独立可测。**依赖**：import 既有 `getTenantToken`（从 `src/cli/commands/init-feishu.ts` 重构到 `src/feishu/utils.ts`，见 5.7）。

```typescript
// 类型
export interface AppAbility {
  bot: { enable: boolean; message_card_callback_url?: string };
  web_app?: { enable: boolean };
}

export interface PublishResult {
  versionId: string;
  status: 'pending' | 'auto-approved' | 'rejected';
}

// 错误码语义化
export class FeishuApiError extends Error {
  constructor(
    public code: number,
    public endpoint: string,
    message: string
  ) {
    super(`[${endpoint}] code=${code}: ${message}`);
  }
}

// 5 个公开函数
export async function getTenantToken(appId: string, appSecret: string): Promise<string>
export async function getAppAbility(appId: string, appSecret: string): Promise<AppAbility>
export async function enableBotCapability(appId: string, appSecret: string): Promise<void>
export async function publishNewVersion(appId: string, appSecret: string, log: string): Promise<PublishResult>
export async function approveAppVersion(appId: string, appSecret: string, versionId: string): Promise<void>

// 状态判断逻辑：
// - publishNewVersion 后,调 GET /v6/.../app_versions/{vid} 查询 status
// - status === 'approved' → auto-approved
// - status === 'pending' → pending (用户非 admin 或需要 admin 同意)
// - status === 'rejected' → rejected
// 该判断在调用方 (skill helper) 完成,v7-ability.ts 仅负责裸 API 调用
```

**错误码映射**：
- `210020` 审核中 → `FeishuApiError('PENDING_REVIEW', ...)`
- `210017` 无权限（用户非 admin）→ `FeishuApiError('NOT_ADMIN', ...)`
- `210021` 非开发者后台创建 → `FeishuApiError('INVALID_ORIGIN', ...)`
- 其他 → 透传原始 `code` + `msg`

### 5.2 cc-linker 侧 — `src/cli/commands/feishu/*.ts`

新增 4 个子命令，复用既有 `init-feishu.ts` 的 `saveConfig` / `getTenantToken` 逻辑。

```bash
cc-linker feishu enable-bot --app-id=... --app-secret=...
cc-linker feishu publish-version --app-id=... --app-secret=... --log="..."
cc-linker feishu approve-version --app-id=... --app-secret=... --version-id=...
cc-linker feishu set-config --key=app_id --value=cli_xxx
```

每个子命令退出码：
- `0` = 成功
- `2` = 非 admin（提示用户联系管理员）
- `3` = 审核中（建议等待后重试）
- `1` = 其他错误

### 5.3 Skill 侧 — helper 脚本的 BrowserBackend 接口

**关键澄清**：`BrowserBackend` 接口**只在 helper 脚本内部使用**，不对外暴露。SKILL.md 不直接调用它，Claude 通过 Bash 调 `bun run helper setup --phase=<phase>`，helper 内部根据 phase 选择具体操作。

```typescript
// helper/src/backends/types.ts (helper 脚本内部)
export interface BrowserBackend {
  readonly name: 'gstack' | 'playwright';
  
  // 生命周期
  launch(): Promise<void>;
  close(): Promise<void>;
  
  // 导航
  navigate(url: string): Promise<void>;
  waitForSelector(selector: string, timeoutMs?: number): Promise<boolean>;
  waitForNavigation(timeoutMs?: number): Promise<void>;
  
  // 交互
  click(selector: string): Promise<void>;
  type(selector: string, text: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  press(key: string): Promise<void>;
  
  // 数据获取
  getText(selector: string): Promise<string | null>;
  getInputValue(selector: string): Promise<string | null>;
  getAttribute(selector: string, attr: string): Promise<string | null>;
  
  // 视觉
  screenshot(name: string): Promise<string>;  // 返回保存路径
  
  // 错误恢复
  reload(): Promise<void>;
  goBack(): Promise<void>;
  
  // 特殊
  saveCookies(path: string): Promise<void>;
  loadCookies(path: string): Promise<void>;
}
```

### 5.4 Skill 侧 — 后端实现

**GStackBackend**（薄封装 — **spike-first**）：
- **实现前必须先 spike**（0.5 天）：
  - 跑 `gstack --version` 确认安装
  - 跑 `gstack browse --help` 确认实际命令格式
  - 跑一次 `gstack browse navigate https://example.com` 验证是否支持持久 session
  - 跑一次 `gstack browse click <sel>` 验证命令格式
- **三种可能结果及应对**：
  - 情况 A：gstack 是 CLI 模式且支持 session → 按本设计走薄封装
  - 情况 B：gstack 是 MCP server 模式（给 Claude 提供工具）→ 改用 mcp 协议调用
  - 情况 C：CLI 命令格式不符合预期或无 session → 放弃 GStackBackend，只用 Playwright
- **二维码处理**：gstack 默认 headed 模式，二维码在浏览器窗口显示，用户直接扫码

**PlaywrightBackend**（重实现 — **二维码处理修正**）：
- `playwright-core` + 系统 Chrome 优先；无则 `bunx playwright install chromium`
- cookie 持久化：`~/.cc-linker/feishu-cookies.json`
- **二维码处理（修正版）**：
  1. **首选**：用 headed 模式（默认），用户直接在浏览器窗口扫码 — **避免二维码解析问题**
  2. **降级**（用户要求 headless）：截图保存到 `~/.cc-linker/setup-screenshots/qr-{timestamp}.png`，告诉用户"用手机扫码这张图"
  3. **不采用**：`qrcode-terminal` 是从**字符串**渲染二维码，不能从浏览器**图片**还原 — 原 spec 这里写错了
  4. **可选增强**（如未来需要）：用 `jsqr` 包解码图片 → 提取 URL → 用 `qrcode-terminal` 渲染到终端。但此方案脆弱，建议默认走前两条路径

### 5.5 Skill 侧 — 业务编排（helper 脚本内部）

**关键澄清**：以下代码是 **helper 脚本（`helper/src/flows/setup.ts`）的内部实现**，不是 skill 逻辑。SKILL.md 只告诉 Claude "run `bun run helper setup --phase=<phase>`"，Claude 通过 Bash 调用，helper 内部执行此代码。

`helper/src/flows/setup.ts` 串联 7 个 phase：

```typescript
export async function runSetup(opts: { 
  backend: BrowserBackend; 
  state: SetupState; 
  resume?: boolean;
}): Promise<SetupResult> {
  // Phase 0: detect domain (feishu.cn vs larksuite.com)
  if (!opts.state.domain) {
    opts.state.domain = await detectFeishuDomain();
    saveState(opts.state);
  }
  
  // Phase 1: ensure no daemon running (避免 WebSocket 冲突)
  if (await isDaemonRunning()) {
    log('检测到 daemon 在跑,临时停止以避免 WebSocket 冲突');
    await execCcLinker(['stop']);
  }
  
  // Phase 2: login (可 resume)
  if (!opts.state.loggedIn) await login(opts.backend, opts.state.domain);
  opts.state.loggedIn = true; saveState(opts.state);
  
  // Phase 3: createApp (可 resume)
  if (!opts.state.appId) {
    const { appId, appSecret } = await createApp(opts.backend, 'cc-linker');
    opts.state.appId = appId; opts.state.appSecret = appSecret;
    saveState(opts.state);
  }
  
  // Phase 4: grantScopes
  if (!opts.state.scopesGranted) {
    await grantScopes(opts.backend, opts.state.appId, REQUIRED_SCOPES);
    opts.state.scopesGranted = true; saveState(opts.state);
  }
  
  // Phase 5: subscribeEvents
  if (!opts.state.eventsSubscribed) {
    const { verificationToken } = await subscribeEvents(opts.backend, opts.state.appId);
    opts.state.verificationToken = verificationToken;
    opts.state.eventsSubscribed = true; saveState(opts.state);
  }
  
  // Phase 6: enableBot + publish (调 cc-linker CLI)
  await enableBotAndPublish(opts.state.appId, opts.state.appSecret, opts.state.domain);
  
  // Phase 7: captureOwnerOpenId + saveConfig
  await captureOwnerAndSave(opts.state.appId, opts.state.appSecret, opts.state.domain);
  
  return { success: true, appId: opts.state.appId };
}
```

### 5.6 Skill 侧 — 状态管理

```typescript
// ~/.cc-linker/setup-state.json
{
  "version": 1,
  "startedAt": "2026-06-17T10:00:00Z",
  "lastUpdatedAt": "2026-06-17T10:05:00Z",
  "backend": "playwright",
  "domain": "feishu.cn",          // 新增: 国内/海外域自动识别结果
  "daemonStoppedAtStart": true,    // 新增: 进入流程前是否停了 daemon
  "loggedIn": true,
  "appId": "cli_a1b2c3d4",
  "appSecret": "***masked***",
  "scopesGranted": true,
  "eventsSubscribed": true,
  "verificationToken": "v_xxx",
  "ownerOpenId": "ou_xxx",
  "versionId": "v1.0.0"
}
```

**resume 机制**：用户跑 `/setup-feishu` 时检测到此文件存在且有未完成项，自动从断点续跑。

**关键修复**：
- `domain` 字段记录检测到的飞书域（`feishu.cn` / `larksuite.com`），所有 API 调用都用此域
- `daemonStoppedAtStart` 字段记录：进入流程前停过 daemon → 完成后必须**自动重启 daemon**（不能丢）

### 5.7 既有代码重构路径（必做，在 M1 之前）

当前 `init-feishu.ts` 的几个函数是私有的，spec 5.1/5.2 假设复用但未明确路径。第一步重构（半天）：

```
src/cli/commands/init-feishu.ts (既有, 内部函数)
  ├── getTenantToken()   ──┐
  ├── saveConfig()       ──┼──→  src/feishu/utils.ts (新建, 公开 export)
  ├── captureOpenId()    ──┘
                              │
src/feishu/v7-ability.ts (新) ┘ import 这些公共函数

src/cli/commands/init-feishu.ts (重构后) → 改为 import + 复用
src/cli/commands/setup.ts (既有 printPermissionGuide) → 改为用 v7-ability
```

**具体动作**：
1. 创建 `src/feishu/utils.ts`，export `getTenantToken`、`saveConfig`、`captureOpenId`、`maskSecret`
2. 改 `init-feishu.ts` 为 import 这些函数
3. 改 `v7-ability.ts` import `getTenantToken` from `src/feishu/utils`
4. helper 脚本的 `enableBotAndPublish`/`captureOwnerAndSave` 通过 `child_process.spawn` 调 `cc-linker feishu enable-bot` 等子命令（不直接 import TypeScript — 跨仓库边界）

**验证标准**：`init-feishu.ts` 重构前后行为一致（手测一次完整 setup 流程）。

### 5.8 飞书域自动识别

海外用户用 `open.larksuite.com`，国内用 `open.feishu.cn`，两个域 token 不互通。helper 在 Phase 0 必须先识别：

```typescript
// helper/src/utils/domain.ts
export type FeishuDomain = 'feishu.cn' | 'larksuite.com';

export async function detectFeishuDomain(): Promise<FeishuDomain> {
  // 并行探测两个域
  const results = await Promise.allSettled([
    fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: 'invalid', app_secret: 'invalid' }),
      signal: AbortSignal.timeout(5000),
    }),
    fetch('https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: 'invalid', app_secret: 'invalid' }),
      signal: AbortSignal.timeout(5000),
    }),
  ]);
  
  // 选连通且能返回 JSON 错误响应的域（不能仅看 TCP 通）
  // 通常国内优先
  if (results[0].status === 'fulfilled' && results[0].value.status < 500) {
    return 'feishu.cn';
  }
  if (results[1].status === 'fulfilled' && results[1].value.status < 500) {
    return 'larksuite.com';
  }
  throw new Error('无法连接飞书开放平台，请检查网络');
}
```

**应用**：
- 所有 v7 API 调用 base URL = `https://open.${domain === 'feishu.cn' ? 'feishu' : 'larksuite'}.cn/...` 实际 larksuite 是 `https://open.larksuite.com`
- 浏览器 navigate URL 同样使用对应域
- setup-state.json 持久化 domain
- 错误信息中提示"你使用的是飞书国内版/海外版"

---

## 6. 数据流

### 6.1 正常流

```
1. 用户在 Claude Code 中输入: /setup-feishu

2. Skill 加载,读取 ~/.cc-linker/setup-state.json
   - 不存在 → 全新流程
   - 存在 + 全部完成 → 提示"已配置,是否重新配置?"
   - 存在 + 未完成 → 提示"上次中断在 X 阶段,是否续跑?"
   - 存在 + daemonStoppedAtStart=true → 提示"上次中断时停了 daemon,先帮你重启"

3. 域检测 (Phase 0):
   - helper 并行探测 open.feishu.cn 和 open.larksuite.com
   - 选定连通的域,记入 state

4. 后端检测 (Bash: `bun run helper backend detect`):
   - spawn('gstack', ['--version']) → 成功则用 gstack
   - 失败则用 Playwright (首次提示安装)
   - **若两者都不可用**: 打印清晰的手动操作指南,引导用户按 6 步完成(回到当前 `init-feishu` 体验)
   - **若用户已经在 daemon 上用 cc-linker**:
     - 临时停 daemon (避免 WebSocket 冲突)
     - 记录 state.daemonStoppedAtStart=true
     - 流程结束后**自动重启 daemon**

5. 浏览器登录:
   - navigate('https://open.${domain}/app')
   - 检测登录态 (cookie 有效)
   - 未登录则点击 QR 登录
   - **gstack headed 模式**: 用户在浏览器窗口扫码
   - **Playwright headless 模式**: 截图保存,告诉用户"用手机扫码这张图"
   - 等待登录成功,保存 cookies

6. 创建应用 (UI 模拟):
   - click('create-app-btn')
   - fill('app-name', 'cc-linker')
   - fill('app-desc', 'cc-linker 飞书机器人')
   - click('submit')
   - getText('app-id-display') → 抓 App ID
   - getText('app-secret-display') → 抓 App Secret

7. 开通 5 个权限 (UI 模拟,串行):
   - 对每个 scope: search → 找到 → click 申请
   - 处理可能的确认弹窗

8. 订阅事件:
   - navigate('/event')
   - click('mode-websocket')
   - click('add-event')
   - search 'im.message.receive_v1'
   - click 确认
   - getText('verification-token') → 关键抓取

9. 启用 Bot + 发布版本 (调 cc-linker CLI):
   - exec('cc-linker feishu enable-bot --domain=${domain} ...')
   - exec('cc-linker feishu publish-version --domain=${domain} ...')
   - 尝试 exec('cc-linker feishu approve-version --domain=${domain} ...')
   - 若 approve 失败 (非 admin) → 打印管理员链接

10. 抓 owner open_id:
   - exec('cc-linker start --daemon') 临时启动
   - 提示用户给 Bot 发消息
   - captureOpenId 复用既有逻辑 (120s 超时)
   - 抓完立即 stop daemon (避免一直占着 WS)

11. 写入 config:
   - exec('cc-linker feishu set-config ...') 多次调用
   - 或一次性写 ~/.cc-linker/config.toml

12. 验证 + 收尾:
   - 若 state.daemonStoppedAtStart=true: 重启 daemon
   - 提示用户发消息测试
   - 30s 后检查 bot 状态
   - 清理 setup-state.json (保留 backup)
   - 输出使用文档
```

### 6.2 失败流 — gstack 失败降级

```
gstack backend.launch() 失败
  ↓
catch 异常,输出 "gstack 启动失败,降级到 Playwright"
  ↓
检查 Playwright 是否安装
  ├─ 已装 → PlaywrightBackend.launch() → 继续
  └─ 未装 → exec('bunx playwright install chromium') → 等装完 → 继续
  ↓
setup-state.json 加 "backendSwitched": true
  ↓
继续主流程
```

### 6.3 失败流 — Verification Token 抓不到

```
getText('verification-token') 返回 null
  ↓
screenshot('token-fail')  // 保存现场
  ↓
throw new SetupError({
  phase: 'subscribeEvents',
  message: '无法读取 Verification Token',
  suggestion: '请打开截图查看 Token 并粘贴到下方',
  screenshotPath: '...'
})
  ↓
Skill 接收错误
  ↓
inquirer.prompt 提示用户粘贴 Token
  ↓
用户粘贴 → 继续
```

### 6.4 失败流 — 非 admin 用户

```
exec('cc-linker feishu approve-version ...') 退出码 2
  ↓
检测到 'NOT_ADMIN' 错误码
  ↓
打印:
  ⚠️  你不是该应用的 admin
  请把以下链接发给企业管理员,管理员点"同意发布"后回来按回车:
    https://open.${domain}/app/{appId}/version
  ↓
inquirer.prompt 等待用户回车
  ↓
用户回车后,继续抓 owner open_id + 写 config
  ↓
最终输出: "配置已写入,待管理员同意发布后即可使用"
```

### 6.5 失败流 — 多 bot 实例冲突

```
Phase 0 检测 isDaemonRunning() 返回 true
  ↓
输出: "检测到 cc-linker daemon 正在跑,需要临时停止避免 WebSocket 冲突"
  ↓
调用 cc-linker stop (复用既有逻辑)
  ↓
state.daemonStoppedAtStart = true
  ↓
继续主流程
  ↓
Phase 7 (验证收尾):
  ├─ state.daemonStoppedAtStart === true → 自动重启 cc-linker start --daemon
  └─ 否则 → 不动
```

**为什么重要**：飞书 WebSocket 同一 app_id 只能一个连接（MEMORY `feishu-p2p-permission-trap`）。如果用户之前 daemon 在跑，captureOpenId 不会收到任何事件（被占线）。

### 6.6 失败流 — 全自动化失败回退到手动

```
gstack 失败 + Playwright 失败 + domain 都探测不到
  ↓
判定: 全自动流程无法继续
  ↓
输出: "自动化配置无法启动,以下是手动操作清单"
  ↓
打印:
  ⚠️  请在浏览器中打开 https://open.${domain}/app
  1. 创建企业自建应用 → 拿到 App ID/Secret
  2. 权限管理 → 开通以下 5 个权限: [...]
  3. 事件订阅 → 长连接模式 → 添加 im.message.receive_v1 → 复制 Verification Token
  4. 回调配置 → 长连接模式 → 添加 card.action.trigger
  5. 应用功能 → 机器人 → 启用
  6. 版本管理与发布 → 创建新版本 → 提交

  完成后运行: cc-linker init-feishu (手动配置向导)
  ↓
inquirer.prompt "是否需要我打印这个清单到本地文件?"
  ↓
保留 setup-state.json (标记 allFailed=true), 方便用户调 debug
```

---

## 7. 错误处理矩阵

| 失败环节 | 现象 | 自动恢复 | 降级策略 |
|---------|------|---------|---------|
| Playwright 未装 | `playwright-core` import 失败 | 提示 `bunx playwright install chromium` | 转 gstack |
| gstack 未装 | `gstack --version` 失败 | 用 Playwright | — |
| gstack 启动失败 | launch 抛错 | 重试 1 次 → 降级 Playwright | — |
| 扫码超时 120s | login 等待超时 | 提示重试 | 重试 3 次后退出 |
| 创建应用失败 | 飞书 UI 错误提示 | 截图 + 提示 | 进入手动模式 |
| App ID 抓不到 | DOM 文本为空 | 截图 + 提示复制 | 等待用户粘贴 |
| 权限搜索无结果 | selector 超时 | 重试不同关键词 | 跳过此权限,记入 failed list |
| 权限弹窗未确认 | 对话框仍在 | 自动点确认 | 截图提示 |
| Verification Token 抓不到 | getText 返回空 | 截图 | 提示用户粘贴 |
| v7 API 报 210020 (审核中) | API 返回错误 | sleep 30s 重试 3 次 | 跳过此步,提示用户后续手动 |
| v7 API 报 210017 (无权限) | API 返回错误 | — | 提示联系管理员 |
| 自动批准失败 | approve API 报错 | — | 打印 admin 链接,等待用户回车 |
| captureOpenId 超时 | WebSocket 120s 无消息 | 提示用户重发消息 | 重试 2 次后跳过 |
| 写 config 失败 | 文件权限/磁盘错误 | chmod 0o600 重试 | 退出,提示用户手动 |

---

## 8. 安全与权限

### 8.1 敏感数据处理

| 数据 | 存储位置 | 权限 | 日志输出 | 截图策略 |
|------|---------|------|---------|---------|
| App Secret | `~/.cc-linker/config.toml` | 0o600 | **绝不输出** | **禁用截图**（创建成功页）|
| Verification Token | `~/.cc-linker/config.toml` | 0o600 | 允许输出 | **禁用截图**（事件订阅页）|
| App ID | `~/.cc-linker/config.toml` | 0o600 | 允许输出 | 允许截图（公开标识）|
| Cookie | `~/.cc-linker/feishu-cookies.json` | 0o600 | **绝不输出** | **禁用截图**（登录页）|

**截图策略（修正）**：
- 三个敏感页面**完全禁用截图**（不靠"mask 后保留"，因为 mask 不可靠）
  - 创建应用成功页（暴露 App Secret）
  - 事件订阅页（暴露 Verification Token）
  - 登录页（暴露 session cookie）
- 其他页面正常截图用于 debug
- helper 内部维护一个 `BLOCKED_SCREENSHOT_PATTERNS` 列表（URL 正则或 page.title() 包含关键字）
- 截图保存到 `~/.cc-linker/setup-screenshots/`，权限 0o600
- helper 退出时**默认清理**截图（除非用户传 `--keep-screenshots`）

### 8.2 网络请求

- 所有飞书 API 请求走 HTTPS
- Skill helper 脚本无远端调用（除飞书官方域 `*.feishu.cn` / `*.larksuite.com`）
- gstack / Playwright 驱动浏览器时禁止访问非飞书域（可由浏览器扩展 enforce，**不在本期范围**）

### 8.3 权限申请最小化

Skill 仅申请必需 5 个权限，无任何扩展权限请求。

---

## 9. 测试策略

### 9.1 单元测试（cc-linker 侧）

```
tests/unit/feishu/v7-ability.test.ts
  - getTenantToken: mock fetch, 验证成功 + 401 + 500 路径
  - getAppAbility: mock fetch, 验证 v7 response 解析
  - enableBotCapability: mock fetch, 验证 body 正确, 错误码 210020/210017/210021
  - publishNewVersion: mock fetch, 验证 versionId 返回
  - approveAppVersion: mock fetch, 验证 PATCH 端点

tests/unit/cli/feishu.test.ts
  - cc-linker feishu enable-bot: 退出码映射
  - cc-linker feishu approve-version: NOT_ADMIN 退出码 2
```

### 9.2 单元测试（Skill 侧）

```
skill-helper/tests/unit/backends/playwright.test.ts
  - 复用系统 Chrome 路径查找
  - cookie 加载/保存

skill-helper/tests/unit/flows/setup.test.ts
  - 状态机正确: 跳过已完成的 phase
  - resume 流程
  - 异常 → state 持久化
```

### 9.3 集成测试（端到端）

**关键澄清**：真实飞书租户 credentials **不能进 CI**（安全风险、租户管理成本高）。集成测试分两层：

**Layer A: Playwright route mock（CI 跑）**
```
tests/integration/auto-setup-mock.test.ts
  - 用 Playwright 的 page.route() mock 飞书域响应
  - mock 数据准备: 静态 HTML 模拟飞书控制台各页面（创建应用、权限、事件）
  - 不调真实 v7 API,用 msw (Mock Service Worker) mock fetch
  - 跑 helper 全流程,验证:
    - 各 phase 顺序正确
    - state 持久化
    - 退出码映射
  - CI 上跑 (无需真实凭据)
```

**Layer B: 真实飞书租户（仅本机）**
```
tests/integration/auto-setup-real.test.ts
  - 前置: 开发者本机有飞书测试租户 + 已开 Bot 权限的应用
  - 跑真实 createApp + grantScopes + subscribeEvents
  - 不在 CI 跑,通过 npm script `test:integration:real` 手动触发
  - 输出真实截图 + setup-state.json,人工 review
  - 跑一次后清理(删除测试创建的应用)
```

**视觉回归测试**（layer A 的扩展）：
- 静态 HTML mock 中嵌入"飞书历史版本"的截图（从真实租户导出）
- 跑 helper 全流程,对比 mock HTML 截图 vs 历史截图
- **不对比像素**（飞书会 A/B test），**只对比关键文本节点和 selector 命中**
- 失败时人工 review 飞书控制台改了什么

**测试租户管理**：
- **短期**：开发者本机手测（不进入 CI）
- **长期**（不承诺）：项目维护者注册专用 test tenant，凭据放本地 `.env.test`，不进 git

### 9.4 视觉回归测试

每个 phase 跑完后自动截图，保存到 `tests/fixtures/auto-setup/`：
- 飞书改版后能快速发现 selector 失效
- 截图 hash 对比

### 9.5 手动验收清单

发布前在飞书测试租户上跑一次完整流程：
- [ ] 全程无需手动点飞书后台任何菜单
- [ ] 5 个权限全部开通
- [ ] Verification Token 正确写入 config
- [ ] Bot 启用成功
- [ ] 版本发布并自动批准
- [ ] owner_open_id 正确捕获
- [ ] Bot 收到测试消息并回复

---

## 10. 实施计划

### 10.1 工作量分配

| 模块 | 工时 | 仓库 |
|------|------|------|
| **既有代码重构（getTenantToken/saveConfig/captureOpenId → src/feishu/utils）** | **0.5 天** | cc-linker |
| v7 API 库（5 个函数 + 错误码映射） | 2 天 | cc-linker |
| cc-linker feishu 子命令（5 个: enable-bot / publish-version / approve-version / set-config / domain-info） | 1 天 | cc-linker |
| cc-linker 单元测试 | 1 天 | cc-linker |
| **gstack spike（验证 CLI/MCP 模式、session 支持）** | **0.5 天** | 新建 |
| Skill 仓库搭建（`cc-linker-feishu-skill`） | 0.5 天 | 新建 |
| SKILL.md 编写 | 1 天 | 新建 |
| helper 脚本入口（CLI 子命令分发） | 0.5 天 | 新建 |
| BrowserBackend 接口 + 类型（helper 内部） | 0.5 天 | 新建 |
| PlaywrightBackend 实现 | 2 天 | 新建 |
| GStackBackend 实现（视 spike 结果） | 0.5-1 天 | 新建 |
| 后端检测 + 降级逻辑 | 0.5 天 | 新建 |
| 域检测（feishu.cn vs larksuite.com） | 0.5 天 | 新建 |
| 业务编排（7 个 phase） | 2.5 天 | 新建 |
| 状态管理 + resume + 多 bot 冲突 | 1 天 | 新建 |
| 错误处理 + 截图策略 + 降级 | 1 天 | 新建 |
| 单元测试（Skill 侧） | 1 天 | 新建 |
| 集成测试（Playwright route mock + CI 可跑） | 2 天 | 新建 |
| 真实租户本机集成测试（Layer B） | 1 天 | 新建 |
| 视觉回归（selector 文本对比） | 1 天 | 新建 |
| 文档（README + 故障排查 + 故障排查） | 1 天 | 新建 |
| **合计** | **~22.5 工作日 ≈ 4.5 周** | |

**vs 原 17.5 天估算**：+5 天 buffer（gstack spike + 真实租户测试 + selector 维护 + 截图策略细化 + 重构路径）

### 10.2 里程碑

- **M0.5（Day 0.5）**：既有代码重构 + gstack spike ✅（决定后续是否做 GStackBackend）
- **M1（Day 3）**：v7 API 库 + 单元测试 ✅（独立可用，CLI 用户受益）
- **M2（Day 4.5）**：cc-linker feishu 子命令族 + 单元测试 ✅
- **M3（Day 6）**：Skill 仓库 + SKILL.md + helper 入口 + BrowserBackend 接口
- **M4（Day 9）**：PlaywrightBackend + 域检测 + 后端检测
- **M5（Day 12）**：业务编排 7 phase + 状态管理
- **M6（Day 14.5）**：错误处理 + 截图策略 + 多 bot 冲突 + 全失败 fallback
- **M7（Day 17）**：单元测试 + Playwright route mock 集成测试（CI 可跑）
- **M8（Day 19）**：本机真实飞书租户集成测试（Layer B）
- **M9（Day 22.5）**：视觉回归 + 文档完成

### 10.3 风险点与应对

| 风险 | 概率 | 应对 |
|------|------|------|
| 飞书控制台改版导致 selector 失效 | 高 | 集中管理 selectors.ts + 视觉回归（10.4 详述）|
| Playwright 跨平台差异 | 中 | 主要在 macOS/Linux 验证,Windows 标注"尽力而为" |
| gstack 实际是 MCP 模式不是 CLI | 中 | spike-first 验证,失败时只用 Playwright |
| gstack 无持久 session | 中 | helper 维护自己的 Playwright session 兜底 |
| 飞书测试租户不可用 | 高 | Layer A mock 测试在 CI 跑,Layer B 真实测试只在本机 |
| Verification Token DOM 抓不到 | 中 | 截图禁用 + 用户粘贴降级路径已设计 |
| domain 探测误判（两个都通但内容不一致）| 低 | 探测时同时检查响应 JSON 的 `code` 字段（飞书返回 99991/99992 等）|
| 多 bot WebSocket 冲突 | 中 | 6.5 流程已设计:进入前停 daemon,完成后重启 |

### 10.4 Selector 维护流程

**目录结构**：
```
helper/src/selectors/
├── _meta.ts                    // last-verified 时间戳集中管理
├── login.ts                    // 登录页 selector
├── create-app.ts               // 创建应用 selector
├── permissions.ts              // 权限管理 selector
├── event-subscription.ts       // 事件订阅 selector
└── callback.ts                 // 回调配置 selector
```

**每个 selector 文件格式**：
```typescript
// helper/src/selectors/login.ts
export const LOGIN_SELECTORS = {
  qrCodeButton: '[data-testid="qrcode-login"]',
  // ...
} as const;

// last verified: 2026-06-17 by @wuyujun
// 如果飞书改版,selector 失效,请:
// 1. 在测试租户手动打开飞书控制台
// 2. DevTools 找到新 selector
// 3. 改这里 + 更新 last-verified 日期
```

**维护触发**：
- 每次跑 helper 成功 → 自动更新 `_meta.ts` 的 `lastVerified`
- 超过 **30 天**未验证的 selector → helper 启动时 warning（"飞书控制台可能已改版，建议手测一次"）
- 跑 helper 失败时 → 截图 + 当前 selector → 提示"可能是 selector 失效，请检查 selectros/login.ts 是否需要更新"

**CI 监控**（Layer A 视觉回归）：
- helper 跑完后,对比 mock HTML vs 历史截图的 **selector 命中**（不对比像素）
- 关键 selector 集合（5-10 个）需要全命中,否则 CI fail
- selector 命中失败时,打印建议: "试试 `data-testid=create-app-v2`"

---

## 11. 文档

### 11.1 用户文档

`cc-linker-feishu-skill/README.md`:
- 一句话价值主张
- 前置条件（Claude Code、cc-linker 安装）
- 使用流程（`/setup-feishu` 一行命令）
- 常见问题 FAQ
- 故障排查（Verification Token 抓不到怎么办 / 非 admin 怎么办）

### 11.2 开发文档

- `BrowserBackend` 接口文档
- 新增后端的接入指南
- 测试租户准备流程

### 11.3 维护文档

- 飞书控制台改版时的 selector 更新流程
- 飞书 v7 API 升级迁移路径

---

## 12. 附录

### 12.1 飞书 v7 API 端点参考

```
GET    https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal
GET    https://open.feishu.cn/open-apis/application/v7/applications/{app_id}
PATCH  https://open.feishu.cn/open-apis/application/v7/applications/{app_id}/ability
POST   https://open.feishu.cn/open-apis/application/v7/applications/{app_id}/publish
PATCH  https://open.feishu.cn/open-apis/application/v6/applications/{app_id}/app_versions/{version_id}
GET    https://open.feishu.cn/open-apis/bot/v3/info
```

### 12.2 必需权限列表

```
im:message:readonly          - 主动读取消息（REST）
im:message.p2p_msg:readonly  - 私聊事件推送（必装，p2p 陷阱）
im:message                   - 消息操作（读/发/撤回）
im:message:send_as_bot       - 以应用身份发消息
im:resource                  - 下载用户资源（图片等）
```

### 12.3 关键参考链接

- v7 application API: https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/application-v7/application-v7/application-base/patch
- v7 publish: https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/application-v7/application-v7/application-publish/create
- v6 app version: https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/application-v6/application-app_version/patch
- Bot info: https://open.feishu.cn/document/ukTMukTMukTM/uAjMxEjLwITMx4CMyETM
- p2p 权限陷阱: MEMORY `feishu-p2p-permission-trap.md`

### 12.4 既有代码复用点（重构后）

- `src/feishu/utils.ts`（**新建, 从 init-feishu.ts 抽出的公共函数**）:
  - `getTenantToken(appId, appSecret)` → v7-ability.ts + helper 都 import
  - `captureOpenId(appId, appSecret)` → helper 通过 `cc-linker feishu capture-open-id` 子命令调
  - `saveConfig(config, path)` → feishu set-config 子命令调
  - `maskSecret(secret)` → 日志/截图 mask
- `src/cli/commands/init-feishu.ts`（**重构后**）: 改为 import from `src/feishu/utils`, 行为不变
- `src/cli/commands/setup.ts`（**升级**）: `printPermissionGuide` 用 v7-ability 做精确检测
- `src/runtime/state-coordinator.ts`: `isDaemonRunning()` → helper 检测多 bot 冲突
- `src/utils/paths.ts`: `CONFIG_PATH`, `RUNTIME_PID_FILE` 路径常量
- `src/utils/logger.ts`: 复用 logger 风格

---

## 13. 后续演进（不在本期范围）

记录到 ROADMAP，本期不实现：

- **R1**：把 skill helper 进一步抽象，支持更多 IM 平台（钉钉、企业微信、Slack）
- **R2**：把 setup 流程做成可嵌入的 npm 包，让其他工具也能复用
- **R3**：cc-linker 完整 CLI 版的 Playwright 自动化（用于非 Claude Code 用户）
- **R4**：飞书海外版（larksuite.com）适配
- **R5**：版本发布后的"健康检查"（验证 bot 实际工作）
