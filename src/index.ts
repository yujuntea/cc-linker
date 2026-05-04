#!/usr/bin/env bun
import { Command } from 'commander';

const program = new Command();

program
  .name('cc-bridge')
  .description('cc-connect 与 Claude Code CLI 的会话桥接工具')
  .version('0.1.0');

program.parse();
