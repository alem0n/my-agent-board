/**
 * pi 扩展胶水层：将真实 ExtensionAPI/ExtensionContext 适配到 client 库端口。
 *
 * 职责契约（infrastructure 层）：
 * - 对 pi 的 41 个事件逐一 Typed 订阅（缺项/错拼为编译错误，保证状态覆盖）。
 * - 从 ctx 构建环境快照（PiEnvironmentProvider）。
 * - 生命周期遵循《手册》：factory 中只做配置装配，不启动定时器/进程；
 *   session_start 启动 Reporter，session_shutdown 停止（尽力刷新，残留丢弃）。
 * - project_trust 返回 undecided（不干预信任决策）。
 *
 * 手册依据：docs/extensions.md（Respect the runtime lifecycle）。
 */
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { BoardLogger, LogLevel } from '../domain/logging.js';
import { silentLogger, LOG_LEVELS } from '../domain/logging.js';
import { logConfigIssues } from '../domain/client-config.js';
import type {
  ContextUsageSnapshot,
  ExtensionMode,
  PiEnvironmentProvider,
  PiEnvironmentSnapshot,
  PiStateSource,
} from '../domain/pi-env.js';
import type { Transport } from '../domain/ports.js';
import { loadClientConfig, envLogLevel, LOG_LEVEL_ENV } from './client-config-loader.js';
import { FileIdentityStore, SerialFileWriter } from './file-store.js';
import { HttpTransport } from './http-client.js';
import { Reporter } from '../services/reporter.js';

const DEFAULT_AGENT_DIR = path.join(os.homedir(), '.pi', 'agent');

/** BoardLogger 的 pi 进程内实现：JSON 行异步写入本地文件（串行写队列，不依赖 pino、不阻塞 pi 主线程）。
 * 默认 silent：除非用户经配置文件 logLevel 或 AGENT_BOARD_LOG_LEVEL 显式开启，不创建文件、不产生任何日志 IO。 */
class JsonLineFileLogger implements BoardLogger {
  private readonly filePath: string;
  private readonly minLevel: number;
  private readonly writer = new SerialFileWriter();
  private lost = 0;

  constructor(filePath: string, level: LogLevel = 'silent') {
    this.filePath = filePath;
    this.minLevel = LEVELS[level];
  }

  trace(msg: string, fields?: Record<string, unknown>): void {
    this.write('trace', msg, fields);
  }
  debug(msg: string, fields?: Record<string, unknown>): void {
    this.write('debug', msg, fields);
  }
  info(msg: string, fields?: Record<string, unknown>): void {
    this.write('info', msg, fields);
  }
  warn(msg: string, fields?: Record<string, unknown>): void {
    this.write('warn', msg, fields);
  }
  error(msg: string, fields?: Record<string, unknown>): void {
    this.write('error', msg, fields);
  }

  private write(
    level: 'trace' | 'debug' | 'info' | 'warn' | 'error',
    msg: string,
    fields?: Record<string, unknown>,
  ): void {
    if (LEVELS[level] < this.minLevel) {
      return;
    }
    const line =
      JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(fields ?? {}) }) + '\n';
    // 异步写：日志调用本身不同步阻塞；失败退化为 stderr（meta-logging）并计数。
    void this.writer
      .enqueue(() => fsp.appendFile(this.filePath, line, 'utf8'))
      .catch((error: unknown) => {
        this.lost += 1;
        if (this.lost <= 3) {
          process.stderr.write(`agent-board logger write failed: ${String(error)}\n`);
        }
      });
  }

  /** 等待排队日志落盘（关闭路径调用）。 */
  flush(): Promise<void> {
    return this.writer.flush();
  }
}

const LEVELS: Record<LogLevel, number> = {
  silent: Number.POSITIVE_INFINITY,
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
};

export interface AgentBoardPaths {
  agentDir?: string;
  configPath?: string;
  logPath?: string;
}

export interface AgentBoardComponents {
  reporter: Reporter;
  stop: () => Promise<void>;
}

/**
 * 组装 client 组合根（扩展 factory 调用）。可注入路径用于测试。
 * 异步：配置文件异步读取（pi ExtensionFactory 允许返回 Promise）。
 */
export async function createAgentBoard(
  pi: ExtensionAPI,
  paths: AgentBoardPaths = {},
): Promise<AgentBoardComponents> {
  const agentDir = paths.agentDir ?? DEFAULT_AGENT_DIR;
  const logPath = paths.logPath ?? path.join(agentDir, 'agent-board-client.log');

  // client 默认零日志：env 或配置文件显式开启 logLevel 前不产生任何日志 IO。
  // 配置解析期不输出（级别未定）；解析结果中的 issues 在级别确定后补输出（不静默失败）。
  const config = await loadClientConfig({
    ...(paths.configPath === undefined ? {} : { filePath: paths.configPath }),
    logger: silentLogger,
  });
  const env = envLogLevel();
  const logger = new JsonLineFileLogger(logPath, env.level ?? config.logLevel ?? 'silent');
  if (env.invalid !== undefined) {
    logger.warn('client.config.issue', {
      context: 'client',
      field: LOG_LEVEL_ENV,
      message: `invalid value '${env.invalid}'; must be one of ${LOG_LEVELS.join('/')}; logging stays off`,
    });
  }
  logConfigIssues(config, logger, 'client');

  const identityStore = new FileIdentityStore(
    path.join(agentDir, 'agent-board-identity.json'),
    logger,
  );
  const transport: Transport = new HttpTransport({
    serverUrl: config.serverUrl,
    requestTimeoutMs: config.requestTimeoutMs,
    logger,
  });

  let currentCtx: ExtensionContext | undefined;

  const envProvider: PiEnvironmentProvider = {
    snapshot(): PiEnvironmentSnapshot {
      return snapshotFromContext(currentCtx, pi);
    },
  };

  const handlers = new Map<string, (event: unknown) => void>();
  const source: PiStateSource = {
    subscribe(state, handler) {
      handlers.set(state, handler);
      return () => {
        if (handlers.get(state) === handler) {
          handlers.delete(state);
        }
      };
    },
  };

  const dispatch = (state: string, event: unknown, ctx: ExtensionContext): void => {
    currentCtx = ctx;
    const handler = handlers.get(state);
    if (handler !== undefined) {
      handler(event);
    }
  };

  const unsubscribeAllExtra: Array<() => void> = [];

  const unsubscribeAll = bindAllEvents(pi, dispatch);

  const reporter = new Reporter({
    source,
    env: envProvider,
    transport,
    identityStore,
    config,
    logger,
  });

  let started = false;
  const ensureStarted = (): void => {
    if (started) {
      return;
    }
    started = true;
    reporter.start();
  };

  // 《手册》: long-lived resources 从 session_start 启动，session_shutdown 关闭。
  const unsubscribeSessionStart = pi.on('session_start', () => {
    ensureStarted();
  });
  // factory 期的启动路径：若扩展加载时 session 已在运行（reload 后），不订阅后续事件将丢失；
  // 由 session_start 兜底，最坏情况是错过加载到首事件之间的事件（保守假设，见设计文档）。
  // 《手册》: session_shutdown 是会话级资源的同步点（handler 被 await）；
  // await stop 使关闭路径的尽力排空获得限时窗口（buffer 为空时即时返回）；
  // 随后等日志队列落盘——生产路径 components.stop() 不可达（扩展入口丢弃 components）。
  const unsubscribeSessionShutdown = pi.on('session_shutdown', async (_event, ctx) => {
    currentCtx = ctx;
    await reporter.stop();
    await logger.flush();
  });
  unsubscribeAllExtra.push(unsubscribeSessionStart, unsubscribeSessionShutdown);

  const stop = async (): Promise<void> => {
    for (const unsubscribe of unsubscribeAllExtra) {
      unsubscribe();
    }
    unsubscribeAll();
    await reporter.stop();
    // 等待全部排队异步文件写落盘（身份 / 日志）。
    await Promise.all([identityStore.flush(), logger.flush()]);
  };

  return { reporter, stop };
}

/** 从 ExtensionContext 构建可采样环境快照（ctx 缺省时回落进程级默认值）。 */
function snapshotFromContext(
  ctx: ExtensionContext | undefined,
  pi: ExtensionAPI,
): PiEnvironmentSnapshot {
  if (ctx === undefined) {
    return {
      sessionId: undefined,
      sessionName: undefined,
      cwd: process.cwd(),
      mode: 'print',
      hasUI: false,
      isProjectTrusted: false,
      isIdle: true,
      hasPendingMessages: false,
      model: undefined,
      thinkingLevel: undefined,
      contextUsage: undefined,
      activeTools: [],
      piVersion: piVersion(),
      startedAt: STARTED_AT,
    };
  }

  let sessionId: string | undefined;
  let sessionName: string | undefined;
  try {
    sessionId = ctx.sessionManager.getSessionId();
  } catch {
    sessionId = undefined;
  }
  try {
    sessionName = ctx.sessionManager.getSessionName();
  } catch {
    sessionName = undefined;
  }

  const model = ctx.model;
  const usage = ctx.getContextUsage();
  const contextUsage: ContextUsageSnapshot | undefined =
    usage === undefined
      ? undefined
      : { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent };

  return {
    sessionId,
    sessionName,
    cwd: ctx.cwd,
    mode: ctx.mode satisfies ExtensionMode,
    hasUI: ctx.hasUI,
    isProjectTrusted: ctx.isProjectTrusted(),
    isIdle: ctx.isIdle(),
    hasPendingMessages: ctx.hasPendingMessages(),
    model: model === undefined ? undefined : { provider: model.provider, id: model.id },
    thinkingLevel: ctx.thinkingLevel,
    contextUsage,
    activeTools: pi.getActiveTools(),
    piVersion: piVersion(),
    startedAt: STARTED_AT,
  };
}

function piVersion(): string | undefined {
  const value = process.env['PI_VERSION'];
  return typeof value === 'string' && value.length >= 1 ? value : undefined;
}

const STARTED_AT = Date.now();

/**
 * 绑定全部 41 个 pi 事件到 dispatch。逐事件显式 typed 订阅：
 * 错拼事件名、遗漏或 ctx 类型不匹配即编译失败（覆盖性的编译期保障）。
 * project_trust 的 ctx 为 ProjectTrustContext（子集），且必须返回决策结果；
 * 扩展不干预信任，返回 undecided。
 */
function bindAllEvents(
  pi: ExtensionAPI,
  dispatch: (state: string, event: unknown, ctx: ExtensionContext) => void,
): () => void {
  const unsubs: Array<() => void> = [];
  const bind = (
    state: string,
    subscribe: (handler: (event: unknown, ctx: ExtensionContext) => void) => () => void,
  ): void => {
    unsubs.push(subscribe((event, ctx) => dispatch(state, event, ctx)));
  };

  bind('project_trust', (handler) =>
    pi.on('project_trust', (event, ctx) => {
      handler(event, ctx as unknown as ExtensionContext);
      return { trusted: 'undecided' };
    }),
  );
  bind('resources_discover', (handler) => pi.on('resources_discover', handler));
  bind('mcp_servers_change', (handler) => pi.on('mcp_servers_change', handler));
  bind('session_start', (handler) => pi.on('session_start', handler));
  bind('session_info_changed', (handler) => pi.on('session_info_changed', handler));
  bind('session_before_switch', (handler) => pi.on('session_before_switch', handler));
  bind('session_before_fork', (handler) => pi.on('session_before_fork', handler));
  bind('session_before_compact', (handler) => pi.on('session_before_compact', handler));
  bind('session_compact', (handler) => pi.on('session_compact', handler));
  bind('session_compact_failed', (handler) => pi.on('session_compact_failed', handler));
  bind('session_shutdown', (handler) => pi.on('session_shutdown', handler));
  bind('session_before_tree', (handler) => pi.on('session_before_tree', handler));
  bind('session_tree', (handler) => pi.on('session_tree', handler));
  bind('context', (handler) => pi.on('context', handler));
  bind('context_with_system', (handler) => pi.on('context_with_system', handler));
  bind('cache_warming_decision', (handler) => pi.on('cache_warming_decision', handler));
  bind('before_provider_request', (handler) => pi.on('before_provider_request', handler));
  bind('before_provider_headers', (handler) => pi.on('before_provider_headers', handler));
  bind('after_provider_response', (handler) => pi.on('after_provider_response', handler));
  bind('provider_stream_event', (handler) => pi.on('provider_stream_event', handler));
  bind('before_agent_start', (handler) => pi.on('before_agent_start', handler));
  bind('agent_start', (handler) => pi.on('agent_start', handler));
  bind('agent_end', (handler) => pi.on('agent_end', handler));
  bind('agent_before_settle', (handler) => pi.on('agent_before_settle', handler));
  bind('agent_settled', (handler) => pi.on('agent_settled', handler));
  bind('ui_prompt_start', (handler) => pi.on('ui_prompt_start', handler));
  bind('ui_prompt_end', (handler) => pi.on('ui_prompt_end', handler));
  bind('turn_start', (handler) => pi.on('turn_start', handler));
  bind('turn_end', (handler) => pi.on('turn_end', handler));
  bind('message_start', (handler) => pi.on('message_start', handler));
  bind('message_update', (handler) => pi.on('message_update', handler));
  bind('message_end', (handler) => pi.on('message_end', handler));
  bind('tool_execution_start', (handler) => pi.on('tool_execution_start', handler));
  bind('tool_execution_update', (handler) => pi.on('tool_execution_update', handler));
  bind('tool_execution_end', (handler) => pi.on('tool_execution_end', handler));
  bind('model_select', (handler) => pi.on('model_select', handler));
  bind('thinking_level_select', (handler) => pi.on('thinking_level_select', handler));
  bind('user_bash', (handler) => pi.on('user_bash', handler));
  bind('input', (handler) => pi.on('input', handler));
  bind('tool_call', (handler) => pi.on('tool_call', handler));
  bind('tool_result', (handler) => pi.on('tool_result', handler));

  return () => {
    for (const unsubscribe of unsubs) {
      unsubscribe();
    }
  };
}
