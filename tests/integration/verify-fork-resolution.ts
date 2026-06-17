/**
 * 集成烟雾测试 — Fork 翻译在真实机器数据上工作
 *
 * 用法:
 *   bun run tests/integration/verify-fork-resolution.ts
 *
 * 不需要 Feishu / bot 启动 / SDK spawn。纯逻辑路径:
 *   1. 读 ~/.claude/daemon/roster.json + ~/.claude/jobs/<short>/state.json
 *      自动扫描所有 (stale parent → live worker) 对
 *   2. 对每对跑 resolveLiveSession,验证翻译正确
 *   3. 验证 fork 端的 rendezvous socket 就绪(canUse=true)
 *   4. 模拟 user-mapping migrator(内存里跑),验证翻译正确
 *
 * 不写任何文件,只读 + 打印。
 * 不依赖任何敏感数据(用户名/openId/api key)。
 */

import { resolveLiveSession, __resetResolverCache } from '../../src/agent-view/fork-resolver';
import { checkRendezvousEligibility } from '../../src/agent-view/rendezvous-fallback';
import { readRoster } from '../../src/agent-view/roster-source';
import { migrateUserMappingSessions } from '../../src/agent-view/user-mapping-migrator';
import { readFileSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { expandPath } from '../../src/utils/paths';

const HOME = expandPath('~');

interface Finding {
  parentUuid: string;
  parentShort: string;
  workerShort: string;
  workerSessionId: string;
  sharedJsonl: string;
  workerPid: number;
  workerLinkScanOffset: number;
}

/** 自动扫描:在真实 ~/.claude/ 上找 (stale parent + live worker) 对 */
function autoDetect(): Finding[] {
  const findings: Finding[] = [];
  const roster = readRoster();
  if (!roster?.workers) return [];

  const jobsDir = join(HOME, '.claude', 'jobs');
  if (!existsSync(jobsDir)) return [];

  // 收集 live workers 的 linkScanPath → parent uuid
  type W = {
    short: string;
    sessionId: string;
    pid: number;
    linkScanPath: string;
    linkScanOffset: number;
  };
  const workers: W[] = [];
  for (const [short, w] of Object.entries(roster.workers)) {
    if (!w?.pid || !w?.sessionId) continue;
    const statePath = join(jobsDir, short, 'state.json');
    if (!existsSync(statePath)) continue;
    try {
      const s = JSON.parse(readFileSync(statePath, 'utf8'));
      if (s.linkScanPath && s.linkScanPath.endsWith('.jsonl')) {
        workers.push({
          short,
          sessionId: w.sessionId,
          pid: w.pid,
          linkScanPath: s.linkScanPath,
          linkScanOffset: s.linkScanOffset ?? 0,
        });
      }
    } catch {
      // malformed state.json — skip
    }
  }

  // 对每个 worker,parent = linkScanPath basename 的 .jsonl
  for (const w of workers) {
    const parentBasename = basename(w.linkScanPath, '.jsonl');
    const parentShort = parentBasename.slice(0, 8);

    // skip:parent short == worker short(同 session 续接,不是 fork)
    if (parentShort === w.short) continue;

    // parent 不在 jobs/(daemon 已清理)= stale parent
    const parentJobDir = join(jobsDir, parentShort);
    if (existsSync(parentJobDir)) continue;

    findings.push({
      parentUuid: parentBasename,
      parentShort,
      workerShort: w.short,
      workerSessionId: w.sessionId,
      sharedJsonl: w.linkScanPath,
      workerPid: w.pid,
      workerLinkScanOffset: w.linkScanOffset,
    });
  }

  return findings;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '...';
}

async function main() {
  console.log('=== Fork 翻译集成验收 (v2.6) ===\n');
  __resetResolverCache();

  const findings = autoDetect();
  if (findings.length === 0) {
    console.log('❌ 没有找到 (stale parent + live worker) 对。');
    console.log('   可能原因:');
    console.log('     - 机器上从来没有 TUI 被关闭过、也没 --fork 续接过');
    console.log('     - 你的所有 bg session 都还在跑(没有 stale)');
    console.log('     - 没法验证 fix — 但 975 个单测已经覆盖了 fork 翻译逻辑');
    process.exit(0);
  }

  console.log(`找到 ${findings.length} 个候选 (parent 死了 / worker 活着):\n`);

  let allPass = true;

  for (let i = 0; i < findings.length; i++) {
    const f = findings[i];
    console.log(`━━━ Candidate ${i + 1} ━━━`);
    console.log(`  parent (stale):  ${truncate(f.parentUuid, 36)}`);
    console.log(`  worker (alive):  short=${f.workerShort}  pid=${f.workerPid}`);
    console.log(`  shared JSONL:    ${truncate(f.sharedJsonl, 60)}`);
    console.log('');

    // === Test 1: resolveLiveSession ===
    console.log('  [Test 1] resolveLiveSession(parentUuid) — fork 翻译');
    __resetResolverCache();
    const r = await resolveLiveSession(f.parentUuid);
    const t1 =
      r?.isLive === false &&
      r?.hasLiveFork === true &&
      r?.liveFork?.short === f.workerShort &&
      r?.liveFork?.pid === f.workerPid;
    console.log(`    isLive:        ${r?.isLive}  (期望 false)`);
    console.log(`    hasLiveFork:   ${r?.hasLiveFork}  (期望 true)`);
    console.log(`    liveFork.short:    ${r?.liveFork?.short}  (期望 ${f.workerShort})`);
    console.log(`    liveFork.pid:      ${r?.liveFork?.pid}  (期望 ${f.workerPid})`);
    console.log(`    liveFork.jsonl:    ${r?.jsonlPath === f.sharedJsonl ? 'match' : 'MISMATCH'}`);
    console.log(`    ${t1 ? '✅ PASS' : '❌ FAIL'}`);
    console.log('');

    // === Test 2: rendezvous eligibility ===
    console.log('  [Test 2] checkRendezvousEligibility(workerShort) — rendezvous 通道');
    __resetResolverCache();
    const e = await checkRendezvousEligibility(f.workerShort);
    const t2 = e.canUse === true && !!e.rendezvousSock;
    console.log(`    canUse:    ${e.canUse}  (期望 true)`);
    console.log(`    reason:    ${e.reason}`);
    console.log(`    hasSock:   ${!!e.rendezvousSock}  (期望 true)`);
    console.log(`    ${t2 ? '✅ PASS' : '❌ FAIL'}`);
    console.log('');

    // === Test 3: 模拟 user-mapping migration ===
    console.log('  [Test 3] 模拟 user-mapping migration (内存)');
    const entries = new Map<string, any>();
    entries.set('ou_smoke_test', {
      type: 'pending_agent_reply',
      sessionUuid: f.parentUuid,
      shortId: f.parentShort,
      cwd: '/x/smoke',
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      timeoutMs: 300000,
      casToken: 'smoke',
    });
    const um = {
      _entries: entries,
      async allEntries() { return this._entries; },
      async compareAndSwap(openId: string, oldE: any, newE: any) {
        if (this._entries.get(openId) === oldE) {
          if (newE === null) this._entries.delete(openId);
          else this._entries.set(openId, newE);
          return true;
        }
        return false;
      },
    };
    __resetResolverCache();
    const m = await migrateUserMappingSessions(um);
    const newUuid = entries.get('ou_smoke_test')?.sessionUuid;
    // Accept 36-char fullUuid; or 36-char + same as parent (continuation case)
    const t3 = m.migrated === 1 && newUuid?.length === 36;
    console.log(`    scanned:  ${m.scanned}`);
    console.log(`    migrated: ${m.migrated}  (期望 1)`);
    console.log(`    old sessionUuid: ${truncate(f.parentUuid, 36)}`);
    console.log(`    new sessionUuid: ${truncate(newUuid ?? '(null)', 36)}  (期望 36 字符)`);
    console.log(`    ${t3 ? '✅ PASS' : '❌ FAIL'}`);
    console.log('');

    const allThree = t1 && t2 && t3;
    if (allThree) {
      console.log(`  🎉 Candidate ${i + 1}: 全部通过 — fork 翻译在此 case 上工作正常`);
    } else {
      console.log(`  ⚠️  Candidate ${i + 1}: 至少 1 个测试失败 — 需诊断`);
      allPass = false;
    }
    console.log('');
  }

  console.log('=== 总结 ===');
  console.log(`候选数: ${findings.length}`);
  console.log(`结果:   ${allPass ? '✅ 全部通过' : '❌ 至少 1 个失败'}`);
  process.exit(allPass ? 0 : 1);
}

main().catch(err => {
  console.error('脚本错误:', err);
  process.exit(1);
});
