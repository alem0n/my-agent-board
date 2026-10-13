/**
 * Reporter：client 侧采集编排（services 层）。
 *
 * 职责契约：
 * - 订阅全部 41 个事件状态（通过 PiStateSource 端口），映射为契约载荷并组装信封。
 * - 周期采样 agent_snapshot（session_start / agent_end 边界补采）。
 * - 缓冲（超限丢弃最旧条目，状态持续刷新无需持久化）、退避重试、断线健康探测
 *   恢复、uuid 持久化与采用。
 * - 关闭时尽力排空（先等待进行中的 flush，再对剩余缓冲每批单次尝试，限时 3s）；
 *   关闭唤醒恢复探测的退避睡眠，退出不挂起在退避定时器上。
 * - 不直接访问 IO：通过 Transport / IdentityStore 端口交互。
 * 设计文档：docs/DESIGN.md §6.3、§7。
 */
import {
  PROTOCOL_VERSION,
  STATE_REGISTRY,
  type ReportEnvelope,
  type ReportResponse,
} from '../domain/contracts.js';
import type { ClientConfig } from '../domain/client-config.js';
import type { BoardLogger } from '../domain/logging.js';
import type { PiEnvironmentProvider, PiStateSource } from '../domain/pi-env.js';
import type { IdentityStore, Transport } from '../domain/ports.js';
import type { PersistedIdentity } from '../domain/identity.js';
import { resolveIdentity } from '../domain/identity.js';
import { BatchTooLargeError } from '../domain/errors.js';
import { computeBackoffDelay, retryWithBackoff } from './retry.js';
import { EVENT_STATES, buildSnapshotPayload, mapEvent } from './mapper.js';

export const MAX_BATCH = 512;
const SHUTDOWN_FLUSH_TIMEOUT_MS = 3_000;

export interface ReporterDeps {
  source: PiStateSource;
  env: PiEnvironmentProvider;
  transport: Transport;
  identityStore: IdentityStore;
  config: ClientConfig;
  logger: BoardLogger;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** 随机源注入（抖动确定性测试）。 */
  random?: () => number;
}

export interface ReporterStats {
  collected: number;
  droppedIdentity: number;
  droppedUnmapped: number;
  sent: number;
  droppedRejected: number;
  /** 丢弃总数：缓冲超限 / 上报失败耗尽重试 / 关闭时残留。 */
  dropped: number;
  rejections: number;
  flushFailures: number;
  recoveryCount: number;
}

export class Reporter {
  private readonly deps: ReporterDeps;
  private readonly now: () => number;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly randomFn: () => number;
  private identity: PersistedIdentity | null = null;
  private identityLoaded = false;
  private identityLoading: Promise<void> | null = null;
  private buffer: ReportEnvelope[] = [];
  private running = false;
  private started = false;
  private reachable = true;
  private flushInFlight: Promise<{ sent: number }> | null = null;
  private recoveryInFlight = false;
  /** 恢复探测退避睡眠的唤醒句柄（stop 时清除，避免退出挂起）。 */
  private recoveryWaiters: Array<() => void> = [];
  /** 413 拆分后的批次大小上限（成功后重置为 MAX_BATCH）。 */
  private batchSizeLimit = MAX_BATCH;
  private unsubscribers: (() => void)[] = [];
  private flushTimer: ReturnType<typeof setInterval> | undefined;
  private snapshotTimer: ReturnType<typeof setInterval> | undefined;
  private readonly stats: ReporterStats = {
    collected: 0,
    droppedIdentity: 0,
    droppedUnmapped: 0,
    sent: 0,
    droppedRejected: 0,
    dropped: 0,
    rejections: 0,
    flushFailures: 0,
    recoveryCount: 0,
  };

  /** 进行中的身份持久化写，关闭路径等待其完成。 */
  private pendingWrites: Promise<void> = Promise.resolve();

  constructor(deps: ReporterDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.sleepFn = deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.randomFn = deps.random ?? Math.random;
  }

  /** 当前持久化的身份（测试与诊断用）。 */
  get currentIdentity(): PersistedIdentity | null {
    return this.identity;
  }

  /** 启动：订阅事件、启动采样与 flush 定时器。幂等。 */
  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.running = true;
    // 重置关闭后残留状态（stop→start 重启场景）：上轮不可达、进行中批次、拆半限频不带入新会话。
    this.reachable = true;
    this.flushInFlight = null;
    this.batchSizeLimit = MAX_BATCH;
    this.deps.logger.info('reporter.start', {
      serverUrl: this.deps.config.serverUrl,
      states: EVENT_STATES.length + 1,
    });

    for (const state of EVENT_STATES) {
      const unsubscribe = this.deps.source.subscribe(state, (event) => {
        this.collectEvent(state, event);
      });
      this.unsubscribers.push(unsubscribe);
    }

    this.flushTimer = setInterval(() => {
      void this.flushCycle().catch((error) => {
        this.deps.logger.error('report.flushUnexpectedError', { error: String(error) });
      });
    }, this.deps.config.flushIntervalMs);
    this.snapshotTimer = setInterval(() => {
      this.collectSnapshot();
    }, this.deps.config.reportIntervalMs);

    // 持久化身份异步预载（不阻塞启动）；flush 前等待其完成。
    this.identityLoading = this.loadIdentity();
  }

  /** 异步加载持久化身份；失败按空身份处理（首次上报时由 server 分配）。 */
  private async loadIdentity(): Promise<void> {
    try {
      this.identity = await this.deps.identityStore.load();
      if (this.identity !== null) {
        this.deps.logger.info('identity.loaded', { uuid: this.identity.uuid });
      }
    } catch (error) {
      // 预载失败不阻断上报：后续按无持久化身份处理。
      this.deps.logger.error('identity.loadFailed', { error: String(error) });
    } finally {
      this.identityLoaded = true;
    }
  }

  private async ensureIdentity(): Promise<void> {
    if (this.identityLoaded) {
      return;
    }
    await this.identityLoading;
  }

  /**
   * 停止：取消订阅、清定时器、尽力排空缓冲、残留丢弃并计数。幂等。
   * 先等待进行中的 flush 退出，再对剩余缓冲尽力发送（每批单次尝试），
   * 整体限时 SHUTDOWN_FLUSH_TIMEOUT_MS；超时或不可达时残留丢弃并计数。
   */
  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }
    this.running = false;
    this.started = false;
    this.deps.logger.info('reporter.stop', { buffered: this.buffer.length });

    for (const unsubscribe of this.unsubscribers) {
      unsubscribe();
    }
    this.unsubscribers = [];
    if (this.flushTimer !== undefined) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.snapshotTimer !== undefined) {
      clearInterval(this.snapshotTimer);
      this.snapshotTimer = undefined;
    }
    // 唤醒恢复探测的退避睡眠：关闭不等待完整退避周期。
    this.wakeRecovery();

    const guard = shutdownTimer(SHUTDOWN_FLUSH_TIMEOUT_MS);
    try {
      await Promise.race([this.shutdownDrain(), guard.promise]);
    } catch (error) {
      this.deps.logger.warn('reporter.shutdownFlushError', { error: String(error) });
    } finally {
      guard.cancel();
    }
    this.dropOverflow(true);
    // 等待进行中的身份持久化写落盘。
    await this.pendingWrites;
  }

  /** 手动触发一次 flush（测试与关闭路径共用）。 */
  async flushNow(): Promise<void> {
    await this.flushCycle();
  }

  /** 手动采样一次快照并刷新缓冲（演示入口与 e2e 测试共用）。 */
  async collectSnapshotAndFlush(): Promise<void> {
    this.collectSnapshot();
    await this.flushCycle();
  }

  getStats(): ReporterStats {
    return { ...this.stats };
  }

  isReachable(): boolean {
    return this.reachable;
  }

  // ---------------------------------------------------------------------------
  // 采集
  // ---------------------------------------------------------------------------

  /** 事件型状态采集：映射 + 组信封 + 入队。 */
  collectEvent(state: string, event: unknown): void {
    if (!this.running) {
      return;
    }
    const env = this.deps.env.snapshot();
    const mapped = mapEvent(state, event, env);
    if (mapped === undefined) {
      this.stats.droppedUnmapped += 1;
      this.deps.logger.error('report.unmappedState', { state });
      return;
    }

    if (state === 'session_start' || state === 'agent_end') {
      this.collectSnapshot();
    }
    this.enqueue(state, mapped, this.now());
  }

  /** 采样型状态采集：agent_snapshot。 */
  collectSnapshot(): void {
    if (!this.running) {
      return;
    }
    const env = this.deps.env.snapshot();
    const payload = buildSnapshotPayload(env, this.now());
    this.enqueue('agent_snapshot', payload, this.now());
  }

  /** 组信封并入队（含高频状态合并与超限溢出）。 */
  private enqueue(state: string, payload: Record<string, unknown>, timestamp: number): void {
    const identityResult = resolveIdentity(this.deps.config.name, this.deps.env.snapshot());
    if (!identityResult.ok) {
      this.stats.droppedIdentity += 1;
      this.deps.logger.warn('report.identityMissing', {
        state,
        reason: identityResult.reason,
      });
      return;
    }
    const resolved = identityResult.identity;
    const envelope: ReportEnvelope = {
      protocolVersion: PROTOCOL_VERSION,
      state,
      timestamp,
      agent: {
        ...(this.identity === null ? {} : { uuid: this.identity.uuid }),
        name: resolved.name,
        cwd: resolved.cwd,
        ...(resolved.sessionId === undefined ? {} : { sessionId: resolved.sessionId }),
      },
      payload,
    };

    this.coalesceOrAppend(envelope);
    this.stats.collected += 1;

    if (this.buffer.length >= this.deps.config.flushOnCount) {
      void this.flushCycle();
    }
  }

  /** event+coalesce 状态：合并窗口内替换缓冲中的同状态信封（载荷取最新）。 */
  private coalesceOrAppend(envelope: ReportEnvelope): void {
    const contract = STATE_REGISTRY.get(envelope.state);
    if (contract !== undefined && contract.frequency === 'event+coalesce') {
      const windowMs = contract.coalesceWindowMs ?? 1000;
      for (let index = this.buffer.length - 1; index >= 0; index -= 1) {
        const candidate = this.buffer[index];
        if (candidate === undefined) {
          break;
        }
        if (candidate.state !== envelope.state) {
          continue;
        }
        if (envelope.timestamp - candidate.timestamp <= windowMs) {
          this.buffer[index] = envelope;
          return;
        }
        break;
      }
    }
    this.buffer.push(envelope);
    this.dropOverflow(false);
  }

  /** 缓冲超限：丢弃最旧条目（监控状态持续刷新，新数据优先于旧数据）。 */
  private dropOverflow(shutdown: boolean): void {
    const limit = shutdown ? 0 : this.deps.config.maxBufferSize;
    if (this.buffer.length <= limit) {
      return;
    }
    const dropped = this.buffer.splice(0, this.buffer.length - limit);
    this.stats.dropped += dropped.length;
    this.deps.logger.warn('buffer.overflow', {
      dropped: dropped.length,
      buffered: this.buffer.length,
      ...(shutdown ? { reason: 'shutdown' } : {}),
    });
  }

  /** 跟踪进行中的异步身份写，stop() 等待其完成。 */
  private trackWrite(write: Promise<unknown>): void {
    this.pendingWrites = this.pendingWrites.then(
      () => write,
      () => write,
    ) as Promise<void>;
  }

  // ---------------------------------------------------------------------------
  // 上报
  // ---------------------------------------------------------------------------

  /** 常规 flush：运行中且可达时进入排空循环；已在排空则复用其结果。 */
  private async flushCycle(): Promise<{ sent: number }> {
    if (!this.running || !this.reachable || this.buffer.length === 0) {
      return { sent: 0 };
    }
    if (this.flushInFlight !== null) {
      return this.flushInFlight;
    }
    const run = this.runDrain(false);
    this.flushInFlight = run;
    try {
      return await run;
    } finally {
      this.flushInFlight = null;
    }
  }

  /**
   * 关闭路径排空：先等进行中的 flush（其循环检测 running=false 后退出），
   * 再忽略 running/reachable 守卫排空剩余缓冲（尽力而为）。
   */
  private async shutdownDrain(): Promise<{ sent: number }> {
    if (this.flushInFlight !== null) {
      try {
        await this.flushInFlight;
      } catch (error) {
        this.deps.logger.warn('reporter.shutdownFlushError', { error: String(error) });
      }
    }
    if (this.buffer.length === 0) {
      return { sent: 0 };
    }
    const run = this.runDrain(true);
    this.flushInFlight = run;
    try {
      return await run;
    } finally {
      this.flushInFlight = null;
    }
  }

  /**
   * 排空循环：splice 批次 → 重试发送 → 处理结果（413 拆半 / 毒信剔除 / 失败保留或丢弃）。
   * shutdown=true 时忽略 running/reachable 守卫且每批仅单次尝试：已关闭的会话不再
   * 循环重试（避免退避睡眠拖长退出），失败批次丢弃并计数，整体限时由 stop 的 race 兜底。
   */
  private async runDrain(shutdown: boolean): Promise<{ sent: number }> {
    // 首次 flush 前等待持久化身份加载（异步文件读，不阻塞采集）。
    await this.ensureIdentity();
    const retry = shutdown ? { ...this.deps.config.retry, maxAttempts: 1 } : this.deps.config.retry;
    let sent = 0;
    while (this.buffer.length > 0 && (shutdown || (this.running && this.reachable))) {
      const batch = this.buffer
        .splice(0, Math.min(this.batchSizeLimit, MAX_BATCH, this.buffer.length))
        // 发送时补盖身份 uuid：身份为异步加载，加载完成前入队的信封此时补上
        // （server 信任请求携带的 uuid，补盖后无需 server 侧研判）。
        .map((envelope) =>
          envelope.agent.uuid === undefined && this.identity !== null
            ? { ...envelope, agent: { ...envelope.agent, uuid: this.identity.uuid } }
            : envelope,
        );
      const outcome = await retryWithBackoff(() => this.deps.transport.postBatch(batch), retry, {
        sleep: this.sleepFn,
        random: this.randomFn,
        shouldRetry: (error) => !(error instanceof BatchTooLargeError),
        onAttempt: (attempt, delayMs, error) => {
          this.deps.logger.warn('report.retry', {
            attempt,
            delayMs,
            error: String(error),
            batchSize: batch.length,
          });
        },
      });
      if (!outcome.ok) {
        this.stats.flushFailures += 1;
        const tooLarge = outcome.lastError instanceof BatchTooLargeError;
        if (tooLarge) {
          if (batch.length <= 1) {
            this.deps.logger.error('report.oversizedDropped', { state: batch[0]?.state });
            continue;
          }
          // 拆半：整批回填，下一批仅取一半（batchSizeLimit），成功后重置。
          const half = Math.max(1, Math.ceil(batch.length / 2));
          this.batchSizeLimit = half;
          this.buffer.unshift(...batch);
          continue;
        }
        this.requeueOrDrop(batch);
        this.markUnreachable();
        return { sent };
      }
      const response = outcome.result;
      if (response === undefined) {
        this.stats.flushFailures += 1;
        this.requeueOrDrop(batch);
        this.markUnreachable();
        return { sent };
      }
      if (!response.ok) {
        this.handleRejection(batch, response);
        continue;
      }
      await this.applyIdentity(response);
      this.batchSizeLimit = MAX_BATCH;
      sent += batch.length;
      this.stats.sent += batch.length;
    }
    return { sent };
  }

  private handleRejection(batch: ReportEnvelope[], response: ReportResponse): void {
    this.stats.rejections += 1;
    const rejected = response.rejected ?? [];
    const dropIndexes = new Set(rejected.map((entry) => entry.index));
    for (const entry of rejected) {
      this.stats.droppedRejected += 1;
      this.deps.logger.error('report.rejected', {
        index: entry.index,
        code: entry.code,
        message: entry.message,
        ...(entry.state === undefined ? {} : { state: entry.state }),
      });
    }
    const remaining = batch.filter((_, index) => !dropIndexes.has(index));
    if (remaining.length > 0) {
      this.buffer.unshift(...remaining);
    }
  }

  private requeueOrDrop(batch: ReportEnvelope[]): void {
    if (this.running) {
      this.buffer.unshift(...batch);
      return;
    }
    // 已停止：重试已耗尽，丢弃并计数（下一会话会采集刷新后的新状态）。
    this.stats.dropped += batch.length;
    this.deps.logger.warn('report.shutdownDropped', { dropped: batch.length });
  }

  private markUnreachable(): void {
    if (!this.reachable) {
      return;
    }
    this.reachable = false;
    this.deps.logger.error('transport.unreachable', { serverUrl: this.deps.config.serverUrl });
    void this.runRecovery().catch((error) => {
      this.deps.logger.error('recovery.unexpectedError', { error: String(error) });
    });
  }

  /** 断线恢复：按退避间隔探测健康，恢复后触发 flush。 */
  private async runRecovery(): Promise<void> {
    if (this.recoveryInFlight) {
      return;
    }
    this.recoveryInFlight = true;
    try {
      let attempt = 1;
      while (this.running && !this.reachable) {
        const delayMs = computeBackoffDelay(this.deps.config.retry, attempt, this.randomFn);
        await this.recoverySleep(delayMs);
        if (!this.running || this.reachable) {
          break;
        }
        try {
          const healthy = await this.deps.transport.health();
          if (healthy) {
            this.reachable = true;
            this.stats.recoveryCount += 1;
            this.deps.logger.info('transport.recovered', {
              attempt,
              serverUrl: this.deps.config.serverUrl,
            });
            await this.flushCycle().catch((error) => {
              this.deps.logger.error('report.flushUnexpectedError', { error: String(error) });
            });
          }
        } catch {
          this.deps.logger.debug('transport.probeFailed', { attempt });
        }
        attempt += 1;
      }
    } finally {
      this.recoveryInFlight = false;
    }
  }

  /** 唤醒恢复探测的退避睡眠（关闭路径调用，避免退出挂起在退避定时器上）。 */
  private wakeRecovery(): void {
    const waiters = this.recoveryWaiters.splice(0, this.recoveryWaiters.length);
    for (const wake of waiters) {
      wake();
    }
  }

  /** 从等待列表移除一个唤醒句柄（定时器触发或被唤醒后调用）。 */
  private removeRecoveryWaiter(wake: () => void): void {
    const index = this.recoveryWaiters.indexOf(wake);
    if (index >= 0) {
      this.recoveryWaiters.splice(index, 1);
    }
  }

  /**
   * 恢复探测的退避睡眠。注入 sleep（测试确定性）直通；默认为可唤醒的真实定时器——
   * 否则关闭时进行中的退避定时器（默认至 30s）会挂起进程退出。
   */
  private recoverySleep(ms: number): Promise<void> {
    if (this.deps.sleep !== undefined) {
      return this.deps.sleep(ms);
    }
    return new Promise<void>((resolve) => {
      const wake = (): void => {
        clearTimeout(timer);
        this.removeRecoveryWaiter(wake);
        resolve();
      };
      const timer = setTimeout(() => {
        this.removeRecoveryWaiter(wake);
        resolve();
      }, ms);
      this.recoveryWaiters.push(wake);
    });
  }

  /** 采用 server 分配的 uuid 并持久化；持久化失败降级为仅内存持有（明确日志）。 */
  private async applyIdentity(response: ReportResponse): Promise<void> {
    if (!response.assigned) {
      return;
    }
    if (this.identity !== null && this.identity.uuid === response.uuid) {
      return;
    }
    const next: PersistedIdentity = {
      uuid: response.uuid,
      assignedAt: this.now(),
      serverUrl: this.deps.config.serverUrl,
    };
    // 跟踪异步身份写：stop 的限时 race 可能截断 drain，但 pendingWrites 仍等其落盘。
    const write = this.deps.identityStore.save(next);
    this.trackWrite(write);
    const result = await write;
    if (result.ok) {
      this.identity = next;
      this.deps.logger.info('identity.persisted', { uuid: next.uuid });
    } else {
      this.identity = next;
      this.deps.logger.error('identity.persistFailed', {
        uuid: next.uuid,
        error: result.error,
        degradation: 'uuid held in memory only; not persisted across sessions',
      });
    }
  }
}

/**
 * 关闭排空的限时 guard：真实定时器。不能使用注入的测试 sleep——
 * 即时的注入 sleep 会让 race 立即 resolve，排空从未真正发生。
 * 返回的 cancel 保证无论 race 谁先完成都不遗留定时器句柄。
 */
function shutdownTimer(ms: number): { promise: Promise<void>; cancel: () => void } {
  let resolveTimer: () => void;
  const promise = new Promise<void>((resolve) => {
    resolveTimer = resolve;
  });
  const timer = setTimeout(() => resolveTimer(), ms);
  return { promise, cancel: () => clearTimeout(timer) };
}
