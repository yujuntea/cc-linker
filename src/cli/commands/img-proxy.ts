import chalk from 'chalk';
import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { homedir, platform } from 'os';
import { spawnSync } from 'child_process';
import inquirer from 'inquirer';
import { config } from '../../utils/config';
import { CCLinkerError } from '../../utils/errors';
import { getExecutablePath } from '../../utils/executable';
import { readCurrentUpstreamFromSettings } from '../../img-proxy/resolve';
import {
  IMG_PROXY_DIR, IMG_PROXY_CACHE_DIR, IMG_PROXY_ROUTES_PATH,
  IMG_PROXY_PID_FILE, IMG_PROXY_LOG_FILE, CLAUDE_PROVIDERS_DIR,
  AUTO_PROVIDERS_DIR,
} from '../../utils/paths';
import { installProvider, uninstallProvider, isProviderInstalled } from '../../img-proxy/provider-config';
import { loadRoutes, removeRoute, resolveProxyByUpstream } from '../../img-proxy/routes';
import { scanProviderFiles, hasCcSwitch } from '../../img-proxy/provider-scan';
import { discoverCandidates, type Candidate } from '../../img-proxy/discover';
import { startProxyServer } from '../../img-proxy/server';
import { DEFAULT_PROMPT_TEMPLATE } from '../../img-proxy/transform';
import { writePidAtomic, readPid, isPidAlive, clearPid } from '../../utils/pid';
import { escapePlistString } from '../../utils/plist';
import {
  detectShell, getRcFilePath, isWrapperInstalled,
  installWrapper, uninstallWrapper,
} from '../../img-proxy/wrapper';
import { IMG_PROXY_WRAPPER_BACKUP_DIR } from '../../utils/paths';

// ---------- 运行状态 ----------
function isRunning(): boolean {
  const pid = readPid(IMG_PROXY_PID_FILE);
  return pid !== null && isPidAlive(pid);
}

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
    const existingPid = readPid(IMG_PROXY_PID_FILE);
    if (existingPid !== null && isPidAlive(existingPid)) {
      console.log(chalk.yellow(`⚠️  代理已在运行 (PID: ${existingPid})`));
      return;
    }
    if (existingPid !== null) {
      // stale PID 文件:上次崩溃 / kill -9 留下
      console.warn(chalk.gray(`⚠️  发现过期 PID 文件 (stale PID: ${existingPid}),清理后继续`));
      clearPid(IMG_PROXY_PID_FILE);
    }
    const { spawn } = await import('child_process');
    const child = spawn(getExecutablePath(), ['img-proxy', 'start'], {
      detached: true, stdio: 'ignore',
      env: { ...process.env, CC_LINKER_IMG_PROXY_DAEMON: '1' },
    });
    child.unref();
    // Poll PID 文件直到 child.pid 写入 — 确定性,替代 1200ms 盲目等待
    // (Fix #4:避免 parent 在 1200ms 内看着 PID 文件刚被 child 写好就以为是成功,
    //  但 child 实际是 EADDRINUSE crash 后的"碰巧 PID 文件在了但 child 已死")
    const childPid = child.pid;
    let ready = false;
    for (let i = 0; i < 50; i++) {  // 最多 5s,每 100ms 检查
      if (readPid(IMG_PROXY_PID_FILE) === childPid) { ready = true; break; }
      await new Promise(r => setTimeout(r, 100));
    }
    if (!ready) {
      console.log(chalk.red(`❌ 后台启动失败,查看日志: ${IMG_PROXY_LOG_FILE}`));
      process.exit(1);
    }
    console.log(chalk.green(`✅ img-proxy 已在后台启动 (PID: ${childPid})`));
    console.log(chalk.cyan(`   监听: http://${hostname}:${port}`));
    console.log(chalk.cyan(`   日志: ${IMG_PROXY_LOG_FILE}   停止: cc-linker img-proxy stop`));
    process.exit(0);
  }

  // 分支 2/3:child 或前台 → 起 server
  const existingPid = readPid(IMG_PROXY_PID_FILE);
  if (existingPid !== null) {
    if (isPidAlive(existingPid)) {
      console.error(chalk.yellow(`⚠️  代理已在运行 (PID: ${existingPid})`));
      process.exit(0);
    }
    // stale PID 文件 → 清理
    console.warn(chalk.gray(`⚠️  发现过期 PID 文件 (stale PID: ${existingPid}),清理后继续`));
    clearPid(IMG_PROXY_PID_FILE);
  }
  mkdirSync(dirname(IMG_PROXY_PID_FILE), { recursive: true });
  // 原子 create-only — 防止并发两个进程都通过 isRunning 检查后互相覆盖 PID
  if (!writePidAtomic(IMG_PROXY_PID_FILE, process.pid)) {
    // race:另一进程在我们 cleanup 之后抢先写了
    const winner = readPid(IMG_PROXY_PID_FILE);
    console.error(chalk.yellow(`⚠️  代理已被另一进程启动 (PID: ${winner ?? '?'},race condition)`));
    process.exit(0);
  }

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

// ---------- stop ----------
export async function imgProxyStop(): Promise<void> {
  const plistPath = launchdPlistPath();
  if (existsSync(plistPath)) { try { spawnSync('launchctl', ['stop', 'com.cclinker.img-proxy']); } catch {} }
  if (existsSync(IMG_PROXY_PID_FILE)) {
    const pid = readPid(IMG_PROXY_PID_FILE);
    if (pid === null) {
      // 文件存在但内容损坏,直接清掉
      clearPid(IMG_PROXY_PID_FILE);
    } else if (isPidAlive(pid)) {
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
      clearPid(IMG_PROXY_PID_FILE);
    } else {
      console.log(chalk.yellow(`⚠️  PID 文件指向已死的进程 (PID: ${pid}),清理`));
      clearPid(IMG_PROXY_PID_FILE);
    }
  } else {
    console.log(chalk.yellow('⚠️  img-proxy 未在运行'));
  }
  // Fix #7: plist unload 在 stop+SIGTERM 之后(daemon.ts uninstallMacOS 的顺序)
  // —— 先卸载 launchd 监督会导致 KeepAlive 在我们杀 PID 的窗口里重启一个新 child,
  //    status 报"未运行"假阴性。
  if (existsSync(plistPath)) { try { spawnSync('launchctl', ['unload', plistPath]); } catch {} }
}

// ---------- status ----------
export async function imgProxyStatus(): Promise<void> {
  console.log(chalk.blue('=== cc-linker img-proxy 状态 ===\n'));
  console.log(isRunning() ? chalk.green(`✅ 运行中 (PID: ${readPid(IMG_PROXY_PID_FILE) ?? '?'})`) : chalk.yellow('⚠️  未运行 (cc-linker img-proxy start --daemon)'));
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

// ---------- resolve ----------
// upstream 由 Commander 的 <upstream>(尖括号 = 必填)传入,这里类型就是 string
export async function imgProxyResolve(opts: { upstream: string }): Promise<void> {
  const port = config.get<number>('img_proxy.port', 8765);
  const hostname = config.get<string>('img_proxy.hostname', '127.0.0.1');
  const proxyUrl = resolveProxyByUpstream(IMG_PROXY_ROUTES_PATH, port, hostname, opts.upstream);
  if (proxyUrl) console.log(proxyUrl);
  // 空 stdout = "没找到" — wrapper 检测用
}

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

// ---------- install / uninstall ----------
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
    console.log(chalk.gray(`    • ${AUTO_PROVIDERS_DIR}/ (auto)`));
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

  if (useClassification) {
    const skippedMultimodal = candidates.length - filtered.length;
    if (skippedMultimodal > 0) {
      console.log(chalk.gray(`  ℹ  Smart 模式:跳过 ${skippedMultimodal} 个 multimodal provider (它们不需要图片代理)\n`));
    }
  }

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

  console.log(chalk.blue(`\n安装图片代理到 ${targets.length} 个 provider...\n`));
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
        wrapperInstalled = true;
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

export async function imgProxyUninstall(opts: { providers?: string; all?: boolean }): Promise<void> {
  const port = config.get<number>('img_proxy.port', 8765);
  const hostname = config.get<string>('img_proxy.hostname', '127.0.0.1');
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
      uninstallProvider({ providerPath: t.path, alias: t.alias, routesPath: IMG_PROXY_ROUTES_PATH, port, hostname });
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
  const plistPath = launchdPlistPath();

  // Fix #5: 重装前先停现有 daemon,避免 launchd KeepAlive 重启新 child 时
  // 旧进程还在 :8765 上导致 EADDRINUSE,服务静默失败
  if (existsSync(plistPath)) {
    spawnSync('launchctl', ['stop', 'com.cclinker.img-proxy']);
    const existingPid = readPid(IMG_PROXY_PID_FILE);
    if (existingPid !== null && isPidAlive(existingPid)) {
      console.log(chalk.gray(`  停止旧 daemon (PID: ${existingPid})...`));
      try {
        process.kill(existingPid, 'SIGTERM');
        for (let i = 0; i < 20; i++) {
          try { process.kill(existingPid, 0); await new Promise(r => setTimeout(r, 300)); }
          catch { break; }
        }
        try { process.kill(existingPid, 0); process.kill(existingPid, 'SIGKILL'); } catch {}
      } catch {}
    }
    spawnSync('launchctl', ['unload', plistPath]);
    clearPid(IMG_PROXY_PID_FILE);
  }

  // Fix #3: PATH / homedir / exe 等插入 XML 之前转义,防 & 等特殊字符
  // 导致 plist 损坏 + launchctl load 静默失败
  const safePath = escapePlistString(process.env.PATH ?? '');
  const safeHome = escapePlistString(homedir());
  const safeExe = escapePlistString(exe);
  const safeLog = escapePlistString(IMG_PROXY_LOG_FILE);

  // ProgramArguments 不带 --daemon,改用 env 注入 CC_LINKER_IMG_PROXY_DAEMON=1
  // → launchd 直接起 child,不双重 fork,KeepAlive 崩溃重拉的也是 child
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.cclinker.img-proxy</string>
  <key>ProgramArguments</key>
  <array>
    <string>${safeExe}</string>
    <string>img-proxy</string>
    <string>start</string>
  </array>
  <key>WorkingDirectory</key><string>${safeHome}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${safeLog}</string>
  <key>StandardErrorPath</key><string>${safeLog}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CC_LINKER_IMG_PROXY_DAEMON</key><string>1</string>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:${safePath}</string>
  </dict>
</dict>
</plist>`;
  mkdirSync(dirname(plistPath), { recursive: true });
  writeFileSync(plistPath, plist, { mode: 0o644 });

  // Fix #3: 检查 launchctl load 返回码,失败时不静默 ✅
  // 'already loaded' 是合法的(用户手启动过),其他 stderr 都报出来
  const loadResult = spawnSync('launchctl', ['load', plistPath]);
  const loadErr = loadResult.stderr.toString().trim();
  if (loadResult.status !== 0 && !loadErr.includes('already loaded')) {
    console.log(chalk.red(`❌ launchctl load 失败 (exit ${loadResult.status})`));
    console.log(chalk.yellow(`   ${loadErr}`));
    console.log(chalk.gray(`   检查 plist: ${plistPath}`));
    process.exit(1);
  }
  if (loadErr.includes('already loaded')) {
    // load 会失败因为 plist 已经在;但我们 unload 过上面的代码块 —— 这种情况
    // 只在 plist 文件被外部修改时出现,提醒一下
    console.log(chalk.gray('  (plist 已加载,启动当前 daemon 即可)'));
  }

  const startResult = spawnSync('launchctl', ['start', 'com.cclinker.img-proxy']);
  if (startResult.status !== 0) {
    const err = startResult.stderr.toString().trim();
    if (err) console.log(chalk.yellow(`⚠️ launchctl start 警告: ${err}`));
  }

  console.log(chalk.green('✅ img-proxy 开机自启已配置 (KeepAlive,崩溃 10s 内自拉起)'));
  console.log(chalk.cyan(`   ${plistPath}`));
  console.log(chalk.gray('   卸载: cc-linker img-proxy daemon uninstall'));
}

export async function imgProxyDaemonUninstall(): Promise<void> {
  if (!existsSync(launchdPlistPath())) { console.log(chalk.yellow('未配置 launchd')); return; }
  spawnSync('launchctl', ['unload', launchdPlistPath()]);
  unlinkSync(launchdPlistPath());
  console.log(chalk.green('✅ img-proxy 开机自启已卸载'));
}
