/**
 * server 入口点：只做组装与初始化，不承载业务逻辑。
 *
 * 职责契约：
 * - 读取配置 → 初始化日志 → 依赖注入 → 启动 HTTP server。
 * - 优雅关闭：SIGINT/SIGTERM → 停止接收、强制持久化注册表、退出。
 * - 业务规则属于 services 层。
 *
 * 运行：pnpm dev -- --port=7878 --data-dir=./data（或 pnpm tsx src/index.ts）
 */
import * as path from 'node:path';
import process from 'node:process';
import { loadServerConfig } from './config.js';
import { boardLogger as logger } from './logger.js';
import { AgentRegistry } from './services/registry.js';
import { BoardHttpServer } from './infrastructure/http-server.js';
import { FileRegistryStore } from './infrastructure/registry-file-store.js';

export async function main(): Promise<number> {
  const config = loadServerConfig();
  const registryPath = path.resolve(config.dataDir, 'agents.json');

  const registry = new AgentRegistry(new FileRegistryStore(registryPath, logger), logger, {
    historyLimit: 1000,
    persistDebounceMs: 250,
  });

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
      'GET /v1/agents',
      'GET /v1/agents/:uuid',
      'GET /v1/agents/:uuid/history?state=&limit=&since=',
      'GET /v1/health',
      ...(config.webUi ? ['GET / (Web UI)', 'GET /ui (Web UI)'] : []),
    ],
    registryPath,
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info('server.shuttingDown', { signal });
    try {
      await server.stop();
      registry.close();
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
