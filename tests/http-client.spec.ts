/**
 * HttpTransport 单元测试：真实 node:http 响应解析（成功/部分拒绝/413/非 2xx/网络失败）。
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'node:http';
import * as net from 'node:net';
import type { AddressInfo } from 'node:net';
import { HttpTransport } from '../src/infrastructure/http-client.js';
import { silentLogger } from '../src/domain/logging.js';
import { BatchTooLargeError } from '../src/domain/errors.js';

let server: http.Server | undefined;
let handler: ((request: http.IncomingMessage, response: http.ServerResponse) => void) | undefined;

async function start(
  respond: (request: http.IncomingMessage, response: http.ServerResponse) => void,
): Promise<string> {
  handler = respond;
  server = http.createServer((request, response) => handler?.(request, response));
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function stop(): Promise<void> {
  const current = server;
  server = undefined;
  if (current === undefined) {
    return;
  }
  await new Promise<void>((resolve) => {
    current.closeAllConnections();
    current.close(() => resolve());
  });
}

function makeTransport(url: string) {
  return new HttpTransport({ serverUrl: url, requestTimeoutMs: 2_000, logger: silentLogger });
}

/** 取一个“刚刚释放”的端口：内核保证对其连接立即 RST（ECONNREFUSED）。 */
async function freedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.listen(0, '127.0.0.1', () => {
      const address = socket.address() as net.AddressInfo;
      socket.close(() => resolve(address.port));
    });
    socket.on('error', reject);
  });
}

afterEach(async () => {
  await stop();
});

describe('HttpTransport', () => {
  it('2xx 响应解析为成功 ReportResponse', async () => {
    const url = await start((_req, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          ok: true,
          uuid: '11111111-1111-1111-1111-111111111111',
          assigned: true,
          accepted: 3,
        }),
      );
    });
    const transport = makeTransport(url);
    const result = await transport.postBatch([
      {
        protocolVersion: '1',
        state: 'agent_start',
        timestamp: 1,
        agent: { name: 'a', cwd: '/c' },
        payload: {},
      },
    ]);
    expect(result.ok).toBe(true);
    expect(result.uuid).toBe('11111111-1111-1111-1111-111111111111');
    expect(result.assigned).toBe(true);
    expect(result.accepted).toBe(3);
  });

  it('400 + rejected 数组解析为 ok:false（供 client 剔除毒信）', async () => {
    const url = await start((_req, response) => {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          ok: false,
          rejected: [{ index: 0, code: 'E_INVALID_PAYLOAD', message: 'bad', state: 'turn_end' }],
        }),
      );
    });
    const transport = makeTransport(url);
    const result = await transport.postBatch([]);
    expect(result.ok).toBe(false);
    expect(result.rejected).toEqual([
      { index: 0, code: 'E_INVALID_PAYLOAD', message: 'bad', state: 'turn_end' },
    ]);
  });

  it('413 抛 BatchTooLargeError（client 拆分重试信号）', async () => {
    const url = await start((_req, response) => {
      response.writeHead(413);
      response.end('{}');
    });
    const transport = makeTransport(url);
    await expect(transport.postBatch([])).rejects.toBeInstanceOf(BatchTooLargeError);
  });

  it('其他非 2xx 抛常规错误且包含状态码', async () => {
    const url = await start((_req, response) => {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { code: 'E_INTERNAL', message: 'boom' } }));
    });
    const transport = makeTransport(url);
    const error = await transport.postBatch([]).catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('500');
    expect(error.message).toContain('boom');
  });

  it('2xx 但响应体缺少 uuid 抛错（协议完整性）', async () => {
    const url = await start((_req, response) => {
      response.writeHead(200);
      response.end(JSON.stringify({ ok: true }));
    });
    const transport = makeTransport(url);
    await expect(transport.postBatch([])).rejects.toThrow(/uuid/);
  });

  it('响应体非 JSON 抛错', async () => {
    const url = await start((_req, response) => {
      response.writeHead(200);
      response.end('not-json');
    });
    const transport = makeTransport(url);
    await expect(transport.postBatch([])).rejects.toThrow(/parse failed/);
  });

  it('健康探测：2xx true、连接失败 false', async () => {
    const url = await start((_req, response) => {
      response.writeHead(200);
      response.end('{}');
    });
    const transport = makeTransport(url);
    expect(await transport.health()).toBe(true);
    await stop();
    // 不复用已关闭 origin（undici 连接池可能持有僵死 keep-alive 套接字）
    const dead = makeTransport(`http://127.0.0.1:${await freedPort()}`);
    expect(await dead.health()).toBe(false);
  });

  it('连接被拒绝时抛网络错误', async () => {
    const transport = makeTransport(`http://127.0.0.1:${await freedPort()}`);
    await expect(transport.postBatch([])).rejects.toThrow(/batch request failed/);
  });
});
