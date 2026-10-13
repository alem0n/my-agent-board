/**
 * server 端注册表领域模型（纯数据，无 IO）。
 *
 * 职责契约：定义 agent 注册记录、历史条目与快照结构，供 services/registry.ts 与
 * infrastructure 持久化层共享。
 * 设计文档：docs/DESIGN.md §5、§8。
 */

/** 历史条目：状态上报或身份变化。 */
export type HistoryEntry =
  | { kind: 'report'; timestamp: number; state: string; payload: unknown }
  | {
      kind: 'identity_change';
      timestamp: number;
      fields: Record<string, { from: unknown; to: unknown }>;
    };

/** 单个 agent 的注册记录。 */
export interface AgentRecord {
  uuid: string;
  /** 当前值；变化时保留 uuid 并更新（docs/DESIGN.md §5.4）。 */
  name: string;
  cwd: string;
  sessionId: string;
  firstSeen: number;
  lastSeen: number;
  /** 最近一次心跳时间戳（REQ-013）；0 = 从未心跳。 */
  lastHeartbeat: number;
  reportCount: number;
  protocolVersion: string;
  /** 逐状态最新载荷。 */
  latest: Record<string, { timestamp: number; payload: unknown }>;
  /** 上限历史（环形截断）。 */
  history: HistoryEntry[];
}

/** 列表查询摘要。 */
export interface AgentSummary {
  uuid: string;
  name: string;
  cwd: string;
  sessionId: string;
  firstSeen: number;
  lastSeen: number;
  /** 最近一次心跳时间戳（REQ-013）；0 = 从未心跳。 */
  lastHeartbeat: number;
  reportCount: number;
  stateCount: number;
  /** 派生在线状态（基于 lastSeen 与 lastHeartbeat，REQ-013）。 */
  online: boolean;
  /** 最后上报的状态标识（latest 中时间戳最大者；无上报时为 null）。 */
  lastState: string | null;
}

export interface HistoryQuery {
  state?: string;
  limit?: number;
  since?: number;
}

export interface HistoryResult {
  uuid: string;
  state?: string;
  entries: HistoryEntry[];
  /** 结果因 limit/since 截断（区别于环形存档截断）。 */
  truncated: boolean;
}
