import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { StateCoordinator } from '../../../src/runtime/state-coordinator';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('StateCoordinator (per-platform locks v3.3)', () => {
  let tmpDir: string;
  let lockPath: string;
  let coordinator: StateCoordinator;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'state-coord-test-'));
    lockPath = join(tmpDir, 'owner.lock');
    coordinator = new StateCoordinator(lockPath);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ---------- 向后兼容：单 lock 路径注入 + 无参 tryAcquire ----------

  it('backward-compat: tryAcquire() 无参默认 feishu 平台锁', () => {
    expect(coordinator.tryAcquire()).toBe(true);
    expect(coordinator.isHeld()).toBe(true);
    // 默认路径 owner.lock 实际被改写为 owner.feishu.lock
    const feishuLockPath = join(tmpDir, 'owner.feishu.lock');
    expect(existsSync(feishuLockPath)).toBe(true);
    expect(existsSync(lockPath)).toBe(false); // 默认 owner.lock 未使用
  });

  it('backward-compat: static isLocked() 无参检查默认 owner.lock 路径', () => {
    // 写入默认 owner.lock（带当前 PID）
    writeFileSync(lockPath, JSON.stringify({
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
    }));
    expect(StateCoordinator.isLocked()).toBe(true);
  });

  it('backward-compat: static assertNotRunning() 无参检查默认 owner.lock 路径', () => {
    writeFileSync(lockPath, JSON.stringify({
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
    }));
    expect(() => StateCoordinator.assertNotRunning()).toThrow();
    try {
      StateCoordinator.assertNotRunning();
    } catch (err: any) {
      expect(err.code).toBe('E013');
    }
  });

  // ---------- 单平台：feishu ----------

  it('feishu: tryAcquire({ platforms: ["feishu"] }) 写入 owner.feishu.lock', () => {
    expect(coordinator.tryAcquire({ platforms: ['feishu'] })).toBe(true);
    const feishuLockPath = join(tmpDir, 'owner.feishu.lock');
    expect(existsSync(feishuLockPath)).toBe(true);
    const data = JSON.parse(readFileSync(feishuLockPath, 'utf8'));
    expect(data.pid).toBe(process.pid);
    expect(data.platforms).toEqual(['feishu']);
  });

  it('feishu: 第二个实例在 feishu 锁存在时无法 acquire', () => {
    coordinator.tryAcquire({ platforms: ['feishu'] });
    const other = new StateCoordinator(lockPath);
    expect(other.tryAcquire({ platforms: ['feishu'] })).toBe(false);
  });

  it('feishu: 第二个实例可以 acquire wecom 锁（跨平台互不干扰）', () => {
    coordinator.tryAcquire({ platforms: ['feishu'] });
    const other = new StateCoordinator(lockPath);
    expect(other.tryAcquire({ platforms: ['wecom'] })).toBe(true);
    expect(existsSync(join(tmpDir, 'owner.wecom.lock'))).toBe(true);
  });

  // ---------- 单平台：wecom ----------

  it('wecom: tryAcquire({ platforms: ["wecom"] }) 写入 owner.wecom.lock', () => {
    expect(coordinator.tryAcquire({ platforms: ['wecom'] })).toBe(true);
    const wecomLockPath = join(tmpDir, 'owner.wecom.lock');
    expect(existsSync(wecomLockPath)).toBe(true);
    const data = JSON.parse(readFileSync(wecomLockPath, 'utf8'));
    expect(data.platforms).toEqual(['wecom']);
  });

  it('wecom: static isLocked("wecom") 检查 owner.wecom.lock', () => {
    expect(coordinator.tryAcquire({ platforms: ['wecom'] })).toBe(true);
    expect(StateCoordinator.isLocked('wecom', lockPath)).toBe(true);
    expect(StateCoordinator.isLocked('feishu', lockPath)).toBe(false);
  });

  // ---------- 双平台：all ----------

  it('all: tryAcquire({ platforms: ["feishu","wecom"] }) 写入 owner.all.lock', () => {
    expect(coordinator.tryAcquire({ platforms: ['feishu', 'wecom'] })).toBe(true);
    const allLockPath = join(tmpDir, 'owner.all.lock');
    expect(existsSync(allLockPath)).toBe(true);
    const data = JSON.parse(readFileSync(allLockPath, 'utf8'));
    expect(data.platforms).toEqual(['feishu', 'wecom']);
  });

  it('all: 双平台锁与单平台锁互斥', () => {
    // 先以 all 启动 → 再以单平台 wecom 启动应失败
    coordinator.tryAcquire({ platforms: ['feishu', 'wecom'] });
    const other = new StateCoordinator(lockPath);
    expect(other.tryAcquire({ platforms: ['wecom'] })).toBe(false);
  });

  it('all: 单平台锁存在时，双平台 acquire 失败', () => {
    // 先以单平台 wecom 启动 → 再以 all 启动应失败（wecom 平台冲突）
    coordinator.tryAcquire({ platforms: ['wecom'] });
    const other = new StateCoordinator(lockPath);
    expect(other.tryAcquire({ platforms: ['feishu', 'wecom'] })).toBe(false);
  });

  it('all: static isLocked("feishu") 在 all 锁存在时返回 false（隔离检查）', () => {
    coordinator.tryAcquire({ platforms: ['feishu', 'wecom'] });
    // 单平台静态检查只看 owner.feishu.lock（不存在）
    expect(StateCoordinator.isLocked('feishu', lockPath)).toBe(false);
  });

  // ---------- 死进程 stale 锁清理 ----------

  it('stale lock: 死进程的 lock 文件被清理并允许 acquire', () => {
    const feishuLockPath = join(tmpDir, 'owner.feishu.lock');
    writeFileSync(feishuLockPath, JSON.stringify({
      pid: 999999999,
      acquiredAt: new Date().toISOString(),
      platforms: ['feishu'],
    }));
    expect(coordinator.tryAcquire({ platforms: ['feishu'] })).toBe(true);
  });

  // ---------- release ----------

  it('release: 释放后 lockPath 文件被删除', () => {
    coordinator.tryAcquire({ platforms: ['feishu'] });
    coordinator.release();
    expect(coordinator.isHeld()).toBe(false);
    expect(existsSync(join(tmpDir, 'owner.feishu.lock'))).toBe(false);
  });

  it('release: 未持有锁时不报错（幂等）', () => {
    expect(() => coordinator.release()).not.toThrow();
  });

  // ---------- double acquire ----------

  it('double acquire: 同一实例连续 tryAcquire 第二次返回 true', () => {
    expect(coordinator.tryAcquire({ platforms: ['feishu'] })).toBe(true);
    expect(coordinator.tryAcquire({ platforms: ['feishu'] })).toBe(true);
  });

  // ---------- 顺序: 释放后再次获取 ----------

  it('release -> re-acquire: 释放后可再次获取同一平台锁', () => {
    coordinator.tryAcquire({ platforms: ['feishu'] });
    coordinator.release();
    expect(coordinator.tryAcquire({ platforms: ['feishu'] })).toBe(true);
  });
});