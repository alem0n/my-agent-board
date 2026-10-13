/**
 * 内置 Web UI 测试：--web 开关的挂载与隔离契约。
 */
import { describe, it, expect } from 'vitest';
import * as http from 'node:http';
import { BoardHttpServer } from '../src/infrastructure/http-server.js';
import { AgentRegistry } from '../src/services/registry.js';
import { WEB_UI_HTML } from '../src/infrastructure/web-ui-asset.js';
import { loadServerConfig } from '../src/config.js';
import { boardLogger } from '../src/logger.js';

let registry: AgentRegistry;

function startServer(webUi: boolean): Promise<BoardHttpServer & { port: number }> {
  registry = new AgentRegistry(boardLogger, { historyLimit: 10 });
  const server = new BoardHttpServer({
    host: '127.0.0.1',
    port: 0,
    registry,
    logger: boardLogger,
    webUi,
  });
  return server.start().then((address) => ({ ...server, port: address.port, stop: server.stop }));
}

function get(
  port: number,
  path: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
  });
}

describe('--web 开关参数解析', () => {
  it('裸 --web 与 --web=true 开启；--web=false / 非法值 / 缺省 关闭', () => {
    expect(loadServerConfig(['node', 'x', '--web']).webUi).toBe(true);
    expect(loadServerConfig(['node', 'x', '--web=true']).webUi).toBe(true);
    expect(loadServerConfig(['node', 'x', '--web=TRUE']).webUi).toBe(true);
    expect(loadServerConfig(['node', 'x', '--web=false']).webUi).toBe(false);
    expect(loadServerConfig(['node', 'x', '--web=maybe']).webUi).toBe(false);
    expect(loadServerConfig(['node', 'x', '--port=9999']).webUi).toBe(false);
  });
});

describe('Web UI 挂载契约', () => {
  it('启用时 GET / 与 /ui 返回 HTML，API 路由不受影响', async () => {
    const server = await startServer(true);
    try {
      const root = await get(server.port, '/');
      expect(root.status).toBe(200);
      expect(root.headers['content-type']).toContain('text/html');
      expect(root.body).toBe(WEB_UI_HTML);
      expect(root.body).toContain('agent-board');

      const ui = await get(server.port, '/ui');
      expect(ui.status).toBe(200);
      expect(ui.body).toBe(WEB_UI_HTML);

      // API 路由共存
      const health = await get(server.port, '/v1/health');
      expect(health.status).toBe(200);
      expect(JSON.parse(health.body)['protocolVersion']).toBe('1');
    } finally {
      await server.stop();
    }
  });

  it('关闭时 GET / 与 /ui 返回 404 JSON（默认行为，用户可自行可视化）', async () => {
    const server = await startServer(false);
    try {
      const root = await get(server.port, '/');
      expect(root.status).toBe(404);
      const errorBody = JSON.parse(root.body) as { error: { code: string } };
      expect(errorBody.error.code).toBe('E_NOT_FOUND');
      const ui = await get(server.port, '/ui');
      expect(ui.status).toBe(404);
    } finally {
      await server.stop();
    }
  });

  it('agents 表列为「在线符号领头、状态次之、uuid 最后」的上下布局（防回潮）', () => {
    expect(WEB_UI_HTML).toContain('grid-template-columns: 1fr;');
    expect(WEB_UI_HTML).not.toContain('grid-template-columns: minmax');
    const head = /<thead><tr>(.*?)<\/tr><\/thead>/.exec(WEB_UI_HTML)?.[1] ?? '';
    expect(head.startsWith('<th title="在线状态')).toBe(true);
    expect(
      head.startsWith(
        '<th title="在线状态（REQ-013：近 60s 有上报或心跳）">在线</th><th title="健康度（BOARD.md A3：● 良好 / ◐ 观察 / ! 需处理 / — 无数据）">健康</th><th title="运行相位（A1）">相位</th><th>状态</th>',
      ),
    ).toBe(true);
    expect(head.endsWith('<th>uuid</th>')).toBe(true);
    // 在线状态以文本符号 ✓/✗ 表示（不用颜色圆点）
    expect(WEB_UI_HTML).toContain("(a.online ? '✓' : '✗')");
    expect(WEB_UI_HTML).not.toContain('dot-on');
    expect(WEB_UI_HTML).not.toContain('dot-off');
    // 健康度同样以符号呈现（A3）：●/◐/!/—，不用颜色
    expect(WEB_UI_HTML).toContain(
      "var HEALTH_SYMBOL = { good: '●', watch: '◐', attention: '!', unknown: '—' };",
    );
    // 相位标签（A1）
    expect(WEB_UI_HTML).toContain("'waiting-human': '等待人工'");
    expect(WEB_UI_HTML).toContain("streaming: '流式输出中'");
    // KPI 条容器（C1）
    expect(WEB_UI_HTML).toContain('<div class="kpis" id="kpis"></div>');
    expect(WEB_UI_HTML).toContain("kpi('!', '需处理', c.attention)");
    // 关注度排序（C2）：需处理 → 观察 → 良好 → 无数据，同档 lastSeen 倒序
    expect(WEB_UI_HTML).toContain('attentionRank(a) - attentionRank(b) || b.lastSeen - a.lastSeen');
    // 详情面板的派生状态块：相位/健康/run 摘要/注意项
    expect(WEB_UI_HTML).toContain('\'<h2 style="margin-top:20px">运行状态</h2>\'');
    expect(WEB_UI_HTML).toContain('esc(runLine(s.run))');
    // 详情块的健康提示读 status.health（详情响应无顶层 health 字段）
    expect(WEB_UI_HTML).toContain('healthTitle({ health: s.health })');
    expect(WEB_UI_HTML).toContain('<ul class="attention">');
    // 状态列渲染最后上报事件的中文标签
    expect(WEB_UI_HTML).toContain('stateLabel(a.lastState)');
    // 中文标签表覆盖 42 项状态（抽样校验中英文映射存在）
    expect(WEB_UI_HTML).toContain("agent_snapshot: '环境快照'");
    expect(WEB_UI_HTML).toContain("tool_call: '工具调用'");
    expect(WEB_UI_HTML).toContain("session_start: '会话启动'");
    // 点击详情的 null 崩溃修复：historyLimit/stateFilter 读前有存在性检查
    expect(WEB_UI_HTML).toContain("var limitEl = document.getElementById('historyLimit');");
    expect(WEB_UI_HTML).toContain("var filterEl = document.getElementById('stateFilter');");
    expect(WEB_UI_HTML).toContain("' + esc(a.uuid) + '</span></td>'");
    // 空表占位与新列数一致（10 列）
    expect(WEB_UI_HTML).toContain('colspan="10"');
  });

  it('内联 <script> 语法可解析（CSS 误插进 SCRIPT 的 P0 回归防护）', () => {
    const scriptMatch = /<script>([\s\S]*)<\/script>/.exec(WEB_UI_HTML);
    expect(scriptMatch).not.toBeNull();
    expect(() => new Function(scriptMatch?.[1] ?? '')).not.toThrow();
  });

  it('详情面板提供删除功能（按钮 + DELETE 请求 + 确认 + 绑定）', () => {
    expect(WEB_UI_HTML).toContain('<button id="deleteBtn" type="button">删除该 agent</button>');
    expect(WEB_UI_HTML).toContain('function deleteSelectedAgent');
    expect(WEB_UI_HTML).toContain("'/v1/agents/' + encodeURIComponent(uuid), { method: 'DELETE' }");
    // 确认对话框 + 重建提示（信任模型：存活进程下次上报/心跳会重建记录）
    expect(WEB_UI_HTML).toContain('window.confirm');
    expect(WEB_UI_HTML).toContain('其下次上报或心跳会重建记录');
    expect(WEB_UI_HTML).toContain("getElementById('deleteBtn')");
    // 删除后清除选中并刷新
    expect(WEB_UI_HTML).toContain('selectedUuid = null;');
    // 详情渲染后重绑定工具条（含删除按钮）；漏绑则按钮无响应
    expect(WEB_UI_HTML).toContain('bindToolbar();');
  });

  it('详情页历史区为事件时间线 + 趋势图（C3/C4，替代原始 JSON 表）', () => {
    // 时间线：逐条摘要 + 全量悬停，最新在上
    expect(WEB_UI_HTML).toContain('function entrySummary');
    expect(WEB_UI_HTML).toContain('function clockTime');
    expect(WEB_UI_HTML).toContain('class="tl"');
    expect(WEB_UI_HTML).toContain('事件时间线（最近 ');
    expect(WEB_UI_HTML).not.toContain('历史（最近 ');
    // 趋势：内联 SVG 迷你线，零外部资源
    expect(WEB_UI_HTML).toContain('function computeTrends');
    expect(WEB_UI_HTML).toContain('function sparkline');
    expect(WEB_UI_HTML).toContain('<polyline');
    expect(WEB_UI_HTML).toContain('消息 token');
    expect(WEB_UI_HTML).toContain('工具耗时');
    expect(WEB_UI_HTML).toContain('错误率');
    // P1 新字段进入时间线摘要
    expect(WEB_UI_HTML).toContain("p['durationMs'] !== undefined");
  });

  it('UI 页面引用的 API 端点均存在（无悬空 fetch）', async () => {
    const paths = ['/v1/health', '/v1/agents'];
    expect(WEB_UI_HTML).toMatch(/\/v1\/agents/);
    expect(WEB_UI_HTML).toMatch(/\/v1\/agents\/' \+ encodeURIComponent/);
    const server = await startServer(true);
    try {
      for (const path of paths) {
        const res = await get(server.port, path);
        expect(res.status).toBe(200);
      }
    } finally {
      await server.stop();
    }
  });
});

describe('UI 派生状态函数行为（从内联脚本提取执行）', () => {
  const script = /<script>([\s\S]*)<\/script>/.exec(WEB_UI_HTML)?.[1] ?? '';

  /** 提取单个函数源码并执行（无 DOM 依赖的纯函数）。 */
  function extractFunction(name: string): string {
    const re = new RegExp(`function ${name}\\([\\s\\S]*?\\n  \\}`);
    const body = re.exec(script)?.[0] ?? '';
    expect(body, `function ${name} not found`).toBeTruthy();
    return body;
  }

  it('attentionRank 按级别排队且未知级别兼底为最低档', () => {
    const rank = new Function(`${extractFunction('attentionRank')}; return attentionRank;`)() as (
      agent: Record<string, unknown>,
    ) => number;
    expect(rank({ health: { level: 'attention' } })).toBe(0);
    expect(rank({ health: { level: 'watch' } })).toBe(1);
    expect(rank({ health: { level: 'good' } })).toBe(2);
    expect(rank({ health: { level: 'unknown' } })).toBe(3);
    // 无派生数据与对象原型键都不改变排队结果（防御性）
    expect(rank({})).toBe(3);
    expect(rank({ health: { level: 'constructor' } })).toBe(3);
  });

  it('runLine 进行中/完成/无记录三种语义', () => {
    const runLine = new Function(
      `${extractFunction('formatDuration')}${extractFunction('runLine')} return runLine;`,
    )() as (run: Record<string, unknown> | null) => string;
    expect(runLine({ startedAt: null })).toBe('无 run 记录');
    expect(runLine(null)).toBe('无 run 记录');
    const running = runLine({
      running: true,
      startedAt: 1000,
      endedAt: null,
      durationMs: 90_000,
      outcome: null,
      turns: 2,
      toolCalls: 3,
      totalTokens: 5000,
    });
    expect(running).toContain('进行中');
    expect(running).toContain('2 轮');
    expect(running).toContain('3 次工具');
    expect(running).toContain('5,000 tokens');
    const done = runLine({
      running: false,
      startedAt: 1000,
      endedAt: 2000,
      durationMs: 60_000,
      outcome: 'error',
      turns: 1,
      toolCalls: 0,
      totalTokens: 0,
    });
    expect(done).toContain('出错');
    expect(done).toContain('1m');
  });

  it('entrySummary 摘要字段不含 payload 全文（隐私 + 可读性）', () => {
    const entrySummary = new Function(
      `${extractFunction('entrySummary')} return entrySummary;`,
    )() as (entry: Record<string, unknown>) => string;
    expect(
      entrySummary({
        kind: 'report',
        state: 'tool_execution_end',
        payload: { toolName: 'bash', isError: true, durationMs: 340 },
      }),
    ).toBe('bash · 失败 · 340ms');
    expect(
      entrySummary({
        kind: 'report',
        state: 'message_end',
        payload: { role: 'assistant', stopReason: 'tool_use' },
      }),
    ).toBe('assistant · tool_use');
    expect(
      entrySummary({ kind: 'report', state: 'after_provider_response', payload: { status: 429 } }),
    ).toBe('HTTP 429');
    // 身份变更条目走 fields 分支
    expect(
      entrySummary({
        kind: 'identity_change',
        timestamp: 1,
        fields: { name: { from: 'a', to: 'b' } },
      }),
    ).toContain('身份变更');
    // 未知/空字段不报 undefined
    expect(entrySummary({ kind: 'report', state: 'agent_start', payload: {} })).toBe('');
  });

  it('computeTrends 聚合 token/耗时/错误率三序列', () => {
    const computeTrends = new Function(
      `${extractFunction('computeTrends')} return computeTrends;`,
    )() as (entries: Array<Record<string, unknown>>) => {
      tokens: number[];
      durations: number[];
      errPct: number[];
    };
    const entries = [
      { kind: 'report', state: 'message_end', payload: { usage: { totalTokens: 100 } } },
      { kind: 'report', state: 'message_end', payload: { usage: { totalTokens: 300 } } },
      { kind: 'report', state: 'tool_execution_end', payload: { durationMs: 120, isError: false } },
      { kind: 'report', state: 'tool_execution_end', payload: { durationMs: 480, isError: true } },
      { kind: 'report', state: 'after_provider_response', payload: { status: 200 } },
      { kind: 'report', state: 'after_provider_response', payload: { status: 500 } },
    ];
    const trends = computeTrends(entries);
    expect(trends.tokens).toEqual([100, 300]);
    expect(trends.durations).toEqual([120, 480]);
    expect(trends.errPct.length).toBeGreaterThan(0);
    // errPct 已为百分数：4 次尝试 2 次失败（工具失败 + 5xx）→ 50
    const total = trends.errPct.reduce((sum, ratio) => sum + ratio, 0);
    const count = trends.errPct.length;
    expect(Math.round(total / count)).toBe(50);
  });

  it('sparkline 生成内联 SVG，空数据显示无数据，单点仅文本', () => {
    const sparkline = new Function(`${extractFunction('sparkline')} return sparkline;`)() as (
      values: number[],
      label: string,
      unit: string,
    ) => string;
    const empty = sparkline([], '消息 token', '');
    expect(empty).toContain('无数据');
    expect(empty).not.toContain('<svg');
    const single = sparkline([42], '消息 token', '');
    expect(single).toContain('42');
    expect(single).not.toContain('<svg');
    const line = sparkline([1, 5, 2, 8], '工具耗时', 'ms');
    expect(line).toContain('<svg');
    expect(line).toContain('<polyline');
    expect(line).toContain('8ms');
  });
});
