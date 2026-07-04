import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { addRoute, getUpstreamByAlias, resolveProxyByUpstream, loadRoutes, removeRoute } from '../../../src/img-proxy/routes';

let tmpDir: string;
let routesPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'routes-test-'));
  routesPath = join(tmpDir, 'routes.json');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true });
});

describe('getUpstreamByAlias(重命名后)', () => {
  test('找到 alias 的 upstream', () => {
    addRoute(routesPath, 'glm-5.2', 'https://open.bigmodel.cn/api/anthropic', '/tmp/glm-5.2.json');
    expect(getUpstreamByAlias(routesPath, 'glm-5.2')).toBe('https://open.bigmodel.cn/api/anthropic');
  });

  test('alias 不存在返回 null', () => {
    expect(getUpstreamByAlias(routesPath, 'nope')).toBeNull();
  });

  test('空 routes 文件返回 null', () => {
    expect(getUpstreamByAlias(routesPath, 'any')).toBeNull();
  });
});

describe('resolveProxyByUpstream(新函数)', () => {
  test('按 upstream 找到 proxy URL', () => {
    addRoute(routesPath, 'glm-5.2', 'https://open.bigmodel.cn/api/anthropic', '/tmp/glm-5.2.json');
    const result = resolveProxyByUpstream(routesPath, 8765, '127.0.0.1', 'https://open.bigmodel.cn/api/anthropic');
    expect(result).toBe('http://127.0.0.1:8765/glm-5.2');
  });

  test('upstream 不匹配返回 null', () => {
    addRoute(routesPath, 'glm-5.2', 'https://open.bigmodel.cn/api/anthropic', '/tmp/glm-5.2.json');
    const result = resolveProxyByUpstream(routesPath, 8765, '127.0.0.1', 'https://unknown.com');
    expect(result).toBeNull();
  });

  test('多个 routes 找正确的那个', () => {
    addRoute(routesPath, 'glm-5.2', 'https://open.bigmodel.cn', '/tmp/glm-5.2.json');
    addRoute(routesPath, 'kimi', 'https://api.moonshot.cn', '/tmp/kimi.json');
    expect(resolveProxyByUpstream(routesPath, 8765, '127.0.0.1', 'https://api.moonshot.cn')).toBe('http://127.0.0.1:8765/kimi');
  });

  test('空 routes 返回 null', () => {
    expect(resolveProxyByUpstream(routesPath, 8765, '127.0.0.1', 'https://any.com')).toBeNull();
  });
});

describe('基础行为(loadRoutes / saveRoutes / addRoute / removeRoute)', () => {
  test('loadRoutes 在文件不存在时返回空表', () => {
    // routesPath 是 beforeEach 创建的空 tmp 路径,文件不存在
    const table = loadRoutes(routesPath);
    expect(table).toEqual({ version: 1, routes: {} });
  });

  test('loadRoutes 处理损坏 JSON 时返回空表', () => {
    writeFileSync(routesPath, '{ not valid json');
    const table = loadRoutes(routesPath);
    expect(table).toEqual({ version: 1, routes: {} });
  });

  test('saveRoutes + loadRoutes 往返一致', () => {
    addRoute(routesPath, 'glm-5.2', 'https://open.bigmodel.cn', '/tmp/x.json');
    const reloaded = loadRoutes(routesPath);
    expect(reloaded.routes['glm-5.2']?.upstream).toBe('https://open.bigmodel.cn');
  });

  test('addRoute 覆盖同名 alias(更新字段)', () => {
    addRoute(routesPath, 'glm-5.2', 'https://old.com', '/tmp/x.json');
    addRoute(routesPath, 'glm-5.2', 'https://new.com', '/tmp/x.json');
    const entry = loadRoutes(routesPath).routes['glm-5.2']!;
    expect(entry.upstream).toBe('https://new.com');
    // alias 数还是 1(被覆盖,不是新增)
    expect(Object.keys(loadRoutes(routesPath).routes)).toHaveLength(1);
  });

  test('removeRoute 删除指定的 alias,保留其它', () => {
    addRoute(routesPath, 'glm-5.2', 'https://a.com', '/tmp/a.json');
    addRoute(routesPath, 'kimi', 'https://b.com', '/tmp/b.json');
    removeRoute(routesPath, 'glm-5.2');
    const routes = loadRoutes(routesPath).routes;
    expect(routes['glm-5.2']).toBeUndefined();
    expect(routes['kimi']?.upstream).toBe('https://b.com');
  });

  test('removeRoute 对不存在的 alias 是 no-op', () => {
    addRoute(routesPath, 'glm-5.2', 'https://a.com', '/tmp/a.json');
    removeRoute(routesPath, 'nonexistent');
    expect(loadRoutes(routesPath).routes['glm-5.2']?.upstream).toBe('https://a.com');
  });
});
