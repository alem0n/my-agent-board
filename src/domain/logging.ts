/**
 * 日志端口：domain/services 层通过此接口输出结构化日志。
 *
 * 职责契约：领域层不依赖 pino 等具体实现。实现方：
 * - src/logger.ts 的 pino 实例（server 侧）。
 * - infrastructure 层的 JSON 行文件日志器（pi 扩展侧，避免在 pi 进程内引入运行时依赖）。
 */
export interface BoardLogger {
  trace(msg: string, fields?: Record<string, unknown>): void;
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

/** client 日志级别。silent 为默认：除用户显式配置外不产生任何日志输出。 */
export type LogLevel = 'silent' | 'trace' | 'debug' | 'info' | 'warn' | 'error';

/** 全部日志级别（解析校验用）。 */
export const LOG_LEVELS: ReadonlyArray<LogLevel> = [
  'silent',
  'trace',
  'debug',
  'info',
  'warn',
  'error',
];

/** 满足 BoardLogger 的最小实现：丢弃全部日志（测试默认注入）。 */
export const silentLogger: BoardLogger = {
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
