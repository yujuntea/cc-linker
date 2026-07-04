import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { writePidAtomic, readPid, isPidAlive, clearPid } from '../../../src/utils/pid';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('utils/pid', () => {
  let pidFile: string;
  beforeEach(() => { pidFile = join(mkdtempSync(join(tmpdir(), 'pid-test-')), 'daemon.pid'); });
  afterEach(() => { rmSync(pidFile, { recursive: true, force: true }); });

  describe('writePidAtomic', () => {
    it('writes PID when file does not exist, returns true', () => {
      expect(writePidAtomic(pidFile, 12345)).toBe(true);
      expect(existsSync(pidFile)).toBe(true);
      expect(readPid(pidFile)).toBe(12345);
    });

    it('returns false (does not overwrite) when file already exists (race protection)', () => {
      // Fix #4 核心场景:进程 A 写了,进程 B 后续 wx 写应失败(不覆盖 A 的 PID)。
      expect(writePidAtomic(pidFile, 100)).toBe(true);
      expect(writePidAtomic(pidFile, 200)).toBe(false);  // 第二进程被拒
      expect(readPid(pidFile)).toBe(100);  // A 的 PID 保留
    });

    it('file mode is 0o600 (owner-only)', () => {
      writePidAtomic(pidFile, 12345);
      const stat = require('fs').statSync(pidFile);
      // mask 后 9 位: 0o600 = 384 = 0b110000000
      expect(stat.mode & 0o777).toBe(0o600);
    });
  });

  describe('readPid', () => {
    it('returns null when file missing', () => {
      expect(readPid(pidFile)).toBeNull();
    });

    it('returns null when file contains non-numeric garbage', () => {
      require('fs').writeFileSync(pidFile, 'not-a-pid');
      expect(readPid(pidFile)).toBeNull();
    });

    it('returns parsed pid when valid', () => {
      writePidAtomic(pidFile, 99999);
      expect(readPid(pidFile)).toBe(99999);
    });
  });

  describe('isPidAlive', () => {
    it('returns true for current process pid', () => {
      expect(isPidAlive(process.pid)).toBe(true);
    });

    it('returns false for a clearly-dead pid', () => {
      // pid 999999 is highly unlikely to exist; if it does, this test is flaky.
      // Bun.spawn would be safer for a guaranteed-dead pid but is overkill.
      expect(isPidAlive(999999)).toBe(false);
    });
  });

  describe('clearPid', () => {
    it('removes the file', () => {
      writePidAtomic(pidFile, 12345);
      expect(existsSync(pidFile)).toBe(true);
      clearPid(pidFile);
      expect(existsSync(pidFile)).toBe(false);
    });

    it('no-throw on missing file (idempotent cleanup)', () => {
      expect(() => clearPid(pidFile)).not.toThrow();
    });
  });
});