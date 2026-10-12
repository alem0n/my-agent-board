/**
 * 映射器测试：全部 41 个事件状态有映射器、映射输出满足契约、隐私约束成立。
 *
 * 对应验收门槛：2 契约完整（映射覆盖）、9 隐私。
 */
import { describe, it, expect } from 'vitest';
import { mapEvent, buildSnapshotPayload, EVENT_STATES } from '../src/services/mapper.js';
import {
  runAgentSimulation,
  SimulatedEnvironment,
  SimulatedStateSource,
} from '../src/infrastructure/simulator.js';
import { STATE_REGISTRY, getContract } from '../src/domain/contracts.js';
import { validatePayload } from '../src/domain/validation.js';

const NOW = 1791800000000;

const env = () => new SimulatedEnvironment({ startedAt: NOW - 12345 }).snapshot();

describe('映射覆盖（与状态注册表一致）', () => {
  it('EVENT_STATES 恰好 41 项且无重复（另加 1 采样状态共 42）', () => {
    expect(EVENT_STATES).toHaveLength(41);
    expect(new Set(EVENT_STATES).size).toBe(41);
  });

  it('所有事件状态均有映射器且输出通过契约校验', () => {
    const events = new Map<string, unknown[]>();
    const recorder = {
      emit: (state: string, event: unknown) => {
        const list = events.get(state) ?? [];
        list.push(event);
        events.set(state, list);
      },
      subscribe: () => () => undefined,
    } as unknown as SimulatedStateSource;

    runAgentSimulation({ source: recorder, env: new SimulatedEnvironment(), now: () => NOW });

    for (const state of EVENT_STATES) {
      const list = events.get(state);
      expect(list, `simulator should emit ${state}`).toBeDefined();
      const event = list?.[0];
      const payload = mapEvent(state, event, env());
      expect(payload, `mapper for ${state} must exist`).toBeDefined();
      const result = validatePayload(state, payload!);
      expect(
        result.ok,
        `${state}: ${JSON.stringify(result.errors)} (payload: ${JSON.stringify(payload)})`,
      ).toBe(true);
    }
  });

  it('agent_snapshot 映射覆盖 EnvironmentContext 全部可采样字段并通过契约', () => {
    const payload = buildSnapshotPayload(env(), NOW);
    const contract = getContract('agent_snapshot');
    const declared = (contract?.payload.fields ?? []).map((field) => field.name).sort();
    expect(declared).toEqual(
      [
        'sessionId',
        'sessionName',
        'cwd',
        'mode',
        'hasUI',
        'isProjectTrusted',
        'isIdle',
        'hasPendingMessages',
        'model',
        'thinkingLevel',
        'contextUsage',
        'activeToolCount',
        'piVersion',
        'uptimeMs',
      ].sort(),
    );
    const result = validatePayload('agent_snapshot', payload);
    expect(result.ok, JSON.stringify(result.errors)).toBe(true);
    expect(payload['uptimeMs']).toBe(12345);
  });

  it('注册表状态数 = 41 事件 + 1 快照', () => {
    expect(STATE_REGISTRY.size).toBe(EVENT_STATES.length + 1);
    expect(STATE_REGISTRY.has('agent_snapshot')).toBe(true);
  });
});

describe('隐私约束（不上报原文内容）', () => {
  it('input / before_agent_start 仅上报长度，不含文本', () => {
    const inputPayload = mapEvent(
      'input',
      { type: 'input', text: 'SECRET-API-KEY-XYZ', images: [], source: 'interactive' },
      env(),
    )!;
    expect(JSON.stringify(inputPayload)).not.toContain('SECRET');
    expect(inputPayload['textLength']).toBe(18);

    const beforePayload = mapEvent(
      'before_agent_start',
      { type: 'before_agent_start', prompt: 'PRIVATE-PROMPT', images: [], systemPrompt: 'x' },
      env(),
    )!;
    expect(JSON.stringify(beforePayload)).not.toContain('PRIVATE');
  });

  it('user_bash 仅上报命令长度，不含命令内容', () => {
    const payload = mapEvent(
      'user_bash',
      {
        type: 'user_bash',
        command: 'rm -rf /sensitive-path',
        excludeFromContext: false,
        cwd: '/p',
      },
      env(),
    )!;
    expect(JSON.stringify(payload)).not.toContain('sensitive');
    expect(payload['commandLength']).toBe(22);
  });

  it('tool_call / tool_result 仅上报键名与计数，不含参数值与结果内容', () => {
    const callPayload = mapEvent(
      'tool_call',
      {
        type: 'tool_call',
        toolCallId: 'c1',
        toolName: 'bash',
        input: { command: 'cat /etc/passwd', token: 's3cret' },
      },
      env(),
    )!;
    expect(JSON.stringify(callPayload)).not.toContain('s3cret');
    expect(JSON.stringify(callPayload)).not.toContain('passwd');
    expect(callPayload['inputKeys']).toEqual(['command', 'token']);

    const resultPayload = mapEvent(
      'tool_result',
      {
        type: 'tool_result',
        toolCallId: 'c1',
        toolName: 'bash',
        input: {},
        content: [{ type: 'text', text: 'root:x:0:0' }],
        isError: false,
      },
      env(),
    )!;
    expect(JSON.stringify(resultPayload)).not.toContain('root:x');
    expect(resultPayload['contentPartCount']).toBe(1);
    expect(resultPayload['structuredContent']).toBe(false);
  });

  it('header 事件仅上报键名，不含值', () => {
    const payload = mapEvent(
      'before_provider_headers',
      {
        type: 'before_provider_headers',
        headers: { authorization: 'Bearer SECRET', 'x-api-key': 'k' },
      },
      env(),
    )!;
    expect(JSON.stringify(payload)).not.toContain('SECRET');
    expect(payload['headerNames']).toEqual(['authorization', 'x-api-key']);
  });

  it('message 事件不含消息文本', () => {
    const message = {
      role: 'assistant',
      content: [{ type: 'text', text: 'LEAKED-CONTENT' }],
      provider: 'anthropic',
      model: 'claude-x',
      usage: { input: 1, output: 2, totalTokens: 3 },
      stopReason: 'stop',
    };
    for (const state of ['message_start', 'message_end']) {
      const payload = mapEvent(state, { type: state, message }, env())!;
      expect(JSON.stringify(payload)).not.toContain('LEAKED');
    }
  });
});

describe('结构映射正确性', () => {
  it('message_end 用量字段映射', () => {
    const payload = mapEvent(
      'message_end',
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [],
          provider: 'anthropic',
          model: 'claude-x',
          usage: { input: 4200, output: 180, cacheRead: 3000, cacheWrite: 1200, totalTokens: 4380 },
          stopReason: 'tool_use',
        },
      },
      env(),
    )!;
    expect(payload).toMatchObject({
      role: 'assistant',
      provider: 'anthropic',
      model: 'claude-x',
      stopReason: 'tool_use',
      usage: { input: 4200, output: 180, cacheRead: 3000, cacheWrite: 1200, totalTokens: 4380 },
    });
  });

  it('model_select 拼接 provider/id', () => {
    const payload = mapEvent(
      'model_select',
      {
        type: 'model_select',
        model: { provider: 'openai', id: 'gpt-5' },
        previousModel: undefined,
        source: 'restore',
      },
      env(),
    )!;
    expect(payload).toEqual({ model: 'openai/gpt-5', source: 'restore' });
  });

  it('context 角色计数正确且未知角色剔除', () => {
    const payload = mapEvent(
      'context',
      {
        type: 'context',
        messages: [
          { role: 'user', content: [] },
          { role: 'user', content: [] },
          { role: 'assistant', content: [] },
          { role: 'toolResult', content: [] },
          { role: 'mystery' as unknown, content: [] },
        ],
      },
      env(),
    )!;
    expect(payload['messageCount']).toBe(5);
    expect(payload['roleCounts']).toEqual({ system: 0, user: 2, assistant: 1, toolResult: 1 });
  });

  it('未知状态/采样型状态映射返回 undefined（明确丢弃）', () => {
    expect(mapEvent('agent_snapshot', {}, env())).toBeUndefined();
    expect(mapEvent('not_a_state', {}, env())).toBeUndefined();
  });
});
