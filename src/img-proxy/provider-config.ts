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
}

function proxyBaseUrl(port: number, hostname: string, alias: string): string {
  return `http://${hostname}:${port}/${alias}`;
}

function isProxyUrl(url: unknown, port: number, hostname: string): boolean {
  return typeof url === 'string' && url.startsWith(`http://${hostname}:${port}/`);
}

/** 当前 BASE_URL 是否指向代理 */
export function isProviderInstalled(providerPath: string, port: number, hostname: string): boolean {
  if (!existsSync(providerPath)) return false;
  try {
    return isProxyUrl(JSON.parse(readFileSync(providerPath, 'utf8'))?.env?.ANTHROPIC_BASE_URL, port, hostname);
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

  // 幂等:已 install → 只确保路由存在,不写文件、不覆盖 .bak
  if (isProxyUrl(currentUrl, port, hostname)) {
    const upstream = readUpstreamFromBak(providerPath);
    if (!upstream) {
      // .bak 丢失时不能回退到 currentUrl(那是代理地址,会让路由自指循环)
      throw new Error(
        `${alias}: .bak 丢失,无法恢复 upstream。请先 cc-linker img-proxy uninstall --providers ${alias} 再 install`,
      );
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
  const { providerPath, alias, routesPath } = opts;
  const bakPath = providerPath + '.bak';

  // 文件不存在:只清路由
  if (!existsSync(providerPath)) {
    removeRoute(routesPath, alias);
    return;
  }

  const cfg = JSON.parse(readFileSync(providerPath, 'utf8'));
  const env = cfg.env ?? (cfg.env = {});
  const currentUrl = typeof env.ANTHROPIC_BASE_URL === 'string' ? env.ANTHROPIC_BASE_URL : '';

  // looksProxied:BASE_URL 是否形如 .../<alias>(/...|结尾)
  const looksProxied = currentUrl.includes(`/${alias}/`) || currentUrl.endsWith(`/${alias}`);

  if (looksProxied) {
    // 从 .bak 还原 BASE_URL,保留当前其它字段(如已轮换的 token)
    const restored = readUpstreamFromBak(providerPath);
    if (restored) {
      env.ANTHROPIC_BASE_URL = restored;
      const tmp = providerPath + '.tmp';
      writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
      renameSync(tmp, providerPath);
    }
  }
  // 无论 looksProxied 与否:清路由 + 删 .bak(清理代理痕迹,避免过期备份)
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