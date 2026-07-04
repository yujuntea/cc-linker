import { describe, test, expect } from 'bun:test';
import { discoverShellAliases, stripTrailingComment } from '../../../src/img-proxy/aliases';
import { writeFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function makeTmpRc(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'aliases-test-'));
  const file = join(dir, '.zshrc');
  writeFileSync(file, content);
  return file;
}

describe('discoverShellAliases', () => {
  test('空 rc 文件返回 []', () => {
    const file = makeTmpRc('');
    expect(discoverShellAliases([file])).toEqual([]);
  });

  test('单个 alias 单引号,带 --settings', () => {
    const file = makeTmpRc(`alias cc-byte-agent='claude --settings ~/.claude/providers/byte-agent-glm.json'`);
    const result = discoverShellAliases([file]);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('cc-byte-agent');
    expect(result[0]!.providerAlias).toBe('byte-agent-glm');
  });

  test('单个 alias 双引号', () => {
    const file = makeTmpRc(`alias cc-x="claude --settings /tmp/foo.json"`);
    const result = discoverShellAliases([file]);
    expect(result[0]!.providerAlias).toBe('foo');
  });

  test('无 --settings 的 alias,providerPath=null', () => {
    const file = makeTmpRc(`alias cc-y='echo hi'`);
    const result = discoverShellAliases([file]);
    expect(result[0]!.providerAlias).toBeNull();
    expect(result[0]!.providerPath).toBeNull();
  });

  test('注释行跳过', () => {
    const file = makeTmpRc(`# alias cc-z='should be ignored'`);
    expect(discoverShellAliases([file])).toEqual([]);
  });

  test('非 cc- prefix 的 alias 跳过', () => {
    const file = makeTmpRc(`alias ls='ls -la'\nalias cc-good='claude --settings /tmp/g.json'`);
    const result = discoverShellAliases([file]);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('cc-good');
  });

  test('rc 文件不存在静默跳过', () => {
    expect(discoverShellAliases(['/tmp/does-not-exist-xyz'])).toEqual([]);
  });

  test('多个 rc 文件取并集,重复去重', () => {
    const file1 = makeTmpRc(`alias cc-a='claude --settings /tmp/a.json'`);
    const file2 = makeTmpRc(`alias cc-a='claude --settings /tmp/a.json'\nalias cc-b='echo'`);
    const result = discoverShellAliases([file1, file2]);
    expect(result).toHaveLength(2);
    const names = result.map(r => r.name).sort();
    expect(names).toEqual(['cc-a', 'cc-b']);
  });

  test('引号内的 # 不当作注释剥离 (I-5)', () => {
    const file = makeTmpRc(`alias cc-x='echo # hash'`);
    const result = discoverShellAliases([file]);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('cc-x');
    expect(result[0]!.command).toBe('echo # hash');
  });

  test('行末 # 真注释被剥离 (I-5)', () => {
    const file = makeTmpRc(`alias cc-x='cmd' # 实际注释`);
    const result = discoverShellAliases([file]);
    expect(result).toHaveLength(1);
    expect(result[0]!.command).toBe('cmd');
  });

  test('带空格无所谓 # 前导空格 (I-5) — 命令后的真注释被剥离', () => {
    // 双引号包单引号场景需要 ALIAS_LINE_RE 升级支持,本测试聚焦 stripper 行为:
    // 模拟"单引号内 # + 单引号外 #" — 内层 # 在引号内,被保留;外层 # 是注释,被剥离。
    // 这里用无前缀 alias 行直接验证 stripper 行为(等价单引号场景):
    const input = `echo 'inner # hash' # real comment`;
    expect(stripTrailingComment(input)).toBe(`echo 'inner # hash'`);
  });

  test('反斜杠转义字符不被当作引号开启 (I-5)', () => {
    // \' 不开启单引号,所以 # 在引号外且前面有空格 → 被剥
    const input = `echo \\'# hash`;
    expect(stripTrailingComment(input)).toBe(`echo \\'# hash`);  // # 前是 ',不是空格,保留
    const input2 = `echo \\' # comment`;
    expect(stripTrailingComment(input2)).toBe(`echo \\'`);  // # 前是空格,被剥
  });
});
