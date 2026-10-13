/**
 * pi 扩展胶水层测试：FakeExtensionAPI 驱动真实订阅绑定、环境快照、身份持久化与日志。
 *
 * 说明：ExtensionAPI 为类型导入（编译期消除），测试以结构兼容的 fake 对象满足。
 * 该测试证明扩展胶水在无真实 pi 进程时也可验证（CI 友好）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { createAgentBoard } from '../src/infrastructure/pi-extension.js';
import { AgentRegistry } from '../src/services/registry.js';
import { BoardHttpServer } from '../src/infrastructure/http-server.js';
import { boardLogger } from '../src/logger.js';
import { STATE_IDS } from '../src/domain/contracts.js';

let dir: string;
let registry: AgentRegistry;
let server: BoardHttpServer;
let baseUrl: string;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-ext-'));
  registry = new AgentRegistry(boardLogger);
  server = new BoardHttpServer({ host: '127.0.0.1', port: 0, registry, logger: boardLogger });
  const address = await server.start();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await closeServer();
});

async function closeServer(): Promise<void> {
  await server.stop();
}

/** Fake ExtensionContext：结构兼容，提供扩展读取的全部快照字段。 */
function makeCtx(overrides: Record<string, unknown> = {}): ExtensionContext {
  const ctx = {
    ui: {},
    mode: 'tui',
    hasUI: true,
    cwd: '/home/user/proj',
    sessionManager: {
      getSessionId: () => 'pi-session-abc',
      getSessionName: () => 'feature/board',
    },
    modelRegistry: {},
    model: { provider: 'anthropic', id: 'claude-x' },
    scopedModels: [],
    thinkingLevel: 'high',
    isIdle: () => false,
    isProjectTrusted: () => true,
    isProjectTrustedFn: undefined,
    signal: undefined,
    abort: () => undefined,
    hasPendingMessages: () => true,
    shutdown: () => undefined,
    getContextUsage: () => ({ tokens: 4200, contextWindow: 200000, percent: 2.1 }),
    compact: () => undefined,
    getSystemPrompt: () => '',
    ...overrides,
  };
  return ctx as unknown as ExtensionContext;
}

/** Fake ExtensionAPI：记录全部订阅与 project_trust 决策。 */
function makePi(): ExtensionAPI & {
  emitted: Map<string, Array<(event: unknown, ctx: ExtensionContext) => void>>;
} {
  const emitted = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => void>>();
  const pi = {
    on: (event: string, handler: (event: never, ctx: ExtensionContext) => void) => {
      const list = emitted.get(event) ?? [];
      list.push(handler as (event: unknown, ctx: ExtensionContext) => void);
      emitted.set(event, list);
      return () => {
        const current = emitted.get(event);
        const index =
          current?.indexOf(handler as (event: unknown, ctx: ExtensionContext) => void) ?? -1;
        if (index >= 0) {
          current?.splice(index, 1);
        }
      };
    },
    getActiveTools: () => ['bash', 'read'],
    emitted,
  };
  return pi as unknown as ExtensionAPI & typeof pi;
}

function emit(
  pi: ReturnType<typeof makePi>,
  state: string,
  event: unknown,
  ctx: ExtensionContext,
): void {
  for (const handler of pi.emitted.get(state) ?? []) {
    handler(event, ctx);
  }
}

function writeConfig(config: Record<string, unknown>): string {
  const configPath = path.join(dir, 'agent-board-server.json');
  fs.writeFileSync(configPath, JSON.stringify(config));
  return configPath;
}

describe('pi 扩展胶水层', () => {
  it('订阅全部 41 个事件（缺项即失败）', async () => {
    const pi = makePi();
    const configPath = writeConfig({ url: baseUrl, name: 'ext-agent' });
    const components = await createAgentBoard(pi, { agentDir: dir, configPath });
    const expectedEvents = STATE_IDS.filter((state) => state !== 'agent_snapshot');
    for (const event of expectedEvents) {
      expect(pi.emitted.get(event)?.length, event).toBeGreaterThanOrEqual(1);
    }
    await components.stop();
  });

  it('project_trust 返回 undecided（不干预信任决策）', async () => {
    const pi = makePi();
    const components = await createAgentBoard(pi, {
      agentDir: dir,
      configPath: writeConfig({ url: baseUrl }),
    });
    const handler = pi.emitted.get('project_trust')?.[0] as
      ((event: unknown, ctx: ExtensionContext) => unknown) | undefined;
    expect(handler).toBeDefined();
    const result = handler?.({ type: 'project_trust', cwd: '/x' }, makeCtx());
    expect(result).toEqual({ trusted: 'undecided' });
    await components.stop();
  });

  it('session_start 启动 Reporter；事件经真实订阅路径上报；uuid 持久化', async () => {
    const pi = makePi();
    const configPath = writeConfig({ url: baseUrl, name: 'ext-agent', logLevel: 'info' });
    const components = await createAgentBoard(pi, { agentDir: dir, configPath });
    const ctx = makeCtx();

    // 会话启动 → Reporter 启动
    for (const handler of pi.emitted.get('session_start') ?? []) {
      handler({ type: 'session_start', reason: 'startup' }, ctx);
    }

    // 通过真实绑定触发若干事件
    emit(
      pi,
      'before_agent_start',
      { type: 'before_agent_start', prompt: 'hello', images: [], systemPrompt: 'sys' },
      ctx,
    );
    emit(pi, 'agent_start', { type: 'agent_start' }, ctx);
    emit(
      pi,
      'message_end',
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text' }] } },
      ctx,
    );
    emit(
      pi,
      'tool_call',
      { type: 'tool_call', toolCallId: 'c1', toolName: 'bash', input: { command: 'ls' } },
      ctx,
    );
    emit(pi, 'input', { type: 'input', text: 'hi', source: 'interactive' }, ctx);

    await components.reporter.collectSnapshotAndFlush();

    const uuid = components.reporter.currentIdentity?.uuid;
    expect(uuid).toMatch(/^[0-9a-f-]{36}$/);
    const identityFile = path.join(dir, 'agent-board-identity.json');
    expect(fs.existsSync(identityFile)).toBe(true);
    const identity = JSON.parse(fs.readFileSync(identityFile, 'utf8'));
    expect(identity['uuid']).toBe(uuid);

    // 快照字段来自 ctx
    const agentResponse = await fetch(`${baseUrl}/v1/agents/${uuid}`);
    const record = (await agentResponse.json()) as Record<string, unknown>;
    const latest = record['latest'] as Record<string, unknown>;
    expect(Object.keys(latest)).toEqual(
      expect.arrayContaining(['agent_snapshot', 'before_agent_start', 'message_end', 'tool_call']),
    );
    const snapshot = latest['agent_snapshot']?.['payload'] as Record<string, unknown>;
    expect(snapshot['cwd']).toBe('/home/user/proj');
    expect(snapshot['mode']).toBe('tui');
    expect(snapshot['model']).toBe('anthropic/claude-x');
    expect(snapshot['sessionId']).toBe('pi-session-abc');
    expect(snapshot['sessionName']).toBe('feature/board');
    expect(snapshot['activeToolCount']).toBe(2);
    expect(snapshot['isProjectTrusted']).toBe(true);
    expect(snapshot['isIdle']).toBe(false);
    expect(snapshot['hasPendingMessages']).toBe(true);
    expect(snapshot['contextUsage']).toEqual({ tokens: 4200, contextWindow: 200000, percent: 2.1 });
    expect(record['name']).toBe('ext-agent');

    // 日志文件写入（JSON 行）——仅当配置开启 logLevel 时才写
    const logFile = path.join(dir, 'agent-board-client.log');
    expect(fs.existsSync(logFile)).toBe(true);
    const log = fs.readFileSync(logFile, 'utf8');
    expect(log).toContain('reporter.start');
    await components.stop();
  });

  it('默认零日志：未配置 logLevel 时不创建日志文件（client 轻量契约）', async () => {
    const pi = makePi();
    const components = await createAgentBoard(pi, {
      agentDir: dir,
      configPath: writeConfig({ url: baseUrl }),
    });
    for (const handler of pi.emitted.get('session_start') ?? []) {
      handler({ type: 'session_start', reason: 'startup' }, makeCtx());
    }
    await components.reporter.collectSnapshotAndFlush();
    expect(components.reporter.getStats().sent).toBe(1); // 上报功能正常
    await components.stop();
    expect(fs.existsSync(path.join(dir, 'agent-board-client.log'))).toBe(false);
  }, 20_000);

  it('logLevel 配置开启：按级别写入 JSON 行日志', async () => {
    const pi = makePi();
    const components = await createAgentBoard(pi, {
      agentDir: dir,
      configPath: writeConfig({ url: baseUrl, logLevel: 'info' }),
    });
    for (const handler of pi.emitted.get('session_start') ?? []) {
      handler({ type: 'session_start', reason: 'startup' }, makeCtx());
    }
    await components.reporter.collectSnapshotAndFlush();
    await components.stop(); // logger.flush() 后日志落盘
    const log = fs.readFileSync(path.join(dir, 'agent-board-client.log'), 'utf8');
    expect(log).toContain('reporter.start');
  }, 20_000);

  it('配置文件缺失 + AGENT_BOARD_LOG_LEVEL=error：issues 补输出（不静默）', async () => {
    process.env['AGENT_BOARD_LOG_LEVEL'] = 'error';
    try {
      const pi = makePi();
      const logFile = path.join(dir, 'agent-board-client.log');
      const components = await createAgentBoard(pi, {
        agentDir: dir,
        configPath: path.join(dir, 'nope.json'),
      });
      await components.stop(); // 构造时补输出的 issues 在 flush 后落盘
      const log = fs.readFileSync(logFile, 'utf8');
      expect(log).toContain('client.config.issue');
    } finally {
      delete process.env['AGENT_BOARD_LOG_LEVEL'];
    }
  });

  it('LOG_LEVEL_ENV 优先级高于配置文件；非法值记 issue', async () => {
    const pi = makePi();
    const components = await createAgentBoard(pi, {
      agentDir: dir,
      configPath: writeConfig({ url: baseUrl, logLevel: 'silent' }),
    });
    await components.stop();
    expect(fs.existsSync(path.join(dir, 'agent-board-client.log'))).toBe(false);

    // env 合法值胜过配置文件的 silent
    process.env['AGENT_BOARD_LOG_LEVEL'] = 'info';
    try {
      const pi2 = makePi();
      const components2 = await createAgentBoard(pi2, {
        agentDir: dir,
        configPath: writeConfig({ url: baseUrl, logLevel: 'silent' }),
      });
      for (const handler of pi2.emitted.get('session_start') ?? []) {
        handler({ type: 'session_start', reason: 'startup' }, makeCtx());
      }
      await components2.stop();
      const log = fs.readFileSync(path.join(dir, 'agent-board-client.log'), 'utf8');
      expect(log).toContain('reporter.start');
    } finally {
      delete process.env['AGENT_BOARD_LOG_LEVEL'];
    }

    // env 非法值：配置文件 logLevel 生效，invalid env 的 issue 在日志级别内可见
    process.env['AGENT_BOARD_LOG_LEVEL'] = 'verbose';
    try {
      const pi3 = makePi();
      const components3 = await createAgentBoard(pi3, {
        agentDir: dir,
        configPath: writeConfig({ url: baseUrl, logLevel: 'warn' }),
      });
      await components3.stop();
      const log = fs.readFileSync(path.join(dir, 'agent-board-client.log'), 'utf8');
      expect(log).toContain('client.config.issue');
      expect(log).toContain('AGENT_BOARD_LOG_LEVEL');
    } finally {
      delete process.env['AGENT_BOARD_LOG_LEVEL'];
    }
  }, 20_000);

  it('session_shutdown 停止 Reporter（await 尽力排空后不再采集）', async () => {
    const pi = makePi();
    const configPath = writeConfig({ url: baseUrl });
    const components = await createAgentBoard(pi, { agentDir: dir, configPath });
    for (const handler of pi.emitted.get('session_start') ?? []) {
      handler({ type: 'session_start', reason: 'startup' }, makeCtx());
    }
    // handler 被 await：stop 的尽力排空在返回前完成
    for (const handler of pi.emitted.get('session_shutdown') ?? []) {
      await handler({ type: 'session_shutdown', reason: 'quit' }, makeCtx());
    }
    // 尽力排空已发送 session_shutdown 采集的信封（server 可见）
    const uuid = components.reporter.currentIdentity?.uuid;
    expect(uuid).toMatch(/^[0-9a-f-]{36}$/);
    const response = await fetch(`${baseUrl}/v1/agents/${uuid}`);
    const record = (await response.json()) as Record<string, unknown>;
    const latest = record['latest'] as Record<string, unknown>;
    expect(Object.keys(latest)).toEqual(expect.arrayContaining(['session_shutdown']));
    // 停止后再触发事件不再采集
    const before = components.reporter.getStats().collected;
    emit(pi, 'agent_start', { type: 'agent_start' }, makeCtx());
    expect(components.reporter.getStats().collected).toBe(before);
    await components.stop();
  });

  it('stop 取消全部事件订阅', async () => {
    const pi = makePi();
    const components = await createAgentBoard(pi, {
      agentDir: dir,
      configPath: writeConfig({ url: baseUrl }),
    });
    await components.stop();
    for (const event of STATE_IDS) {
      expect(pi.emitted.get(event)?.length ?? 0, event).toBe(0);
    }
  });
});
