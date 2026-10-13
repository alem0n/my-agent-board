/**
 * 派生态计算测试（docs/BOARD.md P0：A1 相位 / A2 注意队列 / A3 健康度 / A4 run 摘要）。
 *
 * 纯函数层：构造 AgentRecord 历史，断言派生输出。对应验收门槛 2/6。
 */
import { describe, it, expect } from 'vitest';
import { deriveAgentStatus } from '../src/domain/derivation.js';
import type { AgentRecord } from '../src/domain/registry-model.js';
import { buildEnvelope } from './fixtures/samples.js';

const NOW = 1791800000000;

function makeRecord(): AgentRecord {
  return {
    uuid: 'uuid-a',
    name: 'agent-a',
    cwd: '/home/user/proj',
    sessionId: 'session-a',
    firstSeen: NOW,
    lastSeen: NOW,
    lastHeartbeat: 0,
    reportCount: 0,
    protocolVersion: '1',
    lastState: null,
    latest: {},
    history: [],
  };
}

/** 按顺序推入若干状态上报，返回记录（时间戳递增）。 */
function feed(
  states: Array<{ state: string; payload?: Record<string, unknown>; at?: number }>,
): AgentRecord {
  const record = makeRecord();
  let t = NOW;
  for (const item of states) {
    t = item.at ?? t + 1000;
    const envelope = buildEnvelope(item.state, item.payload ?? {}, { timestamp: t });
    record.history.push({
      kind: 'report',
      timestamp: t,
      state: item.state,
      payload: envelope.payload,
    });
    if (item.state === 'agent_snapshot') {
      record.latest['agent_snapshot'] = { timestamp: t, payload: envelope.payload };
    }
  }
  return record;
}

const derive = (record: AgentRecord, overrides: Record<string, unknown> = {}) =>
  deriveAgentStatus(record, {
    now: NOW + 10_000,
    online: true,
    windowMs: 5 * 60_000,
    ...overrides,
  } as never);

describe('A1 运行相位', () => {
  it('无任何开启标记 + 快照 isIdle=true → idle', () => {
    const record = feed([{ state: 'agent_snapshot', payload: { isIdle: true } }]);
    expect(derive(record).phase).toBe('idle');
  });

  it('ui_prompt_start 未闭合 → waiting-human（最高优先的活动信号）', () => {
    const record = feed([
      { state: 'tool_execution_start', payload: { toolCallId: 't1' } },
      { state: 'ui_prompt_start', payload: { kind: 'confirm' } },
    ]);
    const status = derive(record);
    expect(status.phase).toBe('waiting-human');
    // 注意队列首位为等待人工信号
    expect(status.health.attention[0]?.signal).toBe('waiting-human');
    expect(status.health.attention[0]?.detail).toContain('confirm');
    expect(status.health.level).toBe('watch');
  });

  it('ui_prompt_start 被 ui_prompt_end 闭合后不再等待人工', () => {
    const record = feed([
      { state: 'ui_prompt_start', payload: { kind: 'input' } },
      { state: 'ui_prompt_end', payload: { kind: 'input' } },
    ]);
    expect(derive(record).phase).not.toBe('waiting-human');
  });

  it('tool_execution_start 未闭合 → tool；按 toolCallId 配对闭合', () => {
    const record = feed([
      { state: 'tool_execution_start', payload: { toolCallId: 't1' } },
      { state: 'tool_execution_start', payload: { toolCallId: 't2' } },
      { state: 'tool_execution_end', payload: { toolCallId: 't1', isError: false } },
    ]);
    expect(derive(record).phase).toBe('tool');
  });

  it('全部 tool_execution_end 闭合后相位离开 tool', () => {
    const record = feed([
      { state: 'tool_execution_start', payload: { toolCallId: 't1' } },
      { state: 'tool_execution_end', payload: { toolCallId: 't1', isError: false } },
    ]);
    expect(derive(record).phase).not.toBe('tool');
  });

  it('assistant message_start 未闭合 → streaming', () => {
    const record = feed([{ state: 'message_start', payload: { role: 'assistant' } }]);
    expect(derive(record).phase).toBe('streaming');
  });

  it('toolResult 的 message_start 不构成流式相位', () => {
    const record = feed([{ state: 'message_start', payload: { role: 'toolResult' } }]);
    expect(derive(record).phase).not.toBe('streaming');
  });

  it('session_before_compact 未闭合 → compacting', () => {
    const record = feed([
      { state: 'session_before_compact', payload: { reason: 'threshold', willRetry: false } },
    ]);
    expect(derive(record).phase).toBe('compacting');
  });

  it('session_start 重置相位：上一会话的残留开启标记不计入', () => {
    const record = feed([
      { state: 'message_start', payload: { role: 'assistant' } },
      { state: 'session_start', payload: { reason: 'new' } },
      { state: 'agent_snapshot', payload: { isIdle: true } },
    ]);
    expect(derive(record).phase).toBe('idle');
  });

  it('无 session_start 且历史超 500 条时，相位只看最近回退窗口（环形截断防护）', () => {
    // message_start 在第 0 条（超过 500 条回退窗口）：不构成当前相位标记。
    const states: Array<{ state: string; payload?: Record<string, unknown> }> = [
      { state: 'message_start', payload: { role: 'assistant' } },
    ];
    for (let i = 0; i < 600; i += 1) {
      states.push({ state: 'agent_snapshot', payload: { isIdle: true } });
    }
    const record = feed(states);
    expect(derive(record).phase).toBe('idle');
  });

  it('离线优先于一切活动标记', () => {
    const record = feed([{ state: 'message_start', payload: { role: 'assistant' } }]);
    expect(derive(record, { online: false }).phase).toBe('offline');
  });

  it('无开启标记但快照声明非空闲 → active', () => {
    const record = feed([{ state: 'agent_snapshot', payload: { isIdle: false } }]);
    expect(derive(record).phase).toBe('active');
  });
});

describe('A2/A3 注意队列与健康度', () => {
  it('干净记录 → 良好，注意队列为空', () => {
    const record = feed([{ state: 'agent_snapshot', payload: { isIdle: true } }]);
    const status = derive(record);
    expect(status.health.level).toBe('good');
    expect(status.health.attention).toEqual([]);
  });

  it('离线且无 session_shutdown → 需处理（疑似崩溃）', () => {
    const record = feed([{ state: 'agent_snapshot', payload: { isIdle: true } }]);
    const status = derive(record, { online: false });
    expect(status.health.level).toBe('attention');
    expect(status.health.attention.map((item) => item.signal)).toContain('offline-unexpected');
  });

  it('离线但有 session_shutdown → unknown（不评级，干净退出）', () => {
    const record = feed([
      { state: 'agent_snapshot', payload: { isIdle: true } },
      { state: 'session_shutdown', payload: { reason: 'quit' } },
    ]);
    const status = derive(record, { online: false });
    expect(status.health.level).toBe('unknown');
  });

  it('agent_before_settle.outcome=error → 需处理', () => {
    const record = feed([
      {
        state: 'agent_before_settle',
        payload: { outcome: 'error', entryCount: 3, willContinue: false },
      },
    ]);
    expect(derive(record).health.level).toBe('attention');
  });

  it('message_end.stopReason=error → 需处理', () => {
    const record = feed([
      {
        state: 'message_end',
        payload: { role: 'assistant', contentPartCount: 1, stopReason: 'error' },
      },
    ]);
    const status = derive(record);
    expect(status.health.level).toBe('attention');
    expect(status.health.attention.map((item) => item.signal)).toContain('message-error');
  });

  it('after_provider_response 429 → 观察（限流可恢复）；5xx → 需处理', () => {
    const throttled = feed([
      { state: 'after_provider_response', payload: { status: 429, headerNames: [] } },
    ]);
    expect(derive(throttled).health.level).toBe('watch');
    const serverError = feed([
      { state: 'after_provider_response', payload: { status: 503, headerNames: [] } },
    ]);
    expect(derive(serverError).health.level).toBe('attention');
    expect(derive(serverError).health.attention.map((item) => item.signal)).toContain(
      'provider-server',
    );
  });

  it('压缩失败（非用户中止）→ 需处理；压缩频繁 → 观察', () => {
    const failed = feed([
      {
        state: 'session_compact_failed',
        payload: { reason: 'threshold', aborted: false, willRetry: false, errorMessage: 'boom' },
      },
    ]);
    expect(derive(failed).health.level).toBe('attention');
  });

  it('压缩失败后成功的压缩解除信号', () => {
    const recovered = feed([
      {
        state: 'session_compact_failed',
        payload: { reason: 'threshold', aborted: false, willRetry: false },
      },
      { state: 'session_compact', payload: { reason: 'manual', willRetry: false } },
    ]);
    const status = derive(recovered);
    expect(status.health.attention.map((item) => item.signal)).not.toContain('compact-failed');
    expect(status.health.level).toBe('good');
  });

  it('崩溃疑似按当前会话判定：shutdown 在上一个会话不解除信号', () => {
    const record = feed([
      { state: 'session_shutdown', payload: { reason: 'quit' } },
      { state: 'session_start', payload: { reason: 'new' } },
      { state: 'agent_snapshot', payload: { isIdle: true } },
    ]);
    const status = derive(record, { online: false });
    expect(status.health.attention.map((item) => item.signal)).toContain('offline-unexpected');
  });

  it('工具错误率超 30% 且 ≥2 次失败 → 观察；单次失败不上榜', () => {
    const noisy = feed([
      { state: 'tool_execution_end', payload: { toolCallId: 't1', isError: true } },
      { state: 'tool_execution_end', payload: { toolCallId: 't2', isError: true } },
      { state: 'tool_execution_end', payload: { toolCallId: 't3', isError: true } },
      { state: 'tool_execution_end', payload: { toolCallId: 't4', isError: true } },
    ]);
    const status = derive(noisy);
    expect(status.health.level).toBe('watch');
    expect(status.health.attention.map((item) => item.signal)).toContain('tool-error-rate');
  });

  it('单次工具失败不构成噪声信号（需 ≥2 次）', () => {
    const single = feed([
      { state: 'tool_execution_end', payload: { toolCallId: 't1', isError: true } },
      { state: 'tool_execution_end', payload: { toolCallId: 't2', isError: false } },
    ]);
    expect(derive(single).health.level).toBe('good');
  });

  it('上下文占用 >85% → 观察', () => {
    const record = feed([
      {
        state: 'agent_snapshot',
        payload: {
          isIdle: true,
          contextUsage: { tokens: 9000, contextWindow: 10000, percent: 90 },
        },
      },
    ]);
    const status = derive(record);
    expect(status.health.level).toBe('watch');
    expect(status.health.attention.map((item) => item.signal)).toContain('context-pressure');
  });

  it('快照传输统计有丢弃 → 观察（数据可信度信号，B5 闭环）', () => {
    const record = feed([
      {
        state: 'agent_snapshot',
        payload: {
          isIdle: true,
          transport: {
            dropped: 12,
            droppedRejected: 1,
            flushFailures: 2,
            unreachable: false,
            unreachableSince: null,
          },
        },
      },
    ]);
    const status = derive(record);
    expect(status.health.level).toBe('watch');
    expect(status.health.attention.map((item) => item.signal)).toContain('transport-drop');
  });

  it('相位为 streaming 但超阈值无进展 → 观察（疑似卡死）', () => {
    const record = feed([{ state: 'message_start', payload: { role: 'assistant' }, at: NOW }]);
    const status = deriveAgentStatus(record, {
      now: NOW + 200_000,
      online: true,
      stuckStreamingMs: 120_000,
      stuckBusyMs: 300_000,
    });
    expect(status.health.attention.map((item) => item.signal)).toContain('stuck');
  });

  it('idle/offline/等待人工相位不触发卡死信号', () => {
    const idle = feed([{ state: 'agent_snapshot', payload: { isIdle: true }, at: NOW }]);
    const idleStatus = deriveAgentStatus(idle, {
      now: NOW + 600_000,
      online: true,
      stuckStreamingMs: 120_000,
      stuckBusyMs: 300_000,
    });
    expect(idleStatus.health.attention.map((i) => i.signal)).not.toContain('stuck');
    const waiting = feed([{ state: 'ui_prompt_start', payload: { kind: 'input' }, at: NOW }]);
    const waitingStatus = deriveAgentStatus(waiting, {
      now: NOW + 600_000,
      online: true,
    });
    expect(waitingStatus.health.attention.map((i) => i.signal)).not.toContain('stuck');
  });

  it('窗口外的旧错误不进入注意队列', () => {
    const record = feed([
      {
        state: 'after_provider_response',
        payload: { status: 500, headerNames: [] },
        at: NOW - 10 * 60_000,
      },
      { state: 'agent_snapshot', payload: { isIdle: true } },
    ]);
    expect(derive(record).health.level).toBe('good');
  });
});

describe('A4 run 摘要', () => {
  it('无 before_agent_start → 空摘要', () => {
    const record = feed([{ state: 'agent_snapshot', payload: { isIdle: true } }]);
    const run = derive(record).run;
    expect(run.startedAt).toBe(null);
    expect(run.turns).toBe(0);
    expect(run.toolCalls).toBe(0);
    expect(run.totalTokens).toBe(0);
    expect(run.running).toBe(false);
  });

  it('统计最近一次 run 的轮数、工具调用与 token，未收尾时 running=true', () => {
    const record = feed([
      {
        state: 'before_agent_start',
        payload: { promptLength: 10, imageCount: 0, systemPromptLength: 100 },
      },
      { state: 'turn_start', payload: { turnIndex: 0, eventTimestamp: 1 } },
      {
        state: 'message_end',
        payload: {
          role: 'assistant',
          contentPartCount: 1,
          usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150 },
        },
      },
      { state: 'turn_start', payload: { turnIndex: 1, eventTimestamp: 2 } },
      { state: 'tool_execution_start', payload: { toolCallId: 't1' } },
    ]);
    const run = derive(record).run;
    expect(run.running).toBe(true);
    expect(run.startedAt).toBeGreaterThan(NOW);
    expect(run.turns).toBe(2);
    expect(run.toolCalls).toBe(1);
    expect(run.totalTokens).toBe(150);
    expect(run.durationMs).toBeGreaterThan(0);
  });

  it('agent_settled 收尾后 running=false 并记录用时与 outcome', () => {
    const started = NOW;
    const settled = NOW + 60_000;
    const record = feed([
      {
        state: 'before_agent_start',
        payload: { promptLength: 10, imageCount: 0, systemPromptLength: 100 },
        at: started,
      },
      { state: 'turn_start', payload: { turnIndex: 0, eventTimestamp: 1 }, at: started + 1000 },
      {
        state: 'agent_before_settle',
        payload: { outcome: 'completed', entryCount: 2, willContinue: false },
        at: settled - 1000,
      },
      { state: 'agent_settled', payload: {}, at: settled },
    ]);
    const run = derive(record, { now: settled + 10_000 }).run;
    expect(run.running).toBe(false);
    expect(run.outcome).toBe('completed');
    expect(run.durationMs).toBeGreaterThanOrEqual(59_000);
  });

  it('仅 agent_end 收尾（无 before_settle/settled）也视为完成', () => {
    const record = feed([
      {
        state: 'before_agent_start',
        payload: { promptLength: 10, imageCount: 0, systemPromptLength: 100 },
      },
      { state: 'agent_end', payload: { messageCount: 3, roleCounts: { user: 1, assistant: 2 } } },
    ]);
    const run = derive(record).run;
    expect(run.running).toBe(false);
    expect(run.outcome).toBe(null);
    expect(run.durationMs).toBeGreaterThan(0);
  });

  it('工具用量计入 run 总量（tool_execution_end.usageTotalTokens，BOARD.md A4）', () => {
    const record = feed([
      {
        state: 'before_agent_start',
        payload: { promptLength: 10, imageCount: 0, systemPromptLength: 100 },
      },
      { state: 'tool_execution_start', payload: { toolCallId: 't1' } },
      {
        state: 'tool_execution_end',
        payload: { toolCallId: 't1', isError: false, contentPartCount: 1, usageTotalTokens: 500 },
      },
      {
        state: 'message_end',
        payload: {
          role: 'assistant',
          contentPartCount: 1,
          usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150 },
        },
      },
    ]);
    expect(derive(record).run.totalTokens).toBe(650);
  });

  it('run-error 信号不沿用上一 run 的结局（新 run 进行中时）', () => {
    const record = feed([
      {
        state: 'before_agent_start',
        payload: { promptLength: 10, imageCount: 0, systemPromptLength: 100 },
      },
      {
        state: 'agent_before_settle',
        payload: { outcome: 'error', entryCount: 1, willContinue: false },
      },
      {
        state: 'before_agent_start',
        payload: { promptLength: 20, imageCount: 0, systemPromptLength: 100 },
      },
      { state: 'message_start', payload: { role: 'assistant' } },
    ]);
    const status = derive(record);
    expect(status.health.attention.map((item) => item.signal)).not.toContain('run-error');
    expect(status.run.running).toBe(true);
  });
});
