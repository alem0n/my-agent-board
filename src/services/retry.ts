/**
 * 退避重试策略：指数退避 + 全抖动（纯函数 + 通用重试循环）。
 *
 * 职责契约：传输层错误恢复的核心策略。仅依赖 domain 配置类型。
 * 设计文档：docs/DESIGN.md §6.3。
 */
import type { RetryConfig } from '../domain/client-config.js';

/**
 * 计算第 attempt 次（1-based）重试前的等待毫秒数。
 * 指数退避：min(maxDelayMs, initialDelayMs * factor^(attempt-1))；
 * jitter=true 时全抖动：均匀采样 [0, delay]。
 */
export function computeBackoffDelay(
  config: RetryConfig,
  attempt: number,
  random: () => number = Math.random,
): number {
  const attemptNumber = Math.max(1, Math.floor(attempt));
  const exponential = config.initialDelayMs * config.backoffFactor ** (attemptNumber - 1);
  const base = Math.min(config.maxDelayMs, exponential);
  if (!config.jitter) {
    return Math.round(base);
  }
  return Math.round(random() * base);
}

export interface RetryOutcome<T> {
  ok: boolean;
  result?: T;
  attempts: number;
  lastError?: unknown;
}

/**
 * 重试执行 fn 直到成功或耗尽 maxAttempts。
 * fn 抛出即视为失败；onAttempt 在每次失败后（等待前）以尝试次数与延迟回调。
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  config: RetryConfig,
  options?: {
    sleep?: (ms: number) => Promise<void>;
    random?: () => number;
    onAttempt?: (attempt: number, delayMs: number, error: unknown) => void;
    /** 判定错误是否可重试。默认全部可重试。 */
    shouldRetry?: (error: unknown) => boolean;
  },
): Promise<RetryOutcome<T>> {
  const sleep =
    options?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = options?.random ?? Math.random;
  const shouldRetry = options?.shouldRetry ?? (() => true);

  let lastError: unknown;
  for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
    try {
      const result = await fn();
      return { ok: true, result, attempts: attempt };
    } catch (error) {
      lastError = error;
      const retryable = shouldRetry(error);
      if (!retryable || attempt >= config.maxAttempts) {
        return { ok: false, attempts: attempt, lastError };
      }
      const delay = computeBackoffDelay(config, attempt, random);
      options?.onAttempt?.(attempt, delay, error);
      await sleep(delay);
    }
  }
  return { ok: false, attempts: config.maxAttempts, lastError };
}
