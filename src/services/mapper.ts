/**
 * 状态映射器：pi 事件 → 契约载荷。
 *
 * 职责契约：
 * - 覆盖全部 41 个事件状态（EVENT_STATES）；缺失映射器为编译错误。
 * - 隐私设计（docs/DESIGN.md §9）：只提取长度/计数/键名/枚举/标志，
 *   绝不提取提示词、命令、工具参数值、结果内容、header 值等原文。
 * - 纯函数：输入事件（unknown）与环境快照，输出契约载荷。
 */
import type { PiEnvironmentSnapshot } from '../domain/pi-env.js';
import { STATE_REGISTRY } from '../domain/contracts.js';

/** 全部事件型状态（与 STATE_REGISTRY 一一对应；agent_snapshot 为采样型，单独构建）。 */
export const EVENT_STATES = [
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
] as const;

export type EventStateId = (typeof EVENT_STATES)[number];

type Mapper = (event: unknown, env: PiEnvironmentSnapshot) => Record<string, unknown>;

// ---------------------------------------------------------------------------
// 安全取值助手（unknown → 可上报元数据）
// ---------------------------------------------------------------------------

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function stringLength(value: unknown): number {
  return typeof value === 'string' ? value.length : 0;
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function objectKeys(value: unknown, max: number): string[] {
  const object = asObject(value);
  if (object === undefined) {
    return [];
  }
  return Object.keys(object).slice(0, max);
}

function truncatedString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  return value.length <= max ? value : `${value.slice(0, max)}`;
}

function stringField(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' || value.length < 1 || value.length > max) {
    return undefined;
  }
  return value;
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 消息角色计数。未知角色归入 unknown（契约不含 unknown 键 → 剔除已知角色外的键）。 */
function roleCounts(messages: unknown): Record<string, number> {
  const list = asArray(messages) ?? [];
  const counts: { system: number; user: number; assistant: number; toolResult: number } = {
    system: 0,
    user: 0,
    assistant: 0,
    toolResult: 0,
  };
  for (const message of list) {
    const object = asObject(message);
    const role = object === undefined ? undefined : object['role'];
    if (role === 'system' || role === 'user' || role === 'assistant' || role === 'toolResult') {
      counts[role] += 1;
    }
  }
  return counts;
}

/** provider/model 复合标识。 */
function providerModelId(value: unknown): string | undefined {
  const object = asObject(value);
  if (object === undefined) {
    return undefined;
  }
  const provider = stringField(object['provider'], 64);
  const id = stringField(object['id'], 128);
  if (provider === undefined || id === undefined) {
    return undefined;
  }
  const combined = `${provider}/${id}`;
  return combined.length <= 128
    ? combined
    : `${provider}/${id.slice(0, 128 - provider.length - 1)}`;
}

const MAX_ERROR_MESSAGE = 1024;

// ---------------------------------------------------------------------------
// 映射表（41 项；Record 类型保证缺项编译失败）
// ---------------------------------------------------------------------------

const MAPPERS: Record<EventStateId, Mapper> = {
  project_trust: (event) => {
    const e = asObject(event) ?? {};
    return { cwd: stringField(e['cwd'], 4096) ?? '' };
  },
  resources_discover: (event) => {
    const e = asObject(event) ?? {};
    return {
      cwd: stringField(e['cwd'], 4096) ?? '',
      reason: e['reason'] === 'reload' ? 'reload' : 'startup',
    };
  },
  mcp_servers_change: (event) => {
    const e = asObject(event) ?? {};
    const servers = asArray(e['servers']) ?? [];
    const names = servers
      .map((server) => stringField(asObject(server)?.['name'], 128))
      .filter((name): name is string => name !== undefined)
      .slice(0, 256);
    return { serverCount: names.length, serverNames: names };
  },
  session_start: (event) => {
    const e = asObject(event) ?? {};
    const previous = stringField(e['previousSessionFile'], 4096);
    return {
      reason: sessionStartReason(e['reason']),
      ...(previous === undefined ? {} : { previousSessionFile: previous }),
    };
  },
  session_info_changed: (event) => {
    const e = asObject(event) ?? {};
    return { name: typeof e['name'] === 'string' ? e['name'].slice(0, 256) : '' };
  },
  session_before_switch: (event) => {
    const e = asObject(event) ?? {};
    const target = stringField(e['targetSessionFile'], 4096);
    return {
      reason: e['reason'] === 'resume' ? 'resume' : 'new',
      ...(target === undefined ? {} : { targetSessionFile: target }),
    };
  },
  session_before_fork: (event) => {
    const e = asObject(event) ?? {};
    return {
      entryId: stringField(e['entryId'], 128) ?? '',
      position: e['position'] === 'at' ? 'at' : 'before',
    };
  },
  session_before_compact: (event) => {
    const e = asObject(event) ?? {};
    const preparation = asObject(e['preparation']);
    const branchEntries = preparation === undefined ? 0 : arrayLength(preparation['branchEntries']);
    return {
      reason: compactReason(e['reason']),
      willRetry: e['willRetry'] === true,
      branchEntryCount: branchEntries,
    };
  },
  session_compact: (event) => {
    const e = asObject(event) ?? {};
    return { reason: compactReason(e['reason']), willRetry: e['willRetry'] === true };
  },
  session_compact_failed: (event) => {
    const e = asObject(event) ?? {};
    const message = truncatedString(e['errorMessage'], MAX_ERROR_MESSAGE);
    return {
      reason: compactReason(e['reason']),
      aborted: e['aborted'] === true,
      willRetry: e['willRetry'] === true,
      ...(message === undefined ? {} : { errorMessage: message }),
    };
  },
  session_shutdown: (event) => {
    const e = asObject(event) ?? {};
    const target = stringField(e['targetSessionFile'], 4096);
    return {
      reason: shutdownReason(e['reason']),
      ...(target === undefined ? {} : { targetSessionFile: target }),
    };
  },
  session_before_tree: (event) => {
    const e = asObject(event) ?? {};
    const preparation = asObject(e['preparation']) ?? {};
    const oldLeaf =
      typeof preparation['oldLeafId'] === 'string' ? preparation['oldLeafId'].slice(0, 128) : '';
    return {
      targetId: stringField(preparation['targetId'], 128) ?? '',
      oldLeafId: oldLeaf,
      userWantsSummary: preparation['userWantsSummary'] === true,
    };
  },
  session_tree: (event) => {
    const e = asObject(event) ?? {};
    const newLeafId = typeof e['newLeafId'] === 'string' ? e['newLeafId'].slice(0, 128) : '';
    const oldLeafId = typeof e['oldLeafId'] === 'string' ? e['oldLeafId'].slice(0, 128) : '';
    return {
      newLeafId,
      oldLeafId,
      ...(e['fromExtension'] === undefined ? {} : { fromExtension: e['fromExtension'] === true }),
    };
  },
  context: (event) => {
    const e = asObject(event) ?? {};
    return { messageCount: arrayLength(e['messages']), roleCounts: roleCounts(e['messages']) };
  },
  context_with_system: (event) => {
    const e = asObject(event) ?? {};
    return { messageCount: arrayLength(e['messages']), roleCounts: roleCounts(e['messages']) };
  },
  cache_warming_decision: (event) => {
    const e = asObject(event) ?? {};
    const action = e['action'] === 'warm' || e['action'] === 'stop' ? e['action'] : undefined;
    const warmCost = numberField(e['warmCost']);
    const missCost = numberField(e['missCost']);
    const continuationProbability = numberField(e['continuationProbability']);
    return {
      ...(action === undefined ? {} : { action }),
      ...(warmCost === undefined ? {} : { warmCost: Math.max(0, warmCost) }),
      ...(missCost === undefined ? {} : { missCost: Math.max(0, missCost) }),
      ...(continuationProbability === undefined
        ? {}
        : { continuationProbability: Math.min(1, Math.max(0, continuationProbability)) }),
    };
  },
  before_provider_request: () => ({}),
  before_provider_headers: (event) => {
    const e = asObject(event) ?? {};
    return { headerNames: objectKeys(e['headers'], 128) };
  },
  after_provider_response: (event) => {
    const e = asObject(event) ?? {};
    const status = numberField(e['status']);
    const clampedStatus =
      status === undefined ? 0 : Math.min(599, Math.max(100, Math.round(status)));
    return { status: clampedStatus, headerNames: objectKeys(e['headers'], 128) };
  },
  provider_stream_event: (event) => {
    const e = asObject(event) ?? {};
    const eventType = stringField(asObject(e['data'])?.['type'], 64);
    return {
      provider: stringField(e['provider'], 64) ?? '',
      api: stringField(e['api'], 64) ?? '',
      model: stringField(e['model'], 128) ?? '',
      ...(eventType === undefined ? {} : { eventType }),
    };
  },
  before_agent_start: (event) => {
    const e = asObject(event) ?? {};
    const images = asArray(e['images']);
    return {
      promptLength: stringLength(e['prompt']),
      imageCount: images === undefined ? 0 : images.length,
      systemPromptLength: stringLength(e['systemPrompt']),
    };
  },
  agent_start: () => ({}),
  agent_end: (event) => {
    const e = asObject(event) ?? {};
    return { messageCount: arrayLength(e['messages']), roleCounts: roleCounts(e['messages']) };
  },
  agent_before_settle: (event) => {
    const e = asObject(event) ?? {};
    return {
      outcome: e['outcome'] === 'aborted' || e['outcome'] === 'error' ? e['outcome'] : 'completed',
      entryCount: arrayLength(e['entries']),
      willContinue: e['continue'] === true,
    };
  },
  agent_settled: () => ({}),
  ui_prompt_start: (event) => uiPromptPayload(event),
  ui_prompt_end: (event) => uiPromptPayload(event),
  turn_start: (event) => {
    const e = asObject(event) ?? {};
    const eventTimestamp = numberField(e['timestamp']);
    return {
      turnIndex: nonNegative(e['turnIndex']),
      eventTimestamp: eventTimestamp === undefined ? 0 : Math.round(eventTimestamp),
    };
  },
  turn_end: (event) => {
    const e = asObject(event) ?? {};
    const message = asObject(e['message']);
    const role = message?.['role'];
    return {
      turnIndex: nonNegative(e['turnIndex']),
      toolResultCount: arrayLength(e['toolResults']),
      messageRole:
        role === 'user' || role === 'assistant' || role === 'toolResult' ? role : 'assistant',
      willContinue: e['continue'] === true,
    };
  },
  message_start: (event) => messagePayload(event, { includeIdentity: true }),
  message_update: (event) => {
    const payload = messagePayload(event, { includeIdentity: false });
    const e = asObject(event) ?? {};
    const eventType = stringField(asObject(e['assistantMessageEvent'])?.['type'], 64);
    return eventType === undefined ? payload : { ...payload, eventType };
  },
  message_end: (event) => {
    const payload = messagePayload(event, { includeIdentity: true, includeOutcome: true });
    const e = asObject(event) ?? {};
    const message = asObject(e['message']) ?? {};
    const usage = asObject(message['usage']);
    if (usage === undefined) {
      return payload;
    }
    const usagePayload: Record<string, number> = {};
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens']) {
      const value = numberField(usage[key]);
      if (value !== undefined) {
        usagePayload[key] = Math.max(0, Math.round(value));
      }
    }
    return Object.keys(usagePayload).length === 0 ? payload : { ...payload, usage: usagePayload };
  },
  tool_execution_start: (event) => {
    const e = asObject(event) ?? {};
    return {
      toolCallId: stringField(e['toolCallId'], 128) ?? '',
      toolName: stringField(e['toolName'], 128) ?? '',
      parentToolCallId: stringField(e['parentToolCallId'], 128),
      argKeys: objectKeys(e['args'], 64),
    };
  },
  tool_execution_update: (event) => {
    const e = asObject(event) ?? {};
    return {
      toolCallId: stringField(e['toolCallId'], 128) ?? '',
      toolName: stringField(e['toolName'], 128) ?? '',
      hasPartialResult: e['partialResult'] !== undefined && e['partialResult'] !== null,
    };
  },
  tool_execution_end: (event) => {
    const e = asObject(event) ?? {};
    const result = asObject(e['result']);
    const usageTotalTokens = numberField(
      result?.['usage'] !== undefined ? asObject(result['usage'])?.['totalTokens'] : undefined,
    );
    return {
      toolCallId: stringField(e['toolCallId'], 128) ?? '',
      toolName: stringField(e['toolName'], 128) ?? '',
      isError: e['isError'] === true,
      contentPartCount: arrayLength(result?.['content']),
      ...(usageTotalTokens === undefined
        ? {}
        : { usageTotalTokens: Math.max(0, Math.round(usageTotalTokens)) }),
    };
  },
  model_select: (event) => {
    const e = asObject(event) ?? {};
    const previous = providerModelId(e['previousModel']);
    return {
      model: providerModelId(e['model']) ?? '',
      ...(previous === undefined ? {} : { previousModel: previous }),
      source: e['source'] === 'cycle' || e['source'] === 'restore' ? e['source'] : 'set',
    };
  },
  thinking_level_select: (event) => {
    const e = asObject(event) ?? {};
    return {
      level: stringField(e['level'], 32) ?? '',
      previousLevel: stringField(e['previousLevel'], 32) ?? '',
    };
  },
  user_bash: (event) => {
    const e = asObject(event) ?? {};
    return {
      commandLength: stringLength(e['command']),
      excludeFromContext: e['excludeFromContext'] === true,
      cwd: stringField(e['cwd'], 4096) ?? '',
    };
  },
  input: (event) => {
    const e = asObject(event) ?? {};
    const images = asArray(e['images']);
    const streamingBehavior =
      e['streamingBehavior'] === 'steer' || e['streamingBehavior'] === 'followUp'
        ? e['streamingBehavior']
        : undefined;
    return {
      textLength: stringLength(e['text']),
      imageCount: images === undefined ? 0 : images.length,
      source: e['source'] === 'rpc' || e['source'] === 'extension' ? e['source'] : 'interactive',
      ...(streamingBehavior === undefined ? {} : { streamingBehavior }),
    };
  },
  tool_call: (event) => {
    const e = asObject(event) ?? {};
    return {
      toolCallId: stringField(e['toolCallId'], 128) ?? '',
      toolName: stringField(e['toolName'], 128) ?? '',
      parentToolCallId: stringField(e['parentToolCallId'], 128),
      inputKeys: objectKeys(e['input'], 64),
    };
  },
  tool_result: (event) => {
    const e = asObject(event) ?? {};
    const usageTotalTokens = numberField(asObject(e['usage'])?.['totalTokens']);
    return {
      toolCallId: stringField(e['toolCallId'], 128) ?? '',
      toolName: stringField(e['toolName'], 128) ?? '',
      isError: e['isError'] === true,
      ...(usageTotalTokens === undefined
        ? {}
        : { usageTotalTokens: Math.max(0, Math.round(usageTotalTokens)) }),
      contentPartCount: arrayLength(e['content']),
      structuredContent: e['structuredContent'] !== undefined,
    };
  },
};

function nonNegative(value: unknown): number {
  const number = numberField(value);
  return number === undefined ? 0 : Math.max(0, Math.round(number));
}

function sessionStartReason(value: unknown): 'startup' | 'reload' | 'new' | 'resume' | 'fork' {
  if (
    value === 'startup' ||
    value === 'reload' ||
    value === 'new' ||
    value === 'resume' ||
    value === 'fork'
  ) {
    return value;
  }
  return 'startup';
}

function compactReason(value: unknown): 'manual' | 'threshold' | 'overflow' {
  if (value === 'manual' || value === 'threshold' || value === 'overflow') {
    return value;
  }
  return 'manual';
}

function shutdownReason(value: unknown): 'quit' | 'reload' | 'new' | 'resume' | 'fork' {
  if (
    value === 'quit' ||
    value === 'reload' ||
    value === 'new' ||
    value === 'resume' ||
    value === 'fork'
  ) {
    return value;
  }
  return 'quit';
}

function uiPromptPayload(event: unknown): Record<string, unknown> {
  const e = asObject(event) ?? {};
  const title = typeof e['title'] === 'string' ? e['title'].slice(0, 256) : '';
  return {
    kind:
      e['kind'] === 'select' ||
      e['kind'] === 'confirm' ||
      e['kind'] === 'input' ||
      e['kind'] === 'editor' ||
      e['kind'] === 'custom'
        ? e['kind']
        : 'custom',
    title,
  };
}

function messagePayload(
  event: unknown,
  options: { includeIdentity?: boolean; includeOutcome?: boolean } = {},
): Record<string, unknown> {
  const e = asObject(event) ?? {};
  const message = asObject(e['message']) ?? {};
  const role = message['role'];
  const content = asArray(message['content']);
  const provider = stringField(message['provider'], 64);
  const model = stringField(message['model'], 128);
  const stopReason = stringField(message['stopReason'], 64);
  const includeIdentity = options.includeIdentity === true;
  return {
    role: role === 'user' || role === 'assistant' || role === 'toolResult' ? role : 'assistant',
    contentPartCount: content === undefined ? 0 : content.length,
    ...(includeIdentity && provider !== undefined ? { provider } : {}),
    ...(includeIdentity && model !== undefined ? { model } : {}),
    ...(includeIdentity && options.includeOutcome === true && stopReason !== undefined
      ? { stopReason }
      : {}),
  };
}

/**
 * 映射事件为契约载荷。未知状态或映射缺失返回 undefined（调用方记日志并丢弃）。
 */
export function mapEvent(
  state: string,
  event: unknown,
  env: PiEnvironmentSnapshot,
): Record<string, unknown> | undefined {
  const contract = STATE_REGISTRY.get(state);
  if (contract === undefined || contract.frequency === 'periodic') {
    return undefined;
  }
  const mapper = MAPPERS[state as EventStateId];
  return mapper === undefined ? undefined : mapper(event, env);
}

/** 构建 agent_snapshot 采样载荷（EnvironmentContext 可采样字段全集）。 */
export function buildSnapshotPayload(
  env: PiEnvironmentSnapshot,
  now: number,
): Record<string, unknown> {
  const model = env.model === undefined ? undefined : `${env.model.provider}/${env.model.id}`;
  const sessionId = env.sessionId === undefined ? '' : env.sessionId.slice(0, 256);
  const sessionName = env.sessionName === undefined ? '' : env.sessionName.slice(0, 256);
  const contextUsage =
    env.contextUsage === undefined
      ? undefined
      : {
          tokens: env.contextUsage.tokens,
          contextWindow: env.contextUsage.contextWindow,
          percent: env.contextUsage.percent,
        };
  return {
    sessionId,
    sessionName,
    cwd: env.cwd,
    mode: env.mode,
    hasUI: env.hasUI,
    isProjectTrusted: env.isProjectTrusted,
    isIdle: env.isIdle,
    hasPendingMessages: env.hasPendingMessages,
    ...(model === undefined ? {} : { model }),
    ...(env.thinkingLevel === undefined ? {} : { thinkingLevel: env.thinkingLevel.slice(0, 32) }),
    ...(contextUsage === undefined ? {} : { contextUsage }),
    activeToolCount: env.activeTools.length,
    ...(env.piVersion === undefined ? {} : { piVersion: env.piVersion.slice(0, 64) }),
    uptimeMs: Math.max(0, Math.round(now - env.startedAt)),
  };
}
