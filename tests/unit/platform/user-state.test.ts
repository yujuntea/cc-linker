import { describe, it, expect } from 'bun:test';
import type {
  PlatformMappingEntry,
  PlatformUserManager,
  ClaimPendingResult,
} from '../../../src/platform/user-state';
import type { UserManager } from '../../../src/feishu/mapping';

// 验证 PlatformUserManager 抽象基类签名匹配 feishu/mapping.ts 真实 UserManager
describe('PlatformUserManager interface contract', () => {
  it('declares all 8 methods that feishu UserManager implements', () => {
    type AssertHasMethods = PlatformUserManager extends {
      getEntry(userId: string): PlatformMappingEntry | undefined;
      getVersion(): number;
      compareAndSwap(openId: string, expected: PlatformMappingEntry | null, newValue: PlatformMappingEntry | null): Promise<boolean>;
      claimPendingNewSession(openId: string, messageId: string): Promise<ClaimPendingResult>;
      rollbackClaim(openId: string, messageId: string): Promise<boolean>;
      bindSessionToClaim(openId: string, messageId: string, sessionUuid: string, cwd: string): Promise<boolean>;
      rollbackTimedOutClaims(): Promise<number>;
      validateOwner(userId: string): boolean;
      allEntries(): Promise<Array<[string, PlatformMappingEntry]>>;
    } ? true : false;
    const assertCheck: AssertHasMethods = true;
    expect(assertCheck).toBe(true);
  });

  it('feishu UserManager satisfies PlatformUserManager contract (compile-time)', () => {
    type AssertImplements = UserManager extends PlatformUserManager ? true : false;
    const check: AssertImplements = true;
    expect(check).toBe(true);
  });

  it('PlatformMappingEntry includes agent view optional fields', () => {
    const entry: PlatformMappingEntry = {
      type: 'pending_agent_reply',
      sessionUuid: null,
      createdAt: '2026-06-19T00:00:00Z',
      shortId: 'abc123',
      startedAt: '2026-06-19T00:00:00Z',
      timeoutMs: 300000,
    };
    expect(entry.shortId).toBe('abc123');
  });
});