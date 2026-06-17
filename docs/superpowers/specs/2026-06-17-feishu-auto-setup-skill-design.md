# cc-linker 飞书一键配置 Skill 设计规格

> 版本: v1.0
> 日期: 2026-06-17
> 状态: 已评审，待实现

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

```
┌─────────────────────────────────────────────────────────────┐
│  Claude Code 客户端                                          │
│                                                              │
│  ┌────────────────────────────────────────────────────┐     │
│  │ /setup-feishu Skill (SKILL.md)                      │     │
│  │  - 顶层 orchestration 提示                          │     │
│  │  - 调用 Helper 脚本完成实际操作                      │     │
│  └────────────────────┬───────────────────────────────┘     │
│                       │ Bash tool                            │
└───────────────────────┼──────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────────┐
│  Skill Helper 脚本 (TypeScript / Bun)                       │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │ detect       │  │ gstack       │  │ playwright       │   │
│  │ backend      │→ │ backend      │  │ backend          │   │
│  │              │  │ (Bash 包装)  │  │ (driver.ts)      │   │
│  └──────┬───────┘  └──────┬───────┘  └────────┬─────────┘   │
│         └─────────────────┴───────────────────┘             │
│                          ↓                                   │
│         ┌────────────────────────────────┐                  │
│         │ BrowserBackend 接口             │                  │
│         │ (launch/navigate/click/...)     │                  │
│         └────────────┬───────────────────┘                  │
│                      ↓                                       │
│  ┌──────────────────────────────────────────────┐           │
│  │ 业务编排层                                     │           │
│  │  - login()                                    │           │
│  │  - createApp()                                │           │
│  │  - grantScopes()                              │           │
│  │  - subscribeEvents()                          │           │
│  │  - enableBotAndPublish()  [调 cc-linker CLI]  │           │
│  │  - captureOwnerOpenId()                      │           │
│  │  - saveConfig()         [调 cc-linker CLI]   │           │
│  └──────────────────────────────────────────────┘           │
│                          ↓                                   │
│  ┌──────────────────────────────────────────────┐           │
│  │ 状态管理                                       │           │
│  │  ~/.cc-linker/setup-state.json (续跑)         │           │
│  │  ~/.cc-linker/feishu-cookies.json (免登录)    │           │
│  └──────────────────────────────────────────────┘           │
└─────────────────────┬───────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────────────────┐
│  cc-linker CLI (既有代码 + 新增)                              │
│                                                              │
│  ┌──────────────────────────────────┐                        │
│  │ 新增 src/feishu/v7-ability.ts     │                        │
│  │  - getAppAbility()                │                        │
│  │  - enableBotCapability()          │                        │
│  │  - publishNewVersion()            │                        │
│  │  - approveAppVersion()            │                        │
│  └──────────────────────────────────┘                        │
│  ┌──────────────────────────────────┐                        │
│  │ 新增 src/cli/commands/feishu/    │                        │
│  │  - enable-bot                    │                        │
│  │  - publish-version               │                        │
│  │  - approve-version               │                        │
│  │  - set-config                    │                        │
│  └──────────────────────────────────┘                        │
│  (复用 init-feishu.ts 中的 getTenantToken / captureOpenId)  │
└─────────────────────────────────────────────────────────────┘
```

### 4.2 仓库分布

| 仓库 | 范围 |
|------|------|
| `cc-linker`（既有） | v7 API 库、feishu 子命令族、getTenantToken 复用 |
| `cc-linker-feishu-skill`（新建） | SKILL.md、Helper 脚本（detect backend、gstack 包装、Playwright driver、业务编排） |

---

## 5. 组件设计

### 5.1 cc-linker 侧 — `src/feishu/v7-ability.ts`

封装飞书 v7 application API，独立可测。

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

### 5.3 Skill 侧 — BrowserBackend 接口

```typescript
// skill-helper/src/backends/types.ts
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
  renderQrToTerminal(): Promise<void>;  // Playwright headless 用
}
```

### 5.4 Skill 侧 — 后端实现

**GStackBackend**（薄封装）：
- 通过 `Bash` 工具调用 `gstack browse <subcommand>` CLI
- 命令映射（**待 gstack CLI 文档确认具体语法**）：`navigate <url>` / `click <sel>` / `type <sel> <text>` / `text <sel>` 等
- 实现时第一步：跑 `gstack browse --help` 确认实际命令格式，若语法不符则调整映射
- 二维码在 headed 浏览器窗口显示，无需终端渲染

**PlaywrightBackend**（重实现）：
- `playwright-core` + 系统 Chrome 优先；无则 `bunx playwright install chromium`
- cookie 持久化：`~/.cc-linker/feishu-cookies.json`
- 二维码：`renderQrToTerminal()` 用 `qrcode-terminal` 包渲染

### 5.5 Skill 侧 — 业务编排

`skill-helper/src/flows/setup.ts` 串联 6 个 phase：

```typescript
export async function runSetup(opts: { 
  backend: BrowserBackend; 
  state: SetupState; 
  resume?: boolean;
}): Promise<SetupResult> {
  // Phase 1: login (可 resume)
  if (!opts.state.loggedIn) await login(opts.backend);
  opts.state.loggedIn = true; saveState(opts.state);
  
  // Phase 2: createApp (可 resume)
  if (!opts.state.appId) {
    const { appId, appSecret } = await createApp(opts.backend, 'cc-linker');
    opts.state.appId = appId; opts.state.appSecret = appSecret;
    saveState(opts.state);
  }
  
  // Phase 3: grantScopes
  if (!opts.state.scopesGranted) {
    await grantScopes(opts.backend, opts.state.appId, REQUIRED_SCOPES);
    opts.state.scopesGranted = true; saveState(opts.state);
  }
  
  // Phase 4: subscribeEvents
  if (!opts.state.eventsSubscribed) {
    const { verificationToken } = await subscribeEvents(opts.backend, opts.state.appId);
    opts.state.verificationToken = verificationToken;
    opts.state.eventsSubscribed = true; saveState(opts.state);
  }
  
  // Phase 5: enableBot + publish (调 cc-linker CLI)
  await enableBotAndPublish(opts.state.appId, opts.state.appSecret);
  
  // Phase 6: captureOwnerOpenId + saveConfig
  await captureOwnerAndSave(opts.backend, opts.state);
  
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

---

## 6. 数据流

### 6.1 正常流

```
1. 用户在 Claude Code 中输入: /setup-feishu

2. Skill 加载,读取 ~/.cc-linker/setup-state.json
   - 不存在 → 全新流程
   - 存在 + 全部完成 → 提示"已配置,是否重新配置?"
   - 存在 + 未完成 → 提示"上次中断在 X 阶段,是否续跑?"

3. 后端检测:
   - spawn('gstack', ['--version']) → 成功则用 gstack
   - 失败则用 Playwright (首次提示安装)
   - **若两者都不可用**: 打印清晰的手动操作指南,引导用户按 6 步完成(回到当前 `init-feishu` 体验)

4. 浏览器登录:
   - navigate('https://open.feishu.cn/app')
   - 检测登录态 (cookie 有效)
   - 未登录则点击 QR 登录,等待扫码
   - 保存 cookies

5. 创建应用 (UI 模拟):
   - click('create-app-btn')
   - fill('app-name', 'cc-linker')
   - fill('app-desc', 'cc-linker 飞书机器人')
   - click('submit')
   - getText('app-id-display') → 抓 App ID
   - getText('app-secret-display') → 抓 App Secret

6. 开通 5 个权限 (UI 模拟,串行):
   - 对每个 scope: search → 找到 → click 申请
   - 处理可能的确认弹窗

7. 订阅事件:
   - navigate('/event')
   - click('mode-websocket')
   - click('add-event')
   - search 'im.message.receive_v1'
   - click 确认
   - getText('verification-token') → 关键抓取

8. 启用 Bot + 发布版本 (调 cc-linker CLI):
   - exec('cc-linker feishu enable-bot ...')
   - exec('cc-linker feishu publish-version ...')
   - 尝试 exec('cc-linker feishu approve-version ...')
   - 若 approve 失败 (非 admin) → 打印管理员链接

9. 抓 owner open_id:
   - exec('cc-linker start --daemon') 临时启动
   - 提示用户给 Bot 发消息
   - captureOpenId 复用既有逻辑 (120s 超时)

10. 写入 config:
    - exec('cc-linker feishu set-config ...') 多次调用
    - 或一次性写 ~/.cc-linker/config.toml

11. 验证:
    - 重启 daemon
    - 提示用户发消息测试
    - 30s 后检查 bot 状态

12. 完成:
    - 清理 setup-state.json
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
    https://open.feishu.cn/app/{appId}/version
  ↓
inquirer.prompt 等待用户回车
  ↓
用户回车后,继续抓 owner open_id + 写 config
  ↓
最终输出: "配置已写入,待管理员同意发布后即可使用"
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

| 数据 | 存储位置 | 权限 | 日志输出 |
|------|---------|------|---------|
| App Secret | `~/.cc-linker/config.toml` | 0o600 | **绝不输出**（截图前 mask）|
| Verification Token | `~/.cc-linker/config.toml` | 0o600 | 允许输出（与 Bot 公开行为一致）|
| App ID | `~/.cc-linker/config.toml` | 0o600 | 允许输出（公开标识）|
| Cookie | `~/.cc-linker/feishu-cookies.json` | 0o600 | **绝不输出** |
| App Secret 截图 | mask 处理后保留 | 0o600 | — |

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

**前置条件**：需要一个飞书测试租户（开发者本人在该租户下是 admin）+ 一个"未配置的应用"。

**测试租户来源**：
- 短期：开发者本人的飞书测试租户（自建企业、自己管）
- 长期：CI 上需注册专用 test tenant + test account，由项目维护者持有 credentials，注入到 GitHub Actions Secrets

```
tests/integration/auto-setup.test.ts
  - 启动 helper 脚本
  - 准备: 清除 cookies 和 state
  - 跳过登录 phase (使用预存的 cookie)
  - 跑 createApp + grantScopes + subscribeEvents
  - 调 cc-linker v7 API 启用 Bot + 发版本
  - 验证 setup-state.json 正确
  - 清理: 删除测试创建的应用
```

**CI 兼容性**：
- GitHub Actions Linux runner + Xvfb
- 用 Playwright 的 `headless: true` 模式
- 跳过扫码登录（用测试 cookie）

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
| v7 API 库（5 个函数 + 错误码映射） | 2 天 | cc-linker |
| cc-linker feishu 子命令（4 个） | 1 天 | cc-linker |
| cc-linker 单元测试 | 1 天 | cc-linker |
| Skill 仓库搭建（`cc-linker-feishu-skill`） | 0.5 天 | 新建 |
| SKILL.md 编写 | 1 天 | 新建 |
| BrowserBackend 接口 + 类型 | 0.5 天 | 新建 |
| PlaywrightBackend 实现 | 2 天 | 新建 |
| GStackBackend 实现（Bash 包装） | 1 天 | 新建 |
| 后端检测 + 降级逻辑 | 0.5 天 | 新建 |
| 业务编排（login/createApp/grantScopes/subscribeEvents/...） | 2 天 | 新建 |
| 状态管理 + resume | 1 天 | 新建 |
| 错误处理 + 截图 + 降级 | 1 天 | 新建 |
| 单元测试（Skill 侧） | 1 天 | 新建 |
| 集成测试（端到端 + 飞书测试租户） | 2 天 | 新建 |
| 文档（README + 故障排查） | 1 天 | 新建 |
| **合计** | **17.5 工作日 ≈ 3.5 周** | |

### 10.2 里程碑

- **M1（Day 2）**：v7 API 库 + 单元测试 ✅（独立可用，CLI 用户受益）
- **M2（Day 4）**：cc-linker feishu 子命令族 + 单元测试 ✅
- **M3（Day 6）**：Skill 仓库 + SKILL.md + BrowserBackend 接口
- **M4（Day 9）**：PlaywrightBackend + GStackBackend 可用
- **M5（Day 12）**：业务编排 + 状态管理完成
- **M6（Day 14）**：错误处理 + 降级 + resume 完整
- **M7（Day 17.5）**：集成测试通过 + 文档完成

### 10.3 风险点与应对

| 风险 | 概率 | 应对 |
|------|------|------|
| 飞书控制台改版导致 selector 失效 | 高 | 集中管理 selectors.ts + 视觉回归 |
| Playwright 跨平台差异 | 中 | 主要在 macOS/Linux 验证,Windows 标注"尽力而为" |
| gstack CLI 命令格式未稳定 | 中 | 后端抽象层屏蔽,允许快速重写 |
| 飞书测试租户不可用 | 低 | 用用户自己的租户做 alpha 测试 |
| Verification Token DOM 抓不到 | 中 | 截图 + 用户粘贴降级路径已设计 |

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

### 12.4 既有代码复用点

- `src/cli/commands/init-feishu.ts`:
  - `getTenantToken(appId, appSecret)` → v7-ability.ts 复用
  - `captureOpenId(appId, appSecret)` → skill helper 复用
  - `saveConfig(config, path)` → feishu set-config 复用
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
