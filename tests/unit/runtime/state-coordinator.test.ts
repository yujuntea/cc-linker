import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { StateCoordinator } from '../../../src/runtime/state-coordinator';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('StateCoordinator', () => {
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

  it('acquires lock when no existing lock', () => {
    expect(coordinator.tryAcquire()).toBe(true);
    expect(coordinator.isHeld()).toBe(true);
    expect(existsSync(lockPath)).toBe(true);
  });

  it('rejects when lock is held by live process', () => {
    // Create a lock file with current PID
    writeFileSync(lockPath, JSON.stringify({
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
    }));

    const coordinator2 = new StateCoordinator(lockPath);
    expect(coordinator2.tryAcquire()).toBe(false);
  });

  it('removes stale lock (dead process)', () => {
    // Create a lock file with a dead PID
    writeFileSync(lockPath, JSON.stringify({
      pid: 999999999, // very unlikely to exist
      acquiredAt: new Date().toISOString(),
    }));

    const result = coordinator.tryAcquire();
    expect(result).toBe(true);
    expect(coordinator.isHeld()).toBe(true);
  });

  it('releases lock and removes file', () => {
    coordinator.tryAcquire();
    coordinator.release();

    expect(coordinator.isHeld()).toBe(false);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('static isLocked returns true for live process', () => {
    coordinator.tryAcquire();
    expect(StateCoordinator.isLocked(lockPath)).toBe(true);
  });

  it('static isLocked returns false for dead process', () => {
    writeFileSync(lockPath, JSON.stringify({
      pid: 999999999,
      acquiredAt: new Date().toISOString(),
    }));
    expect(StateCoordinator.isLocked(lockPath)).toBe(false);
  });

  it('static isLocked returns false when no lock file', () => {
    expect(StateCoordinator.isLocked(lockPath)).toBe(false);
  });

  it('double acquire returns true (same instance)', () => {
    expect(coordinator.tryAcquire()).toBe(true);
    expect(coordinator.tryAcquire()).toBe(true);
  });
});
