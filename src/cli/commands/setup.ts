import chalk from 'chalk';
import { existsSync, readFileSync } from 'fs';
import inquirer from 'inquirer';
import { RegistryManager } from '../../registry';
import { syncBeforeCommand } from '../../scanner';
import { CLAUDE_SETTINGS_PATH } from '../../utils/paths';
import {
  getTenantToken,
  getBotName,
  captureOpenId as captureOpenIdSdk,
  isDaemonRunning,
  loadExistingConfig,
  saveConfig,
  maskSecret,
} from './init-feishu';

export function savePermissionMode(mode: string, configPath?: string): void {
  const existing = loadExistingConfig(configPath);
  if (!existing.claude) existing.claude = {};
  existing.claude.permission_mode = mode;
  if (!existing.sdk) existing.sdk = {};
  existing.sdk.permission_mode = mode;
  saveConfig(existing, configPath);
}

/** Check if Claude Code hook is already installed */
function isHookInstalled(): boolean {
  if (!existsSync(CLAUDE_SETTINGS_PATH)) return false;
  try {
    const settings = JSON.parse(readFileSync(CLAUDE_SETTINGS_PATH, 'utf8'));
    if (!Array.isArray(settings.hooks?.SessionStart)) return false;
    return settings.hooks.SessionStart.some((matcher: any) =>
      matcher?.hooks?.some((h: any) => h?.command?.includes('cc-linker'))
    );
  } catch {
    return false;
  }
}

interface SetupOptions {
  skipFeishu?: boolean;
  skipHook?: boolean;
  skipImgProxy?: boolean;
}

/** Result returned by the Feishu wizard for the summary display */
interface FeishuWizardResult {
  configured: boolean;
  appId: string;
  started: boolean;
  autoStart: boolean;
}

/** Result returned by the img-proxy wizard for the summary display */
interface ImgProxyWizardResult {
  configured: boolean;
  installedCount: number;
  started: boolean;
  autoStart: boolean;
  wrapperInstalled: boolean;
  wrapperSkipped: boolean;
}

export async function setup(registry: RegistryManager, opts: SetupOptions = {}): Promise<void> {
  // Calculate total steps dynamically
  const totalSteps = (opts.skipFeishu ? 3 : 4) + (opts.skipImgProxy ? 0 : 1);

  console.log(chalk.blue('═══════════════════════════════════════════'));
  console.log(chalk.blue('  cc-linker 一键配置向导'));
  console.log(chalk.blue('═══════════════════════════════════════════\n'));

  console.log(chalk.gray('本向导将引导你完成以下配置：'));
  console.log(chalk.gray('  1. 初始化会话注册表'));
  console.log(chalk.gray('  2. 选择 Claude Code 权限模式'));
  console.log(chalk.gray('  3. 安装 Claude Code 自动注册钩子'));
  let stepNum = 4;
  if (!opts.skipFeishu) {
    console.log(chalk.gray(`  ${stepNum}. 配置飞书 Bot（App ID + App Secret + 开机自启）`));
    stepNum++;
  }
  if (!opts.skipImgProxy) {
    console.log(chalk.gray(`  ${stepNum}. 启用图片代理 (img-proxy,自动识别纯文本模型 / 多模态 / CC Switch)`));
  }
  console.log('');

  // ===== Step 1: Initialize registry =====
  console.log(chalk.cyan(`── Step 1/${totalSteps} ── 初始化会话注册表`));

  const isFresh = Object.keys(registry.sessions).length === 0;
  console.log(chalk.gray(isFresh ? '  创建 registry...' : '  刷新现有 registry...'));

  await syncBeforeCommand(registry, undefined, undefined, false, true);

  const sessionCount = Object.keys(registry.sessions).length;
  console.log(chalk.green(`  ✅ 已注册 ${sessionCount} 个会话`));
  console.log('');

  // ===== Step 2: Claude Code 权限模式 =====
  console.log(chalk.cyan(`── Step 2/${totalSteps} ── Claude Code 权限模式`));
  console.log('');
  console.log(chalk.gray('  ℹ  权限模式说明:'));
  console.log(chalk.gray('    控制 Claude Code 执行操作时的交互确认行为。'));
  console.log(chalk.gray('    由于飞书端无法完成终端式交互确认，默认自动接受文件编辑。'));
  console.log('');
  console.log(chalk.gray('  可选值:'));
  console.log(chalk.gray('    acceptEdits          (推荐) 自动接受文件编辑，最适合飞书侧使用'));
  console.log(chalk.gray('    bypassPermissions    跳过所有权限检查，慎用'));
  console.log(chalk.gray('    auto                 智能判断'));
  console.log(chalk.gray('    default              使用 Claude Code 默认（可能弹出确认）'));
  console.log(chalk.gray('    dontAsk              不询问'));
  console.log(chalk.gray('    plan                 强制进入 plan 模式'));
  console.log('');

  const { permissionMode } = await inquirer.prompt([{
    type: 'list',
    name: 'permissionMode',
    message: '请选择 Claude Code 权限模式:',
    default: 'acceptEdits',
    choices: [
      { name: 'acceptEdits          (推荐) 自动接受文件编辑，最适合飞书侧使用', value: 'acceptEdits' },
      { name: 'bypassPermissions    跳过所有权限检查，慎用', value: 'bypassPermissions' },
      { name: 'auto                 智能判断', value: 'auto' },
      { name: 'default              使用 Claude Code 默认（可能弹出确认）', value: 'default' },
      { name: 'dontAsk              不询问', value: 'dontAsk' },
      { name: 'plan                 强制进入 plan 模式', value: 'plan' },
    ],
  }]);

  savePermissionMode(permissionMode);
  console.log(chalk.green(`  ✅ 权限模式已设置为: ${permissionMode}（已同步到 [claude] 和 [sdk]）`));
  console.log('');

  // ===== Step 3: Install hook =====
  let hookInstalled = false;
  if (!opts.skipHook) {
    console.log(chalk.cyan(`── Step 3/${totalSteps} ── 安装 Claude Code 钩子`));

    if (isHookInstalled()) {
      console.log(chalk.green('  ✅ Hook 已安装，跳过'));
      hookInstalled = true;
    } else {
      console.log(chalk.gray('  安装 SessionStart 钩子...'));
      try {
        const { hookInstall } = await import('./hook');
        hookInstall();
        hookInstalled = true;
      } catch (err) {
        console.log(chalk.red(`  ❌ Hook 安装失败: ${err}`));
        console.log(chalk.yellow('  提示：你可以稍后手动执行 cc-linker hook install'));
      }
    }
    console.log('');
  }

  // ===== Step 4: Feishu Bot setup (optional) =====
  let feishuResult: FeishuWizardResult = { configured: false, appId: '', started: false, autoStart: false };

  if (!opts.skipFeishu) {
    console.log(chalk.cyan(`── Step 4/${totalSteps} ── 配置飞书 Bot`));
    console.log('');

    const existingConfig = loadExistingConfig();
    const existingAppId = existingConfig.feishu_bot?.app_id ?? '';
    const existingAppSecret = existingConfig.feishu_bot?.app_secret ?? '';

    if (existingAppId && existingAppSecret) {
      console.log(chalk.gray('  检测到已有飞书配置:'));
      console.log(chalk.gray(`    App ID:     ${existingAppId.slice(0, 6)}****`));
      console.log(chalk.gray(`    App Secret: ${maskSecret(existingAppSecret)}`));

      const { reconfigure } = await inquirer.prompt([{
        type: 'confirm',
        name: 'reconfigure',
        message: '是否重新配置飞书 Bot？',
        default: false,
      }]);

      if (!reconfigure) {
        feishuResult = { configured: true, appId: existingAppId, started: isDaemonRunning(), autoStart: false };
        console.log(chalk.green('  ✅ 使用现有飞书配置'));
      } else {
        feishuResult = await runFeishuWizard(existingAppId, existingAppSecret);
      }
    } else {
      const { setupFeishu } = await inquirer.prompt([{
        type: 'confirm',
        name: 'setupFeishu',
        message: '是否配置飞书 Bot？（跳过则仅保留终端侧功能）',
        default: true,
      }]);

      if (setupFeishu) {
        feishuResult = await runFeishuWizard();
      } else {
        console.log(chalk.gray('  跳过飞书配置'));
      }
    }
    console.log('');
  }

  // ===== Step (last): img-proxy setup =====
  let imgProxyResult: ImgProxyWizardResult = {
    configured: false,
    installedCount: 0,
    started: false,
    autoStart: false,
    wrapperInstalled: false,
    wrapperSkipped: false,
  };

  if (!opts.skipImgProxy) {
    console.log(chalk.cyan(`── Step ${totalSteps}/${totalSteps} ── 启用图片代理 (img-proxy)`));
    console.log('');
    console.log(chalk.gray('  ℹ  img-proxy 让纯文本模型(glm-5.2/qwen/deepseek 等)也能在 Claude Code'));
    console.log(chalk.gray('     里接收粘贴的图片:把图片存成本地文件,模型收到路径文本 + 调 MCP 提示。'));
    console.log(chalk.gray('     模型需要配图片识别能力(Read 工具 / 图片识别 MCP / mmx-cli 等本地 CLI)才能"看见"。'));
    console.log('');

    try {
      imgProxyResult = await runImgProxyWizard();
    } catch (err) {
      // Best effort: img-proxy 失败不阻断 setup
      console.log(chalk.yellow(`  ⚠️ img-proxy 配置失败: ${err}`));
      console.log(chalk.gray('  提示: 可稍后手动执行 cc-linker img-proxy install/start'));
    }
    console.log('');
  }

  // ===== Summary =====
  printSummary(sessionCount, hookInstalled, feishuResult, imgProxyResult);
  process.exit(0);
}

async function runImgProxyWizard(): Promise<ImgProxyWizardResult> {
  const result: ImgProxyWizardResult = {
    configured: false,
    installedCount: 0,
    started: false,
    autoStart: false,
    wrapperInstalled: false,
    wrapperSkipped: false,
  };
  const { scanProviderFiles, hasCcSwitch } = await import('../../img-proxy/provider-scan');

  const allProviders = scanProviderFiles().filter(p => p.baseUrl);

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

  console.log(chalk.gray(`  检测到 ${allProviders.length} 个可用 provider(manual + cc-switch):`));
  for (const p of allProviders.slice(0, 8)) {
    console.log(chalk.gray(`    • ${p.alias}  ${p.baseUrl.slice(0, 60)}${p.baseUrl.length > 60 ? '...' : ''}`));
  }
  if (allProviders.length > 8) console.log(chalk.gray(`    ... 其余 ${allProviders.length - 8} 个`));
  console.log('');

  const { configure } = await inquirer.prompt([{
    type: 'confirm',
    name: 'configure',
    message: '是否启用图片代理(选要启用的 provider → 启动 daemon)?',
    default: true,
  }]);

  if (!configure) {
    console.log(chalk.gray('  跳过 img-proxy 配置'));
    return result;
  }

  // 调用 smart install：自动过滤多模态、按需提示 wrapper
  const { imgProxyInstall } = await import('./img-proxy');
  try {
    const installResult = await imgProxyInstall({});
    result.installedCount = installResult.installedCount;
    // 只在至少装上 1 个 provider 时才算 configured,避免出现
    // "✅ 已启用 (0 个 provider)" 这种自相矛盾的 summary。
    result.configured = installResult.installedCount > 0;
    result.wrapperInstalled = installResult.wrapperInstalled;
    result.wrapperSkipped = installResult.wrapperSkipped;
    // 2026-07-10: imgProxyInstall 内部已含 promptStartDaemon(同款 inquirer 引导),
    // 这里不再重复问 — 用 result.startedNow 字段。早期 wizard 自己问 startNow 调
    // imgProxyStart,跟 imgProxyInstall 内部那个会双问,用户被问两次同样的问题。
    result.started = installResult.startedNow;
    // 2026-07-10: 同上,launchd 也不重复问(P0-1 sibling)。imgProxyInstall 内部已调
    // promptLaunchdAutoStart → imgProxyDaemonInstall,result.autoStart 已返回 —
    // wizard 只透传 flag,不再触发二次 prompt / 二次 install(避免同一 plist 被
    // stop → unload → reload → 重启 + 再次健康检查,浪费 ~5s)。
    result.autoStart = installResult.autoStart;
    if (installResult.installedCount === 0) {
      console.log(chalk.yellow('  ⚠️ 0 个 provider 被安装(全部跳过 / 多模态 / 用户跳选)'));
    }
  } catch (err) {
    console.log(chalk.red(`  ❌ 安装失败: ${err}`));
    return result;
  }

  return result;
}

async function runFeishuWizard(existingAppId = '', existingAppSecret = ''): Promise<FeishuWizardResult> {
  const result: FeishuWizardResult = { configured: false, appId: '', started: false, autoStart: false };

  // Check if daemon is already running
  let skipCapture = false;
  if (isDaemonRunning()) {
    console.log(chalk.yellow('  ⚠️ 检测到 Bot 服务正在后台运行'));
    console.log(chalk.gray('   飞书 WebSocket 同一 App ID 只能有一个连接在线'));
    console.log('');

    const { action } = await inquirer.prompt([{
      type: 'list',
      name: 'action',
      message: '请选择处理方式:',
      choices: [
        { name: '停止现有服务，继续配置（推荐）', value: 'stop' },
        { name: '手动输入 owner_open_id（跳过消息捕获）', value: 'manual' },
        { name: '取消', value: 'cancel' },
      ],
      default: 'stop',
    }]);

    if (action === 'cancel') return result;
    if (action === 'stop') {
      const { stop } = await import('./start');
      await stop();
      console.log(chalk.gray('  等待飞书服务端释放连接...'));
      await new Promise(r => setTimeout(r, 3000));
      console.log(chalk.green('  ✅ 已停止现有服务'));
    } else {
      skipCapture = true;
    }
  }

  // Print permission guide before asking for credentials
  printPermissionGuide();

  // Step 1: Get app_id
  const { appId } = await inquirer.prompt([{
    type: 'input',
    name: 'appId',
    message: '飞书 App ID:',
    default: existingAppId || undefined,
    validate: (v: string) => v.trim() ? true : 'App ID 不能为空',
  }]);

  // Step 2: Get app_secret
  // Note: `default` is intentionally omitted — @inquirer/password v5+ hardcodes
  // useState('') and ignores config.default, so passing it would be misleading.
  const { appSecret } = await inquirer.prompt([{
    type: 'password',
    name: 'appSecret',
    message: existingAppSecret
      ? '飞书 App Secret（留空保持原值，或粘贴新值）:'
      : '飞书 App Secret:',
    mask: '*',
    // 允许空输入（reconfigure 路径回车保留原值）；首次配置（existingAppSecret 为空）仍必须输入
    validate: (v: string) =>
      v.trim() || existingAppSecret ? true : 'App Secret 不能为空',
  }]);
  // Reuse existing secret if user pressed Enter without typing a new one
  const resolvedAppSecret = appSecret.trim() || existingAppSecret.trim();

  // Step 3: Verify credentials
  console.log(chalk.gray('  验证凭据...'));
  const token = await getTenantToken(appId.trim(), resolvedAppSecret);
  if (!token) {
    console.log(chalk.red('  ❌ 凭据无效，请检查 App ID 和 App Secret'));
    console.log(chalk.yellow('  请确认：'));
    console.log(chalk.yellow('  1. 飞书开放平台 → 你的应用 → 凭证与基础信息'));
    console.log(chalk.yellow('  2. 确认已开启下方列出的所有必要权限'));
    process.exit(1);
  }

  const botName = await getBotName(token);
  console.log(chalk.green(`  ✅ 凭据有效${botName ? `（Bot: ${botName}）` : ''}`));
  result.appId = appId.trim();

  // Step 4: Capture open_id
  let openId: string | null = null;
  if (skipCapture) {
    const { manualId } = await inquirer.prompt([{
      type: 'input',
      name: 'manualId',
      message: '请输入 owner_open_id（在飞书发送 /whoami 可获取）:',
      validate: (v: string) => v.trim() ? true : 'open_id 不能为空',
    }]);
    openId = manualId.trim();
    console.log(chalk.green(`  ✅ owner_open_id: ${openId}`));
  } else {
    console.log(chalk.cyan('  请在飞书中给 Bot 发一条任意消息...'));
    console.log(chalk.gray('  （等待最多 120 秒）'));

    try {
      openId = await captureOpenIdSdk(appId.trim(), resolvedAppSecret);
    } catch (err) {
      console.log(chalk.yellow(`  ⚠️ 消息捕获失败: ${err}`));
    }

    if (!openId) {
      console.log(chalk.yellow('  ⚠️ 未获取到 open_id'));
      const { proceed } = await inquirer.prompt([{
        type: 'confirm',
        name: 'proceed',
        message: '是否跳过 owner_open_id 配置？（跳过后任何人都能使用此 Bot）',
        default: false,
      }]);
      if (!proceed) return result;
    } else {
      console.log(chalk.green(`  ✅ 获取到 open_id: ${openId}`));
    }
  }

  // Step 5: Save config
  const { defaultCwd } = await inquirer.prompt([{
    type: 'input',
    name: 'defaultCwd',
    message: '默认工作目录（/new 未指定路径时使用）:',
    default: process.env.HOME || '~/Git',
  }]);

  const existing = loadExistingConfig();
  existing.feishu_bot = {
    app_id: appId.trim(),
    app_secret: resolvedAppSecret,
    ...(openId ? { owner_open_id: openId } : {}),
    ...(defaultCwd.trim() ? { default_cwd: defaultCwd.trim() } : {}),
  };
  if (!existing.general) existing.general = { log_level: 'info' };
  saveConfig(existing);

  console.log(chalk.green('  ✅ 飞书配置已保存'));
  result.configured = true;
  console.log('');

  // Step 6: Start bot
  const { startNow } = await inquirer.prompt([{
    type: 'confirm',
    name: 'startNow',
    message: '是否现在启动 Bot 服务？',
    default: true,
  }]);

  if (startNow) {
    console.log(chalk.cyan('  启动 Bot 服务...'));
    const { spawnSync } = await import('child_process');
    const { join } = await import('path');

    // Detect cc-linker executable (supports compiled binary + dev mode)
    let exePath = 'cc-linker';
    const argv0 = process.argv[0];
    if (argv0.endsWith('cc-linker')) {
      exePath = argv0;
    } else {
      const distPath = join(process.cwd(), 'dist', 'cc-linker');
      if (existsSync(distPath)) exePath = distPath;
    }

    const cmdResult = spawnSync(exePath, ['start', '--daemon'], { stdio: 'inherit' });

    // Verify daemon actually started by checking PID file and process liveness
    await new Promise(r => setTimeout(r, 2000));
    const { RUNTIME_PID_FILE } = await import('../../utils/paths');
    let verified = false;
    if (existsSync(RUNTIME_PID_FILE)) {
      try {
        const pid = parseInt(readFileSync(RUNTIME_PID_FILE, 'utf8').trim(), 10);
        process.kill(pid, 0);
        verified = true;
      } catch {
        // PID file exists but process is dead
      }
    }

    result.started = cmdResult.status === 0 && verified;
    if (result.started) {
      console.log(chalk.green('  ✅ Bot 已启动'));
    } else {
      console.log(chalk.yellow('  ⚠️ 自动启动失败，请手动执行: cc-linker start --daemon'));
    }
  }

  // Step 7: Auto-start
  const { autoStart } = await inquirer.prompt([{
    type: 'confirm',
    name: 'autoStart',
    message: '是否配置开机自动启动？',
    default: true,
  }]);

  if (autoStart) {
    console.log(chalk.cyan('  配置开机自启...'));
    const { installDaemon } = await import('./daemon');
    await installDaemon();
    result.autoStart = true;
  }

  console.log('');
  return result;
}

function printPermissionGuide(): void {
  console.log(chalk.yellow('  ═══════════════════════════════════════════'));
  console.log(chalk.yellow('  📋 飞书开放平台权限配置指南'));
  console.log(chalk.yellow('  ═══════════════════════════════════════════'));
  console.log('');
  console.log(chalk.gray('  访问飞书开放平台 https://open.feishu.cn/app → 你的应用'));
  console.log('');
  console.log(chalk.cyan('  必需权限（应用自建）:'));
  console.log(chalk.green('    im:message:readonly         获取消息详情（REST 主动读取）'));
  console.log(chalk.green('    im:message.p2p_msg:readonly 接收用户发给 Bot 的单聊消息（事件推送，必装）'));
  console.log(chalk.green('    im:message                  读取、发送、撤回用户消息'));
  console.log(chalk.green('    im:message:send_as_bot      以应用身份发送消息'));
  console.log(chalk.green('    im:resource                 下载用户发送的图片资源'));
  console.log('');
  console.log(chalk.gray('  提示: im:message:readonly 是主动读取，不能触发 im.message.receive_v1 推送；'));
  console.log(chalk.gray('  缺少 im:message.p2p_msg:readonly 会导致 setup 卡 120s 抓不到 open_id。'));
  console.log('');
  console.log(chalk.cyan('  必需事件订阅（事件配置）:'));
  console.log(chalk.green('    im.message.receive_v1      接收用户发给 Bot 的消息'));
  console.log(chalk.green('    im.chat.member.bot.added_v1  Bot 被邀请进群时触发（可选）'));
  console.log(chalk.yellow('    → 订阅方式: 选择「使用 长连接 接收事件」（推荐）'));
  console.log('');
  console.log(chalk.cyan('  必需事件订阅（回调配置）:'));
  console.log(chalk.green('    card.action.trigger        接收卡片按钮点击（/list 切换会话、模型切换、SDK 权限确认等）'));
  console.log(chalk.yellow('    → 订阅方式: 选择「使用 长连接 接收回调」（推荐）'));
  console.log('');
  console.log(chalk.cyan('  必需配置:'));
  console.log(chalk.green('    ✅ 启用 Bot 能力（应用功能 → 机器人）'));
  console.log(chalk.green('    ✅ 开启 WebSocket 长连接（事件订阅 + 回调配置 两个 tab 都要选「长连接」）'));
  console.log(chalk.green('    ✅ 发布应用版本（版本管理与发布 → 创建版本）'));
  console.log('');
  console.log(chalk.yellow.bold('  ⚠️  关键提示: 配置完成后，必须在「版本管理与发布」中'));
  console.log(chalk.yellow.bold('     创建并上线一个新版本，否则所有权限都不会生效!'));
  console.log('');
}

function printSummary(sessionCount: number, hookInstalled: boolean, feishu: FeishuWizardResult, imgProxy?: ImgProxyWizardResult): void {
  console.log(chalk.green('═══════════════════════════════════════════'));
  console.log(chalk.green('  ✅ 配置完成！'));
  console.log(chalk.green('═══════════════════════════════════════════'));
  console.log('');

  console.log(chalk.gray(`  会话注册表:  ✅ 已初始化 (${sessionCount} 个会话)`));
  console.log(chalk.gray(`  Claude Code 钩子: ${hookInstalled ? '✅ 已安装' : '⏸️  未安装'}`));

  if (feishu.configured) {
    console.log(chalk.gray(`  飞书 Bot:     ✅ 已配置 (App ID: ${feishu.appId.slice(0, 6)}****)`));
    console.log(chalk.gray(`  Bot 运行:     ${feishu.started ? '✅ 运行中' : '⏸️  未启动 (cc-linker start --daemon)'}`));
  } else {
    console.log(chalk.gray('  飞书 Bot:     ⏸️  未配置（终端侧功能已就绪）'));
  }

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
  console.log('');

  console.log(chalk.cyan('  常用命令:'));
  console.log(chalk.white('    cc-linker list              — 查看会话'));
  console.log(chalk.white('    cc-linker resume <ID>       — 恢复会话到终端'));
  console.log(chalk.white('    cc-linker daemon status     — 查看 Bot 状态'));
  console.log(chalk.white('    cc-linker daemon uninstall  — 移除开机自启'));
  console.log(chalk.white('    cc-linker stop              — 停止 Bot 服务'));
  if (imgProxy?.configured) {
    console.log(chalk.white('    cc-linker img-proxy status  — 查看图片代理状态'));
    console.log(chalk.white('    cc-linker img-proxy stop    — 停止图片代理 daemon'));
  }
  console.log('');

  if (feishu.configured) {
    console.log(chalk.cyan('  飞书端可用命令:'));
    console.log(chalk.white('    /list                — 列出会话'));
    console.log(chalk.white('    /listDir             — 浏览目录'));
    console.log(chalk.white('    /new [路径] -- 提示  — 创建新会话'));
    console.log(chalk.white('    /model               — 查看/管理模型'));
    console.log(chalk.white('    /stop                — 停止当前会话处理'));
    console.log(chalk.white('    /agents              — 查看 Agent 列表'));
    console.log('');
    console.log(chalk.gray('  完整命令列表：在飞书给 Bot 发 /help'));
    console.log(chalk.gray('  💡 提示：可在飞书开放平台 → 机器人 → 自定义菜单，'));
    console.log(chalk.gray('     把 /list、/new、/agents、/help 绑到菜单上，手机端点选更方便'));
    console.log('');
  }
}
