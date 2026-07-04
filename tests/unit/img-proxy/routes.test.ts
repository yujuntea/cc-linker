import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  addRoute,
  getUpstreamByAlias,
  resolveProxyByUpstream,
  loadRoutes,
  removeRoute,
  normalizeUrlForCompare,
} from '../../../src/img-proxy/routes';

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
  test('找到 alias 的 upstream', async () => {
    await addRoute(routesPath, 'glm-5.2', 'https://open.bigmodel.cn/api/anthropic', '/tmp/glm-5.2.json');
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
  test('按 upstream 找到 proxy URL', async () => {
    await addRoute(routesPath, 'glm-5.2', 'https://open.bigmodel.cn/api/anthropic', '/tmp/glm-5.2.json');
    const result = resolveProxyByUpstream(routesPath, 8765, '127.0.0.1', 'https://open.bigmodel.cn/api/anthropic');
    expect(result).toBe('http://127.0.0.1:8765/glm-5.2');
  });

  test('upstream 不匹配返回 null', async () => {
    await addRoute(routesPath, 'glm-5.2', 'https://open.bigmodel.cn/api/anthropic', '/tmp/glm-5.2.json');
    const result = resolveProxyByUpstream(routesPath, 8765, '127.0.0.1', 'https://unknown.com');
    expect(result).toBeNull();
  });

  test('多个 routes 找正确的那个', async () => {
    await addRoute(routesPath, 'glm-5.2', 'https://open.bigmodel.cn', '/tmp/glm-5.2.json');
    await addRoute(routesPath, 'kimi', 'https://api.moonshot.cn', '/tmp/kimi.json');
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

  test('saveRoutes + loadRoutes 往返一致', async () => {
    await addRoute(routesPath, 'glm-5.2', 'https://open.bigmodel.cn', '/tmp/x.json');
    const reloaded = loadRoutes(routesPath);
    expect(reloaded.routes['glm-5.2']?.upstream).toBe('https://open.bigmodel.cn');
  });

  test('addRoute 覆盖同名 alias(更新字段)', async () => {
    await addRoute(routesPath, 'glm-5.2', 'https://old.com', '/tmp/x.json');
    await addRoute(routesPath, 'glm-5.2', 'https://new.com', '/tmp/x.json');
    const entry = loadRoutes(routesPath).routes['glm-5.2']!;
    expect(entry.upstream).toBe('https://new.com');
    // alias 数还是 1(被覆盖,不是新增)
    expect(Object.keys(loadRoutes(routesPath).routes)).toHaveLength(1);
  });

  test('removeRoute 删除指定的 alias,保留其它', async () => {
    await addRoute(routesPath, 'glm-5.2', 'https://a.com', '/tmp/a.json');
    await addRoute(routesPath, 'kimi', 'https://b.com', '/tmp/b.json');
    await removeRoute(routesPath, 'glm-5.2');
    const routes = loadRoutes(routesPath).routes;
    expect(routes['glm-5.2']).toBeUndefined();
    expect(routes['kimi']?.upstream).toBe('https://b.com');
  });

  test('removeRoute 对不存在的 alias 是 no-op', async () => {
    await addRoute(routesPath, 'glm-5.2', 'https://a.com', '/tmp/a.json');
    await removeRoute(routesPath, 'nonexistent');
    expect(loadRoutes(routesPath).routes['glm-5.2']?.upstream).toBe('https://a.com');
  });
});

// ---------- Fix I-1: URL normalization ----------

describe('normalizeUrlForCompare', () => {
  test('去掉末尾斜杠', () => {
    expect(normalizeUrlForCompare('https://x.com/api/')).toBe('https://x.com/api');
  });

  test('空 pathname 回退到 /', () => {
    expect(normalizeUrlForCompare('https://x.com/')).toBe('https://x.com/');
  });

  test('小写 host', () => {
    expect(normalizeUrlForCompare('HTTPS://X.com/api')).toBe('https://x.com/api');
  });

  test('protocol 默认 https → :// 后无端口', () => {
    expect(normalizeUrlForCompare('https://x.com:443/api')).toBe('https://x.com/api');
    // 默认端口会被 URL.normalize 自动剥离,这点是规范化的一部分。
  });

  test('保留非默认端口', () => {
    expect(normalizeUrlForCompare('https://x.com:8765/api')).toBe('https://x.com:8765/api');
  });

  test('多级尾部斜杠', () => {
    expect(normalizeUrlForCompare('https://x.com/api//')).toBe('https://x.com/api');
  });

  test('无法解析的 URL 原样返回(不会抛)', () => {
    expect(normalizeUrlForCompare('not a url')).toBe('not a url');
    expect(normalizeUrlForCompare('')).toBe('');
  });
});

describe('resolveProxyByUpstream 容忍 URL 小差异(Fix I-1)', () => {
  test('trailing slash mismatch 也匹配', async () => {
    await addRoute(routesPath, 'glm-5.2', 'https://x.com/api/', '/tmp/x.json');
    expect(resolveProxyByUpstream(routesPath, 8765, '127.0.0.1', 'https://x.com/api')).toBe('http://127.0.0.1:8765/glm-5.2');
  });

  test('case mismatch 也匹配', async () => {
    await addRoute(routesPath, 'glm-5.2', 'https://X.com/api', '/tmp/x.json');
    expect(resolveProxyByUpstream(routesPath, 8765, '127.0.0.1', 'https://x.com/api')).toBe('http://127.0.0.1:8765/glm-5.2');
  });

  test('查询侧畸形 URL 返回 null 而不抛', async () => {
    await addRoute(routesPath, 'glm-5.2', 'https://x.com/api', '/tmp/x.json');
    expect(resolveProxyByUpstream(routesPath, 8765, '127.0.0.1', 'not a url')).toBeNull();
  });
});

// ---------- Fix I-3: preserve installed_at ----------

describe('addRoute 保留 installed_at (Fix I-3)', () => {
  test('新 alias 设置 installed_at 为当前时间', async () => {
    const before = Date.now();
    await addRoute(routesPath, 'glm-5.2', 'https://x.com/api', '/tmp/x.json');
    const after = Date.now();
    const entry = loadRoutes(routesPath).routes['glm-5.2']!;
    const ts = Date.parse(entry.installed_at);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  test('覆盖同名 alias 时保留原始 installed_at', async () => {
    await addRoute(routesPath, 'glm-5.2', 'https://x.com/api', '/tmp/x.json');
    const original = loadRoutes(routesPath).routes['glm-5.2']!.installed_at;
    // 等一点时间确保 new Date() 会产生不同时间戳(避免假阳性)
    await new Promise(r => setTimeout(r, 20));
    await addRoute(routesPath, 'glm-5.2', 'https://y.com/api', '/tmp/x.json');
    const entry = loadRoutes(routesPath).routes['glm-5.2']!;
    expect(entry.installed_at).toBe(original);
    expect(entry.upstream).toBe('https://y.com/api');
  });
});

// ---------- Fix I-2: file lock ----------

describe('addRoute 并发不丢路由 (Fix I-2)', () => {
  test('两个并行 addRoute 后两条路由都在', async () => {
    const [a, b] = await Promise.all([
      addRoute(routesPath, 'glm-5.2', 'https://x.com/api', '/tmp/x.json'),
      addRoute(routesPath, 'kimi', 'https://api.moonshot.cn', '/tmp/kimi.json'),
    ]);
    expect(a).toBeUndefined(); // void
    expect(b).toBeUndefined();
    const routes = loadRoutes(routesPath).routes;
    expect(Object.keys(routes).sort()).toEqual(['glm-5.2', 'kimi']);
    expect(routes['glm-5.2']?.upstream).toBe('https://x.com/api');
    expect(routes['kimi']?.upstream).toBe('https://api.moonshot.cn');
  });

  test('同一 alias 并发 addRoute 不会丢字段', async () => {
    // 两个并行 addRoute 写同一个 alias,最终 installed_at / upstream 必须
    // 是其中某个完整的写入(不是被半写) —— 序列化锁保证读改写原子。
    await Promise.all([
      addRoute(routesPath, 'glm-5.2', 'https://a.com/api', '/tmp/a.json'),
      addRoute(routesPath, 'glm-5.2', 'https://b.com/api', '/tmp/b.json'),
    ]);
    const entry = loadRoutes(routesPath).routes['glm-5.2']!;
    expect(['https://a.com/api', 'https://b.com/api']).toContain(entry.upstream);
    // 也得满足上下游字段一致(provider_path / original_base_url) —— 这是
    // 之前 read-modify-write race 下可能被破坏的不变量
    expect(entry.provider_path).toMatch(/\.json$/);
    expect(entry.original_base_url).toBe(entry.upstream);
    expect(entry.alias).toBe('glm-5.2');
  });
});
