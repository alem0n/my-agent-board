/**
 * HttpTransport：client 侧 HTTP 传输实现（infrastructure 层）。
 *
 * 职责契约：
 * - 实现 Transport 端口：POST /v1/report/batch、GET /v1/health、POST /v1/heartbeat。
 * - 超时控制（AbortSignal.timeout）、413 拆分信号、协议错误转译为领域错误。
 * - 不做重试（重试策略在 services 层 Reporter 中编排）。
 * 设计文档：docs/DESIGN.md §6.1、§6.3。
 */
import type { BoardLogger } from '../domain/logging.js';
import type { ReportEnvelope, ReportResponse, RejectedReport } from '../domain/contracts.js';
import type { HeartbeatResult } from '../domain/ports.js';
import { ERROR_CODES, BatchTooLargeError } from '../domain/errors.js';
import type { Transport } from '../domain/ports.js';

export interface HttpTransportOptions {
  serverUrl: string;
  requestTimeoutMs: number;
  logger: BoardLogger;
}

export class HttpTransport implements Transport {
  private readonly options: HttpTransportOptions;

  constructor(options: HttpTransportOptions) {
    this.options = options;
  }

  async postBatch(reports: ReportEnvelope[]): Promise<ReportResponse> {
    const url = `${this.options.serverUrl}/v1/report/batch`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reports }),
        signal: AbortSignal.timeout(this.options.requestTimeoutMs),
      });
    } catch (error) {
      throw new Error(`batch request failed: ${String(error)}`);
    }

    if (response.status === 413) {
      throw new BatchTooLargeError(`batch rejected as too large (${reports.length} reports)`);
    }

    const text = await response.text();
    let body: unknown;
    try {
      body = text.length === 0 ? {} : (JSON.parse(text) as unknown);
    } catch {
      throw new Error(
        `batch response parse failed (status ${response.status}): ${text.slice(0, 200)}`,
      );
    }

    if (response.ok) {
      return parseSuccessResponse(body);
    }

    // 400 且携带逐条拒绝：转译为 ok:false 的 ReportResponse（client 剔除毒信后重试剩余）。
    const rejected = extractRejected(body);
    if (rejected !== undefined) {
      return { ok: false, uuid: '', assigned: false, rejected };
    }
    const message = extractErrorMessage(body);
    throw new Error(`batch rejected (status ${response.status}): ${message}`);
  }

  async postHeartbeat(uuid: string): Promise<HeartbeatResult> {
    const url = `${this.options.serverUrl}/v1/heartbeat`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ uuid }),
        signal: AbortSignal.timeout(this.options.requestTimeoutMs),
      });
    } catch (error) {
      throw new Error(`heartbeat request failed: ${String(error)}`);
    }
    if (response.status === 404) {
      return { ok: false, missing: true };
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`heartbeat rejected (status ${response.status}): ${text.slice(0, 200)}`);
    }
    return { ok: true };
  }

  async health(): Promise<boolean> {
    const url = `${this.options.serverUrl}/v1/health`;
    try {
      const response = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(this.options.requestTimeoutMs),
      });
      return response.ok;
    } catch (error) {
      this.options.logger.debug('transport.healthProbeError', { url, error: String(error) });
      return false;
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseSuccessResponse(body: unknown): ReportResponse {
  if (!isObject(body)) {
    throw new Error('batch success response is not an object');
  }
  const uuid = body['uuid'];
  const assigned = body['assigned'] === true;
  if (typeof uuid !== 'string' || uuid.length < 1) {
    throw new Error('batch success response missing uuid');
  }
  const accepted = typeof body['accepted'] === 'number' ? body['accepted'] : undefined;
  const rejected = extractRejected(body);
  return {
    ok: true,
    uuid,
    assigned,
    ...(accepted === undefined ? {} : { accepted }),
    ...(rejected === undefined ? {} : { rejected }),
  };
}

function extractRejected(body: unknown): RejectedReport[] | undefined {
  if (!isObject(body)) {
    return undefined;
  }
  const rejected = body['rejected'];
  if (!Array.isArray(rejected)) {
    return undefined;
  }
  const result: RejectedReport[] = [];
  for (const entry of rejected) {
    if (!isObject(entry)) {
      continue;
    }
    result.push({
      index: typeof entry['index'] === 'number' ? entry['index'] : -1,
      code: typeof entry['code'] === 'string' ? entry['code'] : ERROR_CODES.INVALID_ENVELOPE,
      message: typeof entry['message'] === 'string' ? entry['message'] : 'unknown rejection',
      ...(typeof entry['state'] === 'string' ? { state: entry['state'] } : {}),
    });
  }
  return result;
}

function extractErrorMessage(body: unknown): string {
  if (isObject(body) && isObject(body['error']) && typeof body['error']['message'] === 'string') {
    return body['error']['message'];
  }
  return 'unknown error';
}
