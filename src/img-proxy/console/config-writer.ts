// src/img-proxy/console/config-writer.ts
//
// 共用 helper:把 console_enabled 的 atomic write + config.reload() 集中到一处,
// 让 console api.ts (POST /admin/api/config) 和 cli/commands/img-proxy.ts
// (img-proxy console enable|disable) 走同一个安全路径:
//   - read current config.toml
//   - guard img_proxy is a plain object (array/string 会破坏 stringify)
//   - merge { console_enabled }
//   - atomic write (.tmp + renameSync)
//   - 重新读 (config.reload()) 让运行中 daemons 的下次 get() 见到新值
//
// 失败处理:写盘失败 / parse 失败抛 Error,调用方决定返 500 还是 console.log。

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { parse, stringify } from '@iarna/toml';
import { config, DEFAULTS } from '../../utils/config';

export interface SetConsoleEnabledResult {
  /** 写回前 file 里的 console_enabled(false 表示旧文件里没有这一项,0 是默认值) */
  previous: boolean;
  /** 实际写回磁盘的值 */
  applied: boolean;
}

/** 把 ctx.configPath (must be already-expanded absolute path) 里的
 *  [img_proxy]console_enabled 设为 enabled,atomic write,触发 config.reload()。 */
export function setConsoleEnabled(configPath: string, enabled: boolean): SetConsoleEnabledResult {
  let current: any = {};
  // 文件不存在时当作空 {} (CLI 第一次 enable / 用户是全新 install 时常见)。
  // 文件存在但 parse 失败才是真错误,抛 Error 让调用方处理。
  if (existsSync(configPath)) {
    try {
      current = parse(readFileSync(configPath, 'utf8')) ?? {};
    } catch (err) {
      throw new Error(`读 config.toml 失败: ${err}`);
    }
  }

  // 之前 handlePostConfig 的 array/string guard:img_proxy 必须是 plain object,
  // 否则 spread 损坏 TOML。这里同样保护(分离后唯一 source of truth)。
  const existing = current.img_proxy;
  const baseImgProxy =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? existing
      : { ...DEFAULTS.img_proxy };
  const previous = Boolean(baseImgProxy.console_enabled);
  baseImgProxy.console_enabled = enabled;
  current.img_proxy = baseImgProxy;

  try {
    const tmp = configPath + '.tmp';
    writeFileSync(tmp, stringify(current), { mode: 0o600 });
    renameSync(tmp, configPath);
  } catch (err) {
    throw new Error(`写 config.toml 失败: ${err}`);
  }

  // 热 reload — 在 running daemon 内让 config.get('img_proxy.console_enabled')
  // 下次返回新值(对 console_enabled gate 的 hot-toggle 是必要的)。
  // CLI 调用时 daemon 还没起,reload 写进进程的 in-memory 状态无所谓
  // (daemon 重启会读 file,file 已是新值)。
  config.reload();

  return { previous, applied: enabled };
}
