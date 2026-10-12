/**
 * 契约校验器：信封与逐状态载荷的纯函数校验。
 *
 * 职责契约：
 * - 无外部依赖、无 IO；输入未知数据，输出结构化校验结果。
 * - 未知键拒绝（契约权威性）；枚举/范围/长度/可空逐项检查。
 * - server 端在入库前调用；client 端不依赖（server 权威校验）。
 */
import {
  getContract,
  SUPPORTED_PROTOCOL_VERSIONS,
  type AgentIdentityFields,
  type FieldSpec,
} from './contracts.js';
import { ERROR_CODES } from './errors.js';

export interface FieldError {
  field: string;
  code: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: FieldError[];
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const good = (): ValidationResult => ({ ok: true, errors: [] });
const bad = (field: string, code: string, message: string): ValidationResult => ({
  ok: false,
  errors: [{ field, code, message }],
});

function append(a: ValidationResult, b: ValidationResult): ValidationResult {
  return { ok: a.ok && b.ok, errors: [...a.errors, ...b.errors] };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isInteger(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

/** 校验单个字段规格 against 已取出的值。 */
export function validateField(spec: FieldSpec, value: unknown, path: string): ValidationResult {
  if (value === undefined || value === null) {
    if (spec.nullable === true && value === null) {
      return good();
    }
    if (spec.required === true) {
      return bad(path, 'E_FIELD_REQUIRED', `field '${path}' is required`);
    }
    return good();
  }

  switch (spec.type) {
    case 'string': {
      if (typeof value !== 'string') {
        return bad(path, 'E_FIELD_TYPE', `field '${path}' must be string, got ${typeof value}`);
      }
      if (spec.min !== undefined && value.length < spec.min) {
        return bad(
          path,
          'E_FIELD_RANGE',
          `field '${path}' length ${value.length} < min ${spec.min}`,
        );
      }
      if (spec.max !== undefined && value.length > spec.max) {
        return bad(
          path,
          'E_FIELD_RANGE',
          `field '${path}' length ${value.length} > max ${spec.max}`,
        );
      }
      if (spec.enum !== undefined && !(spec.enum as ReadonlyArray<string>).includes(value)) {
        return bad(
          path,
          'E_FIELD_ENUM',
          `field '${path}' value not in enum [${spec.enum.join(', ')}]`,
        );
      }
      if (spec.pattern !== undefined && !new RegExp(spec.pattern).test(value)) {
        return bad(
          path,
          'E_FIELD_PATTERN',
          `field '${path}' does not match pattern ${spec.pattern}`,
        );
      }
      return good();
    }
    case 'integer': {
      if (!isInteger(value)) {
        return bad(path, 'E_FIELD_TYPE', `field '${path}' must be integer, got ${typeof value}`);
      }
      return checkRange(spec, value, path);
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return bad(
          path,
          'E_FIELD_TYPE',
          `field '${path}' must be finite number, got ${typeof value}`,
        );
      }
      return checkRange(spec, value, path);
    }
    case 'boolean': {
      if (typeof value !== 'boolean') {
        return bad(path, 'E_FIELD_TYPE', `field '${path}' must be boolean, got ${typeof value}`);
      }
      return good();
    }
    case 'array': {
      if (!Array.isArray(value)) {
        return bad(path, 'E_FIELD_TYPE', `field '${path}' must be array, got ${typeof value}`);
      }
      if (spec.min !== undefined && value.length < spec.min) {
        return bad(
          path,
          'E_FIELD_RANGE',
          `field '${path}' has ${value.length} items < min ${spec.min}`,
        );
      }
      if (spec.max !== undefined && value.length > spec.max) {
        return bad(
          path,
          'E_FIELD_RANGE',
          `field '${path}' has ${value.length} items > max ${spec.max}`,
        );
      }
      if (spec.items === undefined) {
        return good();
      }
      const itemSpec = spec.items;
      return value.reduce<ValidationResult>(
        (acc, item, index) => append(acc, validateField(itemSpec, item, `${path}[${index}]`)),
        good(),
      );
    }
    case 'object': {
      if (!isObject(value)) {
        return bad(path, 'E_FIELD_TYPE', `field '${path}' must be object, got ${typeof value}`);
      }
      if (spec.fields === undefined) {
        return good();
      }
      let result = good();
      for (const member of spec.fields) {
        result = append(
          result,
          validateField(member, value[member.name], `${path}.${member.name}`),
        );
      }
      const declared = new Set(spec.fields.map((member) => member.name));
      for (const key of Object.keys(value)) {
        if (!declared.has(key)) {
          result = append(
            result,
            bad(`${path}.${key}`, 'E_FIELD_UNKNOWN', `unknown field '${path}.${key}'`),
          );
        }
      }
      return result;
    }
  }
}

function checkRange(spec: FieldSpec, value: number, path: string): ValidationResult {
  if (spec.min !== undefined && value < spec.min) {
    return bad(path, 'E_FIELD_RANGE', `field '${path}' value ${value} < min ${spec.min}`);
  }
  if (spec.max !== undefined && value > spec.max) {
    return bad(path, 'E_FIELD_RANGE', `field '${path}' value ${value} > max ${spec.max}`);
  }
  return good();
}

/**
 * 校验状态载荷（逐状态契约）。
 */
export function validatePayload(state: string, payload: unknown): ValidationResult {
  const contract = getContract(state);
  if (contract === undefined) {
    return bad('state', ERROR_CODES.UNKNOWN_STATE, `unknown state '${state}'`);
  }
  return validateField(contract.payload, payload, 'payload');
}

/** agent 身份字段校验（信封子结构）。 */
function validateAgent(agent: unknown): ValidationResult {
  if (!isObject(agent)) {
    return bad('agent', ERROR_CODES.AGENT_IDENTITY, 'agent must be an object');
  }
  const identity = agent as unknown as AgentIdentityFields;
  let result = good();
  result = append(
    result,
    validateField(
      { name: 'name', type: 'string', required: true, min: 1, max: 256 },
      identity['name'],
      'agent.name',
    ),
  );
  result = append(
    result,
    validateField(
      { name: 'cwd', type: 'string', required: true, min: 1, max: 4096 },
      identity['cwd'],
      'agent.cwd',
    ),
  );
  result = append(
    result,
    validateField(
      { name: 'uuid', type: 'string', required: false, pattern: UUID_PATTERN.source },
      identity['uuid'],
      'agent.uuid',
    ),
  );
  result = append(
    result,
    validateField(
      { name: 'sessionId', type: 'string', required: false, min: 0, max: 256 },
      identity['sessionId'],
      'agent.sessionId',
    ),
  );
  result = append(
    result,
    validateField(
      { name: 'piVersion', type: 'string', required: false, min: 1, max: 64 },
      identity['piVersion'],
      'agent.piVersion',
    ),
  );
  return result;
}

export interface EnvelopeValidationOptions {
  now: number;
  /** 允许的最大报告滞后（默认 7 天）。 */
  maxReportAgeMs?: number;
  /** 允许的最大提前量（默认 60s）。 */
  maxFutureMs?: number;
}

/**
 * 校验完整上报信封：协议版本、状态注册表、时间戳、身份字段与状态载荷。
 */
export function validateEnvelope(
  envelope: unknown,
  options: EnvelopeValidationOptions,
): ValidationResult {
  if (!isObject(envelope)) {
    return bad('envelope', ERROR_CODES.INVALID_ENVELOPE, 'envelope must be an object');
  }
  const maxReportAgeMs = options.maxReportAgeMs ?? 7 * 24 * 60 * 60 * 1000;
  const maxFutureMs = options.maxFutureMs ?? 60_000;

  let result = validateField(
    { name: 'protocolVersion', type: 'string', required: true },
    envelope['protocolVersion'],
    'protocolVersion',
  );
  if (
    typeof envelope['protocolVersion'] === 'string' &&
    !(SUPPORTED_PROTOCOL_VERSIONS as ReadonlyArray<string>).includes(envelope['protocolVersion'])
  ) {
    result = append(
      result,
      bad(
        'protocolVersion',
        ERROR_CODES.UNSUPPORTED_PROTOCOL,
        `unsupported protocolVersion '${envelope['protocolVersion']}' (supported: ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')})`,
      ),
    );
  }

  const state = envelope['state'];
  if (typeof state !== 'string' || getContract(state) === undefined) {
    result = append(
      result,
      bad('state', ERROR_CODES.UNKNOWN_STATE, `unknown state '${String(state)}'`),
    );
    return result;
  }

  const timestamp = envelope['timestamp'];
  result = append(
    result,
    validateField(
      { name: 'timestamp', type: 'integer', required: true, min: 0 },
      timestamp,
      'timestamp',
    ),
  );
  if (isInteger(timestamp)) {
    if (timestamp > options.now + maxFutureMs) {
      result = append(
        result,
        bad(
          'timestamp',
          ERROR_CODES.INVALID_ENVELOPE,
          `timestamp is more than ${maxFutureMs}ms in the future`,
        ),
      );
    } else if (timestamp < options.now - maxReportAgeMs) {
      result = append(
        result,
        bad('timestamp', ERROR_CODES.STALE_REPORT, `timestamp older than ${maxReportAgeMs}ms`),
      );
    }
  }

  result = append(result, validateAgent(envelope['agent']));
  result = append(result, validatePayload(state, envelope['payload']));
  return result;
}
