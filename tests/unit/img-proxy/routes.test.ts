import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { addRoute, getUpstreamByAlias, resolveProxyByUpstream } from '../../../src/img-proxy/routes';

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
