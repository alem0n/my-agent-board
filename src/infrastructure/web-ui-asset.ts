/**
 * 内置 Web UI 资产（infrastructure 层）。
 *
 * 职责契约：导出自包含单页 HTML（内联 CSS/JS，零外部资源，离线可用）。
 * 由 http-server 在 --web 启用时挂载到 /（别名 /ui）；不需要时完全不暴露。
 * 页面只调用既有 /v1/* JSON API 渲染，不含任何业务逻辑。
 */

const TITLE = 'my-agent-board';

const STYLES = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px;
    font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
    background: #0d1117; color: #dbe2ea;
  }
  header { display: flex; align-items: baseline; gap: 16px; flex-wrap: wrap; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .meta { color: #7a8794; font-size: 13px; }
  .controls { margin-left: auto; display: flex; gap: 8px; align-items: center; }
  button {
    background: #1f2730; color: #dbe2ea; border: 1px solid #303a45;
    border-radius: 6px; padding: 6px 12px; cursor: pointer; font-size: 13px;
  }
  button:hover { border-color: #4a5a6a; }
  label { font-size: 13px; color: #9faab5; }
  main { display: grid; grid-template-columns: minmax(340px, 1fr) 2fr; gap: 20px; margin-top: 20px; }
  @media (max-width: 900px) { main { grid-template-columns: 1fr; } }
  .panel {
    background: #151b22; border: 1px solid #242d36; border-radius: 10px;
    padding: 16px; min-height: 200px; overflow-x: auto;
  }
  h2 { font-size: 14px; margin: 0 0 12px; color: #9faab5; text-transform: uppercase; letter-spacing: 0.06em; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid #222b34; white-space: nowrap; }
  th { color: #7a8794; font-weight: 600; }
  tr.clickable { cursor: pointer; }
  tr.clickable:hover { background: #1b242e; }
  tr.selected { background: #1c2e42; }
  .uuid { font-family: ui-monospace, monospace; font-size: 12px; color: #8ab4d8; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .badge {
    display: inline-block; background: #1f2730; border: 1px solid #303a45;
    border-radius: 999px; padding: 1px 8px; font-size: 12px; color: #9faab5;
  }
  .state-cell { font-family: ui-monospace, monospace; font-size: 12px; }
  pre {
    margin: 0; padding: 8px; background: #0d1117; border-radius: 6px;
    font-size: 12px; overflow-x: auto; max-width: 640px;
  }
  .error { color: #e5707a; font-size: 13px; padding: 8px; }
  .empty { color: #7a8794; font-size: 13px; padding: 12px 0; }
  .toolbar { display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; align-items: center; }
  select, input[type='number'] {
    background: #1f2730; color: #dbe2ea; border: 1px solid #303a45;
    border-radius: 6px; padding: 5px 8px; font-size: 13px;
  }
`;

const SCRIPT = `
  var selectedUuid = null;
  var autoRefresh = true;
  var timer = null;

  function fetchJson(path) {
    return fetch(path).then(function (res) {
      if (!res.ok) { throw new Error('HTTP ' + res.status + ' ' + path); }
      return res.json();
    });
  }

  function relativeTime(ms) {
    if (ms === undefined || ms === null) { return '-'; }
    var delta = Date.now() - ms;
    if (delta < 0) { delta = 0; }
    if (delta < 1000) { return delta + 'ms ago'; }
    if (delta < 60000) { return Math.floor(delta / 1000) + 's ago'; }
    if (delta < 3600000) { return Math.floor(delta / 60000) + 'm ago'; }
    if (delta < 86400000) { return Math.floor(delta / 3600000) + 'h ago'; }
    return Math.floor(delta / 86400000) + 'd ago';
  }

  function esc(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderAgents(agents) {
    var rows = agents.map(function (a) {
      var cls = 'clickable' + (a.uuid === selectedUuid ? ' selected' : '');
      return '<tr class="' + cls + '" data-uuid="' + esc(a.uuid) + '">'
        + '<td><span class="uuid">' + esc(a.uuid.slice(0, 8)) + '</span></td>'
        + '<td>' + esc(a.name) + '</td>'
        + '<td title="' + esc(a.cwd) + '">' + esc(a.cwd) + '</td>'
        + '<td>' + relativeTime(a.lastSeen) + '</td>'
        + '<td class="num"><span class="badge">' + a.stateCount + ' states</span></td>'
        + '<td class="num">' + a.reportCount + '</td>'
        + '</tr>';
    }).join('');
    document.getElementById('agentRows').innerHTML = rows
      || '<tr><td colspan="6" class="empty">暂无 agent 上报</td></tr>';
    var nodes = document.querySelectorAll('#agentRows tr.clickable');
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].addEventListener('click', function (event) {
        selectedUuid = event.currentTarget.getAttribute('data-uuid');
        renderAgentDetail();
      });
    }
  }

  function renderAgentDetail() {
    var rows = document.querySelectorAll('#agentRows tr.clickable');
    for (var i = 0; i < rows.length; i++) {
      rows[i].classList.toggle('selected', rows[i].getAttribute('data-uuid') === selectedUuid);
    }
    if (!selectedUuid) {
      document.getElementById('detail').innerHTML = '<p class="empty">选择一个 agent 查看逐状态最新载荷与历史</p>';
      return;
    }
    fetchJson('/v1/agents/' + encodeURIComponent(selectedUuid))
      .then(function (agent) {
        var latestMap = agent.latest || {};
        var states = Object.keys(latestMap)
          .map(function (key) { return { state: key, timestamp: latestMap[key].timestamp, payload: latestMap[key].payload }; })
          .sort(function (a, b) { return (b.timestamp || 0) - (a.timestamp || 0); });
        var limit = document.getElementById('historyLimit').value || 20;
        var stateFilter = document.getElementById('stateFilter').value;
        var historyPath = '/v1/agents/' + encodeURIComponent(selectedUuid)
          + '/history?limit=' + limit + (stateFilter ? '&state=' + encodeURIComponent(stateFilter) : '');
        var stateOptions = states.map(function (s) {
          return '<option value="' + esc(s.state) + '">' + esc(s.state) + '</option>';
        }).join('');
        document.getElementById('stateFilter').innerHTML =
          '<option value="">全部状态</option>' + stateOptions;
        if (stateFilter) { document.getElementById('stateFilter').value = stateFilter; }

        var latestHtml = states.map(function (s) {
          return '<tr><td class="state-cell">' + esc(s.state) + '</td>'
            + '<td>' + relativeTime(s.timestamp) + '</td>'
            + '<td><pre>' + esc(JSON.stringify(s.payload, null, 1)) + '</pre></td></tr>';
        }).join('') || '<tr><td colspan="3"><p class="empty">无状态</p></td></tr>';

        return fetchJson(historyPath).then(function (history) {
          var entries = history.entries || [];
          var historyHtml = entries.map(function (e) {
            return '<tr><td class="state-cell">' + esc(e.state) + '</td>'
              + '<td>' + relativeTime(e.timestamp) + '</td>'
              + '<td><pre>' + esc(JSON.stringify(e.payload).slice(0, 200)) + '</pre></td></tr>';
          }).join('') || '<tr><td colspan="3"><p class="empty">无历史</p></td></tr>';
          document.getElementById('detail').innerHTML =
            '<h2>' + esc(agent.name) + ' <span class="uuid">' + esc(agent.uuid) + '</span></h2>'
            + '<div class="toolbar">'
            + '<label>状态 <select id="stateFilter"><option value="">全部状态</option>' + stateOptions + '</select></label>'
            + '<label>条数 <input id="historyLimit" type="number" min="1" max="200" value="' + limit + '"></label>'
            + '</div>'
            + '<h2>最新状态</h2><table><thead><tr><th>state</th><th>时间</th><th>payload</th></tr></thead><tbody>' + latestHtml + '</tbody></table>'
            + '<h2 style="margin-top:20px">历史（最近 ' + entries.length + ' 条）</h2>'
            + '<table><thead><tr><th>state</th><th>时间</th><th>payload</th></tr></thead><tbody>' + historyHtml + '</tbody></table>';
          bindToolbar();
        });
      })
      .catch(function (error) {
        document.getElementById('detail').innerHTML = '<p class="error">加载失败: ' + esc(error.message) + '</p>';
      });
  }

  function bindToolbar() {
    var filter = document.getElementById('stateFilter');
    var limit = document.getElementById('historyLimit');
    if (filter) { filter.addEventListener('change', renderAgentDetail); }
    if (limit) { limit.addEventListener('change', renderAgentDetail); }
  }

  function refresh() {
    fetchJson('/v1/health')
      .then(function (health) {
        document.getElementById('health').textContent =
          'protocol v' + health.protocolVersion + ' · agents: ' + health.agents
          + ' · uptime ' + Math.floor(health.uptimeMs / 1000) + 's';
        return fetchJson('/v1/agents');
      })
      .then(function (data) {
        renderAgents(data.agents || []);
        if (selectedUuid) { renderAgentDetail(); }
      })
      .catch(function (error) {
        document.getElementById('health').textContent = '连接失败: ' + error.message;
      });
  }

  document.getElementById('refreshBtn').addEventListener('click', refresh);
  document.getElementById('autoToggle').addEventListener('change', function (event) {
    autoRefresh = event.target.checked;
    if (timer) { clearInterval(timer); timer = null; }
    if (autoRefresh) { timer = setInterval(refresh, 3000); }
  });
  refresh();
  timer = setInterval(refresh, 3000);
`;

export const WEB_UI_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${TITLE}</title>
<style>${STYLES}</style>
</head>
<body>
<header>
  <div>
    <h1>${TITLE}</h1>
    <div class="meta" id="health">正在连接…</div>
  </div>
  <div class="controls">
    <label><input type="checkbox" id="autoToggle" checked> 自动刷新 3s</label>
    <button id="refreshBtn">立即刷新</button>
  </div>
</header>
<main>
  <section class="panel">
    <h2>Agents</h2>
    <table>
      <thead><tr><th>uuid</th><th>name</th><th>cwd</th><th>lastSeen</th><th>states</th><th class="num">reports</th></tr></thead>
      <tbody id="agentRows"></tbody>
    </table>
  </section>
  <section class="panel" id="detail">
    <p class="empty">选择一个 agent 查看逐状态最新载荷与历史</p>
  </section>
</main>
<script>${SCRIPT}</script>
</body>
</html>
`;
