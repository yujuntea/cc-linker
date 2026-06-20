import chalk from 'chalk';
import { RegistryManager } from '../../registry';
import { userManager, listSnapshotManager, FeishuBot, FeishuMessageEvent, FeishuReplyFn, FeishuBotCardReplyFn, FeishuBotCardAction } from '../../feishu';
import { SpoolQueue } from '../../queue/spool';
import { StateCoordinator } from '../../runtime/state-coordinator';
import { startupReconcile } from '../../runtime/reconciler';
import { logger } from '../../utils/logger';
import { config } from '../../utils/config';
import { CCLinkerError } from '../../utils/errors';
import { ProviderManager } from '../../utils/providers';
import { ClaudeSessionManager, cleanupOrphanProcesses } from '../../proxy/session';
import { SessionActivityCache, cleanupOldActivityLogs } from '../../utils/session-activity';
import { getClaudeProcessesByCwd } from '../../utils/process-info';
import { AgentViewManager } from '../../agent-view/manager';
import type { AgentViewDeps } from '../../agent-view/manager';
import { createPatchFn } from '../../feishu/patch';
import { RUNTIME_PID_FILE, RUNTIME_LOG_FILE, expandPath } from '../../utils/paths';
import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { spawnSync } from 'child_process';
import { WecomImageHandler } from '../../wecom/image-handler';

export interface StartOptions {
  daemon?: boolean;
  noFeishu?: boolean;
  /**
   * PR 3.4: 用户传入的 --platform 标记。
   *  - 'feishu' → 仅启动飞书
   *  - 'wecom' → 仅启动企微
   *  - 'all' → 飞书 + 企微并行启动（默认）
   *  - 'both' → 兼容 PR 2 v1.2.1 旧命令别名，等同 'all'
   */
  platform?: 'feishu' | 'wecom' | 'all' | 'both';
  /**
   * PR 3.4: 已解析的 platforms 数组，由 start() 主函数填好后传给
   * startForeground / startDaemonChild。允许单个平台或两个并存。
   */
  platforms?: ('feishu' | 'wecom')[];
}

/**
 * PR 7 m-12: 启动 grace period 常量 (毫秒).
 *
 * 历史: startForeground 在创建共享 SpoolQueue / bot 前 hardcoded `await sleep(30_000)`,
 *   防止老 daemon 残留误判 (spec §3.4 grace period 设计).
 *   30_000 散在 setTimeout 调用里, 调 grace 长度要 grep 全文 + 跟 logger.info 文案
 *   同步改两处 (容易漏改 → log 文案跟实际值不一致).
 * 修法: 提常量 GRACE_PERIOD_MS = 30_000, logger.info 用同一常量拼文案.
 */
export const GRACE_PERIOD_MS = 30_000;

export async function start(registry: RegistryManager, opts: StartOptions = {}): Promise<void> {
  // PR 3.4: 在最外层就把 --platform 解析成 platforms 数组，让
  // startForeground / startDaemonChild 不需要各自重做平台路由判断。
  // 注意: 这一步必须在 daemon 判断之前，因为 daemon child 也要复用
  // platforms 字段（fork 后的进程 re-run start()，走到 startDaemonChild 分支时
  // 已经带上了 platforms，避免重复解析）。
  const platforms = resolvePlatforms(opts);
  const optsWithPlatforms: StartOptions = { ...opts, platforms };

  // Daemon child process — runs the bot with log file redirection
  if (process.env.CC_LINKER_DAEMON === '1') {
    await startDaemonChild(registry, optsWithPlatforms);
    return;
  }

  if (opts.daemon) {
    // Check for existing daemon
    if (isRunning()) {
      const pid = readPid();
      console.log(chalk.yellow(`⚠️  Bot 已在后台运行 (PID: ${pid})`));
      console.log(chalk.cyan(`   停止: cc-linker stop`));
      return;
    }
    await startDaemon();
    return;
  }

  // PR 3.4 fix: 检查每个 active platform 的锁（不是 default owner.lock）
  // PR 3.3 后飞书锁在 owner.feishu.lock，企微锁在 owner.wecom.lock
  for (const p of platforms) {
    if (StateCoordinator.isLocked(p)) {
      console.log(chalk.red(`❌ ${p} 平台 Bot 正在运行，请先执行 cc-linker stop`));
      process.exit(1);
    }
  }

  await startForeground(registry, optsWithPlatforms);
}

/**
 * PR 3.4: 把 StartOptions.platform + 配置文件组合成实际启动的平台列表。
 *
 * 规则：
 *  - 'feishu' → ['feishu']
 *  - 'wecom' → ['wecom']
 *  - 'all' / 'both' / undefined → ['feishu', 'wecom']（PR 2 行为）
 *  - 然后按配置剔除未配的平台：
 *      feishu: app_id + app_secret 必须都非空
 *      wecom: bot_id + secret 必须都非空
 *  - 全部被剔除 → throw E_CONFIG
 */
function resolvePlatforms(opts: StartOptions): ('feishu' | 'wecom')[] {
  const requested = (() => {
    const raw = opts.platform ?? 'all';
    if (raw === 'feishu') return ['feishu' as const];
    if (raw === 'wecom') return ['wecom' as const];
    if (raw === 'all' || raw === 'both') return ['feishu' as const, 'wecom' as const];
    throw new CCLinkerError('E_CONFIG', `未知的 --platform 取值: ${String(raw)}（期望 feishu / wecom / all）`);
  })();

  const enabled: ('feishu' | 'wecom')[] = [];
  for (const p of requested) {
    if (p === 'feishu') {
      const appId = config.get<string>('feishu_bot.app_id', '');
      const appSecret = config.get<string>('feishu_bot.app_secret', '');
      if (appId && appSecret) {
        enabled.push('feishu');
      } else {
        logger.warn('[start] --platform 含 feishu 但 feishu_bot.app_id/secret 未配置，跳过飞书侧');
      }
    } else if (p === 'wecom') {
      const botId = config.get<string>('wecom.bot_id', '');
      const secret = config.get<string>('wecom.secret', '');
      if (botId && secret) {
        enabled.push('wecom');
      } else {
        logger.warn('[start] --platform 含 wecom 但 wecom.bot_id/secret 未配置，跳过企微侧');
      }
    }
  }

  if (enabled.length === 0) {
    throw new CCLinkerError(
      'E_CONFIG',
      '没有任何可用平台：请在 config.toml 中至少配置 [feishu_bot] (app_id + app_secret) 或 [wecom] (bot_id + secret)',
    );
  }

  return enabled;
}

/** Check if daemon is running */
function isRunning(): boolean {
  if (!existsSync(RUNTIME_PID_FILE)) return false;
  try {
    const pid = parseInt(readFileSync(RUNTIME_PID_FILE, 'utf8').trim(), 10);
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Read PID from file */
function readPid(): number {
  return parseInt(readFileSync(RUNTIME_PID_FILE, 'utf8').trim(), 10);
}

/** Stop all cc-linker daemon processes */
export async function stop(): Promise<void> {
  let stopped = false;

  // 1. Stop launchd service if exists
  const plistPath = join(homedir(), 'Library', 'LaunchAgents', 'com.cclinker.daemon.plist');
  if (existsSync(plistPath)) {
    try {
      spawnSync('launchctl', ['unload', plistPath]);
      console.log(chalk.green('✅ launchd 服务已停止'));
      stopped = true;
    } catch {}
  }

  // 2. Stop PID file process
  if (existsSync(RUNTIME_PID_FILE)) {
    const pid = readPid();
    console.log(chalk.cyan(`正在停止 Bot (PID: ${pid})...`));

    try {
      process.kill(pid, 'SIGTERM');
      stopped = true;

      // Wait for graceful shutdown (up to 15s)
      for (let i = 0; i < 30; i++) {
        try {
          process.kill(pid, 0);
        } catch {
          console.log(chalk.green(`✅ Bot (PID: ${pid}) 已停止`));
          if (existsSync(RUNTIME_PID_FILE)) unlinkSync(RUNTIME_PID_FILE);
          break;
        }
        await new Promise(r => setTimeout(r, 500));
      }

      // Force kill if still running
      try {
        process.kill(pid, 0);
        console.log(chalk.yellow('⚠️  进程未响应，强制终止...'));
        process.kill(pid, 'SIGKILL');
        console.log(chalk.green(`✅ Bot (PID: ${pid}) 已强制停止`));
      } catch {}

      if (existsSync(RUNTIME_PID_FILE)) unlinkSync(RUNTIME_PID_FILE);
    } catch {
      console.log(chalk.yellow('⚠️  进程不存在，清理 PID 文件'));
      if (existsSync(RUNTIME_PID_FILE)) unlinkSync(RUNTIME_PID_FILE);
    }
  }

  // 3. Kill any remaining cc-linker processes
  try {
    const { execSync } = await import('child_process');
    const pids = execSync("pgrep -f 'cc-linker.*daemon' 2>/dev/null || true", { encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(Boolean);

    for (const pidStr of pids) {
      const p = parseInt(pidStr, 10);
      if (p && p !== process.pid) {
        try {
          process.kill(p, 'SIGKILL');
          console.log(chalk.yellow(`⚠️  终止残留进程 (PID: ${p})`));
          stopped = true;
        } catch {}
      }
    }
  } catch {}

  if (!stopped) {
    console.log(chalk.yellow('⚠️  Bot 未在后台运行'));
  }
}

/** Show daemon status */
export async function daemonStatus(): Promise<void> {
  if (!isRunning()) {
    console.log(chalk.yellow('Bot 未在后台运行'));
    return;
  }

  const pid = readPid();
  console.log(chalk.green(`✅ Bot 正在运行 (PID: ${pid})`));
  console.log(chalk.gray(`   日志: ${RUNTIME_LOG_FILE}`));
  console.log(chalk.gray(`   停止: cc-linker stop`));

  // Show last few log lines
  if (existsSync(RUNTIME_LOG_FILE)) {
    const log = readFileSync(RUNTIME_LOG_FILE, 'utf8');
    const lines = log.trim().split('\n').slice(-5);
    if (lines.length > 0) {
      console.log(chalk.cyan('\n最近日志:'));
      for (const line of lines) {
        console.log(chalk.gray(`   ${line}`));
      }
    }
  }
}

interface BotRuntime {
  bot: FeishuBot;
  wsClient: any;
  stateCoordinator: StateCoordinator;
  spoolQueue: SpoolQueue;
  shutdown: (signal: string) => Promise<void>;
  // PR 4.1: 共享给 WecomBot 的 ClaudeSessionManager 实例
  // 飞书 + 企微共用同一 sessionManager → 共享 session lock + claude -p 子进程
  sessionManager?: ClaudeSessionManager;
}

/**
 * Probe whether CLI process detection (via lsof) is permitted on this host.
 *
 * macOS often blocks `lsof` against other users' processes unless Full Disk
 * Access is granted to the running terminal/binary. When the probe fails we
 * fall back to marker + JSONL mtime detection only.
 *
 * Linux/other platforms: always returns true (procfs-based, no extra permissions).
 */
function probeCliProcessDetection(): boolean {
  if (process.platform !== 'darwin') return true;
  try {
    // Probe whether lsof can read our own process's cwd.
    // Using our own PID avoids the false negative that occurs when no
    // claude process is currently running (the common case on startup).
    // If lsof lacks Full Disk Access it will exit non-zero or return
    // empty output, and we fall back to marker + mtime detection.
    const result = Bun.spawnSync([
      'lsof', '-p', String(process.pid), '-a', '-d', 'cwd', '-Fn',
    ]);
    if (result.exitCode !== 0) return false;
    const output = new TextDecoder().decode(result.stdout);
    // Verify the output contains an 'n' line with a path, confirming
    // lsof actually returned usable data (not just an error header).
    return output.includes('\nn') || output.startsWith('n');
  } catch {
    return false;
  }
}

async function createBotRuntime(
  registry: RegistryManager,
  log: (level: string, msg: string) => void,
  wsLogLevel?: number,
  opts: StartOptions = {},
  /**
   * PR 3.4: 可选外部 SpoolQueue 注入。
   * startForeground / startDaemonChild 在 platforms=['feishu','wecom'] 时
   * 自己 new 一个 SpoolQueue，再同时传给 createBotRuntime 和 WecomBot，
   * 让两个 bot 共用同一份 pending/processing 状态。
   * 不传 → 内部 new 一个（向后兼容单飞书启动场景）。
   */
  externalSpoolQueue?: SpoolQueue,
): Promise<BotRuntime> {
  // Step 1: 探测 CLI 进程检测可用性（macOS 权限）
  // 前台和 daemon 模式都需要，确保运行时配置一致
  const cliDetectionOk = probeCliProcessDetection();
  if (!cliDetectionOk) {
    log('WARN', 'CLI 进程检测不可用（macOS 权限），将只使用 marker + mtime 检测');
    config.setRuntimeOverride('runtime.cli_process_detection_enabled', false);
  }

  // Step 2: 清理过期 activity 日志
  // 24 小时未更新的 sidecar 文件可以安全删除
  const cleaned = cleanupOldActivityLogs(24);
  if (cleaned > 0) {
    log('INFO', `清理过期 activity 日志: ${cleaned} 个文件`);
  }

  // PR 3.4: 共用 caller 提供的 SpoolQueue；没传则新创建一个（向后兼容旧调用方）
  const spoolQueue = externalSpoolQueue ?? new SpoolQueue();
  const stateCoordinator = new StateCoordinator();
  let replyFn: FeishuReplyFn = async () => null;
  let cardReplyFn: FeishuBotCardReplyFn = async () => null;
  let patchFn: (messageId: string, card: string) => Promise<any> = async () => null;

  const providerManager = new ProviderManager();

  try {
    await providerManager.scan();
    const count = providerManager.list().length;
    const source = providerManager.getSource();
    log('INFO', `Provider scan complete: ${count} models found (source: ${source})`);
  } catch (err) {
    log('WARN', `Provider scan failed: ${err}`);
  }

  cleanupOrphanProcesses();

  // Step 3-5 (Task 6.2): create sessionManager + activityCache, inject cache, hand the
  // same sessionManager instance to FeishuBot so it does not fall back to the
  // module-level singleton (which would be missing the cache).
  const sessionManager = new ClaudeSessionManager();
  const activityCache = new SessionActivityCache();
  sessionManager.setActivityCache(activityCache);

  if (!stateCoordinator.tryAcquire({ platforms: opts.platforms ?? ['feishu'] })) {
    log('ERROR', '获取 owner.lock 失败，可能有其他实例正在运行');
    process.exit(1);
  }

  try {
    // PR 7 Task 7.2 (M-4): 传 platform 给 startupReconcile
    // - 单平台启动 (feishu-only 或 wecom-only) → 只动自己平台的消息
    // - 双平台 (all) → 不传 platform = 处理全部 (向后兼容 PR 3 行为)
    const platformForReconcile = (opts.platforms?.length === 1)
      ? opts.platforms[0]
      : undefined;
    const result = await startupReconcile({
      registry,
      userManager,
      listSnapshotManager,
      spoolQueue,
      platform: platformForReconcile,
    });
    log('INFO', `启动协调: ${result.recoveredProcessing} 恢复, ${result.rolledBackClaims} 回滚, ${result.mergedEvents} 事件归并`);
  } catch (err) {
    log('ERROR', `启动协调失败: ${err}`);
    stateCoordinator.release();
    process.exit(1);
  }

  const appId = config.get<string>('feishu_bot.app_id', '');
  const appSecret = config.get<string>('feishu_bot.app_secret', '');
  const ownerOpenId = config.get<string>('feishu_bot.owner_open_id', '');

  if (!ownerOpenId) {
    log('WARN', '⚠️  feishu_bot.owner_open_id 未配置！任何知道 Bot 的人都可以使用，可能存在严重安全风险');
  }

  let wsClient: any = null;
  let client: any = null;

  const bot = new FeishuBot({
    userManager,
    listSnapshotManager,
    spoolQueue,
    registry,
    providerManager,
    sessionManager,
    replyFn,
    cardReplyFn,
    feishuClient: client,
  });

  // Construct AgentViewManager. runChatSDK is a placeholder — bot.setAgentView
  // rewrites it to an arrow-bound call to this bot's runChatSDK.
  // AgentViewDeps expects cardReplyFn(card: string, ...) but the bot's
  // FeishuBotCardReplyFn takes (card: Record<string, unknown>, ...); wrap
  // once so both interfaces stay satisfied without an extra JSON.parse round.
  const agentViewCardReplyFn: AgentViewDeps['cardReplyFn'] = async (card, opts) => {
    return cardReplyFn(JSON.parse(card), opts);
  };
  const agentView = new AgentViewManager({
    userManager,
    feishuClient: client,
    replyFn,
    cardReplyFn: agentViewCardReplyFn,
    patchFn,
    runChatSDK: async () => {
      throw new Error('runChatSDK should be replaced by setAgentView before first use');
    },
  });
  bot.setAgentView(agentView);
  // v2.6: 启动迁移 user-mapping 中 stale session entries 到活 fork
  // (在 restoreExpectedReplyStates 之前跑,这样恢复时拿到的就是翻译后的)
  const { migrateUserMappingSessions } = await import('../../agent-view/user-mapping-migrator');
  const migrationResult = await migrateUserMappingSessions(userManager);
  log('INFO', `user-mapping 迁移: ${migrationResult.scanned} 扫描, ${migrationResult.migrated} 已翻译到活 fork`);
  // R8 启动恢复:从 user-mapping.json 恢复 pending_agent_reply slots
  // (清掉超时的,重建未超时的 in-memory + setTimeout)
  await agentView.restoreExpectedReplyStates();

  if (!appId || !appSecret) {
    log('WARN', '飞书 App ID/Secret 未配置，跳过 WSClient 连接');
  } else {
    const larkSdk = await import('@larksuiteoapi/node-sdk');
    const { WSClient, Client, Domain, LoggerLevel, EventDispatcher } = larkSdk;
    client = new Client({
      appId,
      appSecret,
      domain: Domain.Feishu,
    });

    replyFn = async (
      text: string,
      options?: { openId?: string; requestUuid?: string },
    ): Promise<string | null> => {
      const openId = options?.openId;
      if (!openId) {
        log('WARN', `[replyFn] 缺少 openId，跳过发送`);
        return null;
      }

      try {
        const response = await client.im.v1.message.create({
          params: { receive_id_type: 'open_id' },
          data: {
            receive_id: openId,
            msg_type: 'text',
            content: JSON.stringify({ text }),
            uuid: options?.requestUuid,
          },
        });

        const messageId = response.data?.message_id;
        if (!messageId) {
          log('WARN', `[replyFn] API 返回成功但 message_id 为空: ${JSON.stringify(response)}`);
        } else {
          log('DEBUG', `[replyFn] 发送成功: message_id=${messageId}, uuid=${options?.requestUuid}`);
        }
        return messageId ?? null;
      } catch (err: any) {
        log('ERROR', `[replyFn] 发送消息失败: ${err?.message ?? err}, openId=${openId}, uuid=${options?.requestUuid}`);
        return null;
      }
    };
    bot.setReplyFn(replyFn);
    // v2.2.9 fix: 把真 replyFn 同步到 agentView.deps —— 否则 agentView 一直
    // 拿着 line 232 的 stub `async () => null`,Attach/Stop/Reply 等所有走
    // this.deps.replyFn(...) 发文本的路径全部静默无效。
    // cardReplyFn 通过 agentViewCardReplyFn 闭包按名读变量已 work,
    // patchFn 在 line 431 显式同步过,但 replyFn 漏了 —— 这里补齐。
    agentView.deps.replyFn = replyFn;

    cardReplyFn = async (
      card: Record<string, unknown>,
      options?: { openId?: string; messageId?: string },
    ): Promise<string | null> => {
      const openId = options?.openId;
      if (!openId) {
        log('WARN', `[cardReplyFn] 缺少 openId，跳过发送卡片`);
        return null;
      }

      try {
        const response = await client.im.v1.message.create({
          params: { receive_id_type: 'open_id' },
          data: {
            receive_id: openId,
            msg_type: 'interactive',
            content: JSON.stringify(card),
            uuid: options?.messageId ? `card-${options.messageId}` : undefined,
          },
        });

        const messageId = response.data?.message_id;
        if (!messageId) {
          log('WARN', `[cardReplyFn] API 返回成功但 message_id 为空: ${JSON.stringify(response)}`);
        } else {
          log('DEBUG', `[cardReplyFn] 卡片发送成功: message_id=${messageId}`);
        }
        return messageId ?? null;
      } catch (err: any) {
        log('ERROR', `[cardReplyFn] 发送卡片失败: ${err?.message ?? err}, openId=${openId}`);
        return null;
      }
    };
    bot.setCardReplyFn(cardReplyFn);

    // v2.2.20:把 patchFn 实现搬到 src/feishu/patch.ts,延迟参数化(默认 0)。
    // 历史(commit 之前):这里写死 1200ms 延迟 + env var bypass,来自 permission
    // card 路径的"避免 Feishu card action event lock"思路。但 agent-view 的
    // patchFn 也会被 6 处 handler(handleRefreshList/Peek/StopAndSend/
    // NewAndSend/BgConflictCancel/ReplyRequest)复用,1.2s 延迟让用户点 Refresh
    // 后飞书客户端 1.2s 都看不到新内容,叠加 Peek 卡缺 update_multi: true
    // (card.ts:4 已修)出现 revert 现象。Permission card 路径(在 bot.ts:663-679
    // 用自己的 setTimeout)不走这个 patchFn,保留 1200ms 路径不必要。
    // 同步把 CC_LINKER_DISABLE_PATCH_DELAY env var 移除(已无 1200ms 路径需要绕开)。
    patchFn = createPatchFn(client, log);
    // 把新的 patchFn 同步到 agentView.deps(注意:setAgentView 时已绑定 deps 对象)
    agentView.deps.patchFn = patchFn;

    bot.setFeishuClient(client);

    const eventDispatcher = new EventDispatcher({}).register({
      'im.message.receive_v1': async (data: any) => {
        try {
          const msg = data?.message;
          if (!msg) return;

          const sender = data?.sender;
          const openId = sender?.sender_id?.open_id ?? '';

          const event: FeishuMessageEvent = {
            open_id: openId,
            message_id: msg.message_id,
            content: msg.content ?? '{}',
            chat_type: msg.chat_type,
            message_type: msg.message_type,
            // PR 3.4: 提取群聊 chat_id（p2p 模式下为空）
            // feishuMessageEventToPlatform 适配器已用 event.chat_id ?? event.open_id 兜底
            chat_id: msg.chat_id,
          };

          await bot.onMessage(event);
        } catch (err) {
          log('ERROR', `处理飞书消息失败: ${err}`);
        }
      },
      'card.action.trigger': async (data: any) => {
        try {
          const openId = data?.open_id ?? data?.operator?.open_id ?? data?.event?.operator?.open_id ?? data?.callback?.open_id ?? '';
          const messageId = data?.open_message_id ?? data?.context?.open_message_id ?? data?.event?.context?.open_message_id ?? data?.callback?.message?.message_id ?? '';
          const actionValue = data?.action?.value ?? data?.event?.action?.value ?? data?.callback?.action?.value ?? {};

          // v2.2.3 fix: 总是把整个 actionValue 对象传给 handleCardAction,
          // 让它自己根据 value.type / value.tag 判断如何路由。
          // 之前的白名单 (permission/cli_force_send) 漏掉了 Agent View 这一类
          // value 携带 tag 的 action,导致 button value 被 stringify 成空 sessionId,
          // bot.handleCardAction 收到 value='' 后落到 default 分支 → "未知操作"。
          //
          // tag 提取保持兼容:permission/cli_force_send 用 value.type;
          // Agent View 和其它 button 用 value.tag。
          const isObjectValue = typeof actionValue === 'object' && actionValue !== null;
          const tag = isObjectValue
            ? ((actionValue as any).type ?? (actionValue as any).tag ?? '')
            : '';
          const sessionId = actionValue?.sessionId ?? actionValue?.value ?? '';

          const actionPayload: string | Record<string, unknown> = isObjectValue
            ? (actionValue as Record<string, unknown>)
            : sessionId;

          const action: FeishuBotCardAction = {
            open_id: openId,
            action: { tag, value: actionPayload },
            message: { message_id: messageId },
          };

          log('INFO', `[card callback] tag=${tag}, sessionId=${sessionId}, openId=${openId}, messageId=${messageId || '(empty)'}`);
          const reply = await bot.handleCardAction(action);
          const replyStr = typeof reply === 'string'
            ? reply
            : reply
              ? `OBJECT[${JSON.stringify(reply).slice(0, 200)}]`
              : 'null';
          log('INFO', `[card callback] reply=${replyStr}`);

          // If handleCardAction returns a card object, return it directly.
          // The SDK will base64-encode it and send it back via WebSocket.
          if (reply && typeof reply === 'object') {
            return reply;
          }

          // For non-permission actions, return empty response
          return { type: 'raw' as const, data: {} };
        } catch (err) {
          log('ERROR', `处理卡片回调失败: ${err}`);
          return { type: 'raw' as const, data: { code: 0 } };
        }
      },
    });

    wsClient = new WSClient({
      appId,
      appSecret,
      domain: Domain.Feishu,
      loggerLevel: wsLogLevel ?? LoggerLevel.info,
      autoReconnect: true,
      onReady: () => {
        log('INFO', '飞书 WebSocket 连接已建立');
      },
      onError: (err: Error) => {
        log('ERROR', `WSClient 错误: ${err.message}`);
      },
      onReconnecting: () => {
        log('WARN', '飞书 WebSocket 重连中...');
      },
      onReconnected: () => {
        log('INFO', '飞书 WebSocket 重连成功');
      },
    });

    wsClient.start({ eventDispatcher });
  }

  const shutdown = async (_signal: string) => {
    if (wsClient && typeof wsClient.close === 'function') {
      try { wsClient.close(); } catch {}
    }
    bot.requestStop();
    if (bot.isRunning()) {
      const deadline = Date.now() + 10_000;
      while (bot.isRunning() && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 100));
      }
    }
    stateCoordinator.release();
  };

  return { bot, wsClient, stateCoordinator, spoolQueue, shutdown, sessionManager };
}

async function startForeground(registry: RegistryManager, opts: StartOptions, parentOpts?: StartOptions): Promise<void> {
  console.log(chalk.blue('🚀 启动 cc-linker...'));

  // PR 3.4: platforms 已经在 start() 外层解析完毕，opts.platforms 必填
  const platforms = opts.platforms ?? ['feishu'];
  logger.info(`启动平台: ${platforms.join(' + ')}`);

  // Step 1 (probe) + Step 2 (cleanup) 已在 createBotRuntime 内执行
  // Step 3-5 (cache/sessionManager/bot) 也在 createBotRuntime 内执行

  // Step 6: Grace period（避免升级期间老 daemon 残留导致误判）
  // 只在 foreground 模式下执行；daemon 模式不阻塞启动
  // PR 7 m-12: 用 GRACE_PERIOD_MS 常量, 日志文案从常量派生 (单点修改, 不漏改)
  logger.info(`活跃检测 grace period: ${GRACE_PERIOD_MS / 1000} 秒`);
  await new Promise<void>(resolve => setTimeout(resolve, GRACE_PERIOD_MS));

  // PR 3.4: 双平台启动时构造一个共享 SpoolQueue，让飞书 + 企微 bot 看到同一份
  // pending/processing 状态。spoolQueue 是底层 fs 目录，每个进程只需要一个实例。
  const sharedSpoolQueue = platforms.length > 1 ? new SpoolQueue() : undefined;

  // PR 3.4: 仅在要启动飞书时才走 createBotRuntime（它会拉起 WSClient + 回复路径）
  // 单 wecom 模式不需要创建 FeishuBot，但目前 createBotRuntime 始终 new FeishuBot
  // 并跑 startupReconcile —— 这部分 IO 对 wecom-only 场景是浪费但无害。
  // 为保持最小改动，feishu-only 与 all 都走 createBotRuntime；
  // wecom-only 时也复用，让它创建但不发 WSClient。
  let bot: FeishuBot | null = null;
  let wsClient: any = null;
  let stateCoordinator: StateCoordinator | null = null;
  let shutdown: ((signal: string) => Promise<void>) | null = null;
  let spoolQueue: SpoolQueue | null = null;
  // PR 4.1: 共享 sessionManager — 飞书 + 企微 bot 共用同一 ClaudeSessionManager 实例
  // 避免重复 spawn claude -p 子进程，让双平台的 session lock 互相可见
  let sharedSessionManager: ClaudeSessionManager | null = null;

  if (platforms.includes('feishu')) {
    const runtime = await createBotRuntime(registry, (level, msg) => {
      if (level === 'ERROR') {
        console.error(chalk.red(msg));
        logger.error(msg);
      } else if (level === 'WARN') {
        console.log(chalk.yellow(msg));
        logger.warn(msg);
      } else if (level === 'DEBUG') {
        logger.debug(msg);
      } else {
        console.log(msg);
        logger.info(msg);
      }
    }, undefined, opts, sharedSpoolQueue);
    bot = runtime.bot;
    wsClient = runtime.wsClient;
    stateCoordinator = runtime.stateCoordinator;
    shutdown = runtime.shutdown;
    spoolQueue = runtime.spoolQueue;
    // PR 4.1: 取出共享 sessionManager 供 wecom 侧使用
    sharedSessionManager = runtime.sessionManager ?? null;
  } else {
    // PR 3.4: wecom-only 路径，飞书没启动。
    // 仍需要一个最小 StateCoordinator 来释放 daemon 锁；但因为不创建
    // FeishuBot，tryAcquire/release 都需要自己手动管。
    // 为避免重复造轮子（且这一路径 PR 2 未实现 daemon 集成），这里只放一个 WARN。
    logger.warn('[start] wecom-only 启动且未走 createBotRuntime: 暂不支持后台 daemon（前台 OK）');
    spoolQueue = sharedSpoolQueue ?? new SpoolQueue();
    // PR 4.1.1 修复: wecom-only 路径 new ClaudeSessionManager，让 WecomBot 走真流式
    // 历史: sharedSessionManager 在 wecom-only 路径是 null，WecomBot.handleChat
    //   走 PoC echo fallback（实测 log: 'sessionManager 未注入, 走 PoC echo 路径'）。
    // 修法: 单独 new ClaudeSessionManager，settingsPath 缺省（用 global config）
    sharedSessionManager = new ClaudeSessionManager();
  }

  console.log(chalk.green(`✅ cc-linker 已启动 (platforms: ${platforms.join('+')})`));

  // PR 3.4: WecomBot 启动分支（platforms 含 wecom 时）
  let wecomBotInstance: any = null;
  if (platforms.includes('wecom')) {
    const { WecomBot, WECOM_USER_MAPPING_PATH } = await import('../../wecom');
    const botId = config.get<string>('wecom.bot_id', '');
    const secret = config.get<string>('wecom.secret', '');
    const ownerExternalUserId = config.get<string>('wecom.owner_external_user_id', '');
    if (!botId || !secret) {
      console.log(chalk.red('❌ [wecom] bot_id 或 secret 未配置（检查 config.toml [wecom] 节）'));
    } else {
      // PR 2 v1.2.1 (C6 修复): owner 未配时启动 WARN（与飞书侧 owner_open_id 未配 WARN 对称）
      if (!ownerExternalUserId) {
        console.log(chalk.yellow('⚠️  wecom.owner_external_user_id 未配置！任何拿到 bot 凭证的人都可以使用，可能存在严重安全风险'));
        logger.warn('wecom.owner_external_user_id 未配置');
      }
      // PR 3.4: sharedSpoolQueue 注入 — 双平台共用同一份 spool 状态
      // PR 4.1: 注入 sharedSessionManager — 飞书 + 企微共用同一 ClaudeSessionManager 实例
      // PR 6 Task 6.8: 注入 imageHandler — handleChat 处理 images 数组
      // PR 6 Task 6.8: 注入 registryManager — list-refresh card action 调 listActive()
      // 注意: imageHandler / registryManager 都不在这里 new 默认值 — 显式注入
      // 跟其他可选依赖 (sessionManager) 的 "未注入则走 fallback" 风格保持一致。
      const imageHandler = new WecomImageHandler({
        cacheDir: join(expandPath('~/.cc-linker'), 'image_cache'),
      });
      wecomBotInstance = new WecomBot({
        botId,
        secret,
        userMappingPath: WECOM_USER_MAPPING_PATH,
        spoolQueue: spoolQueue ?? undefined,
        sessionManager: sharedSessionManager ?? undefined,
        imageHandler,
        registryManager: registry,
      });
      wecomBotInstance.start();
      console.log(chalk.green('✅ 企微 Bot 已启动'));
      logger.info(`企微 Bot 已启动 (bot_id=${botId})`);
    }
  }

  let shuttingDown = false;
  const gracefulShutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(chalk.yellow(`\n收到 ${signal}，优雅停机中...`));
    try { await bot?.shutdown(); } catch (err) { logger.error(`bot.shutdown() 失败: ${err}`); }
    try { await wecomBotInstance?.stop(); } catch (err) { logger.error(`wecomBot.stop() 失败: ${err}`); }
    if (shutdown) {
      try { await shutdown(signal); } catch (err) { logger.error(`shutdown 失败: ${err}`); }
    }
    logger.info('cc-linker 已停止');
    process.exit(0);
  };

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

  // PR 3.4: dispatch loop
  //  - 飞书 bot 自带内部 dispatch loop（FeishuBot.dispatch） + 2s tick
  //  - 企微 bot 自带 startDispatchLoop（PR 2 实现，2s tick）
  // 双平台并行：每个 bot 自己跑自己的 loop。这里只驱动飞书侧；
  // 企微侧由 WecomBot.start() 内部已经启动（不需要再外面包一层）。
  const dispatchLoop = async () => {
    while (!shuttingDown) {
      if (bot) {
        try { await bot.dispatch(); } catch (err) { logger.error(`bot.dispatch() 失败: ${err}`); }
      } else {
        // wecom-only 路径：没有 FeishuBot，单纯 sleep 等 SIGTERM
        await new Promise(r => setTimeout(r, 2000));
      }
      await new Promise(r => setTimeout(r, 2000));
    }
  };

  await dispatchLoop();
}

async function startDaemonChild(registry: RegistryManager, opts: StartOptions): Promise<void> {
  const pid = process.pid;

  mkdirSync(dirname(RUNTIME_PID_FILE), { recursive: true });
  writeFileSync(RUNTIME_PID_FILE, String(pid), { mode: 0o600 });

  const logStream = Bun.file(RUNTIME_LOG_FILE).writer();
  const { formatLocalTime } = await import('../../utils/logger');
  const log = (level: string, msg: string) => {
    logStream.write(`[${formatLocalTime()}] [${level}] ${msg}\n`);
  };

  console.log = (...args: any[]) => log('INFO', args.join(' '));
  console.error = (...args: any[]) => log('ERROR', args.join(' '));
  console.warn = (...args: any[]) => log('WARN', args.join(' '));
  console.debug = (...args: any[]) => log('DEBUG', args.join(' '));

  // PR 3.4: platforms 已由 start() 外层解析填入；这里直接读 + 建共享 SpoolQueue
  const platforms = opts.platforms ?? ['feishu'];
  log('INFO', `Daemon child started (PID: ${pid}, platforms: ${platforms.join('+')})`);
  process.on('SIGHUP', () => {});

  let shuttingDown = false;
  const baseShutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('INFO', `收到 ${signal}，优雅停机中...`);
    try { const sc = new StateCoordinator(); sc.release(); } catch {}
    try { if (existsSync(RUNTIME_PID_FILE)) unlinkSync(RUNTIME_PID_FILE); } catch {}
    log('INFO', 'cc-linker 已停止');
    process.exit(0);
  };

  process.on('SIGTERM', () => baseShutdown('SIGTERM'));
  process.on('SIGINT', () => baseShutdown('SIGINT'));

  // PR 3.4: 双平台 daemon 时建共享 SpoolQueue，传给 createBotRuntime + WecomBot
  const sharedSpoolQueue = platforms.length > 1 ? new SpoolQueue() : undefined;
  let bot: FeishuBot | null = null;
  let shutdown: ((signal: string) => Promise<void>) | null = null;
  let spoolQueue: SpoolQueue | null = null;
  // PR 4.1: 共享 sessionManager — 飞书 + 企微 bot 共用同一 ClaudeSessionManager 实例
  let sharedSessionManager: ClaudeSessionManager | null = null;

  if (platforms.includes('feishu')) {
    const runtime = await createBotRuntime(registry, log, undefined, opts, sharedSpoolQueue);
    bot = runtime.bot;
    shutdown = runtime.shutdown;
    spoolQueue = runtime.spoolQueue;
    sharedSessionManager = runtime.sessionManager ?? null;
  } else {
    log('WARN', '[startDaemonChild] wecom-only 启动且未走 createBotRuntime: 暂不支持后台 daemon');
    spoolQueue = sharedSpoolQueue ?? new SpoolQueue();
  }

  // PR 3.4: 企微 daemon 子进程
  let wecomBotInstance: any = null;
  if (platforms.includes('wecom')) {
    const { WecomBot, WECOM_USER_MAPPING_PATH } = await import('../../wecom');
    const botId = config.get<string>('wecom.bot_id', '');
    const secret = config.get<string>('wecom.secret', '');
    const ownerExternalUserId = config.get<string>('wecom.owner_external_user_id', '');
    if (!botId || !secret) {
      log('ERROR', '[wecom] bot_id 或 secret 未配置（检查 config.toml [wecom] 节）');
    } else {
      if (!ownerExternalUserId) {
        log('WARN', 'wecom.owner_external_user_id 未配置！任何拿到 bot 凭证的人都可以使用，可能存在严重安全风险');
      }
      wecomBotInstance = new WecomBot({
        botId,
        secret,
        userMappingPath: WECOM_USER_MAPPING_PATH,
        spoolQueue: spoolQueue ?? undefined,
        sessionManager: sharedSessionManager ?? undefined,
        imageHandler: new WecomImageHandler({
          cacheDir: join(expandPath('~/.cc-linker'), 'image_cache'),
        }),
        registryManager: registry,
      });
      wecomBotInstance.start();
      log('INFO', `企微 Bot 已启动 (bot_id=${botId})`);
    }
  }

  log('INFO', `cc-linker daemon started (platforms: ${platforms.join('+')})`);

  const daemonShutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('INFO', `收到 ${signal}，优雅停机中...`);
    try { await bot?.shutdown(); } catch (err) { log('ERROR', `bot.shutdown() 失败: ${err}`); }
    try { await wecomBotInstance?.stop(); } catch (err) { log('ERROR', `wecomBot.stop() 失败: ${err}`); }
    if (shutdown) {
      try { await shutdown(signal); } catch (err) { log('ERROR', `shutdown 失败: ${err}`); }
    }
    try { if (existsSync(RUNTIME_PID_FILE)) unlinkSync(RUNTIME_PID_FILE); } catch {}
    log('INFO', 'cc-linker 已停止');
    process.exit(0);
  };

  process.removeAllListeners('SIGTERM');
  process.removeAllListeners('SIGINT');
  process.on('SIGTERM', () => daemonShutdown('SIGTERM'));
  process.on('SIGINT', () => daemonShutdown('SIGINT'));

  const dispatchLoop = async () => {
    while (!shuttingDown) {
      if (bot) {
        try { await bot.dispatch(); } catch (err) { log('ERROR', `bot.dispatch() 失败: ${err}`); }
      } else {
        await new Promise(r => setTimeout(r, 2000));
      }
      await new Promise(r => setTimeout(r, 2000));
    }
  };

  await dispatchLoop();
}

/** Resolve the cc-linker executable path */
function getExecutablePath(): string {
  const argv0 = process.argv[0];
  // If compiled binary, argv[0] IS the binary
  if (argv0.endsWith('cc-linker')) return argv0;

  const scriptPath = process.argv[1] || '';

  // When running from a globally-installed npm package (e.g. inside
  // node_modules/cc-linker/dist/cli.js), always use the command in PATH.
  // Bun resolves symlinks, so scriptPath will be the real file path.
  if (scriptPath.includes('node_modules')) {
    return 'cc-linker';
  }

  // When running via global symlink (e.g. /usr/local/bin/cc-linker),
  // before Bun resolves it.
  if (scriptPath.endsWith('/cc-linker') || scriptPath === 'cc-linker') {
    return 'cc-linker';
  }

  // Development (bun run src/index.ts): try dist/cc-linker relative to script
  const scriptDir = dirname(scriptPath);
  const distPath = join(scriptDir, '..', 'dist', 'cc-linker');
  if (existsSync(distPath)) return distPath;

  // Fallback: assume 'cc-linker' is in PATH
  return 'cc-linker';
}

/** Parent process: spawns detached child and exits */
async function startDaemon(): Promise<void> {
  const { spawn } = await import('child_process');
  const exe = getExecutablePath();
  // For compiled binaries, argv[1] is the internal script path (/$bunfs/root/cc-linker),
  // not a CLI argument. Use slice(2) to get actual CLI args.
  const args = process.argv.slice(2);
  const child = spawn(exe, args, {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, CC_LINKER_DAEMON: '1' },
  });
  child.unref();

  // Wait briefly for PID file
  await new Promise(r => setTimeout(r, 1500));

  if (!existsSync(RUNTIME_PID_FILE)) {
    console.log(chalk.red('❌ 后台启动失败'));
    process.exit(1);
  }

  const pid = readPid();
  console.log(chalk.green(`✅ cc-linker 已在后台启动 (PID: ${pid})`));
  console.log(chalk.cyan(`   日志: ${RUNTIME_LOG_FILE}`));
  console.log(chalk.cyan(`   停止: cc-linker stop`));
  console.log(chalk.cyan(`   状态: cc-linker daemon status`));
  process.exit(0);
}
