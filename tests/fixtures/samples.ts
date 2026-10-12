/**
 * 测试 fixtures：每个状态的合法载荷样本（与 contracts.ts 对应）。
 *
 * 用途：
 * - contracts.spec：合法输入通过 + 非法变异被拒。
 * - mapper.spec：模拟器输出与契约比对。
 * - e2e：驱动真实 Reporter 覆盖 42 状态。
 */
import type { ReportEnvelope } from '../../src/domain/contracts.js';

export const VALID_SAMPLES: Record<string, Record<string, unknown>> = {
  project_trust: { cwd: '/home/user/proj' },
  resources_discover: { cwd: '/home/user/proj', reason: 'startup' },
  mcp_servers_change: { serverCount: 2, serverNames: ['context7', 'filesystem'] },
  session_start: { reason: 'startup' },
  session_info_changed: { name: 'feature/board' },
  session_before_switch: { reason: 'new', targetSessionFile: '/x/session.jsonl' },
  session_before_fork: { entryId: 'entry_0010', position: 'at' },
  session_before_compact: { reason: 'threshold', willRetry: false, branchEntryCount: 42 },
  session_compact: { reason: 'manual', willRetry: false },
  session_compact_failed: {
    reason: 'manual',
    aborted: true,
    willRetry: false,
    errorMessage: 'timeout',
  },
  session_shutdown: { reason: 'quit' },
  session_before_tree: { targetId: 'entry_0010', oldLeafId: 'entry_0099', userWantsSummary: true },
  session_tree: { newLeafId: 'entry_0010', oldLeafId: 'entry_0099', fromExtension: false },
  context: { messageCount: 8, roleCounts: { system: 1, user: 4, assistant: 3, toolResult: 0 } },
  context_with_system: {
    messageCount: 9,
    roleCounts: { system: 1, user: 4, assistant: 3, toolResult: 1 },
  },
  cache_warming_decision: {
    action: 'warm',
    warmCost: 0.02,
    missCost: 0.18,
    continuationProbability: 0.9,
  },
  before_provider_request: {},
  before_provider_headers: { headerNames: ['content-type', 'anthropic-version'] },
  after_provider_response: { status: 200, headerNames: ['request-id'] },
  provider_stream_event: {
    provider: 'anthropic',
    api: 'anthropic-messages',
    model: 'claude-x',
    eventType: 'text',
  },
  before_agent_start: { promptLength: 128, imageCount: 0, systemPromptLength: 4096 },
  agent_start: {},
  agent_end: { messageCount: 12, roleCounts: { system: 0, user: 4, assistant: 4, toolResult: 4 } },
  agent_before_settle: { outcome: 'completed', entryCount: 42, willContinue: false },
  agent_settled: {},
  ui_prompt_start: { kind: 'confirm', title: 'Allow tool call?' },
  ui_prompt_end: { kind: 'confirm', title: 'Allow tool call?' },
  turn_start: { turnIndex: 0, eventTimestamp: 1791800000000 },
  turn_end: { turnIndex: 0, toolResultCount: 2, messageRole: 'assistant', willContinue: false },
  message_start: {
    role: 'assistant',
    contentPartCount: 1,
    provider: 'anthropic',
    model: 'claude-x',
  },
  message_update: { role: 'assistant', contentPartCount: 1, eventType: 'content_block_delta' },
  message_end: {
    role: 'assistant',
    contentPartCount: 1,
    provider: 'anthropic',
    model: 'claude-x',
    stopReason: 'tool_use',
    usage: { input: 4200, output: 180, cacheRead: 3000, cacheWrite: 1200, totalTokens: 4380 },
  },
  tool_execution_start: {
    toolCallId: 'call_1',
    toolName: 'bash',
    argKeys: ['command', 'description'],
  },
  tool_execution_update: { toolCallId: 'call_1', toolName: 'bash', hasPartialResult: true },
  tool_execution_end: {
    toolCallId: 'call_1',
    toolName: 'bash',
    isError: false,
    contentPartCount: 1,
    usageTotalTokens: 100,
  },
  model_select: { model: 'anthropic/claude-x', previousModel: 'openai/gpt-5', source: 'set' },
  thinking_level_select: { level: 'high', previousLevel: 'medium' },
  user_bash: { commandLength: 16, excludeFromContext: false, cwd: '/home/user/proj' },
  input: { textLength: 24, imageCount: 0, source: 'interactive' },
  tool_call: { toolCallId: 'call_1', toolName: 'bash', inputKeys: ['command', 'description'] },
  tool_result: {
    toolCallId: 'call_1',
    toolName: 'bash',
    isError: false,
    usageTotalTokens: 100,
    contentPartCount: 1,
    structuredContent: true,
  },
  agent_snapshot: {
    sessionId: 'sess-0001',
    sessionName: 'feature/board',
    cwd: '/home/user/proj',
    mode: 'tui',
    hasUI: true,
    isProjectTrusted: true,
    isIdle: false,
    hasPendingMessages: true,
    model: 'anthropic/claude-x',
    thinkingLevel: 'high',
    contextUsage: { tokens: 12000, contextWindow: 200000, percent: 6 },
    activeToolCount: 5,
    piVersion: '1.0.4',
    uptimeMs: 12345,
  },
};

export const ENV_FIELDS = {
  cwd: '/home/user/proj',
  sessionId: 'sess-0001',
};

/** 构造合法信封。 */
export function buildEnvelope(
  state: string,
  payload: Record<string, unknown>,
  overrides: Partial<ReportEnvelope> = {},
): ReportEnvelope {
  return {
    protocolVersion: '1',
    state,
    timestamp: 1791800000000,
    agent: { name: 'agent-a', cwd: '/home/user/proj', sessionId: 'sess-0001' },
    payload,
    ...overrides,
  };
}
