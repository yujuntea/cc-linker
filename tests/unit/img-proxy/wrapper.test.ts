import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  generateWrapperBlock,
  isWrapperInstalled,
  installWrapper,
  uninstallWrapper,
  detectShell,
  WRAPPER_START_MARKER,
  WRAPPER_END_MARKER,
} from '../../../src/img-proxy/wrapper';

let tmpDir: string;
let rcFile: string;
let backupDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'wrapper-test-'));
  rcFile = join(tmpDir, '.zshrc');
  backupDir = join(tmpDir, 'backups');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true });
});

describe('generateWrapperBlock', () => {
  test('包含 start + end markers', () => {
    const block = generateWrapperBlock();
    expect(block).toContain(WRAPPER_START_MARKER);
    expect(block).toContain(WRAPPER_END_MARKER);
  });

  test('包含 cc-linker-proxy 函数定义', () => {
    const block = generateWrapperBlock();
    expect(block).toContain('cc-linker-proxy()');
  });

  test('包含递归防护 (resolve 返同 URL → 直 exec, E7 invariant)', () => {
    const block = generateWrapperBlock();
    expect(block).toMatch(/ANTHROPIC_BASE_URL/);
    expect(block).toContain('command claude');
    // 新版 idempotent guard: 比较 resolve 结果与输入
    expect(block).toMatch(/\$resolved.*=.*\$env_url/);
  });

  test('包含 stderr warn (env override → "改写")', () => {
    const block = generateWrapperBlock();
    expect(block).toContain('改写');
  });

  test('包含 fall back 消息 (env unresolvable)', () => {
    const block = generateWrapperBlock();
    expect(block).toContain('fall back');
  });

  test('包含调 cc-linker img-proxy current-url 和 resolve', () => {
    const block = generateWrapperBlock();
    expect(block).toContain('cc-linker img-proxy current-url');
    expect(block).toContain('cc-linker img-proxy resolve');
  });
});

describe('isWrapperInstalled', () => {
  test('rc 文件不存在返回 false', () => {
    expect(isWrapperInstalled(rcFile)).toBe(false);
  });

  test('rc 文件无 marker 返回 false', () => {
    writeFileSync(rcFile, 'alias ls="ls -la"');
    expect(isWrapperInstalled(rcFile)).toBe(false);
  });

  test('rc 文件含 start marker 返回 true', () => {
    writeFileSync(rcFile, generateWrapperBlock());
    expect(isWrapperInstalled(rcFile)).toBe(true);
  });
});

describe('installWrapper', () => {
  test('空 rc 文件写入 wrapper', () => {
    const result = installWrapper(rcFile, backupDir);
    expect(result.installed).toBe(true);
    expect(readFileSync(rcFile, 'utf8')).toContain(WRAPPER_START_MARKER);
    expect(result.backupPath).toBeUndefined();
  });

  test('非空 rc 文件:先备份后追加', () => {
    const original = 'alias ls="ls -la"\n';
    writeFileSync(rcFile, original);
    const result = installWrapper(rcFile, backupDir);
    expect(result.installed).toBe(true);
    expect(result.backupPath).toBeDefined();
    expect(existsSync(result.backupPath!)).toBe(true);
    expect(readFileSync(rcFile, 'utf8')).toContain(original);
    expect(readFileSync(rcFile, 'utf8')).toContain(WRAPPER_START_MARKER);
  });

  test('幂等:已装再装返回 installed:false', () => {
    writeFileSync(rcFile, generateWrapperBlock());
    const result = installWrapper(rcFile, backupDir);
    expect(result.installed).toBe(false);
    expect(result.reason).toContain('已装');
  });

  test('非空 rc 文件无尾换行:正确插入换行', () => {
    // 注意:无尾换行
    writeFileSync(rcFile, 'alias ls="ls -la"');
    const result = installWrapper(rcFile, backupDir);
    expect(result.installed).toBe(true);
    const content = readFileSync(rcFile, 'utf8');
    expect(content).toContain('alias ls="ls -la"');
    expect(content).toContain(WRAPPER_START_MARKER);
    // 原始行 + 换行 + wrapper
    expect(content.indexOf('alias ls="ls -la"\n' + WRAPPER_START_MARKER)).toBeGreaterThan(-1);
  });
});

describe('uninstallWrapper', () => {
  test('未装时返回 removed:false', () => {
    writeFileSync(rcFile, 'alias ls="ls -la"');
    const result = uninstallWrapper(rcFile, backupDir);
    expect(result.removed).toBe(false);
  });

  test('已装时移除 block', () => {
    writeFileSync(rcFile, 'alias ls="ls -la"\n' + generateWrapperBlock() + '\nalias la="ls -A"');
    const result = uninstallWrapper(rcFile, backupDir);
    expect(result.removed).toBe(true);
    const content = readFileSync(rcFile, 'utf8');
    expect(content).toContain('alias ls');
    expect(content).toContain('alias la');
    expect(content).not.toContain(WRAPPER_START_MARKER);
  });

  test('幂等:已移除再移除 no-op', () => {
    writeFileSync(rcFile, 'alias ls');
    uninstallWrapper(rcFile, backupDir);
    const result = uninstallWrapper(rcFile, backupDir);
    expect(result.removed).toBe(false);
  });

  test('多个 block 时全部移除(全局 regex)', () => {
    const block1 = generateWrapperBlock();
    const block2 = generateWrapperBlock();
    writeFileSync(rcFile, block1 + '\n' + block2 + '\nalias end="ls"');
    const result = uninstallWrapper(rcFile, backupDir);
    expect(result.removed).toBe(true);
    const content = readFileSync(rcFile, 'utf8');
    expect(content).not.toContain(WRAPPER_START_MARKER);
    expect(content).not.toContain(WRAPPER_END_MARKER);
    expect(content).toContain('alias end="ls"');
  });
});

describe('detectShell', () => {
  test('ZSH_VERSION 优先(快速路径)', () => {
    process.env.ZSH_VERSION = '5.9';
    expect(detectShell()).toBe('zsh');
    delete process.env.ZSH_VERSION;
  });

  test('BASH_VERSION 优先(快速路径)', () => {
    process.env.BASH_VERSION = '5.2.0';
    expect(detectShell()).toBe('bash');
    delete process.env.BASH_VERSION;
  });

  test('两个都设了 → 优先 ZSH', () => {
    process.env.ZSH_VERSION = '5.9';
    process.env.BASH_VERSION = '5.2.0';
    expect(detectShell()).toBe('zsh');
    delete process.env.ZSH_VERSION;
    delete process.env.BASH_VERSION;
  });

  test('Fallback 到 $SHELL 路径(/bin/zsh)', () => {
    // 模拟 zsh 没导出 ZSH_VERSION 的情况(常见!)
    delete process.env.ZSH_VERSION;
    delete process.env.BASH_VERSION;
    process.env.SHELL = '/bin/zsh';
    expect(detectShell()).toBe('zsh');
  });

  test('Fallback 到 $SHELL 路径(/bin/bash)', () => {
    delete process.env.ZSH_VERSION;
    delete process.env.BASH_VERSION;
    process.env.SHELL = '/bin/bash';
    expect(detectShell()).toBe('bash');
  });

  test('Fallback 到 $SHELL 路径(/usr/local/bin/zsh)', () => {
    delete process.env.ZSH_VERSION;
    delete process.env.BASH_VERSION;
    process.env.SHELL = '/usr/local/bin/zsh';
    expect(detectShell()).toBe('zsh');
  });

  test('都不设 → 返回 null', () => {
    delete process.env.ZSH_VERSION;
    delete process.env.BASH_VERSION;
    delete process.env.SHELL;
    expect(detectShell()).toBeNull();
  });

  test('$SHELL=/bin/fish → 返回 null(fish 不支持)', () => {
    delete process.env.ZSH_VERSION;
    delete process.env.BASH_VERSION;
    process.env.SHELL = '/bin/fish';
    expect(detectShell()).toBeNull();
  });
});
