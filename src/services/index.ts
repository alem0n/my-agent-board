/**
 * services 层：用例编排。
 *
 * 高内聚低耦合契约：
 * - 只可导入 domain 层与抽象接口。
 * - 不得导入 infrastructure 层的具体实现（通过依赖倒置交互）。
 * - 不得直接访问外部 IO（数据库/HTTP/文件系统）。
 *
 * - Reporter：client 侧状态采集、缓冲、重试与身份编排。
 * - AgentRegistry：server 侧 uuid 分配与聚合存储。
 * - mapper/retry：纯映射与退避策略。
 */
export { Reporter } from './reporter.js';
export type { ReporterDeps, ReporterStats } from './reporter.js';
export { MAX_BATCH } from './reporter.js';
export { AgentRegistry } from './registry.js';
export type { RegistryOptions, IngestResult } from './registry.js';
export { mapEvent, buildSnapshotPayload, EVENT_STATES } from './mapper.js';
export type { EventStateId } from './mapper.js';
export { computeBackoffDelay, retryWithBackoff } from './retry.js';
export type { RetryOutcome } from './retry.js';
