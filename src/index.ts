#!/usr/bin/env bun
import { Command } from 'commander';
import { RegistryManager } from './registry';
import { syncBeforeCommand } from './scanner';
import { handleError } from './utils/errors';
import { init } from './cli/commands/init';
import { list } from './cli/commands/list';

const program = new Command();

program
  .name('cc-bridge')
  .description('cc-connect 与 Claude Code CLI 的会话桥接工具')
  .version('0.1.0');

// Helper to run sync before command
async function withSync(fn: (registry: RegistryManager) => Promise<void>, skipSync = false) {
  const registry = new RegistryManager();
  if (!skipSync) {
    await syncBeforeCommand(registry);
  }
  await fn(registry);
}

program
  .command('init')
  .description('初始化 registry 并扫描已有会话')
  .action(() => withSync(async (registry) => {
    await init(registry);
  }, true));

program
  .command('list')
  .description('列出所有可恢复的会话')
  .option('-p, --project <name>', '按项目名过滤')
  .option('-P, --platform <name>', '按平台过滤')
  .option('-o, --origin <type>', '按来源过滤')
  .option('-a, --active', '只显示最近 2 小时活跃的会话')
  .option('-f, --format <type>', '输出格式: table/json/csv', 'table')
  .option('-l, --limit <n>', '最多显示 n 条', '20')
  .option('-s, --sort <field>', '排序字段', 'last_active')
  .option('--no-sync', '跳过自动同步')
  .action((opts) => withSync(async (registry) => {
    await list(registry, opts);
  }, opts.noSync));

// Parse and handle errors
program.parseAsync(process.argv).catch(handleError);
