/**
 * client 配置文件加载（infrastructure 层）。
 *
 * 职责契约：读取 ~/.pi/agent/agent-board-server.json 并调用纯解析器（异步文件读，不阻塞主线程）。
 * 文件缺失 / JSON 非法 → 明确错误日志 + 内置默认值降级（不得静默失败）。
 * 路径可用环境变量 AGENT_BOARD_SERVER_CONFIG 覆盖（测试与演示注入）。
 */
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseClientConfig, logConfigIssues, type ClientConfig } from '../domain/client-config.js';
import type { BoardLogger } from '../domain/logging.js';

export const DEFAULT_CONFIG_PATH = path.join(
  os.homedir(),
  '.pi',
  'agent',
  'agent-board-server.json',
);
export const CONFIG_PATH_ENV = 'AGENT_BOARD_SERVER_CONFIG';

export function resolveConfigPath(explicit?: string): string {
  if (explicit !== undefined && explicit.length > 0) {
    return explicit;
  }
  const fromEnv = process.env[CONFIG_PATH_ENV];
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }
  return DEFAULT_CONFIG_PATH;
}

/**
 * 异步加载配置文件。任何文件级或字段级问题都产出错误日志后降级为默认值。
 */
export async function loadClientConfig(options: {
  filePath?: string;
  logger: BoardLogger;
}): Promise<ClientConfig> {
  const filePath = resolveConfigPath(options.filePath);
  const logger = options.logger;

  let text: string;
  try {
    text = await fsp.readFile(filePath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      logger.error('client.config.missing', {
        path: filePath,
        action: 'falling back to built-in defaults',
      });
    } else {
      logger.error('client.config.readFailed', {
        path: filePath,
        error: String(error),
        action: 'falling back to built-in defaults',
      });
    }
    const config = parseClientConfig(undefined);
    logConfigIssues(config, logger, code === 'ENOENT' ? 'missing-file' : 'read-failed');
    return config;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    logger.error('client.config.invalidJson', {
      path: filePath,
      error: String(error),
      action: 'falling back to built-in defaults',
    });
    const config = parseClientConfig(undefined);
    logConfigIssues(config, logger, 'invalid-json');
    return config;
  }

  const config = parseClientConfig(parsed);
  logConfigIssues(config, logger, filePath);
  logger.info('client.config.loaded', { path: filePath, serverUrl: config.serverUrl });
  return config;
}
