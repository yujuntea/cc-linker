import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  saveRoutes, loadRoutes, getUpstreamByAlias, setRouteDisabled, addRoute,
} from '../../../src/img-proxy/routes';

describe('routes disable/enable', () => {
  let tmpDir: string, routesPath: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'routes-disable-'));
    routesPath = join(tmpDir, 'routes.json');
    await saveRoutes(routesPath, {
      version: 1,
      routes: {
        'glm-5.2': {
          alias: 'glm-5.2',
          upstream: 'http://upstream-1',
          provider_path: '/fake.json',
          original_base_url: 'http://upstream-1',
          installed_at: '2026-07-05T00:00:00Z',
        },
      },
    });
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it('getUpstreamByAlias 返 null 当 disabled=true', async () => {
    expect(getUpstreamByAlias(routesPath, 'glm-5.2')).toBe('http://upstream-1');
    await setRouteDisabled(routesPath, 'glm-5.2', true);
    expect(getUpstreamByAlias(routesPath, 'glm-5.2')).toBeNull();
  });

  it('setRouteDisabled(false) 恢复 disabled 字段', async () => {
    await setRouteDisabled(routesPath, 'glm-5.2', true);
    await setRouteDisabled(routesPath, 'glm-5.2', false);
    expect(getUpstreamByAlias(routesPath, 'glm-5.2')).toBe('http://upstream-1');
    // routes.json 里不应残留 disabled 字段
    const table = loadRoutes(routesPath);
    expect(table.routes['glm-5.2']?.disabled).toBeUndefined();
  });

  it('setRouteDisabled 未知 alias 抛错', async () => {
    await expect(setRouteDisabled(routesPath, 'nope', true)).rejects.toThrow(/unknown alias: nope/);
  });

  it('addRoute 保留已有 disabled 字段(避免 race 丢 disable)', async () => {
    await setRouteDisabled(routesPath, 'glm-5.2', true);
    await addRoute(routesPath, 'glm-5.2', 'http://upstream-2', '/fake.json');
    // disable 应该保留
    expect(getUpstreamByAlias(routesPath, 'glm-5.2')).toBeNull();
    // 但 upstream 应该更新到新值
    const table = loadRoutes(routesPath);
    expect(table.routes['glm-5.2']?.upstream).toBe('http://upstream-2');
    expect(table.routes['glm-5.2']?.disabled).toBe(true);
  });
});
