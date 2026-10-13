/**
 * 端到端测试：真实 HTTP server（node:http）+ 真实 client 库（Reporter/HttpTransport/
 * 身份文件）+ 模拟 pi 环境。覆盖全部 42 状态的上报、uuid 流与查询 API。
 *
 * 对应验收门槛：5 可运行（本地验证）、2 契约（server 侧校验）、3 身份（端到端）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentRegistry } from '../src/services/registry.js';
import { BoardHttpServer } from '../src/infrastructure/http-server.js';
import { FileIdentityStore } from '../src/infrastructure/file-store.js';
import { HttpTransport } from '../src/infrastructure/http-client.js';
import {
  SimulatedEnvironment,
  SimulatedStateSource,
  runAgentSimulation,
} from '../src/infrastructure/simulator.js';
import { Reporter } from '../src/services/reporter.js';
import { boardLogger } from '../src/logger.js';
import { STATE_IDS } from '../src/domain/contracts.js';
import { buildEnvelope } from './fixtures/samples.js';

let dir: string;
let registry: AgentRegistry;
let server: BoardHttpServer;
let baseUrl: string;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-e2e-'));
  registry = new AgentRegistry(boardLogger);
  server = new BoardHttpServer({ host: '127.0.0.1', port: 0, registry, logger: boardLogger });
  const address = await server.start();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await server.stop();
});

function makeReporter(name?: string) {
  const config = {
    serverUrl: baseUrl,
    reportIntervalMs: 60_000,
    flushIntervalMs: 60_000,
    requestTimeoutMs: 5_000,
    maxBufferSize: 500,
    flushOnCount: 10_000,
    heartbeatIntervalMs: 0,
    retry: { maxAttempts: 3, initialDelayMs: 10, maxDelayMs: 100, backoffFactor: 2, jitter: false },
    issues: [],
  };
  const identityStore = new FileIdentityStore(path.join(dir, 'identity.json'), boardLogger);
  const transport = new HttpTransport({
    serverUrl: baseUrl,
    requestTimeoutMs: 5_000,
    logger: boardLogger,
  });
  const source = new SimulatedStateSource();
  const env = new SimulatedEnvironment({ startedAt: Date.now() - 1000 });
  const reporter = new Reporter({
    source,
    env: { snapshot: () => env.snapshot() },
    transport,
    identityStore,
    config: { ...config, ...(name === undefined ? {} : { name }) },
    logger: boardLogger,
  });
  return { reporter, source, env };
}

async function getJson(pathname: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}${pathname}`);
  return { status: response.status, body: await response.json() };
}

async function postJson(
  pathname: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

describe('端到端：全状态上报与身份流', () => {
  it('模拟 client 完整回放后，server 收到全部 42 项状态', async () => {
    const { reporter, source, env } = makeReporter();
    try {
      reporter.start();
      runAgentSimulation({ source, env });
      await reporter.collectSnapshotAndFlush();
      expect(reporter.getStats().droppedRejected).toBe(0);
      expect(reporter.getStats().sent).toBeGreaterThanOrEqual(42);

      const uuid = reporter.currentIdentity!.uuid;
      const agentResponse = await getJson(`/v1/agents/${uuid}`);
      const record = agentResponse.body as Record<string, unknown>;
      const latest = record['latest'] as Record<string, unknown>;
      const receivedStates = new Set(Object.keys(latest));
      const missing = STATE_IDS.filter((state) => !receivedStates.has(state));
      expect(missing).toEqual([]);
      expect(record['name']).toBe(env.snapshot().sessionId); // name 未设置 → 回退 session id
      expect(record['cwd']).toBe(env.snapshot().cwd);
    } finally {
      await reporter.stop();
    }
  }, 30_000);

  it('uuid 分配并持久化；第二次启动复用同一 uuid', async () => {
    const first = makeReporter();
    first.reporter.start();
    runAgentSimulation({ source: first.source, env: first.env });
    await first.reporter.collectSnapshotAndFlush();
    await first.reporter.stop();
    const uuid = first.reporter.currentIdentity!.uuid;

    expect(fs.existsSync(path.join(dir, 'identity.json'))).toBe(true);

    // 复用持久化身份（身份文件被共享 store 加载）
    const second = makeReporter();
    second.reporter.start();
    runAgentSimulation({ source: second.source, env: second.env });
    await second.reporter.collectSnapshotAndFlush();
    await second.reporter.stop();
    expect(second.reporter.currentIdentity!.uuid).toBe(uuid);
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    // 注册表中仍然只有一个 agent
    const agents = (await getJson('/v1/agents')).body as { agents: Array<Record<string, unknown>> };
    expect(agents.agents.map((agent) => agent['uuid'])).toContain(uuid);
  }, 30_000);

  it('health 与 agents 端点返回协议信息', async () => {
    const health = (await getJson('/v1/health')).body as Record<string, unknown>;
    expect(health['status']).toBe('ok');
    expect(health['protocolVersion']).toBe('1');
    expect(typeof health['agents']).toBe('number');
  });
});

describe('端到端：心跳与在线状态（REQ-013）', () => {
  it('心跳更新 lastHeartbeat；online/lastHeartbeat 经列表与单查暴露', async () => {
    const { reporter } = makeReporter();
    reporter.start();
    await reporter.collectSnapshotAndFlush();
    const uuid = reporter.currentIdentity!.uuid;
    await reporter.stop();

    const beat = await postJson('/v1/heartbeat', { uuid });
    expect(beat.status).toBe(200);
    expect((beat.body as Record<string, unknown>)['ok']).toBe(true);

    const record = (await getJson(`/v1/agents/${uuid}`)).body as Record<string, unknown>;
    expect(record['lastHeartbeat']).toBeGreaterThan(0);
    expect(record['online']).toBe(true);
    const agents = (await getJson('/v1/agents')).body as {
      agents: Array<Record<string, unknown>>;
    };
    const summary = agents.agents.find((agent) => agent['uuid'] === uuid);
    expect(summary?.['online']).toBe(true);
    expect(summary?.['lastHeartbeat']).toBeGreaterThan(0);
    // 心跳不作为监控状态落库（不改 reportCount、不写 latest）
    const before = (await getJson(`/v1/agents/${uuid}`)).body as Record<string, unknown>;
    const reportCountBefore = before['reportCount'];
    expect(reportCountBefore).toBeGreaterThan(0);
    expect(record['reportCount']).toBe(reportCountBefore);
    expect((record['latest'] as Record<string, unknown>)['heartbeat']).toBeUndefined();
  }, 30_000);

  it('心跳不创建/复活记录：未知 uuid → 404；DELETE 后心跳 → 404', async () => {
    const unknown = '00000000-0000-0000-0000-0000000000ff';
    const missing = await postJson('/v1/heartbeat', { uuid: unknown });
    expect(missing.status).toBe(404);
    expect(
      ((missing.body as Record<string, unknown>)['error'] as Record<string, unknown>)['code'],
    ).toBe('E_NOT_FOUND');

    const { reporter } = makeReporter();
    reporter.start();
    await reporter.collectSnapshotAndFlush();
    const uuid = reporter.currentIdentity!.uuid;
    await reporter.stop();
    const deleted = await fetch(`${baseUrl}/v1/agents/${uuid}`, { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    const afterDelete = await postJson('/v1/heartbeat', { uuid });
    expect(afterDelete.status).toBe(404);
  }, 30_000);

  it('心跳 body 缺 uuid 或非法 → 400；GET /v1/heartbeat → 405', async () => {
    const empty = await postJson('/v1/heartbeat', {});
    expect(empty.status).toBe(400);
    const malformed = await postJson('/v1/heartbeat', { uuid: 'not-a-uuid' });
    expect(malformed.status).toBe(400);
    const methodNotAllowed = await fetch(`${baseUrl}/v1/heartbeat`, { method: 'GET' });
    expect(methodNotAllowed.status).toBe(405);
  }, 30_000);
});

describe('端到端：server 端契约校验与错误码', () => {
  it('POST /v1/report 单信封合法返回 200 与 uuid', async () => {
    const result = await postJson('/v1/report', buildEnvelope('agent_settled', {}));
    expect(result.status).toBe(200);
    const body = result.body as Record<string, unknown>;
    expect(body['ok']).toBe(true);
    expect(typeof body['uuid']).toBe('string');
  });

  it('单信封协议版本不支持返回 400 + E_UNSUPPORTED_PROTOCOL', async () => {
    const envelope = buildEnvelope('agent_settled', {});
    const result = await postJson('/v1/report', { ...envelope, protocolVersion: '9' });
    expect(result.status).toBe(400);
    const body = result.body as { error: { code: string } };
    expect(body.error.code).toBe('E_UNSUPPORTED_PROTOCOL');
  });

  it('未知状态返回 400 + E_UNKNOWN_STATE', async () => {
    const envelope = buildEnvelope('agent_settled', {});
    const result = await postJson('/v1/report', { ...envelope, state: 'mystery_state' });
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe('E_UNKNOWN_STATE');
  });

  it('载荷违反契约返回 400 + E_INVALID_PAYLOAD（details 含字段错误）', async () => {
    const envelope = buildEnvelope('turn_end', {
      turnIndex: 'zero',
      toolResultCount: 1,
      messageRole: 'assistant',
      willContinue: false,
    });
    const result = await postJson('/v1/report', envelope);
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe('E_INVALID_PAYLOAD');
  });

  it('陈旧时间戳返回 400 + E_STALE_REPORT', async () => {
    const stale = buildEnvelope('agent_settled', {});
    stale.timestamp = 1000;
    const result = await postJson('/v1/report', stale);
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe('E_STALE_REPORT');
  });

  it('批量原子拒绝：任一非法整体 400 并逐条返回 rejected', async () => {
    const valid = buildEnvelope('agent_settled', {});
    const invalid = buildEnvelope('turn_end', {
      turnIndex: -5,
      toolResultCount: 0,
      messageRole: 'assistant',
      willContinue: false,
    });
    const result = await postJson('/v1/report/batch', { reports: [valid, invalid] });
    expect(result.status).toBe(400);
    const body = result.body as { ok: boolean; rejected: Array<{ index: number; code: string }> };
    expect(body.ok).toBe(false);
    expect(body.rejected).toHaveLength(1);
    expect(body.rejected[0]?.index).toBe(1);
  });

  it('批量全部合法返回 200 且 accepted 计数正确', async () => {
    const a = buildEnvelope('agent_settled', {});
    const b = buildEnvelope('agent_start', {});
    const result = await postJson('/v1/report/batch', { reports: [a, b] });
    expect(result.status).toBe(200);
    const body = result.body as { ok: boolean; accepted: number };
    expect(body.ok).toBe(true);
    expect(body.accepted).toBe(2);
  });

  it('批量超过 512 条返回 413 + E_BATCH_TOO_LARGE', async () => {
    const reports = Array.from({ length: 513 }, () => buildEnvelope('agent_settled', {}));
    const result = await postJson('/v1/report/batch', { reports });
    expect(result.status).toBe(413);
    expect((result.body as { error: { code: string } }).error.code).toBe('E_BATCH_TOO_LARGE');
  });

  it('空批量返回 200 且 assigned:false（无 uuid 可采用）', async () => {
    const result = await postJson('/v1/report/batch', { reports: [] });
    expect(result.status).toBe(200);
    const body = result.body as { ok: boolean; accepted: number; uuid: string; assigned: boolean };
    expect(body.ok).toBe(true);
    expect(body.accepted).toBe(0);
    expect(body.assigned).toBe(false);
  });

  it('未知 agent 查询返回 404 + E_NOT_FOUND', async () => {
    const result = await getJson('/v1/agents/00000000-0000-0000-0000-000000000000');
    expect(result.status).toBe(404);
    expect((result.body as { error: { code: string } }).error.code).toBe('E_NOT_FOUND');
  });

  it('未知路由返回 404，非法方法返回 405', async () => {
    const notFound = await getJson('/v1/nope');
    expect(notFound.status).toBe(404);
    const method = await fetch(`${baseUrl}/v1/agents`, { method: 'DELETE' });
    expect(method.status).toBe(405);
  });

  it('DELETE /v1/agents/:uuid 删除条目（请求即授权，无本地研判）；不存在返回 404', async () => {
    const { reporter } = makeReporter();
    reporter.start();
    await reporter.collectSnapshotAndFlush();
    const uuid = reporter.currentIdentity!.uuid;
    await reporter.stop();

    const deleted = await fetch(`${baseUrl}/v1/agents/${uuid}`, { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ uuid, deleted: true });

    const after = await getJson(`/v1/agents/${uuid}`);
    expect(after.status).toBe(404);

    const again = await fetch(`${baseUrl}/v1/agents/${uuid}`, { method: 'DELETE' });
    expect(again.status).toBe(404);

    // history 路径不可删（属于只读资源）
    const historyDelete = await fetch(`${baseUrl}/v1/agents/${uuid}/history`, {
      method: 'DELETE',
    });
    expect(historyDelete.status).toBe(405);
  });

  it('历史查询端点支持 state/limit/since，且非法 limit 被钳制', async () => {
    // 自建记录，不依赖前序用例留下的共享注册表状态（含 agent_settled）
    const { reporter, source, env } = makeReporter();
    reporter.start();
    runAgentSimulation({ source, env });
    await reporter.collectSnapshotAndFlush();
    const uuid = reporter.currentIdentity!.uuid;
    await reporter.stop();
    const history = (await getJson(`/v1/agents/${uuid}/history?state=agent_settled&limit=5`))
      .body as Record<string, unknown>;
    const entries = history['entries'] as Array<Record<string, unknown>>;
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((entry) => entry['state'] === 'agent_settled')).toBe(true);

    const clamped = (await getJson(`/v1/agents/${uuid}/history?limit=99999`)).body as Record<
      string,
      unknown
    >;
    expect((clamped['entries'] as unknown[]).length).toBeLessThanOrEqual(1000);
    const invalid = (await getJson(`/v1/agents/${uuid}/history?limit=abc`)).body as Record<
      string,
      unknown
    >;
    expect(Array.isArray(invalid['entries'])).toBe(true);
  });

  it('空请求体与非 JSON 返回 400', async () => {
    const empty = await fetch(`${baseUrl}/v1/report`, { method: 'POST' });
    expect(empty.status).toBe(400);
    const notJson = await fetch(`${baseUrl}/v1/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'this is not json',
    });
    expect(notJson.status).toBe(400);
  });
});
