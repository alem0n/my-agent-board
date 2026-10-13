/**
 * server 入口点：只做组装与初始化，不承载业务逻辑。
 *
 * 职责契约：
 * - 读取配置 → 初始化日志 → 依赖注入 → 启动 HTTP server。
 * - 优雅关闭：SIGINT/SIGTERM → 停止接收、退出。
 * - 注册表为纯内存（REQ-008）：不写盘，重启即清空。
 *
 * 运行：pnpm dev -- --port=7878（或 pnpm tsx src/index.ts）
 */
import process from 'node:process';
import { loadServerConfig } from './config.js';
import { boardLogger as logger, configureLogging, logger as rootLogger } from './logger.js';
import { AgentRegistry } from './services/registry.js';
import { BoardHttpServer } from './infrastructure/http-server.js';

export async function main(): Promise<number> {
  const config = loadServerConfig();

  // 显式 --log-level 覆盖环境变量种子值；非法值已在解析层回退默认并生成告警。
  if (config.logLevelProvided) {
    configureLogging(config.logLevel);
  }
  for (const warning of config.warnings) {
    logger.warn('server.configFallback', { warning });
  }

  const registry = new AgentRegistry(logger, { historyLimit: 1000 });

  const server = new BoardHttpServer({
    host: config.host,
    port: config.port,
    registry,
    logger,
    webUi: config.webUi,
  });

  const address = await server.start();
  logger.info('server.started', {
    host: address.host,
    port: address.port,
    logLevel: rootLogger.level,
    webUi: config.webUi,
    endpoints: [
      'POST /v1/report',
      'POST /v1/report/batch',
      'POST /v1/heartbeat',
      'GET /v1/agents',
      'GET /v1/agents/:uuid',
      'GET /v1/agents/:uuid/history?state=&limit=&since=',
      'DELETE /v1/agents/:uuid',
      'GET /v1/health',
      ...(config.webUi ? ['GET / (Web UI)', 'GET /ui (Web UI)'] : []),
    ],
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info('server.shuttingDown', { signal });
    try {
      await server.stop();
    } catch (error) {
      logger.error('server.shutdownError', { error: String(error) });
    }
  };

  await new Promise<void>((resolve) => {
    process.on('SIGINT', () => resolve());
    process.on('SIGTERM', () => resolve());
  });
  await shutdown('signal');

  return 0;
}

if (!process.env['VITEST'] && process.env.NODE_ENV !== 'test') {
  void main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      // 启动失败（端口占用等）：结构化错误日志 + 非 0 退出，避免裸 unhandled rejection。
      logger.error('server.startupFailed', { error: String(error) });
      process.exitCode = 1;
    });
}
