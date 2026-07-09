import { existsSync, writeFileSync, readFileSync, unlinkSync } from 'fs';

/**
 * 原子写入 PID 文件 —— 用 `flag: 'wx'` (O_EXCL | O_CREAT) 防止两个进程同时写。
 * 返回 true 表示写入成功(本进程拿到 PID 文件所有权),
 * 返回 false 表示文件已存在(另一进程已抢先,本进程应放弃启动)。
 *
 * 修 Fix #4:之前用 `writeFileSync(path, data)` 配合先 `existsSync` 检查是非原子的,
 * parent + launchd KeepAlive 重启在并发窗口里两个进程都会通过检查并互相覆盖 PID。
 */
export function writePidAtomic(pidFile: string, pid: number): boolean {
  try {
    writeFileSync(pidFile, String(pid), { flag: 'wx', mode: 0o600 });
    return true;
  } catch (e: unknown) {
    if (e instanceof Error && (e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  }
}

/** 读 PID 文件里的 PID。文件不存在返回 null。 */
export function readPid(pidFile: string): number | null {
  if (!existsSync(pidFile)) return null;
  try {
    const n = parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** PID 对应的进程是否还活着。 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 删 PID 文件(忽略 ENOENT)。 */
export function clearPid(pidFile: string): void {
  try { unlinkSync(pidFile); } catch {}
}