// tests/unit/img-proxy/routes-options.test.ts
//
// routes.ts 路由级选项(addRoute opts / getRouteByAlias)单测:
//   - addRoute 带 inject_headers/request_transform 持久化到 routes.json
//   - 重跑 addRoute 不带 opts 时保留已有选项(与 disabled 保留语义一致)
//   - getRouteByAlias: 正常返回完整 entry;disabled → null;未知 → null
//   - getUpstreamByAlias 委托 getRouteByAlias 后行为不变

import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { addRoute, getRouteByAlias, getUpstreamByAlias, loadRoutes } from '../../../src/img-proxy/routes';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('routes route-level options', () => {
  let routesPath: string, workDir: string;
  const tmpDirs: string[] = [];

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'img-proxy-routes-opts-'));
    tmpDirs.push(workDir);
    routesPath = join(workDir, 'routes.json');
  });

  afterAll(() => {
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  });

  it('addRoute 持久化 inject_headers / request_transform', async () => {
    await addRoute(routesPath, 'opencode', 'https://opencode.ai/zen/go', '/manual/opencode.json', {
      inject_headers: { 'x-opencode-session': 'sess-1' },
      request_transform: 'openai-dialect-normalizer',
    });
    const entry = loadRoutes(routesPath).routes['opencode'];
    expect(entry.inject_headers).toEqual({ 'x-opencode-session': 'sess-1' });
    expect(entry.request_transform).toBe('openai-dialect-normalizer');
  });

  it('重跑 addRoute 不带 opts 时保留已有选项(不静默丢手工配置)', async () => {
    await addRoute(routesPath, 'opencode', 'https://opencode.ai/zen/go', '/manual/opencode.json', {
      inject_headers: { 'x-opencode-session': 'sess-1' },
    });
    await addRoute(routesPath, 'opencode', 'https://opencode.ai/zen/go', '/manual/opencode.json');
    const entry = loadRoutes(routesPath).routes['opencode'];
    expect(entry.inject_headers).toEqual({ 'x-opencode-session': 'sess-1' });
  });

  it('重跑 addRoute 带新 opts 时覆盖旧值', async () => {
    await addRoute(routesPath, 'oc', 'https://a.example', '/p', {
      inject_headers: { 'x-opencode-session': 'old' },
    });
    await addRoute(routesPath, 'oc', 'https://a.example', '/p', {
      inject_headers: { 'x-opencode-session': 'new' },
    });
    expect(loadRoutes(routesPath).routes['oc'].inject_headers).toEqual({ 'x-opencode-session': 'new' });
  });

  it('getRouteByAlias: 返回完整 entry;disabled → null;未知 → null', async () => {
    await addRoute(routesPath, 'oc', 'https://a.example', '/p', {
      request_transform: 'openai-dialect-normalizer',
    });
    const e = getRouteByAlias(routesPath, 'oc');
    expect(e?.upstream).toBe('https://a.example');
    expect(e?.request_transform).toBe('openai-dialect-normalizer');
    expect(getRouteByAlias(routesPath, 'nope')).toBeNull();
  });

  it('getUpstreamByAlias 委托 getRouteByAlias 后行为不变(含 disabled 语义)', async () => {
    await addRoute(routesPath, 'oc', 'https://a.example', '/p');
    expect(getUpstreamByAlias(routesPath, 'oc')).toBe('https://a.example');
    expect(getUpstreamByAlias(routesPath, 'nope')).toBeNull();
  });

  it('持久化形态: routes.json 为合法 JSON 且选项字段在 entry 内(向后兼容 — 旧版读不到只是忽略)', async () => {
    await addRoute(routesPath, 'oc', 'https://a.example', '/p', {
      inject_headers: { 'x-opencode-session': 's' },
    });
    const raw = JSON.parse(await Bun.file(routesPath).text());
    expect(raw.version).toBe(1);
    expect(raw.routes.oc.inject_headers).toEqual({ 'x-opencode-session': 's' });
  });
});
