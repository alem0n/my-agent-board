/**
 * BoardHttpServer：server 端 HTTP 端点实现（infrastructure 层）。
 *
 * 职责契约：
 * - 基于 node:http（零新增运行时依赖），路由见 docs/DESIGN.md §6.1。
 * - 协议/契约校验 → AgentRegistry 摄入；非法请求返回结构化错误码。
 * - 错误响应统一为 { error:{ code, message, details? } }；批量拒绝返回 { ok:false, rejected:[...] }。
 *
 * 端点：
 *   POST /v1/report              单信封上报
 *   POST /v1/report/batch        批量上报（原子批：任一非法整体拒绝并逐条返回）
 *   GET  /v1/agents              agent 列表
 *   GET  /v1/agents/:uuid        单 agent 注册记录 + 逐状态最新载荷
 *   GET  /v1/agents/:uuid/history?state=&limit=&since=   历史记录
 *   GET  /v1/health              健康检查
 */
import * as http from 'node:http';
import type { AgentRegistry } from '../services/registry.js';
import type { BoardLogger } from '../domain/logging.js';
import { PROTOCOL_VERSION, type BatchRequest, type ReportEnvelope } from '../domain/contracts.js';
import { ERROR_CODES } from '../domain/errors.js';
import { validateEnvelope, type FieldError } from '../domain/validation.js';

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_BATCH_REPORTS = 512;
const MAX_HISTORY_LIMIT = 1000;

export interface BoardServerOptions {
  host: string;
  port: number;
  registry: AgentRegistry;
  logger: BoardLogger;
  now?: () => number;
  /** 报告允许的最大滞后（默认 7 天）。 */
  maxReportAgeMs?: number;
}

interface RouteResult {
  status: number;
  body: unknown;
}

export class BoardHttpServer {
  private readonly options: Required<
    Omit<BoardServerOptions, 'host' | 'port' | 'registry' | 'logger'>
  >;
  private readonly host: string;
  private readonly port: number;
  private readonly registry: AgentRegistry;
  private readonly logger: BoardLogger;
  private server: http.Server | undefined;
  private readonly startedAt: number;

  constructor(options: BoardServerOptions) {
    this.host = options.host;
    this.port = options.port;
    this.registry = options.registry;
    this.logger = options.logger;
    this.startedAt = Date.now();
    this.options = {
      now: options.now ?? (() => Date.now()),
      maxReportAgeMs: options.maxReportAgeMs ?? 7 * 24 * 60 * 60 * 1000,
    };
  }

  /** 启动监听。返回实际监听地址（port=0 时为系统分配端口）。 */
  async start(): Promise<{ host: string; port: number }> {
    if (this.server !== undefined) {
      throw new Error('server already started');
    }
    const server = http.createServer((request, response) => {
      void this.handleRequest(request, response);
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', (error: NodeJS.ErrnoException) => {
        this.server = undefined;
        reject(new Error(`server listen failed: ${error.message}`));
      });
      server.listen(this.port, this.host, () => resolve());
    });
    const address = server.address();
    const actualPort = typeof address === 'object' && address !== null ? address.port : this.port;
    return { host: this.host, port: actualPort };
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (server === undefined) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
    this.server = undefined;
  }

  get uptimeMs(): number {
    return Date.now() - this.startedAt;
  }

  // ---------------------------------------------------------------------------
  // 路由
  // ---------------------------------------------------------------------------

  private async handleRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const method = request.method ?? 'GET';
      const path = url.pathname;

      if (path === '/v1/health' && method === 'GET') {
        this.writeJson(response, 200, this.healthBody());
        return;
      }
      if (path === '/v1/agents' && method === 'GET') {
        this.writeJson(response, 200, { agents: this.registry.list() });
        return;
      }
      if (path === '/v1/report' && method === 'POST') {
        const result = await this.handleSingleReport(request);
        this.writeJson(response, result.status, result.body);
        return;
      }
      if (path === '/v1/report/batch' && method === 'POST') {
        const result = await this.handleBatchReport(request);
        this.writeJson(response, result.status, result.body);
        return;
      }
      const agentMatch = /^\/v1\/agents\/([^/]+)$/.exec(path);
      if (agentMatch !== null && method === 'GET') {
        const result = this.agentRecord(decodeURIComponent(agentMatch[1] ?? ''));
        this.writeJson(response, result.status, result.body);
        return;
      }
      const historyMatch = /^\/v1\/agents\/([^/]+)\/history$/.exec(path);
      if (historyMatch !== null && method === 'GET') {
        const result = this.agentHistory(decodeURIComponent(historyMatch[1] ?? ''), url);
        this.writeJson(response, result.status, result.body);
        return;
      }

      const knownPath =
        path === '/v1/health' ||
        path === '/v1/agents' ||
        path === '/v1/report' ||
        path === '/v1/report/batch' ||
        /^\/v1\/agents\/[^/]+(\/history)?$/.test(path);
      if (knownPath && method !== 'GET' && method !== 'POST') {
        this.writeJson(
          response,
          405,
          this.errorBody(ERROR_CODES.METHOD_NOT_ALLOWED, `method ${method} not allowed on ${path}`),
        );
        return;
      }
      this.writeJson(
        response,
        404,
        this.errorBody(ERROR_CODES.NOT_FOUND, `no route for ${method} ${path}`),
      );
    } catch (error) {
      this.logger.error('server.requestError', { error: String(error) });
      this.writeJson(response, 500, this.errorBody(ERROR_CODES.INTERNAL, 'internal server error'));
    }
  }

  private async handleSingleReport(request: http.IncomingMessage): Promise<RouteResult> {
    const body = await this.readBody(request);
    if (!body.ok) {
      return { status: body.status, body: body.error };
    }
    const envelope = body.value;
    const validation = validateEnvelope(envelope, {
      now: this.options.now(),
      maxReportAgeMs: this.options.maxReportAgeMs,
    });
    if (!validation.ok) {
      const mapped = mapValidationErrors(validation.errors);
      return {
        status: 400,
        body: this.errorBody(mapped.code, mapped.message, { errors: validation.errors }),
      };
    }
    const ingest = this.registry.ingest(envelope as ReportEnvelope, this.options.now());
    return {
      status: 200,
      body: {
        ok: true,
        uuid: ingest.uuid,
        assigned: ingest.assigned,
        ...(ingest.replaced ? { replaced: true } : {}),
      },
    };
  }

  private async handleBatchReport(request: http.IncomingMessage): Promise<RouteResult> {
    const body = await this.readBody(request);
    if (!body.ok) {
      return { status: body.status, body: body.error };
    }
    const batch = body.value as BatchRequest;
    if (typeof batch !== 'object' || batch === null || !Array.isArray(batch['reports'])) {
      return {
        status: 400,
        body: this.errorBody(
          ERROR_CODES.INVALID_ENVELOPE,
          'batch body must be { reports: Envelope[] }',
        ),
      };
    }
    const reports = batch['reports'] as unknown[];
    if (reports.length > MAX_BATCH_REPORTS) {
      return {
        status: 413,
        body: this.errorBody(
          ERROR_CODES.BATCH_TOO_LARGE,
          `batch exceeds ${MAX_BATCH_REPORTS} reports`,
        ),
      };
    }

    const rejected: Array<{ index: number; code: string; message: string; state?: string }> = [];
    const valid: ReportEnvelope[] = [];
    for (const [index, report] of reports.entries()) {
      const validation = validateEnvelope(report, {
        now: this.options.now(),
        maxReportAgeMs: this.options.maxReportAgeMs,
      });
      if (!validation.ok) {
        const mapped = mapValidationErrors(validation.errors);
        rejected.push({
          index,
          code: mapped.code,
          message: mapped.message,
          ...(typeof report === 'object' &&
          report !== null &&
          !Array.isArray(report) &&
          typeof (report as Record<string, unknown>)['state'] === 'string'
            ? { state: (report as Record<string, unknown>)['state'] as string }
            : {}),
        });
        continue;
      }
      valid.push(report as ReportEnvelope);
    }

    if (rejected.length > 0) {
      // 原子批：任一非法即整体拒绝，client 剔除毒信后重试剩余。
      return { status: 400, body: { ok: false, rejected } };
    }

    let uuid = '';
    let assigned = false;
    let replaced = false;
    let accepted = 0;
    for (const envelope of valid) {
      const ingest = this.registry.ingest(envelope, this.options.now());
      if (uuid === '') {
        uuid = ingest.uuid;
      }
      assigned = assigned || ingest.assigned;
      replaced = replaced || ingest.replaced;
      accepted += 1;
    }
    return {
      status: 200,
      body: {
        ok: true,
        accepted,
        uuid,
        assigned,
        ...(replaced ? { replaced: true } : {}),
      },
    };
  }

  private healthBody(): Record<string, unknown> {
    return {
      status: 'ok',
      protocolVersion: PROTOCOL_VERSION,
      agents: this.registry.list().length,
      uptimeMs: this.uptimeMs,
    };
  }

  private agentRecord(uuid: string): RouteResult {
    const record = this.registry.get(uuid);
    if (record === undefined) {
      return {
        status: 404,
        body: this.errorBody(ERROR_CODES.NOT_FOUND, `agent '${uuid}' not found`),
      };
    }
    return { status: 200, body: record };
  }

  private agentHistory(uuid: string, url: URL): RouteResult {
    const record = this.registry.get(uuid);
    if (record === undefined) {
      return {
        status: 404,
        body: this.errorBody(ERROR_CODES.NOT_FOUND, `agent '${uuid}' not found`),
      };
    }
    const stateParam = url.searchParams.get('state') ?? undefined;
    const limitParam = url.searchParams.get('limit');
    const sinceParam = url.searchParams.get('since');
    const limit = limitParam === null ? undefined : Number.parseInt(limitParam, 10);
    const since = sinceParam === null ? undefined : Number.parseInt(sinceParam, 10);
    const result = this.registry.history(uuid, {
      ...(stateParam === undefined || stateParam === '' ? {} : { state: stateParam }),
      ...(Number.isFinite(limit)
        ? { limit: Math.min(MAX_HISTORY_LIMIT, Math.max(1, limit as number)) }
        : {}),
      ...(Number.isFinite(since) ? { since: since as number } : {}),
    });
    if (result === undefined) {
      return {
        status: 404,
        body: this.errorBody(ERROR_CODES.NOT_FOUND, `agent '${uuid}' not found`),
      };
    }
    return { status: 200, body: result };
  }

  // ---------------------------------------------------------------------------
  // 工具
  // ---------------------------------------------------------------------------

  private async readBody(
    request: http.IncomingMessage,
  ): Promise<{ ok: true; value: unknown } | { ok: false; status: number; error: unknown }> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of request) {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        return {
          ok: false,
          status: 413,
          error: this.errorBody(
            ERROR_CODES.BATCH_TOO_LARGE,
            `request body exceeds ${MAX_BODY_BYTES} bytes`,
          ),
        };
      }
      chunks.push(chunk as Buffer);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (text.trim().length === 0) {
      return {
        ok: false,
        status: 400,
        error: this.errorBody(ERROR_CODES.INVALID_ENVELOPE, 'request body is empty'),
      };
    }
    try {
      return { ok: true, value: JSON.parse(text) as unknown };
    } catch (error) {
      return {
        ok: false,
        status: 400,
        error: this.errorBody(
          ERROR_CODES.INVALID_ENVELOPE,
          `request body is not valid JSON: ${String(error)}`,
        ),
      };
    }
  }

  private errorBody(
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ): Record<string, unknown> {
    return { error: { code, message, ...(details === undefined ? {} : details) } };
  }

  private writeJson(response: http.ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    response.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
    });
    response.end(payload);
  }
}

interface MappedValidation {
  code: string;
  message: string;
}

/** 将字段级校验错误映射为协议层错误码（docs/DESIGN.md §6.2）。 */
function mapValidationErrors(errors: FieldError[]): MappedValidation {
  const first = errors[0];
  if (first === undefined) {
    return { code: ERROR_CODES.INVALID_ENVELOPE, message: 'validation failed' };
  }
  if (first.code === ERROR_CODES.UNKNOWN_STATE || first.field === 'state') {
    return { code: ERROR_CODES.UNKNOWN_STATE, message: first.message };
  }
  if (first.field === 'protocolVersion') {
    return { code: ERROR_CODES.UNSUPPORTED_PROTOCOL, message: first.message };
  }
  if (first.code === ERROR_CODES.STALE_REPORT) {
    return { code: ERROR_CODES.STALE_REPORT, message: first.message };
  }
  if (first.field.startsWith('agent.')) {
    return { code: ERROR_CODES.AGENT_IDENTITY, message: first.message };
  }
  if (first.field === 'payload' || first.field.startsWith('payload.')) {
    return { code: ERROR_CODES.INVALID_PAYLOAD, message: first.message };
  }
  return { code: ERROR_CODES.INVALID_ENVELOPE, message: first.message };
}
