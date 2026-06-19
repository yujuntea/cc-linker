import { writeFileSync, readFileSync, renameSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { RUNTIME_OWNER_LOCK_PATH } from '../utils/paths';
import { CCLinkerError } from '../utils/errors';
import { logger } from '../utils/logger';

/** IM 平台标识。 */
export type Platform = 'feishu' | 'wecom';

/** 单实例持有的平台集合（lock 文件 -> platform[]）。 */
const ALL_PLATFORMS: readonly Platform[] = ['feishu', 'wecom'];

/** tryAcquire 入参：声明要启动的平台。 */
export interface TryAcquireOptions {
  /** 启动的平台列表。单平台 ['feishu'] / ['wecom']；双平台 ['feishu', 'wecom']（→ owner.all.lock）。 */
  platforms: Platform[];
}

/** Owner lock 文件内容 schema。platforms 字段为可选以兼容旧 lock 文件。 */
interface LockData {
  pid: number;
  acquiredAt: string;
  /** 持有此锁的 bot 进程覆盖的平台列表（v3.3+）。 */
  platforms?: Platform[];
}

/**
 * Owner lock manager.
 *
 * v3.3 起支持按平台独立锁文件：
 *  - 单平台启动：owner.feishu.lock / owner.wecom.lock
 *  - 双平台启动：owner.all.lock（单 lock 同时声明两个平台占用）
 *
 * CLI write 命令（init / sync / clean 等）默认检查 feishu 平台锁；
 * 调用方可显式传入 platform 检查特定平台，或传入 lockPath 直接检查指定文件。
 */
export class StateCoordinator {
  private lockPath: string;
  private held = false;

  constructor(lockPath?: string) {
    this.lockPath = lockPath ?? RUNTIME_OWNER_LOCK_PATH;
  }

  /**
   * 根据平台集合计算 lock 文件路径：
   *  - platforms.length === 1 → owner.${platform}.lock
   *  - platforms.length === 2 → owner.all.lock
   *  - platforms.length === 0 → 退化到默认 owner.lock（向后兼容）
   *
   * 派生规则：保留 this.lockPath 的目录部分，文件名替换为 owner.${suffix}.lock。
   */
  private getLockPath(opts: TryAcquireOptions): string {
    if (opts.platforms.length === 0) {
      return this.lockPath;
    }
    const dir = dirname(this.lockPath);
    const suffix = opts.platforms.length === 2 ? 'all' : opts.platforms[0]!;
    return join(dir, `owner.${suffix}.lock`);
  }

  /**
   * 尝试获取 owner 锁。
   *
   * @param opts.platforms - 启动的平台列表。默认 ['feishu']（向后兼容）。
   * @returns true = 成功，false = 其他进程在跑（任一平台冲突）。
   */
  tryAcquire(opts?: TryAcquireOptions): boolean {
    if (this.held) return true;

    const platforms: Platform[] = opts?.platforms ?? ['feishu'];
    const targetLockPath = this.getLockPath({ platforms });

    // 互斥矩阵：
    //  - 双平台启动：需同时确保两个单平台锁也未被占用（防止别的进程以单平台启动
    //    owner.feishu.lock / owner.wecom.lock，然后本进程拿到 owner.all.lock 误以为独占）。
    //  - 单平台启动：需确保 owner.all.lock 也未被占用（owner.all 锁已声明本平台占用）。
    const conflictsToCheck: string[] = [];
    if (platforms.length === 2) {
      for (const p of ALL_PLATFORMS) {
        conflictsToCheck.push(this.getLockPath({ platforms: [p] }));
      }
    } else if (platforms.length === 1) {
      conflictsToCheck.push(this.getLockPath({ platforms: ['feishu', 'wecom'] }));
    }
    for (const conflictPath of conflictsToCheck) {
      if (this.checkLiveLock(conflictPath)) {
        logger.warn(`Owner lock 已被其他进程占用 (${conflictPath})`);
        return false;
      }
    }

    if (this.checkLiveLock(targetLockPath)) {
      logger.warn(`Owner lock 已被其他进程占用 (${targetLockPath})`);
      return false;
    }

    // Acquire lock
    const dir = dirname(targetLockPath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });

    const lockData: LockData = {
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      platforms,
    };
    const tmp = targetLockPath + '.tmp';
    writeFileSync(tmp, JSON.stringify(lockData, null, 2), { mode: 0o600 });
    // Atomic rename
    try {
      renameSync(tmp, targetLockPath);
    } catch {
      // Another process won the race
      return false;
    }

    // 更新实例状态：持有标志 + 实际 lock 路径
    this.held = true;
    this.lockPath = targetLockPath;
    logger.info(`Owner lock 已获取 (PID ${process.pid}, platforms: ${platforms.join('+')}, path: ${targetLockPath})`);
    return true;
  }

  /**
   * 检查指定 lockPath 是否被存活进程持有。
   *  - 文件不存在 → false
   *  - 文件解析失败或进程已死 → 清理 stale lock 并返回 false
   *  - 进程存活 → true
   */
  private checkLiveLock(lockPath: string): boolean {
    if (!existsSync(lockPath)) return false;
    try {
      const lockData = JSON.parse(readFileSync(lockPath, 'utf8')) as LockData;
      const pid = lockData.pid as number;
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        // Process dead — stale lock
        logger.info(`清理过期 owner lock (PID ${pid}, path: ${lockPath})`);
        unlinkSync(lockPath);
        return false;
      }
    } catch (err) {
      logger.warn(`解析 owner lock 失败: ${err} (path: ${lockPath})`);
      try { unlinkSync(lockPath); } catch {}
      return false;
    }
  }

  /**
   * 释放 owner 锁。释放的是 tryAcquire() 实际写入的 lockPath。
   */
  release(): void {
    if (!this.held) return;

    try {
      if (existsSync(this.lockPath)) {
        unlinkSync(this.lockPath);
      }
    } catch (err) {
      logger.warn(`释放 owner lock 失败: ${err}`);
    }

    this.held = false;
    logger.info(`Owner lock 已释放 (${this.lockPath})`);
  }

  /**
   * 检查 owner lock 是否被存活进程持有（静态方法）。
   *
   * 重载形式（向后兼容旧调用方）：
   *  - `isLocked()` → 检查默认 ~/.cc-linker/owner.lock
   *  - `isLocked(lockPath)` → 直接检查 lockPath（旧 E2E 测试用此形式）
   *  - `isLocked('feishu' | 'wecom', baseLockPath?)` → 检查对应平台锁路径
   */
  static isLocked(platformOrLockPath?: Platform | string, baseLockPath?: string): boolean {
    let path: string;

    if (platformOrLockPath === 'feishu' || platformOrLockPath === 'wecom') {
      // PR 2 v1.2.1 final (M-2): 用 dirname + basename 重组 platform-specific 路径
      // 历史: `base.replace(/owner\.lock$/, 'owner.feishu.lock')` 当 baseLockPath
      //   不以 `owner.lock` 结尾时 replace 不匹配，**返回原字符串**（fallback 失效）。
      // 修法: 永远以 dirname + `owner.${platform}.lock` 重组，与 baseLockPath 文件名解耦。
      const base = baseLockPath ?? RUNTIME_OWNER_LOCK_PATH;
      path = join(dirname(base), `owner.${platformOrLockPath}.lock`);
    } else if (typeof platformOrLockPath === 'string') {
      // 旧 API：第一个参数直接是 lockPath
      path = platformOrLockPath;
    } else {
      // 未传参数 → 默认 owner.lock
      path = RUNTIME_OWNER_LOCK_PATH;
    }

    if (!existsSync(path)) return false;

    try {
      const lockData = JSON.parse(readFileSync(path, 'utf8')) as LockData;
      const pid = lockData.pid as number;
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    } catch {
      return false;
    }
  }

  /**
   * 断言指定平台未被占用，否则抛出 E013。
   * @param platform - 不传则检查默认 owner.lock（向后兼容旧调用方）。
   */
  static assertNotRunning(platformOrLockPath?: Platform | string, baseLockPath?: string): void {
    if (StateCoordinator.isLocked(platformOrLockPath, baseLockPath)) {
      throw new CCLinkerError('E013', 'Bot 进程正在运行，请使用飞书命令操作会话，而非直接 CLI 操作');
    }
  }

  /** Check if this instance currently holds the lock */
  isHeld(): boolean {
    return this.held;
  }
}

export const stateCoordinator = new StateCoordinator();