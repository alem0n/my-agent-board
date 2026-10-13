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
import { boardLogger as logger } from './logger.js';
import { AgentRegistry } from './services/registry.js';
import { BoardHttpServer } from './infrastructure/http-server.js';

export async function main(): Promise<number> {
  const config = loadServerConfig();

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
  void main().then((code) => {
    process.exitCode = code;
  });
}
