import chalk from 'chalk';
import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { homedir, platform } from 'os';
import { spawnSync } from 'child_process';
import inquirer from 'inquirer';
import { config } from '../../utils/config';
import { CCLinkerError } from '../../utils/errors';
import { getExecutablePath } from '../../utils/executable';
import {
  IMG_PROXY_DIR, IMG_PROXY_CACHE_DIR, IMG_PROXY_ROUTES_PATH,
  IMG_PROXY_PID_FILE, IMG_PROXY_LOG_FILE,
} from '../../utils/paths';
import { installProvider, uninstallProvider, isProviderInstalled } from '../../img-proxy/provider-config';
import { loadRoutes, removeRoute } from '../../img-proxy/routes';
import { scanProviderFiles } from '../../img-proxy/provider-scan';
import { startProxyServer } from '../../img-proxy/server';
import { DEFAULT_PROMPT_TEMPLATE } from '../../img-proxy/transform';

// ---------- 运行状态 ----------
function isRunning(): boolean {
  if (!existsSync(IMG_PROXY_PID_FILE)) return false;
  try {
    process.kill(parseInt(readFileSync(IMG_PROXY_PID_FILE, 'utf8').trim(), 10), 0);
    return true;
  } catch { return false; }
}
function readPid(): number { return parseInt(readFileSync(IMG_PROXY_PID_FILE, 'utf8').trim(), 10); }

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
    if (isRunning()) {
      console.log(chalk.yellow(`⚠️  代理已在运行 (PID: ${readPid()})`));
      return;
    }
    const { spawn } = await import('child_process');
    const child = spawn(getExecutablePath(), ['img-proxy', 'start'], {
      detached: true, stdio: 'ignore',
      env: { ...process.env, CC_LINKER_IMG_PROXY_DAEMON: '1' },
    });
    child.unref();
    await new Promise(r => setTimeout(r, 1200));
    if (!existsSync(IMG_PROXY_PID_FILE)) {
      console.log(chalk.red('❌ 后台启动失败,查看日志: ' + IMG_PROXY_LOG_FILE));
      process.exit(1);
    }
    console.log(chalk.green(`✅ img-proxy 已在后台启动 (PID: ${readPid()})`));
    console.log(chalk.cyan(`   监听: http://${hostname}:${port}`));
    console.log(chalk.cyan(`   日志: ${IMG_PROXY_LOG_FILE}   停止: cc-linker img-proxy stop`));
    process.exit(0);
  }

  // 分支 2/3:child 或前台 → 起 server
  if (isRunning()) {
    console.error(chalk.yellow(`⚠️  代理已在运行 (PID: ${readPid()})`));
    process.exit(0);
  }
  mkdirSync(dirname(IMG_PROXY_PID_FILE), { recursive: true });
  writeFileSync(IMG_PROXY_PID_FILE, String(process.pid), { mode: 0o600 });

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
  if (existsSync(plistPath)) { try { spawnSync('launchctl', ['unload', plistPath]); } catch {} }
  if (existsSync(IMG_PROXY_PID_FILE)) {
    const pid = readPid();
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
    try { if (existsSync(IMG_PROXY_PID_FILE)) unlinkSync(IMG_PROXY_PID_FILE); } catch {}
  } else {
    console.log(chalk.yellow('⚠️  img-proxy 未在运行'));
  }
}

// ---------- status ----------
export async function imgProxyStatus(): Promise<void> {
  console.log(chalk.blue('=== cc-linker img-proxy 状态 ===\n'));
  console.log(isRunning() ? chalk.green(`✅ 运行中 (PID: ${readPid()})`) : chalk.yellow('⚠️  未运行 (cc-linker img-proxy start --daemon)'));
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

// ---------- install / uninstall ----------
export async function imgProxyInstall(opts: { providers?: string; all?: boolean }): Promise<void> {
  const port = config.get<number>('img_proxy.port', 8765);
  const hostname = config.get<string>('img_proxy.hostname', '127.0.0.1');
  const all = scanProviderFiles().filter(p => p.baseUrl);  // 没 BASE_URL 的跳过
  if (all.length === 0) throw new CCLinkerError('E_IMG_PROXY_NO_PROVIDERS', '未扫描到带 ANTHROPIC_BASE_URL 的 provider');

  let targets: { alias: string; path: string; baseUrl: string }[];
  if (opts.all) {
    targets = all.map(p => ({ alias: p.alias, path: p.path, baseUrl: p.baseUrl }));
  } else if (opts.providers) {
    const wanted = opts.providers.split(',').map(s => s.trim()).filter(Boolean);
    targets = wanted.map(a => {
      const p = all.find(x => x.alias === a);
      if (!p) throw new CCLinkerError('E_IMG_PROXY_UNKNOWN_ALIAS', `未找到 provider 文件 ${a}.json`);
      return { alias: p.alias, path: p.path, baseUrl: p.baseUrl };
    });
  } else {
    const choices = all.map(p => ({
      name: `${p.alias}  ${isProviderInstalled(p.path, port, hostname) ? chalk.green('(已 install)') : chalk.gray(p.baseUrl)}`,
      value: p.alias, short: p.alias,
    }));
    const { picks } = await inquirer.prompt([{ type: 'checkbox', name: 'picks', message: '选择要启用图片剥离代理的 provider (空格勾选):', choices, pageSize: 20 }]);
    if (picks.length === 0) { console.log(chalk.gray('未选择')); return; }
    targets = (picks as string[]).map(a => { const p = all.find(x => x.alias === a)!; return { alias: p.alias, path: p.path, baseUrl: p.baseUrl }; });
  }

  console.log(chalk.blue(`\n安装图片代理到 ${targets.length} 个 provider...\n`));
  let installed = 0, skipped = 0;
  for (const t of targets) {
    if (isProviderInstalled(t.path, port, hostname)) {
      console.log(chalk.gray(`  ⊘ ${t.alias}  已 install,跳过`)); skipped++; continue;
    }
    try {
      installProvider({ providerPath: t.path, alias: t.alias, routesPath: IMG_PROXY_ROUTES_PATH, port, hostname });
      console.log(chalk.green(`  ✅ ${t.alias}  ${t.baseUrl}  →  http://${hostname}:${port}/${t.alias}`));
      installed++;
    } catch (err) {
      console.log(chalk.red(`  ❌ ${t.alias}  ${err}`));
    }
  }
  console.log(chalk.green(`\n完成: ${installed} 新装, ${skipped} 已存在。启动: cc-linker img-proxy start --daemon`));
}

export async function imgProxyUninstall(opts: { providers?: string; all?: boolean }): Promise<void> {
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
      uninstallProvider({ providerPath: t.path, alias: t.alias, routesPath: IMG_PROXY_ROUTES_PATH });
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
  // ProgramArguments 不带 --daemon,改用 env 注入 CC_LINKER_IMG_PROXY_DAEMON=1
  // → launchd 直接起 child,不双重 fork,KeepAlive 崩溃重拉的也是 child
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.cclinker.img-proxy</string>
  <key>ProgramArguments</key>
  <array>
    <string>${exe}</string>
    <string>img-proxy</string>
    <string>start</string>
  </array>
  <key>WorkingDirectory</key><string>${homedir()}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${IMG_PROXY_LOG_FILE}</string>
  <key>StandardErrorPath</key><string>${IMG_PROXY_LOG_FILE}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CC_LINKER_IMG_PROXY_DAEMON</key><string>1</string>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:${process.env.PATH ?? ''}</string>
  </dict>
</dict>
</plist>`;
  mkdirSync(dirname(launchdPlistPath()), { recursive: true });
  if (existsSync(launchdPlistPath())) spawnSync('launchctl', ['unload', launchdPlistPath()]);
  writeFileSync(launchdPlistPath(), plist, { mode: 0o644 });
  spawnSync('launchctl', ['load', launchdPlistPath()]);
  spawnSync('launchctl', ['start', 'com.cclinker.img-proxy']);
  console.log(chalk.green('✅ img-proxy 开机自启已配置 (KeepAlive,崩溃 10s 内自拉起)'));
  console.log(chalk.cyan(`   ${launchdPlistPath()}`));
  console.log(chalk.gray('   卸载: cc-linker img-proxy daemon uninstall'));
}

export async function imgProxyDaemonUninstall(): Promise<void> {
  if (!existsSync(launchdPlistPath())) { console.log(chalk.yellow('未配置 launchd')); return; }
  spawnSync('launchctl', ['unload', launchdPlistPath()]);
  unlinkSync(launchdPlistPath());
  console.log(chalk.green('✅ img-proxy 开机自启已卸载'));
}
