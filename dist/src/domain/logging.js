/** 全部日志级别（解析校验用）。 */
export const LOG_LEVELS = [
    'silent',
    'trace',
    'debug',
    'info',
    'warn',
    'error',
];
/** 满足 BoardLogger 的最小实现：丢弃全部日志（测试默认注入）。 */
export const silentLogger = {
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
};
//# sourceMappingURL=logging.js.map