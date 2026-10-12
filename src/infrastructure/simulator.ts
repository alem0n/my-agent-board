/**
 * pi 环境模拟器：测试与本地演示用的 PiStateSource / PiEnvironmentProvider 实现。
 *
 * 职责契约：
 * - 不导入 pi 扩展类型；产出与 pi 事件结构一致的合成事件，驱动真实 mapper。
 * - runAgentSimulation 依次触发全部 41 个事件状态（每个至少一次），
 *   并同步推进环境快照（session、模型、idle、contextUsage 等）。
 * - 用于 e2e 测试与 scripts/demo.sh（"本地可运行的验证方式"）。
 */
import type {
  PiEnvironmentProvider,
  PiEnvironmentSnapshot,
  PiStateSource,
} from '../domain/pi-env.js';
import { EVENT_STATES } from '../services/mapper.js';

export class SimulatedStateSource implements PiStateSource {
  private readonly handlers = new Map<string, Set<(event: unknown) => void>>();

  emit(state: string, event: unknown): void {
    const handlers = this.handlers.get(state);
    if (handlers === undefined) {
      return;
    }
    for (const handler of handlers) {
      handler(event);
    }
  }

  subscribe(state: string, handler: (event: unknown) => void): () => void {
    let handlers = this.handlers.get(state);
    if (handlers === undefined) {
      handlers = new Set();
      this.handlers.set(state, handlers);
    }
    handlers.add(handler);
    return () => {
      const current = this.handlers.get(state);
      current?.delete(handler);
    };
  }
}

const DEFAULT_ENV: PiEnvironmentSnapshot = {
  sessionId: 'sim-session-20261012-0001',
  sessionName: 'feature/board',
  cwd: '/home/user/projects/demo',
  mode: 'tui',
  hasUI: true,
  isProjectTrusted: true,
  isIdle: true,
  hasPendingMessages: false,
  model: { provider: 'Intern-anthropic', id: 'Atria-Dawn-Preview' },
  thinkingLevel: 'high',
  contextUsage: { tokens: 12000, contextWindow: 200000, percent: 6 },
  activeTools: ['bash', 'read', 'edit', 'write', 'grep'],
  piVersion: '1.0.4',
  startedAt: Date.now(),
};

export class SimulatedEnvironment implements PiEnvironmentProvider {
  private state: PiEnvironmentSnapshot;

  constructor(initial: Partial<PiEnvironmentSnapshot> = {}) {
    this.state = { ...DEFAULT_ENV, ...initial, startedAt: initial.startedAt ?? Date.now() };
  }

  snapshot(): PiEnvironmentSnapshot {
    const state = this.state;
    const contextUsage = state.contextUsage === undefined ? undefined : { ...state.contextUsage };
    const model = state.model === undefined ? undefined : { ...state.model };
    return { ...state, contextUsage, model };
  }

  update(patch: Partial<PiEnvironmentSnapshot>): void {
    this.state = { ...this.state, ...patch };
  }
}

export interface SimulationDeps {
  source: SimulatedStateSource;
  env: SimulatedEnvironment;
  now?: () => number;
}

/** 运行完整的合成 agent 会话脚本；返回去重后的已触发状态标识列表。 */
export function runAgentSimulation(deps: SimulationDeps): string[] {
  const { source, env } = deps;
  const now = deps.now ?? (() => Date.now());
  const emitted = new Set<string>();
  const emit = (state: string, event: unknown): void => {
    source.emit(state, event);
    emitted.add(state);
  };

  const cwd = '/home/user/projects/demo';
  const sessionId = env.snapshot().sessionId ?? 'sim-session-20261012-0001';

  // --- 会话启动与资源发现 ----------------------------------------------------
  emit('project_trust', { type: 'project_trust', cwd });
  emit('resources_discover', { type: 'resources_discover', cwd, reason: 'startup' });
  env.update({ isIdle: false, hasPendingMessages: true });
  emit('session_start', { type: 'session_start', reason: 'startup' });
  emit('session_info_changed', { type: 'session_info_changed', name: 'feature/board' });
  emit('mcp_servers_change', {
    type: 'mcp_servers_change',
    servers: [{ name: 'context7' }, { name: 'filesystem' }],
  });

  // --- 模型选择与输入 --------------------------------------------------------
  emit('model_select', {
    type: 'model_select',
    model: { provider: 'Intern-anthropic', id: 'Atria-Dawn-Preview' },
    previousModel: { provider: 'Intern-anthropic', id: 'Atria-Dawn-Lite' },
    source: 'set',
  });
  emit('thinking_level_select', {
    type: 'thinking_level_select',
    level: 'high',
    previousLevel: 'medium',
  });
  emit('input', {
    type: 'input',
    text: '请总结当前目录的测试覆盖缺口',
    images: [],
    source: 'interactive',
  });

  // --- agent 循环：第一轮 -----------------------------------------------------
  emit('before_agent_start', {
    type: 'before_agent_start',
    prompt: '请总结当前目录的测试覆盖缺口',
    images: [],
    systemPrompt: 'You are Pi, a coding agent harness.' + ' guideline'.repeat(200),
  });
  emit('agent_start', { type: 'agent_start' });
  env.update({ isIdle: false });
  emit('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: now() });
  emit('context', {
    type: 'context',
    messages: [{ role: 'user', content: [{ type: 'text', text: '请总结' }] }],
  });
  emit('context_with_system', {
    type: 'context_with_system',
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'system prompt' }] },
      { role: 'user', content: [{ type: 'text', text: '请总结' }] },
    ],
  });

  // --- provider 交互 ----------------------------------------------------------
  emit('before_provider_request', { type: 'before_provider_request', payload: {} });
  emit('before_provider_headers', {
    type: 'before_provider_headers',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
  });
  for (const eventType of ['message_start', 'content_block_delta', 'message_delta']) {
    emit('provider_stream_event', {
      type: 'provider_stream_event',
      provider: 'Intern-anthropic',
      api: 'anthropic-messages',
      model: 'Atria-Dawn-Preview',
      data: { type: eventType },
    });
  }
  emit('after_provider_response', {
    type: 'after_provider_response',
    status: 200,
    headers: { 'request-id': 'req_sim_1', 'x-ratelimit-remaining': '99' },
  });

  // --- assistant 消息流 --------------------------------------------------------
  const assistantMessage = {
    role: 'assistant',
    content: [{ type: 'text', text: '我先查看测试目录结构。' }],
    api: 'anthropic-messages',
    provider: 'Intern-anthropic',
    model: 'Atria-Dawn-Preview',
    usage: { input: 4200, output: 180, cacheRead: 3000, cacheWrite: 1200, totalTokens: 4380 },
    stopReason: 'tool_use',
  };
  emit('message_start', { type: 'message_start', message: assistantMessage });
  emit('message_update', {
    type: 'message_update',
    message: assistantMessage,
    assistantMessageEvent: { type: 'content_block_delta' },
  });
  emit('message_end', { type: 'message_end', message: assistantMessage });

  // --- 工具调用 ----------------------------------------------------------------
  const toolCallId = 'call_0001';
  emit('tool_call', {
    type: 'tool_call',
    toolCallId,
    toolName: 'bash',
    input: { command: 'rg --files tests | head', description: '列出测试文件' },
  });
  emit('tool_execution_start', {
    type: 'tool_execution_start',
    toolCallId,
    toolName: 'bash',
    args: { command: 'rg --files tests | head', description: '列出测试文件' },
  });
  emit('tool_execution_update', {
    type: 'tool_execution_update',
    toolCallId,
    toolName: 'bash',
    args: { command: 'rg --files tests | head' },
    partialResult: 'contracts.spec.ts',
  });
  const toolResultContent = [{ type: 'text', text: 'contracts.spec.ts\nmapper.spec.ts' }];
  emit('tool_result', {
    type: 'tool_result',
    toolCallId,
    toolName: 'bash',
    input: { command: 'rg --files tests | head' },
    content: toolResultContent,
    structuredContent: { files: ['contracts.spec.ts', 'mapper.spec.ts'] },
    isError: false,
  });
  emit('tool_execution_end', {
    type: 'tool_execution_end',
    toolCallId,
    toolName: 'bash',
    result: { content: toolResultContent, isError: false },
    isError: false,
  });

  // --- 用户直执 bash -----------------------------------------------------------
  emit('user_bash', {
    type: 'user_bash',
    command: 'git status --short',
    excludeFromContext: false,
    cwd,
  });

  // --- 第一轮收尾 ---------------------------------------------------------------
  emit('turn_end', {
    type: 'turn_end',
    turnIndex: 0,
    message: assistantMessage,
    toolResults: [{ role: 'toolResult', content: toolResultContent, toolCallId }],
    messageEntryId: 'entry_0042',
    toolResultEntryIds: ['entry_0043'],
  });
  emit('agent_before_settle', {
    type: 'agent_before_settle',
    entries: [{ id: 'entry_0042' }, { id: 'entry_0043' }],
    continue: false,
    outcome: 'completed',
  });
  emit('agent_settled', { type: 'agent_settled' });
  emit('cache_warming_decision', {
    type: 'cache_warming_decision',
    action: 'warm',
    warmCost: 0.02,
    missCost: 0.18,
    continuationProbability: 0.9,
  });

  // --- 上下文压缩 ---------------------------------------------------------------
  emit('session_before_compact', {
    type: 'session_before_compact',
    preparation: { branchEntries: [{ id: 'entry_0001' }, { id: 'entry_0002' }] },
    branchEntries: [{ id: 'entry_0001' }, { id: 'entry_0002' }],
    reason: 'threshold',
    willRetry: false,
    signal: undefined,
  });
  env.update({ contextUsage: { tokens: 9000, contextWindow: 200000, percent: 4.5 } });
  emit('session_compact', {
    type: 'session_compact',
    compactionEntry: { id: 'entry_0050', firstKeptEntryId: 'entry_0003' },
    fromExtension: false,
    reason: 'threshold',
    willRetry: false,
  });
  emit('session_compact_failed', {
    type: 'session_compact_failed',
    reason: 'manual',
    errorMessage: 'simulated compaction timeout',
    aborted: true,
    willRetry: false,
    fromExtension: false,
  });

  // --- UI 阻塞提问 ---------------------------------------------------------------
  emit('ui_prompt_start', { type: 'ui_prompt_start', kind: 'confirm', title: '允许执行该命令？' });
  emit('ui_prompt_end', { type: 'ui_prompt_end', kind: 'confirm', title: '允许执行该命令？' });

  // --- 会话树导航与分叉 ------------------------------------------------------------
  emit('session_before_tree', {
    type: 'session_before_tree',
    preparation: {
      targetId: 'entry_0010',
      oldLeafId: 'entry_0043',
      commonAncestorId: 'entry_0005',
      entriesToSummarize: [{ id: 'entry_0011' }],
      userWantsSummary: true,
      customInstructions: undefined,
      replaceInstructions: undefined,
      label: undefined,
    },
    signal: undefined,
  });
  emit('session_tree', {
    type: 'session_tree',
    newLeafId: 'entry_0010',
    oldLeafId: 'entry_0043',
    fromExtension: false,
  });
  emit('session_before_fork', {
    type: 'session_before_fork',
    entryId: 'entry_0010',
    position: 'at',
  });

  // --- agent 结束 --------------------------------------------------------------------
  env.update({ isIdle: true, hasPendingMessages: false });
  emit('agent_end', {
    type: 'agent_end',
    messages: [assistantMessage, { role: 'toolResult', content: toolResultContent, toolCallId }],
  });

  // --- 会话切换与关闭 -----------------------------------------------------------------
  emit('session_before_switch', {
    type: 'session_before_switch',
    reason: 'new',
    targetSessionFile: `/home/user/.pi/agent/sessions/${sessionId}.jsonl`,
  });
  emit('session_shutdown', {
    type: 'session_shutdown',
    reason: 'quit',
  });

  return [...emitted];
}

/** 断言用：脚本应触发全部事件状态。 */
export function checkSimulationCoverage(emitted: string[]): { missing: string[]; extra: string[] } {
  const emittedSet = new Set(emitted);
  return {
    missing: EVENT_STATES.filter((state) => !emittedSet.has(state)),
    extra: [...emittedSet].filter((state) => !(EVENT_STATES as readonly string[]).includes(state)),
  };
}
