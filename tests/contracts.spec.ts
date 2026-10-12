/**
 * 契约校验测试：状态覆盖完整性 + 逐状态契约（合法/非法）+ 信封校验。
 *
 * 对应验收门槛：1 状态覆盖、2 契约完整。
 */
import { describe, it, expect } from 'vitest';
import {
  STATE_IDS,
  STATE_REGISTRY,
  getContract,
  PROTOCOL_VERSION,
} from '../src/domain/contracts.js';
import { validateEnvelope, validatePayload } from '../src/domain/validation.js';
import { VALID_SAMPLES, buildEnvelope } from './fixtures/samples.js';

/**
 * 《手册》状态清单 fixture（独立硬编码，来自 types.d.ts 的 on() 重载 + ExtensionContext 采样）。
 * 与 STATE_REGISTRY 做双向集合比对：缺项/多项均失败。
 */
const MANUAL_STATE_LIST = [
  'project_trust',
  'resources_discover',
  'mcp_servers_change',
  'session_start',
  'session_info_changed',
  'session_before_switch',
  'session_before_fork',
  'session_before_compact',
  'session_compact',
  'session_compact_failed',
  'session_shutdown',
  'session_before_tree',
  'session_tree',
  'context',
  'context_with_system',
  'cache_warming_decision',
  'before_provider_request',
  'before_provider_headers',
  'after_provider_response',
  'provider_stream_event',
  'before_agent_start',
  'agent_start',
  'agent_end',
  'agent_before_settle',
  'agent_settled',
  'ui_prompt_start',
  'ui_prompt_end',
  'turn_start',
  'turn_end',
  'message_start',
  'message_update',
  'message_end',
  'tool_execution_start',
  'tool_execution_update',
  'tool_execution_end',
  'model_select',
  'thinking_level_select',
  'user_bash',
  'input',
  'tool_call',
  'tool_result',
  'agent_snapshot',
] as const;

const NOW = 1791800000000;

describe('状态注册表覆盖（验收门槛 1）', () => {
  it('注册表恰好包含 42 项状态', () => {
    expect(STATE_IDS).toHaveLength(42);
    expect(STATE_REGISTRY.size).toBe(42);
  });

  it('与《手册》fixture 一一对应：无缺项、无多余项', () => {
    const registry = new Set(STATE_IDS);
    const manual = new Set<string>(MANUAL_STATE_LIST);
    expect([...registry].filter((state) => !manual.has(state))).toEqual([]);
    expect([...manual].filter((state) => !registry.has(state))).toEqual([]);
  });

  it('每个契约具备标识、版本、触发时机、频率策略与载荷字段表', () => {
    for (const state of STATE_IDS) {
      const contract = getContract(state);
      expect(contract, `contract for ${state}`).toBeDefined();
      expect(contract?.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(contract?.trigger.length ?? 0).toBeGreaterThan(0);
      expect(['event', 'event+coalesce', 'periodic']).toContain(contract?.frequency);
      expect(contract?.payload.type).toBe('object');
      expect(Array.isArray(contract?.payload.fields)).toBe(true);
    }
  });
});

describe('逐状态契约（验收门槛 2）', () => {
  it('每个状态的合法样本通过校验', () => {
    for (const state of STATE_IDS) {
      const sample = VALID_SAMPLES[state];
      expect(sample, `sample for ${state}`).toBeDefined();
      const result = validatePayload(state!, sample);
      expect(result.ok, `${state}: ${JSON.stringify(result.errors)}`).toBe(true);
    }
  });

  it('每个状态的信封级校验通过（含身份字段）', () => {
    for (const state of STATE_IDS) {
      const envelope = buildEnvelope(state!, VALID_SAMPLES[state!]!);
      const result = validateEnvelope(envelope, { now: NOW });
      expect(result.ok, `${state}: ${JSON.stringify(result.errors)}`).toBe(true);
    }
  });

  it('删除任一必填字段即拒绝', () => {
    const statesWithoutRequired: string[] = [];
    for (const state of STATE_IDS) {
      const contract = getContract(state!)!;
      const requiredFields = (contract.payload.fields ?? []).filter((field) => field.required);
      if (requiredFields.length === 0) {
        statesWithoutRequired.push(state!);
        continue;
      }
      for (const field of requiredFields) {
        const mutated: Record<string, unknown> = { ...VALID_SAMPLES[state!] };
        delete mutated[field.name];
        const result = validatePayload(state!, mutated);
        expect(result.ok, `${state}.${field.name} should be required`).toBe(false);
      }
    }
    // 仅“出现性/全可选”状态无必填字段（见契约表 §3.2）。
    expect(statesWithoutRequired.sort()).toEqual(
      [
        'agent_settled',
        'agent_start',
        'before_provider_request',
        'cache_warming_decision',
        'session_info_changed',
        'session_tree',
      ].sort(),
    );
  });

  it('必填字段类型错误即拒绝', () => {
    const cases: Array<[string, string, unknown]> = [
      ['context', 'messageCount', 'many'],
      ['turn_end', 'turnIndex', 'zero'],
      ['message_end', 'usage', 'big'],
      ['tool_execution_end', 'isError', 'no'],
      ['agent_snapshot', 'mode', 'terminal'],
      ['agent_snapshot', 'hasUI', 'yes'],
      ['agent_snapshot', 'uptimeMs', -1],
      ['after_provider_response', 'status', 99],
      ['after_provider_response', 'status', 600],
      ['input', 'source', 'voice'],
      ['model_select', 'model', 'no-slash'],
      ['session_start', 'reason', 'unexpected'],
      ['mcp_servers_change', 'serverNames', 'not-an-array'],
      ['before_provider_headers', 'headerNames', { a: 1 }],
      ['context', 'roleCounts', { user: '2' }],
    ];
    for (const [state, field, value] of cases) {
      const mutated: Record<string, unknown> = { ...VALID_SAMPLES[state] };
      mutated[field] = value;
      const result = validatePayload(state, mutated);
      expect(result.ok, `${state}.${field}=${JSON.stringify(value)} should be invalid`).toBe(false);
    }
  });

  it('载荷未知字段即拒绝（契约权威性）', () => {
    for (const state of ['message_start', 'agent_snapshot', 'turn_end', 'input']) {
      const mutated = { ...VALID_SAMPLES[state], unknownExtra: 1 };
      expect(validatePayload(state, mutated).ok, state).toBe(false);
    }
  });

  it('枚举与范围边界：边界值合法、越界非法', () => {
    expect(validatePayload('turn_start', { turnIndex: 0, eventTimestamp: 0 }).ok).toBe(true);
    expect(
      validatePayload('agent_snapshot', { ...VALID_SAMPLES['agent_snapshot']!, uptimeMs: 0 }).ok,
    ).toBe(true);
    expect(
      validatePayload('cache_warming_decision', {
        ...VALID_SAMPLES['cache_warming_decision']!,
        continuationProbability: 1,
      }).ok,
    ).toBe(true);
    expect(
      validatePayload('cache_warming_decision', {
        ...VALID_SAMPLES['cache_warming_decision']!,
        continuationProbability: 1.5,
      }).ok,
    ).toBe(false);
    expect(validatePayload('thinking_level_select', { level: '', previousLevel: 'low' }).ok).toBe(
      false,
    );
  });

  it('可空字段允许 null', () => {
    expect(
      validatePayload('agent_snapshot', {
        ...VALID_SAMPLES['agent_snapshot']!,
        contextUsage: { tokens: null, contextWindow: 200000, percent: null },
      }).ok,
    ).toBe(true);
  });

  it('可选字段缺省合法', () => {
    expect(
      validatePayload('message_end', {
        role: 'assistant',
        contentPartCount: 1,
      }).ok,
    ).toBe(true);
  });
});

describe('信封校验', () => {
  it('协议版本缺失或不支持即拒绝', () => {
    const envelope = buildEnvelope('agent_start', {});
    const missing = { ...envelope };
    delete missing['protocolVersion'];
    expect(validateEnvelope(missing, { now: NOW }).ok).toBe(false);
    expect(validateEnvelope({ ...envelope, protocolVersion: '2' }, { now: NOW }).ok).toBe(false);
    expect(validateEnvelope({ ...envelope, protocolVersion: 'abc' }, { now: NOW }).ok).toBe(false);
  });

  it('当前协议版本合法', () => {
    expect(validateEnvelope(buildEnvelope('agent_start', {}), { now: NOW }).ok).toBe(true);
    expect(PROTOCOL_VERSION).toBe('1');
  });

  it('未知状态拒绝', () => {
    const result = validateEnvelope(buildEnvelope('not_a_state', {}), { now: NOW });
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe('E_UNKNOWN_STATE');
  });

  it('时间戳超前超过 60s 或滞后超过 7 天拒绝', () => {
    const base = buildEnvelope('agent_start', {});
    expect(validateEnvelope({ ...base, timestamp: NOW + 61_000 }, { now: NOW }).ok).toBe(false);
    expect(
      validateEnvelope({ ...base, timestamp: NOW - 7 * 24 * 60 * 60 * 1000 - 1 }, { now: NOW }).ok,
    ).toBe(false);
    expect(validateEnvelope({ ...base, timestamp: NOW - 60_000 }, { now: NOW }).ok).toBe(true);
    expect(validateEnvelope({ ...base, timestamp: NOW + 60_000 }, { now: NOW }).ok).toBe(true);
  });

  it('身份字段缺失或非法拒绝', () => {
    const base = buildEnvelope('agent_start', {});
    const noName = structuredClone(base);
    delete noName.agent['name'];
    expect(validateEnvelope(noName, { now: NOW }).ok).toBe(false);

    const badUuid = structuredClone(base);
    badUuid.agent['uuid'] = 'not-a-uuid';
    expect(validateEnvelope(badUuid, { now: NOW }).ok).toBe(false);

    const validUuid = structuredClone(base);
    validUuid.agent['uuid'] = '12345678-1234-1234-1234-123456789012';
    expect(validateEnvelope(validUuid, { now: NOW }).ok).toBe(true);
  });

  it('信封非对象或非载荷对象拒绝', () => {
    expect(validateEnvelope(null, { now: NOW }).ok).toBe(false);
    expect(validateEnvelope([], { now: NOW }).ok).toBe(false);
    expect(
      validateEnvelope(
        buildEnvelope('agent_start', 'string-payload' as unknown as Record<string, unknown>),
        { now: NOW },
      ).ok,
    ).toBe(false);
  });
});
