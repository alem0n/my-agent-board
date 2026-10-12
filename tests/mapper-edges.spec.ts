/**
 * 映射器边界与降级路径测试：事件字段缺失/畸形时不崩溃且输出可预测。
 *
 * 防御性分支覆盖：client 面对真实 pi 事件时也可能遇到部分字段缺省（类型宽放），
 * 映射必须降级为默认值而不是抛错。
 */
import { describe, it, expect } from 'vitest';
import { mapEvent } from '../src/services/mapper.js';

const env = () => ({
  sessionId: 'sess-0001',
  sessionName: undefined,
  cwd: '/home/user/proj',
  mode: 'tui' as const,
  hasUI: true,
  isProjectTrusted: true,
  isIdle: true,
  hasPendingMessages: false,
  model: undefined,
  thinkingLevel: undefined,
  contextUsage: undefined,
  activeTools: [],
  piVersion: undefined,
  startedAt: 1,
});

describe('映射器边界（字段缺失与畸形输入）', () => {
  it('完全空的事件对象不抛错并降级为默认值', () => {
    const states = [
      'project_trust',
      'resources_discover',
      'session_start',
      'session_before_switch',
      'session_before_fork',
      'session_before_compact',
      'session_compact',
      'session_compact_failed',
      'session_shutdown',
      'session_before_tree',
      'session_tree',
      'mcp_servers_change',
      'before_provider_headers',
      'after_provider_response',
      'provider_stream_event',
      'before_agent_start',
      'agent_end',
      'agent_before_settle',
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
      'cache_warming_decision',
      'resources_discover',
    ];
    for (const state of states) {
      expect(() => mapEvent(state, {}, env())).not.toThrow();
      expect(mapEvent(state, {}, env())).toBeDefined();
    }
  });

  it('mcp_servers_change：server 名称非字符串被过滤，servers 缺省为空', () => {
    const filtered = mapEvent(
      'mcp_servers_change',
      { type: 'mcp_servers_change', servers: [{ name: 42 }, {}, 'x'] },
      env(),
    )!;
    expect(filtered['serverCount']).toBe(0);
    const missing = mapEvent('mcp_servers_change', {}, env())!;
    expect(missing).toEqual({ serverCount: 0, serverNames: [] });
  });

  it('provider_stream_event：data 无 type 字段时 eventType 缺省', () => {
    const payload = mapEvent(
      'provider_stream_event',
      { type: 'provider_stream_event', provider: 'p', api: 'a', model: 'm', data: {} },
      env(),
    )!;
    expect(payload).toEqual({ provider: 'p', api: 'a', model: 'm' });
    const noData = mapEvent(
      'provider_stream_event',
      { type: 'provider_stream_event', provider: 'p', api: 'a', model: 'm' },
      env(),
    )!;
    expect(noData).toEqual({ provider: 'p', api: 'a', model: 'm' });
  });

  it('before_agent_start：prompt/images 缺省时长度为 0', () => {
    const payload = mapEvent('before_agent_start', {}, env())!;
    expect(payload).toEqual({ promptLength: 0, imageCount: 0, systemPromptLength: 0 });
    const withImages = mapEvent(
      'before_agent_start',
      { prompt: 'x', images: [{ type: 'image' }, { type: 'image' }], systemPrompt: 'yx' },
      env(),
    )!;
    expect(withImages).toEqual({ promptLength: 1, imageCount: 2, systemPromptLength: 2 });
  });

  it('message_update：assistantMessageEvent 无 type 时 eventType 缺省', () => {
    const payload = mapEvent(
      'message_update',
      { message: { role: 'assistant', content: [] }, assistantMessageEvent: {} },
      env(),
    )!;
    expect(payload).toEqual({ role: 'assistant', contentPartCount: 0 });
  });

  it('message_end：usage 缺省或部分字段缺省时正确处理', () => {
    const noUsage = mapEvent('message_end', { message: { role: 'user', content: [] } }, env())!;
    expect(noUsage).toEqual({ role: 'user', contentPartCount: 0 });
    const partialUsage = mapEvent(
      'message_end',
      { message: { role: 'assistant', content: [], usage: { input: 5 } } },
      env(),
    )!;
    expect(partialUsage['usage']).toEqual({ input: 5 });
  });

  it('tool_execution_end：result 缺省时 contentPartCount 为 0 且无 usage', () => {
    const payload = mapEvent('tool_execution_end', {}, env())!;
    expect(payload).toMatchObject({ contentPartCount: 0 });
    expect('usageTotalTokens' in payload).toBe(false);
  });

  it('tool_execution_update：partialResult 为 undefined 时 hasPartialResult false', () => {
    const payload = mapEvent(
      'tool_execution_update',
      { toolCallId: 'c', toolName: 'bash', args: {} },
      env(),
    )!;
    expect(payload).toEqual({ toolCallId: 'c', toolName: 'bash', hasPartialResult: false });
  });

  it('tool_result：structuredContent 缺省为 false，usage 缺省不带字段', () => {
    const payload = mapEvent(
      'tool_result',
      { toolCallId: 'c', toolName: 'bash', content: [], isError: true },
      env(),
    )!;
    expect(payload).toMatchObject({ structuredContent: false, isError: true });
    expect('usageTotalTokens' in payload).toBe(false);
  });

  it('cache_warming_decision：可选字段部分提供且越界值被钳制', () => {
    const partial = mapEvent('cache_warming_decision', { action: 'stop' }, env())!;
    expect(partial).toEqual({ action: 'stop' });
    const clamped = mapEvent(
      'cache_warming_decision',
      { continuationProbability: 5, warmCost: -1 },
      env(),
    )!;
    expect(clamped).toEqual({ continuationProbability: 1, warmCost: 0 });
    const invalidAction = mapEvent('cache_warming_decision', { action: 'maybe' }, env())!;
    expect('action' in invalidAction).toBe(false);
  });

  it('model_select：模型字段缺省时退化为空字符串', () => {
    const payload = mapEvent('model_select', {}, env())!;
    expect(payload).toEqual({ model: '', source: 'set' });
  });

  it('before_agent_start 之外的 identity 类边界：thinking/user_bash/input 降级', () => {
    const thinking = mapEvent('thinking_level_select', {}, env())!;
    expect(thinking).toEqual({ level: '', previousLevel: '' });
    const bash = mapEvent('user_bash', {}, env())!;
    expect(bash).toMatchObject({ commandLength: 0, excludeFromContext: false, cwd: '' });
    const input = mapEvent('input', {}, env())!;
    expect(input).toMatchObject({ textLength: 0, imageCount: 0, source: 'interactive' });
  });

  it('session 树/分叉类事件缺省字段降级', () => {
    const tree = mapEvent('session_tree', {}, env())!;
    expect(tree).toEqual({ newLeafId: '', oldLeafId: '' });
    const compact = mapEvent('session_compact_failed', { aborted: true }, env())!;
    expect(compact).toMatchObject({ reason: 'manual', aborted: true, willRetry: false });
  });

  it('turn_end：消息角色未知时降级为 assistant', () => {
    const payload = mapEvent(
      'turn_end',
      { turnIndex: 3, toolResults: [], message: { role: 'mystery' } },
      env(),
    )!;
    expect(payload).toMatchObject({
      turnIndex: 3,
      messageRole: 'assistant',
      toolResultCount: 0,
      willContinue: false,
    });
  });

  it('before_provider_headers：headers 非对象时为空数组', () => {
    const payload = mapEvent('before_provider_headers', { headers: 'nope' }, env())!;
    expect(payload).toEqual({ headerNames: [] });
  });

  it('context：messages 非数组时 messageCount 为 0', () => {
    const payload = mapEvent('context', { messages: 'oops' }, env())!;
    expect(payload).toEqual({
      messageCount: 0,
      roleCounts: { system: 0, user: 0, assistant: 0, toolResult: 0 },
    });
  });
});
