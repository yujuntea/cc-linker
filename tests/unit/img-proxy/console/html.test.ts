import { describe, it, expect } from 'bun:test';
import { INDEX_HTML } from '../../../../src/img-proxy/console/html';

describe('INDEX_HTML', () => {
  it('包含 doctype + html 标签', () => {
    expect(INDEX_HTML).toMatch(/^<!DOCTYPE html>/);
    expect(INDEX_HTML).toContain('<html lang="zh-CN">');
    expect(INDEX_HTML).toContain('</html>');
  });

  it('title 是 cc-linker img-proxy console', () => {
    expect(INDEX_HTML).toContain('<title>cc-linker img-proxy console</title>');
  });

  it('包含 5 个 tab nav', () => {
    expect(INDEX_HTML).toContain('data-tab="dashboard"');
    expect(INDEX_HTML).toContain('data-tab="log"');
    expect(INDEX_HTML).toContain('data-tab="config"');
    expect(INDEX_HTML).toContain('data-tab="routes"');
    expect(INDEX_HTML).toContain('data-tab="cache"');
  });

  it('内嵌 <style> 块', () => {
    expect(INDEX_HTML).toMatch(/<style>[\s\S]+<\/style>/);
  });

  it('内嵌 <script> 块(无外部 src)', () => {
    expect(INDEX_HTML).toMatch(/<script>[\s\S]+<\/script>/);
    // 不应该有外部 script src
    expect(INDEX_HTML).not.toMatch(/<script\s+src=/);
  });

  it('JS 包含 state 管理 + 5 个 view 函数 + poll', () => {
    expect(INDEX_HTML).toContain('renderDashboard');
    expect(INDEX_HTML).toContain('renderLog');
    expect(INDEX_HTML).toContain('renderConfig');
    expect(INDEX_HTML).toContain('renderRoutes');
    expect(INDEX_HTML).toContain('renderCache');
    expect(INDEX_HTML).toContain('setInterval(pollLoop');
  });

  it('JS 包含 confirm() 守卫写操作', () => {
    expect(INDEX_HTML).toContain('confirm(');
    expect(INDEX_HTML).toContain('postJson');
  });
});