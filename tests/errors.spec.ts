/**
 * 协议错误类测试：错误码、详情、批量超限错误。
 */
import { describe, it, expect } from 'vitest';
import { ERROR_CODES, ProtocolError, BatchTooLargeError } from '../src/domain/errors.js';

describe('协议错误类', () => {
  it('携带 code 与结构化详情', () => {
    const error = new ProtocolError(ERROR_CODES.INVALID_PAYLOAD, 'bad field', { field: 'x' });
    expect(error.code).toBe('E_INVALID_PAYLOAD');
    expect(error.message).toBe('bad field');
    expect(error.details).toEqual({ field: 'x' });
  });

  it('无详情时 details 缺省', () => {
    const error = new ProtocolError(ERROR_CODES.NOT_FOUND, 'missing');
    expect(error.details).toBeUndefined();
  });

  it('BatchTooLargeError 是 Error 子类', () => {
    const error = new BatchTooLargeError('too big');
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('too big');
  });

  it('错误码集合完整（协议错误对照表）', () => {
    expect(Object.values(ERROR_CODES).sort()).toEqual(
      [
        'E_UNSUPPORTED_PROTOCOL',
        'E_INVALID_ENVELOPE',
        'E_UNKNOWN_STATE',
        'E_INVALID_PAYLOAD',
        'E_STALE_REPORT',
        'E_AGENT_IDENTITY',
        'E_BATCH_TOO_LARGE',
        'E_NOT_FOUND',
        'E_METHOD_NOT_ALLOWED',
        'E_INTERNAL',
      ].sort(),
    );
  });
});
