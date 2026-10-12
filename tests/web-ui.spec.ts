/**
 * 内置 Web UI 测试：--web 开关的挂载与隔离契约。
 */
import { describe, it, expect } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BoardHttpServer } from '../src/infrastructure/http-server.js';
import { AgentRegistry } from '../src/services/registry.js';
import { WEB_UI_HTML } from '../src/infrastructure/web-ui-asset.js';
import { loadServerConfig } from '../src/config.js';
import { FileRegistryStore } from '../src/infrastructure/registry-file-store.js';
import { boardLogger } from '../src/logger.js';

let registry: AgentRegistry;

function startServer(webUi: boolean): Promise<BoardHttpServer & { port: number }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-webui-'));
  registry = new AgentRegistry(
    new FileRegistryStore(path.join(dir, 'agents.json'), boardLogger),
    boardLogger,
    {
      historyLimit: 10,
      persistDebounceMs: 10,
    },
  );
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
      registry.close();
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
      registry.close();
    }
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
      registry.close();
    }
  });
});
