import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { RegistryManager } from '../../src/registry';
import { syncBeforeCommand } from '../../src/scanner';
import { saveCache } from '../../src/scanner/cache';

describe('Scanner preview migration: old 80-char raw → new 240-char cleaned', () => {
  let tmpDir: string;
  let ccLinkerDir: string;
  let claudeDir: string;
  let projectsDir: string;
  let cachePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'scanner-migration-test-'));
    ccLinkerDir = join(tmpDir, '.cc-linker');
    claudeDir = join(tmpDir, '.claude');
    projectsDir = join(claudeDir, 'projects', '-Users-test-project');
    cachePath = join(ccLinkerDir, 'scan_cache.json');
    mkdirSync(ccLinkerDir, { recursive: true });
    mkdirSync(projectsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('after sync, last_assistant_preview is cleaned 240 chars (no ## /** /`)', async () => {
    // 写一个 JSONL：模拟 user prompt + 复杂 assistant 回复（带 markdown 标题/加粗/代码）
    const sessionId = 'test-migration-1';
    const jsonlPath = join(projectsDir, `${sessionId}.jsonl`);
    const longText = '# 完整最终 Review 修改意见（决策版）\n\n## 0. 内存膨胀分析\n\n### 0.1 单个 queue item 真实大小\n\n看 `traeScanner` 代码，这是 **关键** 路径';
    writeFileSync(jsonlPath, [
      JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: '用户问题' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: longText }] } }),
    ].join('\n') + '\n');

    // 创建 registry（v4 schema, last_assistant_preview 模拟老 80 字符 raw 数据）
    // 注意：RegistryManager 的 basePath 是目录，不是文件路径
    const registry = new RegistryManager(ccLinkerDir);
    registry.upsert(sessionId, {
      origin: 'cli',
      cwd: '/test',
      jsonl_path: jsonlPath,
      project_name: 'test',
      // 模拟老数据：raw markdown（带标题符号、加粗、反引号）
      last_assistant_preview: '# 完整最终 Review 修改意见（决策版）\n\n## 0. 内存膨胀分析\n\n### 0.1 单',
    });

    // 跑 sync（传入 claudeDir 覆盖默认 HOME 查找；saveCache(new Map()) 清空 cache 强制全量重扫）
    saveCache(new Map(), cachePath);
    await syncBeforeCommand(registry, cachePath, claudeDir);

    // 验证：last_assistant_preview 被更新为 cleaned 240 字符，无 ## 等 markdown 符号
    const entry = registry.get(sessionId);
    expect(entry?.last_assistant_preview).toBeDefined();
    expect(entry!.last_assistant_preview).not.toContain('##');
    expect(entry!.last_assistant_preview).not.toContain('**');
    expect(entry!.last_assistant_preview).not.toContain('`');
    expect(entry!.last_assistant_preview).toContain('完整最终 Review 修改意见');
    expect(entry!.last_assistant_preview!.length).toBeLessThanOrEqual(240);
  });

  it('skip thinking + midway state: last_assistant_preview jumps to earlier final answer', async () => {
    const sessionId = 'test-migration-2';
    const jsonlPath = join(projectsDir, `${sessionId}.jsonl`);
    writeFileSync(jsonlPath, [
      JSON.stringify({ type: 'user', message: { content: '问题' } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '## 真正回复：内存队列方案' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '让我分析...' }] } }),
    ].join('\n') + '\n');

    const registry = new RegistryManager(ccLinkerDir);
    registry.upsert(sessionId, {
      origin: 'cli',
      cwd: '/test',
      jsonl_path: jsonlPath,
      project_name: 'test',
    });

    saveCache(new Map(), cachePath);
    await syncBeforeCommand(registry, cachePath, claudeDir);

    const entry = registry.get(sessionId);
    // 末条是 thinking-only → 跳过；找前一个 final answer
    expect(entry?.last_assistant_preview).toBe('真正回复：内存队列方案');
  });
});
