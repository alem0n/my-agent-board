/**
 * client 配置：数据模型 + 纯解析函数（文件读取在 infrastructure 层）。
 *
 * 职责契约：
 * - parseClientConfig 接受任意未知输入，逐字段校验；非法字段 → 默认值 + 明确错误。
 * - 不得静默吞错：所有替换均产出 issues，由调用方输出日志。
 * 设计文档：docs/DESIGN.md（配置文件字段约定）。
 */
import type { BoardLogger } from './logging.js';

export interface RetryConfig {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffFactor: number;
  jitter: boolean;
}

export interface ClientConfig {
  /** server 地址，形如 http://127.0.0.1:7878。 */
  serverUrl: string;
  /** 显示名；未设置时回退 session id。 */
  name?: string;
  /** agent_snapshot 采样间隔。 */
  reportIntervalMs: number;
  /** flush 循环间隔。 */
  flushIntervalMs: number;
  /** 单次 POST 的请求超时。 */
  requestTimeoutMs: number;
  /** 内存缓冲上限；超限丢弃最旧条目。 */
  maxBufferSize: number;
  /** 缓冲达到该条数立即触发 flush。 */
  flushOnCount: number;
  /** 发送失败重试与断线重连参数。 */
  retry: RetryConfig;
  /** issues: 解析过程中发生的替换（每条一个明确原因）。 */
  issues: ConfigIssue[];
}

export interface ConfigIssue {
  field: string;
  message: string;
}

/** 内置默认值（文件缺失或字段非法时降级使用）。 */
export const DEFAULT_CLIENT_CONFIG: Omit<ClientConfig, 'issues'> = {
  serverUrl: 'http://127.0.0.1:7878',
  reportIntervalMs: 30_000,
  flushIntervalMs: 2_000,
  requestTimeoutMs: 5_000,
  maxBufferSize: 1_000,
  flushOnCount: 50,
  retry: {
    maxAttempts: 5,
    initialDelayMs: 500,
    maxDelayMs: 30_000,
    backoffFactor: 2,
    jitter: true,
  },
};

const BOUNDS: Record<string, { min: number; max: number }> = {
  reportIntervalMs: { min: 1_000, max: 3_600_000 },
  flushIntervalMs: { min: 500, max: 60_000 },
  requestTimeoutMs: { min: 500, max: 60_000 },
  maxBufferSize: { min: 10, max: 100_000 },
  flushOnCount: { min: 1, max: 100_000 },
};

function parseRetry(raw: unknown, issues: ConfigIssue[]): RetryConfig {
  const fallback = DEFAULT_CLIENT_CONFIG.retry;
  if (raw === undefined || raw === null) {
    return { ...fallback };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    issues.push({ field: 'retry', message: 'retry must be an object; using defaults' });
    return { ...fallback };
  }
  const source = raw as Record<string, unknown>;
  const result: RetryConfig = { ...fallback };
  const mutable: Record<string, unknown> = result as unknown as Record<string, unknown>;

  const bounds: Record<string, { min: number; max: number }> = {
    maxAttempts: { min: 1, max: 20 },
    initialDelayMs: { min: 0, max: 60_000 },
    maxDelayMs: { min: 100, max: 600_000 },
    backoffFactor: { min: 1, max: 10 },
  };
  for (const key of Object.keys(bounds)) {
    const value = source[key];
    if (value === undefined) {
      continue;
    }
    const spec = bounds[key];
    if (spec === undefined) {
      continue;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      issues.push({
        field: `retry.${key}`,
        message: `must be a number; using default ${fallback[key as keyof RetryConfig]}`,
      });
      continue;
    }
    if (value < spec.min || value > spec.max) {
      issues.push({
        field: `retry.${key}`,
        message: `${value} out of range [${spec.min}, ${spec.max}]; using default`,
      });
      continue;
    }
    mutable[key] = value;
  }

  const jitter = source['jitter'];
  if (jitter !== undefined && typeof jitter !== 'boolean') {
    issues.push({ field: 'retry.jitter', message: 'must be boolean; using default true' });
  } else if (jitter !== undefined) {
    result.jitter = jitter;
  }
  return result;
}

function parseNamedNumber(
  source: Record<string, unknown>,
  key: string,
  fallback: number,
  issues: ConfigIssue[],
): number {
  const value = source[key];
  if (value === undefined) {
    return fallback;
  }
  const spec = BOUNDS[key];
  if (spec === undefined) {
    issues.push({ field: key, message: 'unknown numeric key; using default' });
    return fallback;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    issues.push({ field: key, message: `must be a number; using default ${fallback}` });
    return fallback;
  }
  if (value < spec.min || value > spec.max) {
    issues.push({
      field: key,
      message: `${value} out of range [${spec.min}, ${spec.max}]; using default ${fallback}`,
    });
    return fallback;
  }
  return value;
}

/**
 * 纯解析：接受未知输入，产出 ClientConfig。非法值一律降级为默认并记录 issue。
 *
 * 地址字段约定（host/port 或 url 二选一）：
 * - url 存在且合法 → 使用 url。
 * - url 缺失但 host 与 port 合法 → 组合为 http://host:port。
 * - 其余 → 默认地址 + issue。
 */
export function parseClientConfig(
  raw: unknown,
  emptyReason = 'config is empty; using built-in defaults',
): ClientConfig {
  const issues: ConfigIssue[] = [];
  const fallback = DEFAULT_CLIENT_CONFIG;

  if (raw === undefined || raw === null) {
    return {
      ...fallback,
      issues: [{ field: 'config', message: emptyReason }],
    };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ...fallback,
      issues: [
        { field: 'config', message: 'config must be a JSON object; using built-in defaults' },
      ],
    };
  }
  const source = raw as Record<string, unknown>;

  // name
  let name: string | undefined;
  const rawName = source['name'];
  if (rawName !== undefined) {
    if (typeof rawName !== 'string' || rawName.length > 256) {
      issues.push({ field: 'name', message: 'must be a string of at most 256 chars; ignoring' });
    } else if (rawName.trim().length >= 1) {
      name = rawName;
    } else {
      issues.push({ field: 'name', message: 'empty name; will fall back to session id' });
    }
  }

  // server address
  let serverUrl: string | undefined;
  const rawUrl = source['url'];
  if (rawUrl !== undefined) {
    if (typeof rawUrl !== 'string' || !/^https?:\/\/[A-Za-z0-9._:-]+(:\d+)?(\/.*)?$/.test(rawUrl)) {
      issues.push({ field: 'url', message: `invalid url '${String(rawUrl)}'; using default` });
    } else {
      serverUrl = rawUrl.replace(/\/+$/, '');
    }
  }
  if (serverUrl === undefined) {
    const host = source['host'];
    const port = source['port'];
    if (
      typeof host === 'string' &&
      host.length >= 1 &&
      host.length <= 255 &&
      typeof port === 'number' &&
      Number.isInteger(port) &&
      port >= 1 &&
      port <= 65535
    ) {
      serverUrl = `http://${host}:${port}`;
    } else if (
      rawUrl !== undefined ||
      source['host'] !== undefined ||
      source['port'] !== undefined
    ) {
      issues.push({
        field: 'host/port',
        message: 'host/port invalid or incomplete; using default address',
      });
    } else {
      issues.push({ field: 'url', message: 'no server address configured; using default address' });
    }
  }

  // unknown keys
  const known = new Set([
    'url',
    'host',
    'port',
    'name',
    'reportIntervalMs',
    'flushIntervalMs',
    'requestTimeoutMs',
    'maxBufferSize',
    'flushOnCount',
    'retry',
  ]);
  for (const key of Object.keys(source)) {
    if (!known.has(key)) {
      issues.push({ field: key, message: 'unknown configuration key; ignored' });
    }
  }

  return {
    serverUrl: serverUrl ?? fallback.serverUrl,
    ...(name === undefined ? {} : { name }),
    reportIntervalMs: parseNamedNumber(
      source,
      'reportIntervalMs',
      fallback.reportIntervalMs,
      issues,
    ),
    flushIntervalMs: parseNamedNumber(source, 'flushIntervalMs', fallback.flushIntervalMs, issues),
    requestTimeoutMs: parseNamedNumber(
      source,
      'requestTimeoutMs',
      fallback.requestTimeoutMs,
      issues,
    ),
    maxBufferSize: parseNamedNumber(source, 'maxBufferSize', fallback.maxBufferSize, issues),
    flushOnCount: parseNamedNumber(source, 'flushOnCount', fallback.flushOnCount, issues),
    retry: parseRetry(source['retry'], issues),
    issues,
  };
}

/** 将解析 issues 输出为结构化错误日志（不得静默：文件缺失/非法都经此路径）。 */
export function logConfigIssues(config: ClientConfig, logger: BoardLogger, context: string): void {
  for (const issue of config.issues) {
    logger.error('client.config.issue', { context, field: issue.field, message: issue.message });
  }
}
