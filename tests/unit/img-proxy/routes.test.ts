import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { loadRoutes, saveRoutes, addRoute, removeRoute, resolveUpstream } from '../../../src/img-proxy/routes';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('routes', () => {
  let routesPath: string;
  beforeEach(() => { routesPath = join(mkdtempSync(join(tmpdir(), 'img-proxy-routes-')), 'routes.json'); });
  afterEach(() => { rmSync(routesPath, { recursive: true, force: true }); });

  it('loadRoutes returns empty table when file missing', () => {
    expect(loadRoutes(routesPath)).toEqual({ version: 1, routes: {} });
  });

  it('addRoute persists and resolveUpstream finds it', () => {
    addRoute(routesPath, 'byte-agent-glm', 'https://ark.cn-beijing.volces.com/api/plan', '/home/u/.claude/providers/byte-agent-glm.json');
    expect(resolveUpstream(routesPath, 'byte-agent-glm')).toBe('https://ark.cn-beijing.volces.com/api/plan');
    expect(resolveUpstream(routesPath, 'unknown')).toBeNull();
  });

  it('saveRoute is atomic', () => {
    saveRoutes(routesPath, {
      version: 1,
      routes: {
        'byte-glm': {
          alias: 'byte-glm', upstream: 'https://ark.cn-beijing.volces.com/api/coding',
          provider_path: '/p.json', original_base_url: 'https://ark.cn-beijing.volces.com/api/coding',
          installed_at: '2026-07-04T00:00:00.000Z',
        },
      },
    });
    expect(existsSync(routesPath)).toBe(true);
    expect(loadRoutes(routesPath).routes['byte-glm']).toBeDefined();
  });

  it('addRoute overwrites same alias, keeps others (idempotent on same key)', () => {
    addRoute(routesPath, 'a', 'https://a/', '/pa');
    addRoute(routesPath, 'b', 'https://b/', '/pb');
    addRoute(routesPath, 'a', 'https://a2/', '/pa');
    const table = loadRoutes(routesPath);
    expect(Object.keys(table.routes).sort()).toEqual(['a', 'b']);
    expect(table.routes['a']!.upstream).toBe('https://a2/');
  });

  it('removeRoute deletes only the named alias', () => {
    addRoute(routesPath, 'a', 'https://a/', '/pa');
    addRoute(routesPath, 'b', 'https://b/', '/pb');
    removeRoute(routesPath, 'a');
    const table = loadRoutes(routesPath);
    expect(table.routes['a']).toBeUndefined();
    expect(table.routes['b']).toBeDefined();
  });

  it('removeRoute on missing alias is a no-op', () => {
    expect(() => removeRoute(routesPath, 'nope')).not.toThrow();
  });
});
