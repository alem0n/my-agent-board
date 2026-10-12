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
  main { display: grid; grid-template-columns: 1fr; gap: 20px; margin-top: 20px; }
  .state-label { font-size: 12px; white-space: nowrap; }
  .state-label .raw { color: #6e7681; font-size: 11px; margin-left: 6px; }
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
  // 42 项监控状态的中文友好标签（与 STATE_REGISTRY 一一对应，未映射状态原样兜底）。
  var STATE_LABELS = {
    session_start: '会话启动',
    session_shutdown: '会话关闭',
    session_info_changed: '会话信息变更',
    session_before_switch: '会话切换前',
    session_before_fork: '会话分叉前',
    session_before_compact: '会话压缩前',
    session_compact: '会话已压缩',
    session_compact_failed: '会话压缩失败',
    session_before_tree: '会话树构建前',
    session_tree: '会话树',
    project_trust: '项目信任决策',
    resources_discover: '资源发现',
    mcp_servers_change: 'MCP 服务器变更',
    cache_warming_decision: '缓存预热决策',
    before_provider_headers: '供应商请求头前',
    before_provider_request: '供应商请求前',
    provider_stream_event: '供应商流式事件',
    after_provider_response: '供应商响应后',
    before_agent_start: 'Agent 启动前',
    agent_start: 'Agent 启动',
    agent_end: 'Agent 结束',
    agent_before_settle: 'Agent 收尾前',
    agent_settled: 'Agent 已收尾',
    ui_prompt_start: '输入提示开始',
    ui_prompt_end: '输入提示结束',
    turn_start: '对话轮开始',
    turn_end: '对话轮结束',
    message_start: '消息开始',
    message_end: '消息结束',
    message_update: '消息更新',
    tool_execution_start: '工具执行开始',
    tool_execution_end: '工具执行结束',
    tool_execution_update: '工具执行更新',
    tool_call: '工具调用',
    tool_result: '工具结果',
    model_select: '模型选择',
    thinking_level_select: '思考级别选择',
    user_bash: '用户命令执行',
    input: '用户输入',
    context: '上下文变更',
    context_with_system: '含系统上下文',
    agent_snapshot: '环境快照'
  };

  function stateLabel(state) {
    return STATE_LABELS[state] || state || '-';
  }

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
        + '<td><span class="state-label" title="' + esc(a.lastState) + '">'
        + esc(stateLabel(a.lastState)) + '<span class="raw">' + esc(a.lastState || '') + '</span>'
        + '</span></td>'
        + '<td>' + esc(a.name) + '</td>'
        + '<td title="' + esc(a.cwd) + '">' + esc(a.cwd) + '</td>'
        + '<td>' + relativeTime(a.lastSeen) + '</td>'
        + '<td class="num"><span class="badge">' + a.stateCount + ' states</span></td>'
        + '<td class="num">' + a.reportCount + '</td>'
        + '<td><span class="uuid">' + esc(a.uuid) + '</span></td>'
        + '</tr>';
    }).join('');
    document.getElementById('agentRows').innerHTML = rows
      || '<tr><td colspan="7" class="empty">暂无 agent 上报</td></tr>';
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
        var limitEl = document.getElementById('historyLimit');
        var limit = limitEl ? (limitEl.value || 20) : 20;
        var filterEl = document.getElementById('stateFilter');
        var stateFilter = filterEl ? filterEl.value : '';
        var historyPath = '/v1/agents/' + encodeURIComponent(selectedUuid)
          + '/history?limit=' + limit + (stateFilter ? '&state=' + encodeURIComponent(stateFilter) : '');
        // 选项带 selected 属性：自动刷新重建面板时筛选状态不丢失。
        var stateOptions = states.map(function (s) {
          var selected = s.state === stateFilter ? ' selected' : '';
          return '<option value="' + esc(s.state) + '"' + selected + '>'
            + esc(s.state) + '（' + esc(stateLabel(s.state)) + '）</option>';
        }).join('');

        var latestHtml = states.map(function (s) {
          return '<tr><td class="state-cell">' + esc(stateLabel(s.state)) + '<span class="raw">' + esc(s.state) + '</span></td>'
            + '<td>' + relativeTime(s.timestamp) + '</td>'
            + '<td><pre>' + esc(JSON.stringify(s.payload, null, 1)) + '</pre></td></tr>';
        }).join('') || '<tr><td colspan="3"><p class="empty">无状态</p></td></tr>';

        return fetchJson(historyPath).then(function (history) {
          var entries = history.entries || [];
          var historyHtml = entries.map(function (e) {
            return '<tr><td class="state-cell">' + esc(stateLabel(e.state)) + '<span class="raw">' + esc(e.state) + '</span></td>'
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
      <thead><tr><th>状态</th><th>name</th><th>cwd</th><th>lastSeen</th><th>states</th><th class="num">reports</th><th>uuid</th></tr></thead>
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
