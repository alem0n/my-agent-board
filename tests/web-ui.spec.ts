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

  it('agents 表列为「在线圆点领头、状态次之、uuid 最后」的上下布局（防回潮）', () => {
    expect(WEB_UI_HTML).toContain('grid-template-columns: 1fr;');
    expect(WEB_UI_HTML).not.toContain('grid-template-columns: minmax');
    const head = /<thead><tr>(.*?)<\/tr><\/thead>/.exec(WEB_UI_HTML)?.[1] ?? '';
    expect(head.startsWith('<th title="在线状态')).toBe(true);
    expect(
      head.startsWith(
        '<th title="在线状态（REQ-013：近 60s 有上报或心跳）">在线</th><th>状态</th>',
      ),
    ).toBe(true);
    expect(head.endsWith('<th>uuid</th>')).toBe(true);
    // 在线圆点渲染（REQ-013）
    expect(WEB_UI_HTML).toContain("a.online ? 'dot-on' : 'dot-off'");
    // 圆点样式在 <style>（STYLES）内，不在 <script>（SCRIPT）内
    expect(WEB_UI_HTML).toContain('.dot-on { background: #2ea043; }');
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
  });

  it('内联 <script> 语法可解析（CSS 误插进 SCRIPT 的 P0 回归防护）', () => {
    const scriptMatch = /<script>([\s\S]*)<\/script>/.exec(WEB_UI_HTML);
    expect(scriptMatch).not.toBeNull();
    expect(() => new Function(scriptMatch?.[1] ?? '')).not.toThrow();
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
