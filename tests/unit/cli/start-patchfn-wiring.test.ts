// tests/unit/cli/start-patchfn-wiring.test.ts
//
// v2.2.20 drift detector:start.ts 必须用 createPatchFn(client, log)(无延迟)
// 给 agent-view.deps.patchFn 赋值;如果有人把它改回 1200ms 硬延迟,会重新
// 触发 "Peek 卡 Refresh 后被旧内容覆盖" 的 revert bug。
//
// 验证方法:直接对 start.ts 源码做静态扫描 —— 这比跑 e2e 启动更稳,不依赖
// 飞书 client / 配置文件 / launchd。

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const startTsPath = join(import.meta.dir, '..', '..', '..', 'src', 'cli', 'commands', 'start.ts');
const startSource = readFileSync(startTsPath, 'utf8');

describe('start.ts patchFn wiring (v2.2.20: agent-view 必须 no-delay)', () => {
  test('start.ts 引用 createPatchFn(从 src/feishu/patch)', () => {
    expect(startSource).toContain("from '../../feishu/patch'");
  });

  test('start.ts 把 createPatchFn(client, log) 赋值给 agentView.deps.patchFn', () => {
    // v2.2.20 实测:agent-view 的 patchFn 必须是 createPatchFn 的结果(默认 1200ms
    // 延迟,避开飞书 card action event lock)。
    // 允许两种合法 wiring:
    //   A) `agentView.deps.patchFn = createPatchFn(client, log);`  (直传,用默认 1200ms)
    //   B) `patchFn = createPatchFn(client, log);` 然后 `agentView.deps.patchFn = patchFn;`  (间接)
    // 不能传 forceImmediate(会绕过 lock,客户端不渲染新内容)。
    const direct = /agentView\.deps\.patchFn\s*=\s*createPatchFn\(/;
    const indirect = /patchFn\s*=\s*createPatchFn\([^)]*\);[\s\S]{0,200}agentView\.deps\.patchFn\s*=\s*patchFn/;
    expect(direct.test(startSource) || indirect.test(startSource)).toBe(true);
    // v2.2.20:不能用 forceImmediate=true 跳过延迟,会触发 lock 内 patch → 客户端不渲染
    expect(startSource).not.toMatch(/createPatchFn\([^)]*forceImmediate\s*:\s*true/);
  });

  test('start.ts 不再直接 inline 写 setTimeout 1200 的硬延迟 patchFn', () => {
    // 旧版 start.ts:411-417 写死了 setTimeout(r, 1200)。如果有人 revert 这部分
    // 改动(比如 merge 旧 commit),这个测试会抓住。
    // 注释里出现 1200 是 OK 的(解释历史),实际代码里出现不行。
    const inlineCode = startSource
      .split('\n')
      .filter(line => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
      .join('\n');
    expect(inlineCode).not.toMatch(/setTimeout\(r,\s*1200\)/);
  });
});
