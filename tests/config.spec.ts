/**
 * 配置解析测试：合法配置、缺失文件、JSON 非法、字段非法、未知键。
 *
 * 对应验收门槛：4 配置正确。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseClientConfig } from '../src/domain/client-config.js';
import {
  loadClientConfig,
  resolveConfigPath,
  CONFIG_PATH_ENV,
  LOG_LEVEL_ENV,
  envLogLevel,
} from '../src/infrastructure/client-config-loader.js';
import { loadServerConfig } from '../src/config.js';
import { silentLogger } from '../src/domain/logging.js';

const GOOD_URL_CONFIG = {
  url: 'http://192.168.1.10:7878',
  name: 'ci-agent',
  reportIntervalMs: 60_000,
  flushIntervalMs: 1_000,
  requestTimeoutMs: 3_000,
  maxBufferSize: 500,
  flushOnCount: 20,
  heartbeatIntervalMs: 5_000,
  retry: {
    maxAttempts: 3,
    initialDelayMs: 100,
    maxDelayMs: 5_000,
    backoffFactor: 3,
    jitter: false,
  },
};

describe('parseClientConfig（纯解析）', () => {
  it('合法配置（url 形式）逐字段解析', () => {
    const config = parseClientConfig(GOOD_URL_CONFIG);
    expect(config.issues).toEqual([]);
    expect(config.serverUrl).toBe('http://192.168.1.10:7878');
    expect(config.name).toBe('ci-agent');
    expect(config.reportIntervalMs).toBe(60_000);
    expect(config.retry.maxAttempts).toBe(3);
    expect(config.retry.jitter).toBe(false);
  });

  it('host + port 形式组合为 url', () => {
    const config = parseClientConfig({ host: '10.0.0.5', port: 9000, name: 'dev' });
    expect(config.serverUrl).toBe('http://10.0.0.5:9000');
    expect(config.issues).toEqual([]);
  });

  it('url 优先于 host/port', () => {
    const config = parseClientConfig({ url: 'http://a:1', host: 'b', port: 2 });
    expect(config.serverUrl).toBe('http://a:1');
  });

  it('url 带尾斜杠归一化', () => {
    const config = parseClientConfig({ url: 'http://a:1///' });
    expect(config.serverUrl).toBe('http://a:1');
  });

  it('空输入使用内置默认值并记录 issue', () => {
    const config = parseClientConfig(undefined);
    expect(config.serverUrl).toBe('http://127.0.0.1:7878');
    expect(config.issues.length).toBeGreaterThan(0);
    expect(config.issues[0]?.field).toBe('config');
  });

  it('非法增长数值回退默认值并记录 issue', () => {
    const config = parseClientConfig({
      ...GOOD_URL_CONFIG,
      reportIntervalMs: 10,
      flushIntervalMs: 'x' as unknown as number,
    });
    expect(config.reportIntervalMs).toBe(30_000);
    expect(config.flushIntervalMs).toBe(2_000);
    expect(config.issues.map((issue) => issue.field)).toContain('reportIntervalMs');
    expect(config.issues.map((issue) => issue.field)).toContain('flushIntervalMs');
  });

  it('非法 url 记录 issue 并回退默认地址', () => {
    const config = parseClientConfig({ url: 'not-a-url' });
    expect(config.serverUrl).toBe('http://127.0.0.1:7878');
    expect(config.issues.map((issue) => issue.field)).toContain('url');
  });

  it('host 缺失 port 无法组合：回退默认并记录 issue', () => {
    const config = parseClientConfig({ host: 'only-host' });
    expect(config.serverUrl).toBe('http://127.0.0.1:7878');
    expect(config.issues.map((issue) => issue.field)).toContain('host/port');
  });

  it('非法 retry 结构回退默认并记录 issue', () => {
    const config = parseClientConfig({ ...GOOD_URL_CONFIG, retry: 'fast' });
    expect(config.retry.maxAttempts).toBe(5);
    expect(config.issues.map((issue) => issue.field)).toContain('retry');
  });

  it('retry 字段越界回退默认并记录 issue', () => {
    const config = parseClientConfig({
      ...GOOD_URL_CONFIG,
      retry: { ...GOOD_URL_CONFIG.retry, maxAttempts: 99 },
    });
    expect(config.retry.maxAttempts).toBe(5);
    expect(config.issues.some((issue) => issue.field.startsWith('retry.'))).toBe(true);
  });

  it('未知键告警并忽略（不静默）', () => {
    const config = parseClientConfig({ ...GOOD_URL_CONFIG, mystery: 1 });
    expect(config.issues.map((issue) => issue.field)).toContain('mystery');
  });

  it('空 name 记录 issue（将回退 session id）', () => {
    const config = parseClientConfig({ ...GOOD_URL_CONFIG, name: '' });
    expect(config.name).toBeUndefined();
    expect(config.issues.map((issue) => issue.field)).toContain('name');
  });

  it('logLevel 未配置时为 undefined（client 默认零日志）', () => {
    const config = parseClientConfig(GOOD_URL_CONFIG);
    expect(config.logLevel).toBeUndefined();
    expect(config.issues).toEqual([]);
  });

  it('logLevel 合法值原样保留', () => {
    const config = parseClientConfig({ ...GOOD_URL_CONFIG, logLevel: 'warn' });
    expect(config.logLevel).toBe('warn');
    expect(config.issues).toEqual([]);
  });

  it('logLevel 非法值记 issue 并保持 silent', () => {
    const config = parseClientConfig({ ...GOOD_URL_CONFIG, logLevel: 'verbose' });
    expect(config.logLevel).toBeUndefined();
    expect(config.issues.map((issue) => issue.field)).toContain('logLevel');
  });
});

it('heartbeatIntervalMs：默认 20s；0 = 关闭；越界/类型错 → 默认 + issue', () => {
  expect(parseClientConfig({ url: 'http://x' }).heartbeatIntervalMs).toBe(20_000);
  expect(parseClientConfig({ url: 'http://x', heartbeatIntervalMs: 0 }).heartbeatIntervalMs).toBe(
    0,
  );
  const tooSmall = parseClientConfig({ url: 'http://x', heartbeatIntervalMs: 500 });
  expect(tooSmall.heartbeatIntervalMs).toBe(20_000);
  expect(tooSmall.issues.map((issue) => issue.field)).toContain('heartbeatIntervalMs');
  const notNumber = parseClientConfig({ url: 'http://x', heartbeatIntervalMs: 'fast' });
  expect(notNumber.heartbeatIntervalMs).toBe(20_000);
  expect(notNumber.issues.map((issue) => issue.field)).toContain('heartbeatIntervalMs');
  expect(
    parseClientConfig({ url: 'http://x', heartbeatIntervalMs: 5_000 }).heartbeatIntervalMs,
  ).toBe(5_000);
});

describe('loadClientConfig（文件层）', () => {
  let dir: string;
  let configPath: string;
  let previousEnv: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-cfg-'));
    configPath = path.join(dir, 'agent-board-server.json');
    previousEnv = process.env[CONFIG_PATH_ENV];
    delete process.env[CONFIG_PATH_ENV];
  });

  afterEach(() => {
    if (previousEnv === undefined) {
      delete process.env[CONFIG_PATH_ENV];
    } else {
      process.env[CONFIG_PATH_ENV] = previousEnv;
    }
  });

  it('合法配置文件可解析并连通（serverUrl 正确）', async () => {
    fs.writeFileSync(configPath, JSON.stringify(GOOD_URL_CONFIG));
    const config = await loadClientConfig({ filePath: configPath, logger: silentLogger });
    expect(config.serverUrl).toBe('http://192.168.1.10:7878');
    expect(config.issues).toEqual([]);
  });

  it('文件缺失：错误日志 + 内置默认降级（不静默失败）', async () => {
    const issues: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
    const logger = {
      ...silentLogger,
      error: (msg: string, fields?: Record<string, unknown>) => issues.push({ msg, fields }),
    };
    const config = await loadClientConfig({ filePath: configPath, logger });
    expect(config.serverUrl).toBe('http://127.0.0.1:7878');
    expect(issues.some((entry) => entry.msg === 'client.config.missing')).toBe(true);
    expect(issues[0]?.fields?.['path']).toBe(configPath);
  });

  it('JSON 非法：错误日志 + 默认降级', async () => {
    fs.writeFileSync(configPath, '{ not json');
    const issues: string[] = [];
    const logger = { ...silentLogger, error: (msg: string) => issues.push(msg) };
    const config = await loadClientConfig({ filePath: configPath, logger });
    expect(config.serverUrl).toBe('http://127.0.0.1:7878');
    expect(issues).toContain('client.config.invalidJson');
  });

  it('字段非法：文件级 issue 日志输出', async () => {
    fs.writeFileSync(configPath, JSON.stringify({ url: 42 }));
    const fields: string[] = [];
    const logger = {
      ...silentLogger,
      error: (_msg: string, f?: Record<string, unknown>) => f && fields.push(String(f['field'])),
    };
    const config = await loadClientConfig({ filePath: configPath, logger });
    expect(config.serverUrl).toBe('http://127.0.0.1:7878');
    expect(fields).toContain('url');
  });

  it('resolveConfigPath：显式路径 > 环境变量 > 默认路径', () => {
    expect(resolveConfigPath('/explicit.json')).toBe('/explicit.json');
    process.env[CONFIG_PATH_ENV] = '/from-env.json';
    expect(resolveConfigPath()).toBe('/from-env.json');
    delete process.env[CONFIG_PATH_ENV];
    expect(resolveConfigPath()).toBe(
      path.join(os.homedir(), '.pi', 'agent', 'agent-board-server.json'),
    );
  });

  it('envLogLevel：合法值解析，非法/缺失视为未设置（非法值经 invalid 返回）', () => {
    expect(envLogLevel()).toEqual({});
    process.env[LOG_LEVEL_ENV] = 'info';
    expect(envLogLevel()).toEqual({ level: 'info' });
    process.env[LOG_LEVEL_ENV] = 'verbose';
    expect(envLogLevel()).toEqual({ invalid: 'verbose' });
    delete process.env[LOG_LEVEL_ENV];
  });
});

describe('loadServerConfig（server 参数解析）', () => {
  it('`--port=7899` 与 `--port 7899` 两种形式等效', () => {
    const eq = loadServerConfig(['node', 's', '--port=7899', '--host=0.0.0.0']);
    const sp = loadServerConfig(['node', 's', '--port', '7899', '--host', '0.0.0.0']);
    expect(eq.port).toBe(7899);
    expect(sp.port).toBe(7899);
    expect(sp.host).toBe('0.0.0.0');
  });

  it('空格形式值缺省时回落默认（不把后续 --flag 当值）', () => {
    const conf = loadServerConfig(['node', 's', '--port', '--web']);
    expect(conf.port).toBe(7878);
    expect(conf.webUi).toBe(true);
  });

  it('非法值回落默认；--web 开关语义（--web / --web=false）', () => {
    const bad = loadServerConfig(['node', 's', '--port=99999', '--log-level=chatty']);
    expect(bad.port).toBe(7878);
    expect(bad.logLevel).toBe('info');
    expect(loadServerConfig(['node', 's', '--web']).webUi).toBe(true);
    expect(loadServerConfig(['node', 's', '--web=false']).webUi).toBe(false);
    expect(loadServerConfig(['node', 's']).webUi).toBe(false);
  });

  it('不再包含 dataDir（注册表纯内存，--data-dir 被忽略）', () => {
    const conf = loadServerConfig(['node', 's', '--port=1']);
    expect('dataDir' in conf).toBe(false);
  });
});
