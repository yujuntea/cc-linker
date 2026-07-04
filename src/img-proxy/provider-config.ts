import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } from 'fs';
import { addRoute, removeRoute } from './routes';

export interface InstallOpts {
  providerPath: string;
  alias: string;       // 文件名 stem
  routesPath: string;
  port: number;
  hostname: string;
}

export interface UninstallOpts {
  providerPath: string;
  alias: string;
  routesPath: string;
  port: number;        // 当前 config 的 port + hostname 用于严格匹配"我们装上的代理 URL"
  hostname: string;
}

function proxyBaseUrl(port: number, hostname: string, alias: string): string {
  return `http://${hostname}:${port}/${alias}`;
}

/** 严格匹配:URL 是不是当前 config (port+hostname) 装上去的代理 URL?
 *  只在"我确定是工具自己写进去的"前提下用,避免覆盖用户手动改的 BASE_URL。 */
function isCurrentProxyUrl(url: unknown, port: number, hostname: string): boolean {
  return typeof url === 'string' && url.startsWith(`http://${hostname}:${port}/`);
}

/** 宽松匹配:URL 是不是"任意 host:port 装上的代理 URL 指向同一个 alias"?
 *  用于幂等 install / uninstall 还原 —— 允许跨 port/hostname。
 *
 *  必须是 http:// (我们只装 http,不是 https) + path 以 /alias(/...) 开头。
 *  这避免了 `https://other-host/glm-5.2/api` 这种"巧合包含 /alias 段"的 URL
 *  被误判为我们的代理 URL(否则会覆盖用户手动迁移的 BASE_URL,见 Fix #1)。
 */
function isAnyProxyUrl(url: unknown, alias: string): boolean {
  if (typeof url !== 'string' || !url.startsWith('http://')) return false;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  return parsed.pathname === `/${alias}` || parsed.pathname.startsWith(`/${alias}/`);
}

/** 当前 BASE_URL 是否指向代理(严格,匹配当前 config) */
export function isProviderInstalled(providerPath: string, port: number, hostname: string): boolean {
  if (!existsSync(providerPath)) return false;
  try {
    return isCurrentProxyUrl(JSON.parse(readFileSync(providerPath, 'utf8'))?.env?.ANTHROPIC_BASE_URL, port, hostname);
  } catch {
    return false;
  }
}

export function installProvider(opts: InstallOpts): void {
  const { providerPath, alias, routesPath, port, hostname } = opts;
  if (!existsSync(providerPath)) throw new Error(`provider 文件不存在: ${providerPath}`);
  const cfg = JSON.parse(readFileSync(providerPath, 'utf8'));
  const env = cfg.env ?? (cfg.env = {});
  const currentUrl = env.ANTHROPIC_BASE_URL;

  // 三态机:
  // 1. 真幂等:currentUrl 就是当前 config 的 proxy URL → 不动文件,只确保路由存在
  //    (修过的 token / 其它字段保留)
  // 2. 跨 port/hostname 重装:currentUrl 是任一历史 proxy URL 但不是当前 config 的
  //    → 把 BASE_URL 改到当前 config 的 proxy URL,.bak 保留(不覆盖),
  //      routes upstream 仍用 .bak 里的真实上游(不写 self-loop URL)
  // 3. 首次 install:currentUrl 既不是当前也不是历史的 proxy URL → 备份 + 改写 + 路由
  const isCurrent = isCurrentProxyUrl(currentUrl, port, hostname);
  const isOldProxy = !isCurrent && isAnyProxyUrl(currentUrl, alias);

  if (isCurrent || isOldProxy) {
    const upstream = readUpstreamFromBak(providerPath);
    if (!upstream) {
      // .bak 丢失时不能回退到 currentUrl(那是代理地址,会让路由自指循环)
      throw new Error(
        `${alias}: .bak 丢失,无法恢复 upstream。请先 cc-linker img-proxy uninstall --providers ${alias} 再 install`,
      );
    }
    if (isOldProxy) {
      // 跨 port/hostname 重装:更新 BASE_URL 到当前 config 的 proxy URL,
      // .bak 不动(仍是原始 upstream)。其它字段(包括轮换过的 token)保留。
      env.ANTHROPIC_BASE_URL = proxyBaseUrl(port, hostname, alias);
      const tmp = providerPath + '.tmp';
      writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
      renameSync(tmp, providerPath);
    }
    addRoute(routesPath, alias, upstream, providerPath);
    return;
  }

  // 首次:备份(不覆盖已有 .bak)→ 改 BASE_URL → 原子写 → 加路由
  const bakPath = providerPath + '.bak';
  if (!existsSync(bakPath)) {
    writeFileSync(bakPath, readFileSync(providerPath), { mode: 0o600 });
  }
  env.ANTHROPIC_BASE_URL = proxyBaseUrl(port, hostname, alias);
  const tmp = providerPath + '.tmp';
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  renameSync(tmp, providerPath);
  addRoute(routesPath, alias, currentUrl, providerPath);
}

export function uninstallProvider(opts: UninstallOpts): void {
  const { providerPath, alias, routesPath, port, hostname } = opts;
  const bakPath = providerPath + '.bak';

  // 文件不存在:只清路由
  if (!existsSync(providerPath)) {
    removeRoute(routesPath, alias);
    return;
  }

  const cfg = JSON.parse(readFileSync(providerPath, 'utf8'));
  const env = cfg.env ?? (cfg.env = {});
  const currentUrl = typeof env.ANTHROPIC_BASE_URL === 'string' ? env.ANTHROPIC_BASE_URL : '';

  // 任意历史的 proxy URL(同 alias)就算"是我们装过的"。
  // - 严格匹配只匹配当前 config 的 port/hostname → port 改动后无法还原,用户体感差
  // - 宽松匹配让我们识别"我们装过的代理 URL"(任意 host:port),从而能 .bak 还原
  //   同时,用户手动改到非 proxy URL 的情况(如迁移到 other-host)也不会被覆盖
  //   (因为 other-host URL 不含 /<alias>/ 也不以 /<alias> 结尾)
  const isOurInstall = isAnyProxyUrl(currentUrl, alias);

  if (isOurInstall) {
    // 从 .bak 还原 BASE_URL,保留当前其它字段(如已轮换的 token)
    const restored = readUpstreamFromBak(providerPath);
    if (restored) {
      env.ANTHROPIC_BASE_URL = restored;
      const tmp = providerPath + '.tmp';
      writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
      renameSync(tmp, providerPath);
    }
  }
  // 无论 isOurInstall 与否:清路由 + 删 .bak(清理代理痕迹,避免过期备份)
  removeRoute(routesPath, alias);
  try { if (existsSync(bakPath)) unlinkSync(bakPath); } catch {}
}

function readUpstreamFromBak(providerPath: string): string | null {
  const bakPath = providerPath + '.bak';
  if (!existsSync(bakPath)) return null;
  try {
    return JSON.parse(readFileSync(bakPath, 'utf8'))?.env?.ANTHROPIC_BASE_URL ?? null;
  } catch {
    return null;
  }
}