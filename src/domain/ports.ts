/**
 * 领域端口：client 库与外部交互的抽象（依赖倒置）。
 *
 * 职责契约：services 层（Reporter）依赖这些接口；具体实现在 infrastructure 层：
 * - HttpTransport（node fetch）
 * - FileIdentityStore（本地文件，全部异步，不阻塞主线程）
 */
import type { ReportEnvelope, ReportResponse } from './contracts.js';
import type { PersistedIdentity } from './identity.js';

/**
 * 传输端口。
 * - postBatch：HTTP 2xx 解析为 ReportResponse；携带逐条拒绝的批量 400 也解析为
 *   ReportResponse（ok:false + rejected）；网络错误与其他非 2xx 抛异常（调用方重试）。
 * - health：断线重连探测，true 表示可恢复。
 * - postHeartbeat：进程级心跳（REQ-013）；404 解析为 missing:true（记录被 DELETE 治理），
 *   网络错误抛异常（不进重试队列，下一周期自然重试）。
 */
export interface Transport {
  postBatch(reports: ReportEnvelope[]): Promise<ReportResponse>;
  health(): Promise<boolean>;
  postHeartbeat(uuid: string): Promise<HeartbeatResult>;
}

/** 心跳探测结果：missing = server 上该 uuid 记录不存在（404）。 */
export type HeartbeatResult = { ok: true } | { ok: false; missing: true };

/** 进程级心跳计数（client 组合层维护，供观测/测试断言）。 */
export interface HeartbeatStats {
  /** 成功送达（200，lastHeartbeat 已更新）。 */
  sent: number;
  /** 网络错误或非 404 拒绝（下一周期自然重试，不进重试队列）。 */
  failed: number;
  /** server 上该 uuid 记录不存在（404；记录被 DELETE 治理过）。 */
  missing: number;
}

/** 客户端身份持久化端口（异步：禁止阻塞主线程）。 */
export interface IdentityStore {
  load(): Promise<PersistedIdentity | null>;
  save(identity: PersistedIdentity): Promise<{ ok: true } | { ok: false; error: string }>;
}
