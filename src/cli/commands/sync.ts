import chalk from 'chalk';
import { existsSync } from 'fs';
import { RegistryManager } from '../../registry';
import { syncBeforeCommand } from '../../scanner';
import { StateCoordinator } from '../../runtime/state-coordinator';

interface SyncOptions {
  scan?: boolean;
  force?: boolean;
  clean?: boolean;
}

export async function sync(registry: RegistryManager, opts: SyncOptions): Promise<void> {
  // 运行时拒绝写入
  StateCoordinator.assertNotRunning();

  console.log(chalk.blue('🔄 Syncing sessions...'));

  const beforeKeys = new Set(Object.keys(registry.sessions));

  if (opts.clean) {
    const toClean: string[] = [];
    for (const [uuid, entry] of Object.entries(registry.sessions)) {
      if (entry.jsonl_path && !existsSync(entry.jsonl_path)) {
        toClean.push(uuid);
      }
    }
    if (toClean.length > 0) {
      await registry.removeBatch(toClean);
    }
    console.log(`   Cleaned ${toClean.length} invalid sessions`);
  }

  await syncBeforeCommand(registry, undefined, undefined, false, opts.force);

  const sessions = Object.values(registry.sessions);
  const afterKeys = new Set(Object.keys(registry.sessions));
  const feishu = sessions.filter(s => s.origin === 'feishu').length;
  const cli = sessions.filter(s => s.origin === 'cli').length;

  const newSessions = [...afterKeys].filter(k => !beforeKeys.has(k)).length;
  const updatedSessions = [...afterKeys].filter(k => beforeKeys.has(k)).length;
  const removedSessions = [...beforeKeys].filter(k => !afterKeys.has(k)).length;

  console.log(`   Found ${feishu} feishu sessions, ${cli} Claude Code sessions`);
  console.log(`   New sessions registered: ${newSessions}`);
  console.log(`   Sessions updated: ${updatedSessions}`);
  if (opts.clean) console.log(`   Sessions cleaned: ${removedSessions}`);

  console.log(chalk.green(`✅ Sync complete. Total registered: ${sessions.length}`));
}
