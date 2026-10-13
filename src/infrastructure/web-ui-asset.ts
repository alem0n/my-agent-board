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
  .online-mark { font-weight: bold; }
  .kpis { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 14px; }
  .kpi {
    background: #151b22; border: 1px solid #242d36; border-radius: 8px;
    padding: 8px 14px; font-size: 13px; color: #9faab5;
  }
  .kpi b { font-size: 16px; margin-left: 6px; color: #dbe2ea; }
  .health-mark { font-weight: bold; }
  .attention { margin: 8px 0 0; padding-left: 20px; font-size: 13px; }
  .attention li { margin-bottom: 4px; }
  .phase-mark { font-size: 12px; }
  .trends { display: flex; gap: 12px; flex-wrap: wrap; margin: 12px 0 6px; }
  .trend {
    background: #0d1117; border: 1px solid #222b34; border-radius: 8px;
    padding: 8px 12px; min-width: 150px;
  }
  .trend .trend-label { font-size: 12px; color: #7a8794; margin-bottom: 4px; }
  .trend .trend-value { font-size: 13px; color: #dbe2ea; }
  .spark polyline { vector-effect: non-scaling-stroke; }
  .tl { margin-top: 10px; }
  .tl-item {
    display: flex; gap: 10px; align-items: baseline; padding: 5px 2px;
    border-bottom: 1px solid #1c232c; font-size: 12px;
  }
  .tl-item:hover { background: #1b242e; }
  .tl-dot { color: #8ab4d8; }
  .tl-time { font-family: ui-monospace, monospace; color: #7a8794; white-space: nowrap; }
  .tl-state { white-space: nowrap; min-width: 96px; }
  .tl-sum { color: #9faab5; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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

  var stateLabel = function (state) {
    return STATE_LABELS[state] || state || '-';
  };

  // 派生态符号（BOARD.md §5）：文本符号，不依赖颜色。
  // ● 良好 / ◐ 观察 / ! 需处理 / — 无数据（离线且无错误信号时不评级）
  var HEALTH_SYMBOL = { good: '●', watch: '◐', attention: '!', unknown: '—' };
  var HEALTH_LABEL = { good: '良好', watch: '观察', attention: '需处理', unknown: '无数据' };
  var PHASE_LABEL = {
    offline: '离线',
    'waiting-human': '等待人工',
    tool: '工具执行中',
    compacting: '压缩中',
    streaming: '流式输出中',
    active: '活动中',
    idle: '空闲',
  };

  function healthSymbol(agent) {
    var h = agent.health;
    if (!h) { return '—'; }
    return HEALTH_SYMBOL[h.level] || '—';
  }

  function healthTitle(agent) {
    var h = agent.health;
    if (!h) { return '无派生数据'; }
    var prefix = HEALTH_LABEL[h.level] || h.level;
    var first = (h.attention || [])[0];
    return first ? prefix + ' · ' + first.detail : prefix;
  }

  function phaseLabel(agent) {
    return PHASE_LABEL[agent.phase] || agent.phase || '-';
  }

  // 关注度排序（C2）：需处理 → 观察 → 良好 → 无数据；同档按 lastSeen 倒序。
  function attentionRank(agent) {
    var level = agent.health ? agent.health.level : 'unknown';
    if (level === 'attention') { return 0; }
    if (level === 'watch') { return 1; }
    if (level === 'good') { return 2; }
    return 3;
  }

  function formatDuration(ms) {
    if (ms === undefined || ms === null || ms < 0) { return '-'; }
    var s = Math.round(ms / 1000);
    if (s < 60) { return s + 's'; }
    if (s < 3600) { return Math.floor(s / 60) + 'm' + (s % 60 ? ' ' + (s % 60) + 's' : ''); }
    return Math.floor(s / 3600) + 'h' + (s % 3600 ? ' ' + Math.floor((s % 3600) / 60) + 'm' : '');
  }

  function runLine(run) {
    if (!run || run.startedAt === null) { return '无 run 记录'; }
    var outcome = run.running
      ? '进行中'
      : ({ completed: '完成', aborted: '中止', error: '出错' }[run.outcome] || run.outcome || '-');
    var parts = [outcome, run.turns + ' 轮', run.toolCalls + ' 次工具'];
    if (run.totalTokens > 0) { parts.push(run.totalTokens.toLocaleString('en-US') + ' tokens'); }
    parts.push(formatDuration(run.durationMs) + (run.running ? '（已用）' : '用时'));
    return parts.join(' · ');
  }

  // 事件时间线（C3）与趋势（C4）展示辅助
  function clockTime(ms) {
    if (ms === undefined || ms === null) { return '-'; }
    var d = new Date(ms);
    function pad(n) { return (n < 10 ? '0' : '') + n; }
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  /** 单条历史的摘要字段（取 1-2 个能说明事件含义的字段，全量在 title 悬停）。 */
  function entrySummary(entry) {
    if (entry.kind === 'identity_change') {
      return '身份变更：' + Object.keys(entry.fields || {}).join(',');
    }
    var p = entry.payload || {};
    var parts = [];
    if (p['role'] !== undefined) { parts.push(p['role']); }
    if (p['messageType'] !== undefined) { parts.push(p['messageType']); }
    if (p['toolName'] !== undefined) { parts.push(p['toolName']); }
    if (p['isError'] === true) { parts.push('失败'); }
    if (p['status'] !== undefined) { parts.push('HTTP ' + p['status']); }
    if (p['stopReason'] !== undefined) { parts.push(p['stopReason']); }
    if (p['outcome'] !== undefined) { parts.push(p['outcome']); }
    if (p['reason'] !== undefined) { parts.push(p['reason']); }
    if (p['durationMs'] !== undefined) { parts.push(p['durationMs'] + 'ms'); }
    if (p['usageTotalTokens'] !== undefined) { parts.push(p['usageTotalTokens'] + ' tokens'); }
    if (p['turnIndex'] !== undefined) { parts.push('轮 ' + p['turnIndex']); }
    if (p['model'] !== undefined) { parts.push(p['model']); }
    if (p['source'] !== undefined) { parts.push(p['source']); }
    return parts.join(' · ');
  }

  /** 内联 SVG 迷你趋势线（零外部资源；单色线条，不依赖颜色区分序列）。 */
  function sparkline(values, label, unit) {
    var latest = values.length > 0 ? values[values.length - 1] : null;
    var valueText = latest === null ? '无数据' : latest.toLocaleString('en-US') + (unit || '');
    if (values.length < 2) {
      return '<div class="trend"><div class="trend-label">' + label + '</div><div class="trend-value">'
        + valueText + '</div></div>';
    }
    var min = Infinity, max = -Infinity;
    for (var i = 0; i < values.length; i += 1) {
      if (values[i] < min) { min = values[i]; }
      if (values[i] > max) { max = values[i]; }
    }
    var w = 140, h = 28;
    var span = max === min ? 0 : max - min;
    var pts = [];
    for (var j = 0; j < values.length; j += 1) {
      var x = (j / (values.length - 1)) * (w - 2) + 1;
      var y = h - 3 - (span === 0 ? 0 : ((values[j] - min) / span) * (h - 6));
      pts.push(x.toFixed(1) + ',' + y.toFixed(1));
    }
    return '<div class="trend"><div class="trend-label">' + label + '</div>'
      + '<svg class="spark" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" role="img">'
      + '<polyline points="' + pts.join(' ') + '" fill="none" stroke="#8ab4d8" stroke-width="1.5"/>'
      + '</svg><div class="trend-value">' + valueText + '</div></div>';
  }

  /** 从历史条目计算三条趋势序列：消息 token / 工具耗时 / 错误率。 */
  function computeTrends(entries) {
    var tokens = [], durations = [];
    var attempts = 0, errors = 0;
    var buckets = [];
    var bucketSize = Math.max(5, Math.ceil(attemptsTotal() / 24));
    function attemptsTotal() {
      var n = 0;
      for (var i = 0; i < entries.length; i += 1) {
        var e = entries[i];
        if (e.kind !== 'report') { continue; }
        if (e.state === 'tool_execution_end' || e.state === 'after_provider_response') { n += 1; }
      }
      return n;
    }
    // 错误率按固定桶聚合（最多 24 点）：after_provider_response >=400 或 tool 失败。
    function flushBucket() {
      if (attempts > 0) {
        buckets.push(errors / attempts);
        attempts = 0;
        errors = 0;
      }
    }
    for (var k = 0; k < entries.length; k += 1) {
      var entry = entries[k];
      if (entry.kind !== 'report') { continue; }
      if (entry.state === 'message_end' && entry.payload && entry.payload.usage
          && typeof entry.payload.usage.totalTokens === 'number') {
        tokens.push(entry.payload.usage.totalTokens);
      }
      if (entry.state === 'tool_execution_end' && entry.payload
          && typeof entry.payload.durationMs === 'number') {
        durations.push(entry.payload.durationMs);
      }
      if (entry.state === 'after_provider_response' || entry.state === 'tool_execution_end') {
        var bad = false;
        if (entry.state === 'after_provider_response') {
          bad = typeof entry.payload.status === 'number' && entry.payload.status >= 400;
        } else {
          bad = entry.payload.isError === true;
        }
        attempts += 1;
        if (bad) { errors += 1; }
        if (attempts >= bucketSize) { flushBucket(); }
      }
    }
    flushBucket();
    var errPct = buckets.map(function (r) { return Math.round(r * 100); });
    return { tokens: tokens, durations: durations, errPct: errPct };
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

  function renderKpis(agents) {
    var c = { attention: 0, watch: 0, good: 0, offline: 0 };
    for (var i = 0; i < agents.length; i += 1) {
      var a = agents[i];
      var level = a.health ? a.health.level : 'unknown';
      if (level === 'attention') { c.attention += 1; }
      else if (level === 'watch') { c.watch += 1; }
      else if (level === 'good') { c.good += 1; }
      if (a.online === false) { c.offline += 1; }
    }
    var kpi = function (mark, label, n) {
      return '<div class="kpi"><span class="health-mark">' + mark + '</span> ' + label + ' <b>' + n + '</b></div>';
    };
    document.getElementById('kpis').innerHTML =
      kpi('!', '需处理', c.attention)
      + kpi('◐', '观察', c.watch)
      + kpi('●', '良好', c.good)
      + kpi('✗', '离线', c.offline);
  }

  function renderAgents(agents) {
    var sorted = agents.slice().sort(function (a, b) {
      return attentionRank(a) - attentionRank(b) || b.lastSeen - a.lastSeen;
    });
    var rows = sorted.map(function (a) {
      var cls = 'clickable' + (a.uuid === selectedUuid ? ' selected' : '');
      return '<tr class="' + cls + '" data-uuid="' + esc(a.uuid) + '">'
        + '<td class="online-mark" title="' + (a.online ? '在线' : '离线') + '">'
        + (a.online ? '✓' : '✗') + '</td>'
        + '<td class="health-mark" title="' + esc(healthTitle(a)) + '">' + healthSymbol(a) + '</td>'
        + '<td class="phase-mark" title="运行相位">' + esc(phaseLabel(a)) + '</td>'
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
      || '<tr><td colspan="10" class="empty">暂无 agent 上报</td></tr>';
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
          // 竞态守卫：in-flight 的详情渲染可能晚于删除完成（selectedUuid 已清），
          // 不让它用 404 覆盖「已删除」提示。
          if (!selectedUuid) { return; }
          var entries = history.entries || [];
          // 趋势（C4）：消息 token / 工具耗时 / 错误率
          var trends = computeTrends(entries);
          var trendsHtml = '';
          if (entries.length > 0) {
            trendsHtml = '<h2 style="margin-top:20px">趋势</h2><div class="trends">'
              + sparkline(trends.tokens, '消息 token', '')
              + sparkline(trends.durations, '工具耗时', 'ms')
              + sparkline(trends.errPct, '错误率', '%')
              + '</div>';
          }
          // 事件时间线（C3）：最新在上，逐条摘要 + 全量悬停
          var reversed = entries.slice().reverse();
          var timelineHtml = reversed.map(function (e) {
            var full = e.kind === 'identity_change'
              ? JSON.stringify(e.fields || {})
              : JSON.stringify(e.payload);
            return '<div class="tl-item" title="' + esc(full) + '">'
              + '<span class="tl-dot">●</span>'
              + '<span class="tl-time">' + clockTime(e.timestamp) + '</span>'
              + '<span class="tl-state">' + esc(e.kind === 'identity_change' ? '身份变更' : stateLabel(e.state)) + '</span>'
              + '<span class="tl-sum">' + esc(entrySummary(e)) + '</span>'
              + '</div>';
          }).join('') || '<p class="empty">无历史</p>';
          // 派生状态块（BOARD.md A1-A4）：相位 / 健康度+原因 / run 摘要
          var s = agent.status;
          var statusHtml = '';
          if (s) {
            var attHtml = '';
            var list = s.health.attention || [];
            if (list.length > 0) {
              var lis = list.map(function (item) {
                var mark = item.severity === 'error' ? '<b>!</b>' : '<b>◐</b>';
                return '<li>' + mark + ' ' + esc(item.detail) + '</li>';
              }).join('');
              attHtml = '<ul class="attention">' + lis + '</ul>';
            }
            statusHtml = '<h2 style="margin-top:20px">运行状态</h2>'
              + '<p class="meta">相位 <b>' + esc(phaseLabel(s)) + '</b>'
              + ' · 健康 <span class="health-mark" title="' + esc(healthTitle({ health: s.health })) + '">'
              + healthSymbol(s) + '</span> ' + esc(HEALTH_LABEL[s.health.level] || s.health.level)
              + '</p>'
              + '<p class="meta">最近 run：' + esc(runLine(s.run)) + '</p>'
              + attHtml;
          }
          document.getElementById('detail').innerHTML =
            '<h2>' + esc(agent.name) + ' <span class="uuid">' + esc(agent.uuid) + '</span></h2>'
            + '<p class="meta"><span class="online-mark">' + (agent.online ? '✓' : '✗') + '</span>'
            + (agent.online ? '在线' : '离线')
            + ' · lastSeen ' + relativeTime(agent.lastSeen)
            + ' · lastHeartbeat ' + (agent.lastHeartbeat ? relativeTime(agent.lastHeartbeat) : '从未') + '</p>'
            + statusHtml
            + '<div class="toolbar">'
            + '<label>状态 <select id="stateFilter"><option value="">全部状态</option>' + stateOptions + '</select></label>'
            + '<label>条数 <input id="historyLimit" type="number" min="1" max="200" value="' + limit + '"></label>'
            + '<button id="deleteBtn" type="button">删除该 agent</button>'
            + '</div>'
            + '<h2>最新状态</h2><table><thead><tr><th>state</th><th>时间</th><th>payload</th></tr></thead><tbody>' + latestHtml + '</tbody></table>'
            + trendsHtml
            + '<h2 style="margin-top:20px">事件时间线（最近 ' + entries.length + ' 条，新在上）</h2>'
            + '<div class="tl">' + timelineHtml + '</div>';
          bindToolbar();
        });
      })
      .catch(function (error) {
        document.getElementById('detail').innerHTML = '<p class="error">加载失败: ' + esc(error.message) + '</p>';
      });
  }

  function deleteSelectedAgent() {
    if (!selectedUuid) { return; }
    var uuid = selectedUuid;
    // 治理操作（请求即授权）：给一次确认，并说明存活进程会重建记录（信任模型）
    if (!window.confirm('删除该 agent？latest 与历史一并删除。'
      + '若该进程仍在线，其下次上报或心跳会重建记录。')) { return; }
    fetch('/v1/agents/' + encodeURIComponent(uuid), { method: 'DELETE' })
      .then(function (res) {
        if (res.status === 404) {
          throw new Error('记录已不存在（可能已被其他途径删除）');
        }
        if (!res.ok) { throw new Error('HTTP ' + res.status); }
        selectedUuid = null;
        document.getElementById('detail').innerHTML =
          '<p class="empty">已删除。选择一个 agent 查看逐状态最新载荷与历史</p>';
        refresh();
      })
      .catch(function (error) {
        document.getElementById('detail').innerHTML =
          '<p class="error">删除失败: ' + esc(error.message) + '</p>';
        refresh();
      });
  }

  function bindToolbar() {
    var filter = document.getElementById('stateFilter');
    var limit = document.getElementById('historyLimit');
    var del = document.getElementById('deleteBtn');
    if (filter) { filter.addEventListener('change', renderAgentDetail); }
    if (limit) { limit.addEventListener('change', renderAgentDetail); }
    if (del) { del.addEventListener('click', deleteSelectedAgent); }
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
        renderKpis(data.agents || []);
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
<div class="kpis" id="kpis"></div>
<main>
  <section class="panel">
    <h2>Agents</h2>
    <table>
      <thead><tr><th title="在线状态（REQ-013：近 60s 有上报或心跳）">在线</th><th title="健康度（BOARD.md A3：● 良好 / ◐ 观察 / ! 需处理 / — 无数据）">健康</th><th title="运行相位（A1）">相位</th><th>状态</th><th>name</th><th>cwd</th><th>lastSeen</th><th>states</th><th class="num">reports</th><th>uuid</th></tr></thead>
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
