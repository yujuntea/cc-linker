// src/img-proxy/console/html.ts
//
// Task 7: INDEX_HTML — vanilla JS 单页应用(HTML + 内嵌 CSS + 内嵌 JS,零外部资源,零构建步骤)。
// server.ts GET / 直接返回这个字符串(Task 8 接线)。
//
// 设计要点(spec §5):
//   - 5 个 tab:Dashboard / Log / Config / Routes / Cache
//   - Dashboard + Routes + Cache 走 2s 轮询;Log / Config 手动刷新
//   - 写操作(POST)由 confirm() 守卫,失败弹 alert
//   - 全部 inline,无 <script src>、无 <link rel="stylesheet">
//
// 注:整个 HTML 是单个 TS template literal,所以 JS 内层的 `${...}` 必须写为 `\${...}`,
//  JS 内层的 `\`` 反引号必须写为 `\\\``,普通单引号/双引号不需要转义。

export const INDEX_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>cc-linker img-proxy console</title>
<style>
* { box-sizing: border-box; }
body { font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif; margin: 0; padding: 0; background: #f7f7f8; color: #222; }
nav { display: flex; gap: 4px; background: #1f2937; color: #fff; padding: 0 16px; }
nav button { background: transparent; color: #ccc; border: none; padding: 12px 16px; cursor: pointer; font-size: 13px; }
nav button.active { background: #374151; color: #fff; }
nav button:hover { background: #374151; }
main { padding: 16px; max-width: 1400px; margin: 0 auto; }
.banner { background: #fef3c7; color: #92400e; padding: 8px 12px; border-radius: 4px; margin-bottom: 16px; }
.stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 16px; }
.stat-card { background: #fff; border: 1px solid #e5e7eb; border-radius: 6px; padding: 12px; }
.stat-card .label { font-size: 11px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px; }
.stat-card .value { font-size: 22px; font-weight: 600; margin-top: 4px; }
table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #e5e7eb; border-radius: 6px; overflow: hidden; }
th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #f3f4f6; }
th { background: #f9fafb; font-weight: 600; font-size: 11px; text-transform: uppercase; color: #6b7280; }
tr:last-child td { border-bottom: none; }
tr.disabled { color: #9ca3af; }
.form-row { margin-bottom: 12px; }
.form-row label { display: block; font-size: 12px; color: #6b7280; margin-bottom: 4px; }
.form-row input, .form-row select { padding: 6px 10px; border: 1px solid #d1d5db; border-radius: 4px; font-size: 13px; }
button.action { background: #2563eb; color: #fff; border: none; padding: 6px 14px; border-radius: 4px; cursor: pointer; font-size: 12px; }
button.action:hover { background: #1d4ed8; }
button.action:disabled { background: #9ca3af; cursor: not-allowed; }
button.danger { background: #dc2626; color: #fff; border: none; padding: 6px 14px; border-radius: 4px; cursor: pointer; font-size: 12px; }
button.danger:hover { background: #b91c1c; }
.filters { display: flex; gap: 8px; margin-bottom: 12px; }
.filters input, .filters select { padding: 4px 8px; border: 1px solid #d1d5db; border-radius: 4px; font-size: 12px; }
.status-complete { color: #059669; }
.status-upstream_error, .status-upstream_unreachable { color: #dc2626; }
.status-client_aborted { color: #6b7280; }
.status-stalled { color: #d97706; }
.status-no_body { color: #6366f1; }
</style>
</head>
<body>
<nav>
  <button data-tab="dashboard" class="active">Dashboard</button>
  <button data-tab="log">Log</button>
  <button data-tab="config">Config</button>
  <button data-tab="routes">Routes</button>
  <button data-tab="cache">Cache</button>
</nav>
<main>
  <div id="banner" class="banner" style="display:none"></div>
  <div id="view"></div>
</main>
<script>
const state = { tab: 'dashboard', filters: { alias: '', status: '', streamStatus: '', sinceMs: 0 }, pending: new Set(), data: { stats: null, health: null, log: [], config: null, routes: [], cache: null } };

async function api(method, path, body) {
  const r = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    const text = await r.text().catch(() => r.statusText);
    throw new Error(\`\${method} \${path} → \${r.status} \${text}\`);
  }
  const ct = r.headers.get('content-type') || '';
  return ct.includes('json') ? r.json() : r.text();
}

function showBanner(msg, type) {
  const el = document.getElementById('banner');
  el.textContent = msg;
  el.style.display = 'block';
  el.style.background = type === 'error' ? '#fee2e2' : '#fef3c7';
}

function hideBanner() {
  document.getElementById('banner').style.display = 'none';
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function formatDuration(ms) {
  if (ms == null) return '-';
  if (ms < 1000) return ms + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(2) + 's';
  return (ms / 60000).toFixed(2) + 'm';
}

function renderDashboard() {
  const v = state.data;
  if (!v.stats) return '<p>加载中...</p>';
  const s = v.stats, h = v.health;
  const bs = s.byStatus || {};
  const totalStatus = Object.values(bs).reduce((a, b) => a + b, 0);
  let html = '<div class="stats-grid">';
  html += \`<div class="stat-card"><div class="label">Total Requests</div><div class="value">\${s.totalRequests || 0}</div></div>\`;
  html += \`<div class="stat-card"><div class="label">Stripped Images</div><div class="value">\${s.strippedImages || 0}</div></div>\`;
  html += \`<div class="stat-card"><div class="label">Uptime</div><div class="value">\${formatDuration(h && h.uptimeMs)}</div></div>\`;
  html += \`<div class="stat-card"><div class="label">Routes</div><div class="value">\${h ? h.routeCount : '-'}</div></div>\`;
  html += \`<div class="stat-card"><div class="label">Cache Files</div><div class="value">\${h ? h.cacheFiles : '-'}</div></div>\`;
  html += \`<div class="stat-card"><div class="label">Cache Size</div><div class="value">\${h ? (h.cacheBytes / 1024).toFixed(1) + ' KB' : '-'}</div></div>\`;
  html += '</div>';
  html += '<h3>Status Distribution</h3><table><tr><th>Status</th><th>Count</th><th>%</th></tr>';
  for (const [k, n] of Object.entries(bs)) {
    const pct = totalStatus ? (n / totalStatus * 100).toFixed(1) : '0';
    html += \`<tr><td class="status-\${esc(k)}">\${esc(k)}</td><td>\${n}</td><td>\${pct}%</td></tr>\`;
  }
  html += '</table>';
  html += '<h3 style="margin-top:24px">Per Alias</h3><table><tr><th>Alias</th><th>Requests</th><th>Stripped</th><th>Chunks</th><th>Bytes</th><th>Avg Duration</th><th>Last</th></tr>';
  const ba = s.byAlias || {};
  for (const [alias, a] of Object.entries(ba)) {
    html += \`<tr><td>\${esc(alias)}</td><td>\${a.requests}</td><td>\${a.stripped}</td><td>\${a.chunks}</td><td>\${a.bytes}</td><td>\${formatDuration(a.avgDurationMs)}</td><td>\${new Date(a.lastAt).toLocaleTimeString()}</td></tr>\`;
  }
  html += '</table>';
  return html;
}

function renderLog() {
  const v = state.data;
  let html = '<div class="filters">';
  html += '<input placeholder="alias" value="' + esc(state.filters.alias) + '" oninput="state.filters.alias=this.value">';
  html += '<input placeholder="status code" value="' + esc(state.filters.status) + '" oninput="state.filters.status=this.value">';
  html += '<select onchange="state.filters.streamStatus=this.value"><option value="">streamStatus (any)</option>';
  for (const ss of ['complete','upstream_error','upstream_unreachable','client_aborted','stalled','no_body']) {
    html += \`<option \${state.filters.streamStatus===ss?'selected':''} value="\${ss}">\${ss}</option>\`;
  }
  html += '</select>';
  html += '<button class="action" onclick="state.filters.sinceMs=Date.now()-3600000;pollLoop()">Last 1h</button>';
  html += '<button class="action" onclick="pollLoop()">Refresh</button>';
  html += '</div>';
  html += '<table><tr><th>Time</th><th>Alias</th><th>Method</th><th>Status</th><th>Stream Status</th><th>Chunks</th><th>Bytes</th><th>Duration</th><th>Stripped</th></tr>';
  for (const e of v.log) {
    const p = e.parsed || {};
    html += \`<tr><td>\${new Date(e.ts).toLocaleTimeString()}</td><td>\${esc(p.alias || '-')}</td><td>\${esc(p.method || '-')}</td><td>\${p.upstream_status || '-'}</td><td class="status-\${esc(p.stream_status || '-')}">\${esc(p.stream_status || '-')}</td><td>\${p.chunks ?? '-'}</td><td>\${p.bytes ?? '-'}</td><td>\${formatDuration(p.duration_ms)}</td><td>\${p.stripped ?? '-'}</td></tr>\`;
  }
  html += '</table>';
  return html;
}

function renderConfig() {
  const c = state.data.config || {};
  return \`<form onsubmit="event.preventDefault();postJson('/admin/api/config',{console_enabled:this.console_enabled.checked,upstream_timeout_ms:Number(this.upstream_timeout_ms.value),stream_idle_timeout_ms:Number(this.stream_idle_timeout_ms.value)},'确认修改 img_proxy 配置?')">
    <div class="form-row"><label><input type="checkbox" name="console_enabled" \${c.console_enabled?'checked':''}> console_enabled</label></div>
    <div class="form-row"><label>upstream_timeout_ms (0=不超时)</label><input name="upstream_timeout_ms" type="number" value="\${c.upstream_timeout_ms ?? 0}"></div>
    <div class="form-row"><label>stream_idle_timeout_ms (0=不检测)</label><input name="stream_idle_timeout_ms" type="number" value="\${c.stream_idle_timeout_ms ?? 0}"></div>
    <button class="action" type="submit">保存</button>
  </form>\`;
}

function renderRoutes() {
  let html = '<table><tr><th>Alias</th><th>Upstream</th><th>Installed At</th><th>Status</th><th>Action</th></tr>';
  for (const r of state.data.routes) {
    html += \`<tr class="\${r.disabled?'disabled':''}"><td>\${esc(r.alias)}</td><td>\${esc(r.upstream)}</td><td>\${esc(r.installed_at)}</td><td>\${r.disabled?'disabled':'enabled'}</td><td><button class="\${r.disabled?'action':'danger'}" onclick="postJson('/admin/api/routes/\${r.disabled?'enable':'disable'}',{alias:r.alias},\${r.disabled?'确认启用':'确认禁用'} + ' alias ' + r.alias + '?')" data-alias="\${esc(r.alias)}">\${r.disabled?'Enable':'Disable'}</button></td></tr>\`;
  }
  html += '</table>';
  return html;
}

function renderCache() {
  const h = state.data.health;
  if (!h) return '<p>加载中...</p>';
  return \`<div class="stats-grid">
    <div class="stat-card"><div class="label">Cache Files</div><div class="value">\${h.cacheFiles}</div></div>
    <div class="stat-card"><div class="label">Cache Size</div><div class="value">\${(h.cacheBytes/1024).toFixed(1)} KB</div></div>
  </div>
  <button class="danger" onclick="postJson('/admin/api/cache/clear',{},'确认清空所有缓存?')">立即清理所有缓存</button>\`;
}

const views = { dashboard: renderDashboard, log: renderLog, config: renderConfig, routes: renderRoutes, cache: renderCache };

function render() {
  const view = views[state.tab] || views.dashboard;
  document.getElementById('view').innerHTML = view();
}

function setTab(name) {
  state.tab = name;
  for (const btn of document.querySelectorAll('nav button')) {
    btn.classList.toggle('active', btn.dataset.tab === name);
  }
  render();
  pollLoop();
}

async function pollLoop() {
  hideBanner();
  try {
    if (state.tab === 'dashboard') {
      state.data.stats = await api('GET', '/admin/api/stats');
      state.data.health = await api('GET', '/admin/api/health');
    } else if (state.tab === 'log') {
      const qs = new URLSearchParams();
      if (state.filters.alias) qs.set('alias', state.filters.alias);
      if (state.filters.status) qs.set('status', state.filters.status);
      if (state.filters.streamStatus) qs.set('streamStatus', state.filters.streamStatus);
      if (state.filters.sinceMs) qs.set('sinceMs', String(state.filters.sinceMs));
      state.data.log = await api('GET', '/admin/api/log?' + qs);
    } else if (state.tab === 'routes') {
      state.data.routes = await api('GET', '/admin/api/routes');
    } else if (state.tab === 'config') {
      state.data.config = await api('GET', '/admin/api/config');
    } else if (state.tab === 'cache') {
      state.data.health = await api('GET', '/admin/api/health');
    }
    render();
  } catch (err) {
    showBanner('无法连接 daemon: ' + err.message, 'error');
  }
}

async function postJson(path, body, msg) {
  if (!confirm(msg || '确认执行 ' + path + '?')) return;
  state.pending.add(path);
  try {
    await api('POST', path, body);
    await pollLoop();
  } catch (err) {
    alert('失败: ' + err.message);
  } finally {
    state.pending.delete(path);
  }
}

document.querySelectorAll('nav button').forEach(btn => btn.addEventListener('click', () => setTab(btn.dataset.tab)));
render();
pollLoop();
setInterval(pollLoop, 2000);
</script>
</body>
</html>`;