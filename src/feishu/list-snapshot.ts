import { readFileSync, openSync, writeSync, closeSync, fsyncSync, renameSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { LIST_SNAPSHOT_PATH } from '../utils/paths';
import { logger } from '../utils/logger';
import { config } from '../utils/config';

export interface ListSnapshot {
  /** OpenId -> session list entries */
  entries: ListSnapshotEntry[];
  /** When this snapshot was created */
  createdAt: string;
  /** Open ID of the user who requested this list */
  openId: string;
}

export interface ListSnapshotEntry {
  index: number;
  uuid: string;
  title: string;
}

export class ListSnapshotManager {
  private snapshotPath: string;

  constructor(snapshotPath?: string) {
    this.snapshotPath = snapshotPath ?? LIST_SNAPSHOT_PATH;
  }

  /** I5: Expose path for reconciler access */
  get path(): string {
    return this.snapshotPath;
  }

  private ensureDir(): void {
    const dir = join(this.snapshotPath, '..');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  /** Save a new list snapshot for a user */
  saveSnapshot(openId: string, entries: ListSnapshotEntry[]): void {
    this.ensureDir();

    const snapshot: ListSnapshot = {
      openId,
      entries,
      createdAt: new Date().toISOString(),
    };

    const tmp = this.snapshotPath + '.tmp';
    // M-3 (0 字节 bug 修复): writeFileSync + renameSync 在 macOS fsync 时序问题下可能留 0 字节
    //   (daemon SIGKILL 时 write 还没落盘)。改用 openSync + writeSync (sync 写)
    //   + fsyncSync (强制刷盘) + closeSync + renameSync, 确保 0 字节不出现。
    //   与 src/queue/spool.ts:586-602 writeAtomic / src/platform/user-state.ts:95-110 saveMapping 修法对称。
    const dataStr = JSON.stringify(snapshot, null, 2);
    const fd = openSync(tmp, 'w', 0o600);
    try {
      writeSync(fd, dataStr);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.snapshotPath);
  }

  /**
   * Load the most recent snapshot and check if it's still valid.
   * Returns null if no snapshot exists or it has expired.
   */
  loadSnapshot(openId?: string): ListSnapshot | null {
    if (!existsSync(this.snapshotPath)) return null;

    try {
      const raw = readFileSync(this.snapshotPath, 'utf8');
      const snapshot = JSON.parse(raw) as ListSnapshot;
      const ttlMs = Math.max(1, config.get<number>('queue.list_snapshot_ttl_minutes', 10)) * 60 * 1000;

      // Check TTL
      const age = Date.now() - new Date(snapshot.createdAt).getTime();
      if (age >= ttlMs) {
        logger.debug(`列表快照已过期 (${Math.round(age / 1000)}s)`);
        return null;
      }

      // If openId is provided, validate it matches
      if (openId && snapshot.openId !== openId) {
        return null;
      }

      return snapshot;
    } catch (err) {
      logger.warn(`列表快照解析失败: ${err}`);
      return null;
    }
  }

  /**
   * Resolve a numeric index to a session UUID from the current snapshot.
   * Returns null if snapshot is expired or index is out of range.
   */
  resolveIndex(index: number, openId?: string): string | null {
    const snapshot = this.loadSnapshot(openId);
    if (!snapshot) return null;

    const entry = snapshot.entries.find(e => e.index === index);
    return entry?.uuid ?? null;
  }

  /** Delete the current snapshot */
  clearSnapshot(): void {
    try {
      if (existsSync(this.snapshotPath)) {
        unlinkSync(this.snapshotPath);
      }
    } catch (err) {
      logger.warn(`清除列表快照失败: ${err}`);
    }
  }
}

export const listSnapshotManager = new ListSnapshotManager();
