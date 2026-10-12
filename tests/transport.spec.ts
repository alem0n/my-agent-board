/**
 * 传输可靠性测试：退避重试、断线重连、缓冲溢出丢弃、毒信剔除、413 拆分。
 *
 * 对应验收门槛：6 中的"重连重试"类别。
 *
 * 注意：每个用例务必 try/finally 调用 reporter.stop()，否则 setInterval 句柄
 * 会保持事件循环存活、挂起 vitest。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Reporter, MAX_BATCH } from '../src/services/reporter.js';
import { computeBackoffDelay, retryWithBackoff } from '../src/services/retry.js';
import { BatchTooLargeError, type ReportEnvelope } from '../src/domain/errors.js';
import type { ReportResponse } from '../src/domain/contracts.js';
import type { IdentityStore, Transport } from '../src/domain/ports.js';
import { silentLogger } from '../src/domain/logging.js';
import { buildEnvelope } from './fixtures/samples.js';

const NOW = 1791800000000;
const TEST_UUID = '12345678-1234-1234-1234-123456789012';
/** 健康探测永不成功（用于不可达态断言）。 */
const HEALTH_NEVER = Number.MAX_SAFE_INTEGER;

/** 内存传输：可编程的失败/应答序列。 */
class ScriptedTransport implements Transport {
  public batches: ReportEnvelope[][] = [];
  public healthCalls = 0;
  public healthOkAfter = 0;
  /** 每次 postBatch 的行为序列；每次消费一条。 */
  public behaviors: Array<() => ReportResponse> = [];
  /** 持续失败开关：无视 behaviors 一律抛网络错误。 */
  public failAll = false;

  async postBatch(reports: ReportEnvelope[]): Promise<ReportResponse> {
    this.batches.push(reports);
    if (this.failAll) {
      throw new Error('connection refused');
    }
    const behavior = this.behaviors.shift();
    if (behavior === undefined) {
      return { ok: true, uuid: TEST_UUID, assigned: false, accepted: reports.length };
    }
    return behavior();
  }

  async health(): Promise<boolean> {
    this.healthCalls += 1;
    return this.healthCalls > this.healthOkAfter;
  }
}

const okResponse = (): ReportResponse => ({
  ok: true,
  uuid: TEST_UUID,
  assigned: false,
  accepted: 1,
});
const networkError = (): ReportResponse => {
  throw new Error('connection refused');
};
const tooLarge = (): ReportResponse => {
  throw new BatchTooLargeError('too large');
};

class MemIdentityStore implements IdentityStore {
  public saved: Array<{ uuid: string; assignedAt: number }> = [];

  load() {
    return this.saved.length === 0
      ? null
      : { uuid: this.saved[0]!.uuid, assignedAt: this.saved[0]!.assignedAt };
  }

  save(identity: {
    uuid: string;
    assignedAt: number;
  }): { ok: true } | { ok: false; error: string } {
    this.saved.unshift(identity);
    return { ok: true };
  }
}

const envSnapshot = () => ({
  sessionId: 'sess-0001',
  sessionName: undefined,
  cwd: '/home/user/proj',
  mode: 'tui' as const,
  hasUI: true,
  isProjectTrusted: true,
  isIdle: false,
  hasPendingMessages: false,
  model: undefined,
  thinkingLevel: undefined,
  contextUsage: undefined,
  activeTools: [],
  piVersion: undefined,
  startedAt: NOW,
});

const baseConfig = {
  serverUrl: 'http://127.0.0.1:7878',
  reportIntervalMs: 60_000,
  flushIntervalMs: 60_000,
  requestTimeoutMs: 5_000,
  maxBufferSize: 100,
  flushOnCount: 10_000,
  retry: {
    maxAttempts: 5,
    initialDelayMs: 500,
    maxDelayMs: 30_000,
    backoffFactor: 2,
    jitter: false,
  },
};

function makeReporter(options: {
  transport: Transport;
  identityStore?: IdentityStore;
  config?: Partial<typeof baseConfig>;
}) {
  return new Reporter({
    source: { subscribe: () => () => undefined },
    env: { snapshot: envSnapshot },
    transport: options.transport,
    identityStore: options.identityStore ?? new MemIdentityStore(),
    config: { ...baseConfig, ...options.config },
    logger: silentLogger,
    now: () => NOW,
    sleep: async () => undefined,
    random: () => 0,
  });
}

/** 轮询直到条件满足或超时（用 setImmediate 让后台恢复循环推进）。 */
async function waitFor(predicate: () => boolean, iterations = 200): Promise<void> {
  for (let i = 0; i < iterations && !predicate(); i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe('退避策略（纯函数）', () => {
  const cfg = baseConfig.retry;

  it('无抖动时为指数序列并在 maxDelayMs 封顶', () => {
    expect(computeBackoffDelay(cfg, 1)).toBe(500);
    expect(computeBackoffDelay(cfg, 2)).toBe(1000);
    expect(computeBackoffDelay(cfg, 3)).toBe(2000);
    expect(computeBackoffDelay(cfg, 4)).toBe(4000);
    expect(computeBackoffDelay(cfg, 12)).toBe(30_000);
  });

  it('全抖动时延迟落在 [0, base]', () => {
    const random = () => 0.5;
    expect(computeBackoffDelay({ ...cfg, jitter: true }, 1, random)).toBe(250);
    expect(computeBackoffDelay({ ...cfg, jitter: true }, 2, random)).toBe(500);
  });
});

describe('retryWithBackoff', () => {
  const sleepCalls: number[] = [];

  it('失败后重试至成功，退避序列单调递增', async () => {
    let calls = 0;
    const outcome = await retryWithBackoff(
      async () => {
        calls += 1;
        if (calls < 3) {
          throw new Error('boom');
        }
        return 'ok';
      },
      { ...baseConfig.retry, jitter: false },
      {
        sleep: async (ms) => {
          sleepCalls.push(ms);
        },
        random: () => 0,
      },
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.attempts).toBe(3);
    expect(outcome.result).toBe('ok');
    expect(sleepCalls).toEqual([500, 1000]);
  });

  it('耗尽 maxAttempts 后失败', async () => {
    const outcome = await retryWithBackoff(
      async () => {
        throw new Error('always');
      },
      { ...baseConfig.retry, maxAttempts: 3, jitter: false },
      { sleep: async () => undefined, random: () => 0 },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.attempts).toBe(3);
    expect(String(outcome.lastError)).toContain('always');
  });

  it('shouldRetry=false 时不重试（即时失败）', async () => {
    let calls = 0;
    const outcome = await retryWithBackoff(
      async () => {
        calls += 1;
        throw new Error('irrecoverable');
      },
      baseConfig.retry,
      { sleep: async () => undefined, random: () => 0, shouldRetry: () => false },
    );
    expect(outcome.ok).toBe(false);
    expect(calls).toBe(1);
  });
});

describe('Reporter 发送失败重试与缓冲保留', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-tr-'));
  });

  it('前两次网络失败、第三次成功：退避后重试成功，缓冲不丢', async () => {
    const transport = new ScriptedTransport();
    transport.behaviors = [networkError, networkError];
    const reporter = makeReporter({ transport });
    try {
      reporter.start();
      reporter.collectSnapshot();
      await reporter.flushNow();

      const stats = reporter.getStats();
      expect(stats.sent).toBe(1);
      expect(transport.batches).toHaveLength(3);
      expect(transport.batches[2]).toHaveLength(1);
    } finally {
      await reporter.stop();
    }
  });

  it('连续失败耗尽重试：缓冲保留并标记不可达（恢复探测不成功前不上报）', async () => {
    const transport = new ScriptedTransport();
    transport.failAll = true;
    transport.healthOkAfter = HEALTH_NEVER;
    const reporter = makeReporter({
      transport,
      config: { retry: { ...baseConfig.retry, maxAttempts: 2, jitter: false } },
    });
    try {
      reporter.start();
      reporter.collectSnapshot();
      reporter.collectSnapshot();
      await reporter.flushNow();

      expect(reporter.getStats().sent).toBe(0);
      expect(reporter.isReachable()).toBe(false);
      expect(reporter.getStats().flushFailures).toBe(1);

      // 不可达期间新采集不触发上报
      reporter.collectSnapshot();
      await reporter.flushNow();
      expect(reporter.getStats().sent).toBe(0);
    } finally {
      await reporter.stop();
    }
  });

  it('断线恢复：健康探测成功后恢复上报并排空', async () => {
    const transport = new ScriptedTransport();
    transport.behaviors = [networkError];
    transport.healthOkAfter = 2; // 前 2 次探测失败
    const reporter = makeReporter({
      transport,
      config: { retry: { ...baseConfig.retry, maxAttempts: 1, jitter: false } },
    });
    try {
      reporter.start();
      reporter.collectSnapshot();
      await reporter.flushNow();
      expect(reporter.isReachable()).toBe(false);

      await waitFor(() => reporter.isReachable() && reporter.getStats().sent >= 1);
      expect(reporter.isReachable()).toBe(true);
      expect(reporter.getStats().sent).toBe(1);
      expect(transport.healthCalls).toBeGreaterThanOrEqual(3);
    } finally {
      await reporter.stop();
    }
  });

  it('关闭时无法发送：残余缓冲被丢弃并计数（监控态持续刷新，无需持久化）', async () => {
    const transport = new ScriptedTransport();
    transport.failAll = true;
    const reporter = makeReporter({
      transport,
      config: { retry: { ...baseConfig.retry, maxAttempts: 1, jitter: false } },
    });
    reporter.start();
    reporter.collectSnapshot();
    reporter.collectSnapshot();
    await reporter.stop();

    // 残余被丢弃并计数，不再落盘
    expect(reporter.getStats().dropped).toBe(2);
    expect(fs.existsSync(path.join(dir, 'outbox.jsonl'))).toBe(false);

    // 新实例启动时没有遗留队列需要排空
    const transport2 = new ScriptedTransport();
    const reporter2 = makeReporter({ transport: transport2 });
    try {
      reporter2.start();
      reporter2.collectSnapshot();
      await reporter2.flushNow();
      // 只有本次会话采集的状态被发送
      expect(transport2.batches).toHaveLength(1);
      expect(transport2.batches[0]).toHaveLength(1);
    } finally {
      await reporter2.stop();
    }
  });

  it('缓冲超限丢弃最旧条目，只保留最新状态', async () => {
    const transport = new ScriptedTransport();
    const reporter = makeReporter({
      transport,
      config: { maxBufferSize: 2, flushOnCount: 10_000 },
    });
    try {
      reporter.start();
      for (let i = 0; i < 5; i += 1) {
        reporter.collectSnapshot();
      }
      expect(reporter.getStats().dropped).toBe(3);
      // 只有缓冲内最新的 2 条被发送，旧的 3 条已丢弃
      await reporter.flushNow();
      expect(reporter.getStats().sent).toBe(2);
    } finally {
      await reporter.stop();
    }
  });

  it('批量部分拒绝：剔除毒信后重试剩余', async () => {
    const transport = new ScriptedTransport();
    transport.behaviors = [
      () => ({
        ok: false,
        uuid: '',
        assigned: false,
        rejected: [{ index: 1, code: 'E_INVALID_PAYLOAD', message: 'bad payload' }],
      }),
    ];
    const reporter = makeReporter({ transport });
    try {
      reporter.start();
      reporter.collectSnapshot();
      reporter.collectSnapshot();
      reporter.collectSnapshot();
      await reporter.flushNow();
      // 首次批量拒绝 index 1；剩余 2 条在后续循环中发送
      await waitFor(() => reporter.getStats().sent >= 2);
      expect(reporter.getStats().droppedRejected).toBe(1);
      expect(reporter.getStats().sent).toBe(2);
    } finally {
      await reporter.stop();
    }
  });

  it('413 批量超限：自动拆分重试，不丢数据', async () => {
    const transport = new ScriptedTransport();
    transport.behaviors = [tooLarge, okResponse, okResponse];
    const reporter = makeReporter({ transport });
    try {
      reporter.start();
      reporter.collectSnapshot();
      reporter.collectSnapshot();
      await reporter.flushNow();
      const stats = reporter.getStats();
      expect(stats.sent).toBe(2);
      expect(transport.batches.map((batch) => batch.length)).toEqual([2, 1, 1]);
    } finally {
      await reporter.stop();
    }
  });

  it('批量大小不超过协议上限', () => {
    expect(MAX_BATCH).toBe(512);
  });

  it('高频状态合并：1s 窗口内同状态仅保留最新载荷', async () => {
    const transport = new ScriptedTransport();
    const reporter = makeReporter({ transport });
    try {
      reporter.start();
      const updateEvent = (eventType: string) => ({
        type: 'message_update',
        message: { role: 'assistant', content: [{ type: 'text' }] },
        assistantMessageEvent: { type: eventType },
      });
      reporter['collectEvent']('message_update', updateEvent('text'));
      reporter['collectEvent']('message_update', updateEvent('text'));
      reporter['collectEvent']('message_update', updateEvent('delta'));
      await reporter.flushNow();
      const batch = transport.batches[0];
      const updates = batch.filter((envelope) => envelope.state === 'message_update');
      expect(updates).toHaveLength(1);
      expect(updates[0]?.payload['eventType']).toBe('delta');
    } finally {
      await reporter.stop();
    }
  });

  it('uuid 由 server 分配后应用到后续信封', async () => {
    const transport = new ScriptedTransport();
    transport.behaviors = [() => ({ ok: true, uuid: TEST_UUID, assigned: true, accepted: 1 })];
    const identityStore = new MemIdentityStore();
    const reporter = makeReporter({ transport, identityStore });
    try {
      reporter.start();
      reporter.collectSnapshot();
      await reporter.flushNow();
      expect(reporter.currentIdentity?.uuid).toBe(TEST_UUID);
      expect(identityStore.saved[0]?.uuid).toBe(TEST_UUID);
      // 后续信封携带 uuid
      reporter.collectSnapshot();
      await reporter.flushNow();
      expect(transport.batches[1]?.[0]?.agent.uuid).toBe(TEST_UUID);
    } finally {
      await reporter.stop();
    }
  });

  it('身份持久化失败：明确降级为仅内存持有（不静默、不阻断上报）', async () => {
    const transport = new ScriptedTransport();
    transport.behaviors = [() => ({ ok: true, uuid: TEST_UUID, assigned: true, accepted: 1 })];
    const errors: string[] = [];
    const failingStore: IdentityStore = {
      load: () => null,
      save: () => ({ ok: false, error: 'EACCES' }),
    };
    const failingLogger = {
      ...silentLogger,
      error: (msg: string) => errors.push(msg),
    };
    const reporter = new Reporter({
      source: { subscribe: () => () => undefined },
      env: { snapshot: envSnapshot },
      transport,
      identityStore: failingStore,
      config: baseConfig,
      logger: failingLogger,
      now: () => NOW,
      sleep: async () => undefined,
      random: () => 0,
    });
    try {
      reporter.start();
      reporter.collectSnapshot();
      await reporter.flushNow();
      // 降级：uuid 仅在内存中持有，上报继续成功
      expect(reporter.currentIdentity?.uuid).toBe(TEST_UUID);
      expect(errors.some((msg) => msg === 'identity.persistFailed')).toBe(true);
      reporter.collectSnapshot();
      await reporter.flushNow();
      expect(transport.batches[1]?.[0]?.agent.uuid).toBe(TEST_UUID);
    } finally {
      await reporter.stop();
    }
  });

  it('有效信封 helper 契约一致', () => {
    expect(buildEnvelope('agent_start', {}).state).toBe('agent_start');
  });
});
