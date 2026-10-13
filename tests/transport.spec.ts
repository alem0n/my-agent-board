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
import type { IdentityStore, Transport, HeartbeatResult } from '../src/domain/ports.js';
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

  public heartbeats: string[] = [];

  async postHeartbeat(uuid: string): Promise<HeartbeatResult> {
    this.heartbeats.push(uuid);
    return { ok: true };
  }
}

/** 手动控制的传输：postBatch 挂起直到 resolveBatch 被调用（测试关闭路径与进行中 flush 的并发）。 */
class ManualTransport implements Transport {
  public batches: ReportEnvelope[][] = [];
  private pending: ((response: ReportResponse) => void) | null = null;

  async postBatch(reports: ReportEnvelope[]): Promise<ReportResponse> {
    this.batches.push(reports);
    return new Promise<ReportResponse>((resolve) => {
      this.pending = resolve;
    });
  }

  resolveBatch(response: ReportResponse): void {
    const pending = this.pending;
    this.pending = null;
    pending?.(response);
  }

  async health(): Promise<boolean> {
    return true;
  }

  async postHeartbeat(_uuid: string): Promise<HeartbeatResult> {
    return { ok: true };
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
  heartbeatIntervalMs: 0,
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

describe('优雅关闭：尽力排空与退出唤醒', () => {
  it('可达时关闭：尽力排空缓冲（stop 自身完成发送，不丢弃）', async () => {
    const transport = new ScriptedTransport();
    const reporter = makeReporter({ transport });
    try {
      reporter.start();
      reporter.collectSnapshot();
      reporter.collectSnapshot();
      // 不调用 flushNow：关闭路径必须自行发送缓冲
      await reporter.stop();
      expect(transport.batches).toHaveLength(1);
      expect(transport.batches[0]).toHaveLength(2);
      expect(reporter.getStats().sent).toBe(2);
      expect(reporter.getStats().dropped).toBe(0);
    } finally {
      await reporter.stop();
    }
  });

  it('不可达时关闭：尽力单次尝试整批后丢弃并计数（不产生退避重试风暴）', async () => {
    const transport = new ScriptedTransport();
    transport.failAll = true;
    // 配置 maxAttempts=5：关闭路径强制单次尝试，不随配置重试
    const reporter = makeReporter({ transport });
    try {
      reporter.start();
      reporter.collectSnapshot();
      reporter.collectSnapshot();
      await reporter.stop();
      expect(transport.batches).toHaveLength(1);
      expect(transport.batches[0]).toHaveLength(2);
      expect(reporter.getStats().sent).toBe(0);
      expect(reporter.getStats().dropped).toBe(2);
      expect(reporter.getStats().flushFailures).toBe(1);
    } finally {
      await reporter.stop();
    }
  });

  it('关闭与进行中 flush 并发：先等待其退出，再排空剩余', async () => {
    const transport = new ManualTransport();
    const reporter = makeReporter({ transport });
    try {
      reporter.start();
      reporter.collectSnapshot(); // A：由进行中的 flush 持有
      const flushing = reporter.flushNow();
      // 等待进行中 flush splice 出批次 A（ensureIdentity 后的微任务）再入队 B
      await new Promise((resolve) => setImmediate(resolve));
      reporter.collectSnapshot(); // B：留给关闭路径排空（flushOnCount 大，不自动触发）
      // stop 先置 running=false → 进行中 flush 的循环在批次结束后退出，不抢后续批次
      const stopping = reporter.stop();
      transport.resolveBatch(okResponse()); // A 发送成功；循环检测 running=false 后退出
      // 等待 shutdownDrain 接手：B 被 splice 出并挂起（微任务推进）
      await waitFor(() => transport.batches.length >= 2);
      transport.resolveBatch(okResponse()); // shutdownDrain 排空 B
      await stopping;
      await flushing;
      expect(transport.batches.map((batch) => batch.length)).toEqual([1, 1]);
      expect(reporter.getStats().sent).toBe(2);
      expect(reporter.getStats().dropped).toBe(0);
    } finally {
      await reporter.stop();
    }
  });

  it('排空超时：3s 限时 guard 兑底，缓冲残留按关闭丢弃计数', async () => {
    const transport = new ManualTransport(); // postBatch 永不 resolve
    const reporter = makeReporter({ transport, config: { flushOnCount: 1 } });
    try {
      reporter.start();
      reporter.collectSnapshot(); // flushOnCount=1 → A 立即被 splice 出并挂起（flushInFlight 持有）
      await new Promise((resolve) => setImmediate(resolve));
      reporter.collectSnapshot(); // B 留在缓冲：进行中的 flush 阻止新 flush
      const stopStarted = Date.now();
      await reporter.stop();
      // 限时 guard 生效：关闭不等待永不 settle 的 postBatch
      const elapsed = Date.now() - stopStarted;
      expect(elapsed).toBeGreaterThanOrEqual(2_500);
      expect(elapsed).toBeLessThan(5_000);
      expect(reporter.getStats().sent).toBe(0);
      // B 在缓冲中被 dropOverflow(true) 丢弃计数
      expect(reporter.getStats().dropped).toBe(1);
    } finally {
      await reporter.stop();
    }
  }, 10_000);

  it('stop 后 start 重启：不可达与进行中状态不带入新会话', async () => {
    const transport = new ScriptedTransport();
    transport.failAll = true;
    transport.healthOkAfter = HEALTH_NEVER; // 首轮保持不可达
    const reporter = makeReporter({
      transport,
      config: { retry: { ...baseConfig.retry, maxAttempts: 1, jitter: false } },
    });
    try {
      reporter.start();
      reporter.collectSnapshot();
      await reporter.flushNow(); // → 不可达
      expect(reporter.isReachable()).toBe(false);
      await reporter.stop();

      transport.failAll = false;
      reporter.start(); // 重启：reachable / flushInFlight / batchSizeLimit 已重置
      reporter.collectSnapshot();
      await reporter.flushNow();
      expect(reporter.isReachable()).toBe(true);
      expect(reporter.getStats().sent).toBe(1);
    } finally {
      await reporter.stop();
    }
  });

  it('关闭时唤醒恢复探测：退出不挂起在完整退避周期上（真实定时器）', async () => {
    const transport = new ScriptedTransport();
    transport.failAll = true;
    transport.healthOkAfter = HEALTH_NEVER;
    const reporter = new Reporter({
      source: { subscribe: () => () => undefined },
      env: { snapshot: envSnapshot },
      transport,
      identityStore: new MemIdentityStore(),
      config: {
        ...baseConfig,
        issues: [],
        retry: {
          ...baseConfig.retry,
          maxAttempts: 1,
          jitter: false,
          initialDelayMs: 60_000,
          maxDelayMs: 60_000,
        },
      },
      logger: silentLogger,
      now: () => NOW,
      // 不注入 sleep：恢复退避使用真实、可被 stop 唤醒的定时器
    });
    try {
      reporter.start();
      reporter.collectSnapshot();
      await reporter.flushNow(); // 重试耗尽 → 不可达，恢复探测进入 60s 睡眠
      expect(reporter.isReachable()).toBe(false);

      const stopStarted = Date.now();
      await reporter.stop();
      // 若未唤醒：60s 退避定时器会挂起退出（同时 recoveryWaiters 残留）
      expect(Date.now() - stopStarted).toBeLessThan(5_000);
      expect((reporter as unknown as { recoveryWaiters: unknown[] })['recoveryWaiters']).toEqual(
        [],
      );
      expect(reporter.getStats().dropped).toBe(1); // 尽力一次失败 → 丢弃并计数
    } finally {
      await reporter.stop();
    }
  });
});

describe('传输健康快照（B5：transport 计数经 agent_snapshot 上报）', () => {
  it('失败计数与不可达状态经快照携带至 server', async () => {
    const transport = new ScriptedTransport();
    // flush 全失败 → 不可达；首次健康探测失败、第二次成功，睡眠门控让快照在不可达期间冻结。
    transport.failAll = true;
    transport.healthOkAfter = 1;
    let releaseSleep: () => void = () => undefined;
    const sleepGate = new Promise<void>((resolve) => {
      releaseSleep = resolve;
    });
    const reporter = new Reporter({
      source: { subscribe: () => () => undefined },
      env: { snapshot: envSnapshot },
      transport,
      identityStore: new MemIdentityStore(),
      config: {
        ...baseConfig,
        retry: { ...baseConfig.retry, maxAttempts: 1, initialDelayMs: 1 },
      },
      logger: silentLogger,
      now: () => NOW,
      sleep: async () => sleepGate,
      random: () => 0,
    });
    try {
      reporter.start();
      reporter.collectSnapshot();
      await reporter.flushNow(); // 失败 → 不可达，恢复探测进入门控睡眠
      expect(reporter.isReachable()).toBe(false);
      expect(reporter.getStats().flushFailures).toBe(1);

      // 不可达期间采集：快照冻结当前传输健康（不可达 + 失败计数 + 起始时间）。
      reporter.collectSnapshot();

      // 恢复链路后再放行：探测成功 → 缓冲排空，两份快照到达 server。
      transport.failAll = false;
      releaseSleep();
      await waitFor(() => transport.batches.some((batch) => batch.length > 1), 200);

      const snapshots = transport.batches
        .flat()
        .filter((env) => env.state === 'agent_snapshot')
        .map((env) => env.payload as Record<string, unknown>);
      const unreachable = snapshots.find((payload) => {
        const t = payload['transport'] as Record<string, unknown> | undefined;
        return t !== undefined && t['unreachable'] === true;
      });
      expect(unreachable).toBeDefined();
      expect(unreachable!['transport']).toMatchObject({
        dropped: 0,
        droppedRejected: 0,
        flushFailures: 1,
        unreachable: true,
        unreachableSince: NOW,
      });
    } finally {
      await reporter.stop();
    }
  });
});
