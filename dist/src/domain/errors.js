/**
 * 领域错误码：client-server 协议错误契约。
 *
 * 职责契约：定义全部协议错误标识。http 层据此映射 HTTP 状态码并生成错误响应体。
 */
export const ERROR_CODES = {
    UNSUPPORTED_PROTOCOL: 'E_UNSUPPORTED_PROTOCOL',
    INVALID_ENVELOPE: 'E_INVALID_ENVELOPE',
    UNKNOWN_STATE: 'E_UNKNOWN_STATE',
    INVALID_PAYLOAD: 'E_INVALID_PAYLOAD',
    STALE_REPORT: 'E_STALE_REPORT',
    AGENT_IDENTITY: 'E_AGENT_IDENTITY',
    BATCH_TOO_LARGE: 'E_BATCH_TOO_LARGE',
    NOT_FOUND: 'E_NOT_FOUND',
    METHOD_NOT_ALLOWED: 'E_METHOD_NOT_ALLOWED',
    INTERNAL: 'E_INTERNAL',
};
/** 协议层错误：携带可读消息与结构化详情，供 client 排障与测试断言。 */
export class ProtocolError extends Error {
    code;
    details;
    constructor(code, message, details) {
        super(message);
        this.name = 'ProtocolError';
        this.code = code;
        if (details !== undefined) {
            this.details = details;
        }
    }
}
/** client 侧：批量请求体超过 server 上限（E_BATCH_TOO_LARGE），需拆分重试。 */
export class BatchTooLargeError extends Error {
    constructor(message) {
        super(message);
        this.name = 'BatchTooLargeError';
    }
}
//# sourceMappingURL=errors.js.map