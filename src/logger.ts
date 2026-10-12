/**
 * 日志模块：唯一允许创建与配置 pino 实例的地方。
 *
 * 职责契约：业务模块一律从本文件导入 logger。
 * 禁止各模块自行创建 logger 实例或输出 console。
 *
 * - logger：pino 原始实例（控制台/stdout JSON）。
 * - boardLogger：领域 BoardLogger 端口的 pino 适配（msg + 结构化字段），
 *   供 services/infrastructure 层注入；测试可用 silentLogger。
 */
import pino from 'pino';
import type { BoardLogger } from './domain/logging.js';

const level = process.env['LOG_LEVEL'] ?? 'info';

export const logger = pino({
  level,
  formatters: {
    level(label) {
      return { level: label };
    },
  },
});

const bindLevel =
  (target: 'trace' | 'debug' | 'info' | 'warn' | 'error') =>
  (msg: string, fields?: Record<string, unknown>): void => {
    logger[target](fields ?? {}, msg);
  };

export const boardLogger: BoardLogger = {
  trace: bindLevel('trace'),
  debug: bindLevel('debug'),
  info: bindLevel('info'),
  warn: bindLevel('warn'),
  error: bindLevel('error'),
};
