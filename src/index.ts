#!/usr/bin/env bun
import { Command, Option } from 'commander';
import chalk from 'chalk';
import { RegistryManager } from './registry';
import { syncBeforeCommand } from './scanner';
import { handleError } from './utils/errors';
import { StateCoordinator } from './runtime/state-coordinator';
import { init } from './cli/commands/init';
import { list } from './cli/commands/list';
import { resume } from './cli/commands/resume';
import { show } from './cli/commands/show';
import { sync } from './cli/commands/sync';
import { status } from './cli/commands/status';
import { hookInstall, hookUninstall, hookStatus, hookSessionStart } from './cli/commands/hook';
import { registerSession } from './cli/commands/register';
import { exportSession } from './cli/commands/export';
import { search } from './cli/commands/search';
import { clean } from './cli/commands/clean';
import { start, stop } from './cli/commands/start';
import { initFeishu } from './cli/commands/init-feishu';
import { initWecom } from './cli/commands/init-wecom';
import { setup } from './cli/commands/setup';
import { activityHook } from './cli/commands/activity-hook';
import { installDaemon, uninstallDaemon, daemonStatus as daemonServiceStatus } from './cli/commands/daemon';
import {
  imgProxyStart, imgProxyStop, imgProxyStatus, shouldExitAfterImgProxyStart,
  imgProxyInstall, imgProxyUninstall, imgProxyUpdate,
  imgProxyDaemonInstall, imgProxyDaemonUninstall,
  imgProxyCurrentUrl,
  imgProxyResolve,
  imgProxyCcSwitchSettings,
  imgProxyWrapperInstall, imgProxyWrapperUninstall, imgProxyWrapperStatus,
  imgProxyConsoleEnable, imgProxyConsoleDisable, imgProxyConsoleStatus,
} from './cli/commands/img-proxy';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');

const program = new Command();

program
  .name('cc-linker')
  .description('手机聊天应用 ↔ Claude Code CLI 桥接工具')
  .version(version);

// Helper to run sync before command
async function withSync(fn: (registry: RegistryManager) => Promise<void>, skipSync = false) {
  const registry = new RegistryManager();
  if (!skipSync) {
    await syncBeforeCommand(registry);
  }
  await fn(registry);
}

program
  .command('init')
  .description('初始化 registry 并扫描已有会话')
  .action(() => withSync(async (registry) => {
    await init(registry);
  }, true));

program
  .command('list')
  .description('列出所有可恢复的会话')
  .option('-p, --project <name>', '按项目名过滤')
  .option('-o, --origin <type>', '按来源过滤')
  .option('-a, --active', '只显示最近 2 小时活跃的会话')
  .option('--archived', '显示 archived/corrupted 会话（默认仅显示 active）')
  .option('-f, --format <type>', '输出格式: table/json/csv', 'table')
  .option('-l, --limit <n>', '最多显示 n 条', '20')
  .option('-s, --sort <field>', '排序字段', 'last_active')
  .option('--no-sync', '跳过自动同步')
  .action((opts) => withSync(async (registry) => {
    await list(registry, opts);
  }, !opts.sync));

program
  .command('resume [target]')
  .description('恢复指定会话到 Claude Code CLI')
  .option('-s, --search <query>', '按标题搜索')
  .option('-L, --latest', '恢复最活跃的会话')
  .option('-p, --project <name>', '指定项目')
  .option('-n, --dry-run', '只显示命令，不执行')
  .option('--no-confirm', '跳过 CWD 变更提示')
  .option('--cwd <path>', '手动指定工作目录')
  .option('-f, --force', '跳过 Bot 运行冲突警告')
  .option('--no-sync', '跳过自动同步')
  .action((target, opts) => withSync(async (registry) => {
    await resume(registry, target, opts);
  }, !opts.sync));

program
  .command('show <target>')
  .description('查看会话详情')
  .option('--no-sync', '跳过自动同步')
  .action((target, opts) => withSync(async (registry) => {
    await show(registry, target);
  }, !opts.sync));

program
  .command('sync')
  .description('手动同步会话')
  .option('--scan', '只扫描，不写入 registry（dry run）')
  .option('--force', '强制刷新')
  .option('--clean', '清理无效记录')
  .action((opts) => withSync(async (registry) => {
    await sync(registry, opts);
  }));

program
  .command('status')
  .description('查看桥接工具状态')
  .option('--no-sync', '跳过自动同步')
  .action((opts) => withSync(async (registry) => {
    await status(registry);
  }, !opts.sync));

const hookCmd = program.command('hook').description('管理 Claude Code 钩子');
hookCmd.command('install').action(() => hookInstall());
hookCmd.command('uninstall').action(() => hookUninstall());
hookCmd.command('status').action(() => hookStatus());
hookCmd.command('session-start').action(() => hookSessionStart());

program
  .command('register <uuid>')
  .description('注册会话到 registry（内部命令）')
  .option('-o, --origin <type>', '来源', 'cli')
  .option('-c, --cwd <path>', '工作目录')
  .option('-n, --dry-run', '只显示将要注册的条目，不实际写入')
  .action((uuid, opts) => withSync(async (registry) => {
    await registerSession(registry, uuid, opts);
  }, true));

program
  .command('export <target>')
  .description('导出会话为 markdown/text/json')
  .option('-f, --format <type>', '输出格式: markdown/text/json', 'markdown')
  .option('-o, --output <path>', '输出文件')
  .option('--include-thinking', '包含 thinking block')
  .option('--include-tools', '包含工具调用详情')
  .option('--max-messages <n>', '最大消息数')
  .option('--no-sync', '跳过自动同步')
  .action((target, opts) => withSync(async (registry) => {
    await exportSession(registry, target, opts);
  }, !opts.sync));

program
  .command('search <query>')
  .description('搜索会话')
  .option('--in-title', '只搜索标题')
  .option('--in-content', '搜索 JSONL 内容（较慢）')
  .option('-l, --limit <n>', '最多显示 n 条', '20')
  .option('--no-sync', '跳过自动同步')
  .action((query, opts) => withSync(async (registry) => {
    await search(registry, query, opts);
  }, !opts.sync));

program
  .command('clean')
  .description('清理无效记录')
  .option('--dry-run', '预览')
  .option('--older-than <days>', '清理 N 天前的')
  .option('--no-sync', '跳过自动同步')
  .action((opts) => withSync(async (registry) => {
    await clean(registry, opts);
  }, !opts.sync));

program
  .command('start')
  .description('启动 Bot 进程（默认 feishu + wecom 并行; --platform=feishu 仅飞书; --platform=wecom 仅企微）')
  .option('-d, --daemon', '后台运行（写入 PID 文件）')
  .option('--platform <platform>', 'feishu | wecom | all (default) | both (legacy alias)', 'all')
  .action((opts) => withSync(async (registry) => {
    if (!opts.daemon) {
      StateCoordinator.assertNotRunning();
    }
    // PR 3.4: 'all' 默认让 FeishuBot + WecomBot 并行启动；
    // 'both' 保留为 PR 2 v1.2.1 命令别名（内部等价 'all'）。
    const platform = opts.platform as 'feishu' | 'wecom' | 'all' | 'both';
    await start(registry, { daemon: opts.daemon, platform });
  }, true));

program
  .command('stop')
  .description('停止后台运行的 Bot 服务')
  .action(() => stop());

program
  .command('restart')
  .description('重启 Bot 服务（先 stop 再 start --daemon）')
  .action(() => withSync(async (registry) => {
    const { restart } = await import('./cli/commands/restart');
    await restart(registry);
  }, true));

const daemonCmd = program.command('daemon').description('管理后台 Bot 服务（开机自启）');
daemonCmd.command('install').description('配置开机自动启动').action(() => installDaemon());
daemonCmd.command('uninstall').description('移除开机自动启动').action(() => uninstallDaemon());
daemonCmd.command('status').description('查看后台服务状态').action(() => daemonServiceStatus());

const imgProxyCmd = program.command('img-proxy').description('管理图片剥离代理 (让纯文本模型接受粘贴图片)');
imgProxyCmd.command('install')
  .description('把选定 provider 的 BASE_URL 改写为指向本地代理 (smart 默认,自动跳过多模态)')
  .option('-p, --providers <aliases>', '逗号分隔的 provider 文件名 stem')
  .option('--all', '全部 provider(dumb 模式)')
  .option('--yes', 'smart 默认预选,不交互')
  // Fix I-8: choices 校验 --mode 只接受 smart/dumb — Commander 在 .option() 之后
  // .choices() 在 JS 运行时有效(链上 this),但 TS 类型只在 Option 类上声明,
  // 用 addOption + Option 实例显式表达意图,同时让 TS 类型也满意
  .addOption(
    new Option('--mode <mode>', 'smart 或 dumb(显式模式,默认根据是否有 flag 自动判断)')
      .choices(['smart', 'dumb'] as const),
  )
  .action((opts) => { imgProxyInstall(opts); });
imgProxyCmd.command('uninstall')
  .description('还原 provider 的 BASE_URL')
  .option('-p, --providers <aliases>', '逗号分隔的 provider 文件名 stem')
  .option('--all', '全部已 install 的 provider')
  .action((opts) => imgProxyUninstall(opts));
imgProxyCmd.command('update')
  .description('刷新已装 provider 的 cc-switch 最新配置 (token/model/新增字段); 未装的会新装')
  .option('-p, --providers <aliases>', '逗号分隔的 provider 文件名 stem')
  .option('--all', '全部 provider')
  .option('--yes', 'smart 默认预选,不交互')
  .addOption(
    new Option('--mode <mode>', 'smart 或 dumb').choices(['smart', 'dumb'] as const),
  )
  .action((opts) => { imgProxyUpdate(opts); });
imgProxyCmd.command('start')
  .description('启动代理 (前台;加 --daemon 后台)')
  .option('-d, --daemon', '后台运行')
  .action(async (opts) => {
    // 2026-07-10: imgProxyStart 改 library 化不调 process.exit;CLI 入口自己处理。
    // 关键:必须用 shouldExitAfterImgProxyStart 决定是否 exit —— parent 分支
    // (--daemon) 返回后 parent 该退出,child/foreground 分支返回后 server 会保活,
    // 不能 process.exit 否则自杀。bug 历史:launchd 启的 child 走 child 分支,
    // 旧版 CLI binding 无脑 process.exit(0),server 起完立刻被杀,launchd 反复
    // 重启触发 throttle,daemon 永远起不来。
    try {
      await imgProxyStart(opts);
      if (shouldExitAfterImgProxyStart(opts)) process.exit(0);
    } catch (err) {
      console.error(chalk.red(`❌ ${(err as Error).message}`));
      process.exit(1);
    }
  });
imgProxyCmd.command('stop').description('停止代理').action(() => imgProxyStop());
imgProxyCmd.command('status').description('查看代理状态').action(() => imgProxyStatus());
imgProxyCmd.command('current-url').description('读 ~/.claude/settings.json 的 ANTHROPIC_BASE_URL').action(() => {
  // 2026-07-10: imgProxyCurrentUrl 改 library 化 throw 而不 process.exit(同
  // imgProxyStart / daemon install)。CLI 入口负责 process.exit — 同 sibling。
  try {
    return imgProxyCurrentUrl();
  } catch (err) {
    console.error(chalk.red(`❌ ${(err as Error).message}`));
    process.exit(1);
  }
});
imgProxyCmd.command('resolve <upstream>').description('按真实 upstream URL 查 proxy URL').action((upstream) => imgProxyResolve({ upstream }));
imgProxyCmd.command('cc-switch-settings').description('输出当前 cc-switch provider 的代理 settings 文件路径 (给 cc-linker-proxy wrapper 用)').action(() => imgProxyCcSwitchSettings());
const wrapperCmd = imgProxyCmd.command('wrapper').description('管理 shell wrapper (cc-linker-proxy)');
wrapperCmd.command('install').description('装 wrapper 到 ~/.zshrc').action(() => imgProxyWrapperInstall());
wrapperCmd.command('uninstall').description('从 ~/.zshrc 移除 wrapper').action(() => imgProxyWrapperUninstall());
wrapperCmd.command('status').description('查看 wrapper 状态').action(() => imgProxyWrapperStatus());
const imgProxyDaemonCmd = imgProxyCmd.command('daemon').description('开机自启管理 (macOS launchd)');
imgProxyDaemonCmd.command('install').description('配置开机自启').action(async () => {
  // 2026-07-10: imgProxyDaemonInstall 改 library 化 throw 而不 process.exit。
  // 之前失败时 process.exit(1) 会顺带把 setup wizard 进程杀了(同 imgProxyStart
  // 的 bug),现在 throw 让 wizard 的 try/catch 能接住。
  try {
    await imgProxyDaemonInstall();
  } catch (err) {
    console.error(chalk.red(`❌ ${(err as Error).message}`));
    process.exit(1);
  }
});
imgProxyDaemonCmd.command('uninstall').description('卸载开机自启').action(() => imgProxyDaemonUninstall());
const imgProxyConsoleCmd = imgProxyCmd.command('console').description('管理 Web Console 监控后台 (http://127.0.0.1:8765/)');
// 2026-07-10: imgProxyConsoleEnable / imgProxyConsoleDisable 改 library 化 throw
// 而不 process.exit(同 daemon install / imgProxyStart)。CLI 入口负责 process.exit —
// 跟 sibling 函数对齐。如果这里直接调,wizard 未来若 wrap 它会被 process.exit 杀掉
// (同 launchd child 自杀 bug 的源模式)。
imgProxyConsoleCmd.command('enable').description('启用 Web Console,改 [img_proxy]console_enabled=true').action(() => {
  try {
    return imgProxyConsoleEnable();
  } catch (err) {
    console.error(chalk.red(`❌ 启用失败: ${(err as Error).message}`));
    process.exit(1);
  }
});
imgProxyConsoleCmd.command('disable').description('禁用 Web Console,改 [img_proxy]console_enabled=false').action(() => {
  try {
    return imgProxyConsoleDisable();
  } catch (err) {
    console.error(chalk.red(`❌ 禁用失败: ${(err as Error).message}`));
    process.exit(1);
  }
});
imgProxyConsoleCmd.command('status').description('查看 Web Console 当前状态 + URL').action(() => imgProxyConsoleStatus());

program
  .command('setup')
  .description('一键配置向导（初始化 + 安装钩子 + 配置飞书 Bot + 启用图片代理）')
  .option('--skip-feishu', '跳过飞书 Bot 配置')
  .option('--skip-hook', '跳过 Claude Code 钩子安装')
  .option('--skip-img-proxy', '跳过图片代理 (img-proxy) 配置')
  .action((opts) => withSync(async (registry) => {
    await setup(registry, opts);
  }, true));

program
  .command('init-feishu')
  .description('交互式配置飞书集成（App ID + App Secret + Owner）')
  .action(() => initFeishu());

// PR 3.6: init-wecom 交互式配置企业微信
program
  .command('init-wecom')
  .description('交互式配置企业微信集成（Bot ID + Secret + Owner external_user_id）')
  .action(() => initWecom());

program
  .command('activity-hook')
  .description('Write activity marker (used by Claude Code hooks)')
  .option('--platform <platform>', 'cli or feishu', 'cli')
  .option('--action <action>', 'start, end, or heartbeat', 'heartbeat')
  .option('--session <uuid>', 'session UUID (default: $CLAUDE_SESSION_ID)')
  .action(activityHook);

// Parse and handle errors
program.parseAsync(process.argv).catch(handleError);
