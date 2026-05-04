import chalk from 'chalk';
import { RegistryManager } from '../../registry';
import { syncBeforeCommand } from '../../scanner';

export async function init(registry: RegistryManager): Promise<void> {
  console.log(chalk.green('✅ Created ~/.cc-bridge/registry.json'));

  console.log(chalk.blue('🔍 Scanning for existing sessions...'));
  await syncBeforeCommand(registry);

  const sessions = Object.values(registry.sessions);
  const ccConnect = sessions.filter(s => s.origin === 'cc-connect').length;
  const cli = sessions.filter(s => s.origin === 'cli').length;

  console.log(`   Found ${ccConnect} cc-connect sessions`);
  console.log(`   Found ${cli} Claude Code sessions`);
  console.log(chalk.green(`✅ Registered ${sessions.length} sessions total`));

  console.log('\nNext steps:');
  console.log('  1. Run \'cc-bridge hook install\' to install Claude Code hook');
  console.log('  2. Run \'cc-bridge list\' to view all sessions');
  console.log('  3. Run \'cc-bridge resume\' to resume a session');
}
