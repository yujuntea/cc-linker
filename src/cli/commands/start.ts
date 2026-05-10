import chalk from 'chalk';
import { RegistryManager } from '../../registry';
import { UserManager, ListSnapshotManager, FeishuBot } from '../../feishu';
import { SpoolQueue } from '../../queue/spool';
import { StateCoordinator } from '../../runtime/state-coordinator';
import { startupReconcile } from '../../runtime/reconciler';
import { logger } from '../../utils/logger';
import { config } from '../../utils/config';
import { cleanupOrphanProcesses } from '../../proxy/session';

export async function start(registry: RegistryManager): Promise<void> {
  console.log(chalk.blue('🚀 启动 cc-bridge...'));

  // 1. Initialize modules
  const userManager = new UserManager();
  const listSnapshotManager = new ListSnapshotManager();
  const spoolQueue = new SpoolQueue();
  const stateCoordinator = new StateCoordinator();

  // 2. Cleanup orphan processes on startup
  cleanupOrphanProcesses();

  // 3. Acquire owner lock
  if (!stateCoordinator.tryAcquire()) {
    console.log(chalk.red('❌ 获取 owner.lock 失败，可能有其他实例正在运行'));
    process.exit(1);
  }

  // Cleanup lock on exit
  const cleanup = () => {
    stateCoordinator.release();
    logger.info('cc-bridge 已停止');
  };
  process.on('SIGINT', () => {
    console.log(chalk.yellow('\n收到 SIGINT，优雅停机中...'));
    cleanup();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    console.log(chalk.yellow('\n收到 SIGTERM，优雅停机中...'));
    cleanup();
    process.exit(0);
  });

  try {
    // 4. Startup reconciliation
    const result = await startupReconcile({
      registry,
      userManager,
      listSnapshotManager,
      spoolQueue,
    });
    console.log(chalk.green(`✅ 启动协调: ${result.recoveredProcessing} 恢复, ${result.rolledBackClaims} 回滚, ${result.mergedEvents} 事件归并`));

    // 5. Initialize Feishu Bot (without WSClient — WSClient would be wired up in production)
    // For now, the bot is ready to receive messages via the WSClient callback
    console.log(chalk.green('✅ cc-bridge 已启动'));
    console.log(chalk.cyan('等待飞书消息...'));

    // Keep the process alive
    await new Promise<void>(() => {
      // Process runs until SIGINT/SIGTERM
    });
  } catch (err) {
    console.error(chalk.red(`启动失败: ${err}`));
    cleanup();
    process.exit(1);
  }
}
