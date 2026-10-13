/**
 * AgentRegistry：server 侧 uuid 分配、注册表维护与聚合查询（services 层）。
 *
 * 职责契约：
 * - ingest() 为状态写入入口：uuid 信任来源 = client 请求携带的 uuid（server 不研判：
 *   携带即复用，记录不存在则按该 uuid 建立）；client 未携带时才分配新 uuid。
 * - heartbeat() 为在线探测写入入口（REQ-013）：只更新 lastHeartbeat，不创建记录。
 * - delete() 为治理入口：显式删除条目，请求即授权（无本地研判）。
 * - 注册表为纯内存（REQ-008）：不写盘、无快照加载/去抖写队列；重启即清空。
 * - 全部方法对内存模型同步操作（JS 单线程天然串行）。
 * 设计文档：docs/DESIGN.md §5.2、§7。
 */
import { randomUUID } from 'node:crypto';
import type {
  AgentRecord,
  AgentSummary,
  HistoryQuery,
  HistoryResult,
  HistoryEntry,
} from '../domain/registry-model.js';
import { deriveAgentStatus } from '../domain/derivation.js';
import type { ReportEnvelope } from '../domain/contracts.js';
import type { BoardLogger } from '../domain/logging.js';

export interface RegistryOptions {
  /** 每个 agent 的历史上限（默认 1000）。 */
  historyLimit?: number;
  /** 派生在线状态的判定窗口（默认 60s = 3 × 心跳周期，REQ-013）。 */
  onlineTimeoutMs?: number;
}

export interface IngestResult {
  uuid: string;
  /** server 在本次请求为新分配了 uuid（client 未携带时为 true）。 */
  assigned: boolean;
}

export class AgentRegistry {
  private readonly agents = new Map<string, AgentRecord>();
  private readonly logger: BoardLogger;
  private readonly historyLimit: number;
  private readonly onlineTimeoutMs: number;

  constructor(logger: BoardLogger, options: RegistryOptions = {}) {
    this.logger = logger;
    this.historyLimit = options.historyLimit ?? 1000;
    this.onlineTimeoutMs = options.onlineTimeoutMs ?? 60_000;
  }

  /** 摄入一条已通过契约校验的上报信封，返回 uuid 处理结果。 */
  ingest(envelope: ReportEnvelope, serverNow: number): IngestResult {
    // 信任模型：client 请求携带的 uuid 为信任来源；server 不做本地研判。
    const requested = envelope.agent.uuid;
    const uuid = requested ?? randomUUID();
    const assigned = requested === undefined;

    let record = this.agents.get(uuid);
    if (record === undefined) {
      record = {
        uuid,
        name: envelope.agent.name,
        cwd: envelope.agent.cwd,
        sessionId: envelope.agent.sessionId ?? '',
        firstSeen: serverNow,
        lastSeen: serverNow,
        lastHeartbeat: 0,
        reportCount: 0,
        protocolVersion: envelope.protocolVersion,
        lastState: envelope.state,
        latest: {},
        history: [],
      };
      this.agents.set(uuid, record);
    } else {
      this.recordIdentityChanges(record, envelope, serverNow);
      record.lastState = envelope.state;
    }

    record.name = envelope.agent.name;
    record.cwd = envelope.agent.cwd;
    if (envelope.agent.sessionId !== undefined) {
      record.sessionId = envelope.agent.sessionId;
    }
    record.lastSeen = serverNow;
    record.reportCount += 1;
    record.protocolVersion = envelope.protocolVersion;

    record.latest[envelope.state] = { timestamp: envelope.timestamp, payload: envelope.payload };
    const historyEntry: HistoryEntry = {
      kind: 'report',
      timestamp: envelope.timestamp,
      state: envelope.state,
      payload: envelope.payload,
    };
    record.history.push(historyEntry);
    if (record.history.length > this.historyLimit) {
      record.history.splice(0, record.history.length - this.historyLimit);
    }

    return { uuid, assigned };
  }

  /** 删除 agent 条目（治理操作：请求即授权）。返回条目是否存在。 */
  delete(uuid: string): boolean {
    return this.agents.delete(uuid);
  }

  private recordIdentityChanges(
    record: AgentRecord,
    envelope: ReportEnvelope,
    serverNow: number,
  ): void {
    const fields: Record<string, { from: unknown; to: unknown }> = {};
    if (record.name !== envelope.agent.name) {
      fields['name'] = { from: record.name, to: envelope.agent.name };
    }
    if (record.cwd !== envelope.agent.cwd) {
      fields['cwd'] = { from: record.cwd, to: envelope.agent.cwd };
    }
    if (Object.keys(fields).length === 0) {
      return;
    }
    record.history.push({ kind: 'identity_change', timestamp: serverNow, fields });
    this.logger.info('registry.identityChange', {
      uuid: record.uuid,
      fields,
    });
  }

  list(serverNow: number = Date.now()): AgentSummary[] {
    return [...this.agents.values()].map((record) => this.toSummary(record, serverNow));
  }

  /** 心跳探测：更新 lastHeartbeat；记录不存在返回 false（404，不创建/不复活记录）。 */
  heartbeat(uuid: string, serverNow: number): boolean {
    const record = this.agents.get(uuid);
    if (record === undefined) {
      return false;
    }
    record.lastHeartbeat = serverNow;
    return true;
  }

  /** 派生在线状态（REQ-013）。记录不存在时返回 false（不在线）。 */
  isOnline(uuid: string, serverNow: number = Date.now()): boolean {
    const record = this.agents.get(uuid);
    return record === undefined ? false : this.recordOnline(record, serverNow);
  }

  private toSummary(record: AgentRecord, serverNow: number): AgentSummary {
    const online = this.recordOnline(record, serverNow);
    const status = deriveAgentStatus(record, { now: serverNow, online });
    return {
      uuid: record.uuid,
      name: record.name,
      cwd: record.cwd,
      sessionId: record.sessionId,
      firstSeen: record.firstSeen,
      lastSeen: record.lastSeen,
      lastHeartbeat: record.lastHeartbeat,
      reportCount: record.reportCount,
      stateCount: Object.keys(record.latest).length,
      online,
      lastState: record.lastState,
      phase: status.phase,
      health: status.health,
      run: status.run,
    };
  }

  private recordOnline(record: AgentRecord, serverNow: number): boolean {
    return serverNow - Math.max(record.lastSeen, record.lastHeartbeat) <= this.onlineTimeoutMs;
  }

  get(uuid: string): AgentRecord | undefined {
    return this.agents.get(uuid);
  }

  /**
   * 详情视图：注册记录字段（不含 history）+ 派生在线态 + 派生状态（相位/健康度/run 摘要）。
   * board 路由直接序列化本结果。
   */
  detail(uuid: string, serverNow: number = Date.now()): Record<string, unknown> | undefined {
    const record = this.agents.get(uuid);
    if (record === undefined) {
      return undefined;
    }
    const online = this.recordOnline(record, serverNow);
    const status = deriveAgentStatus(record, { now: serverNow, online });
    const body: Record<string, unknown> = { ...record };
    delete body['history'];
    return { ...body, online, status };
  }

  history(uuid: string, query: HistoryQuery = {}): HistoryResult | undefined {
    const record = this.agents.get(uuid);
    if (record === undefined) {
      return undefined;
    }
    const limit = query.limit ?? 1000;
    const { state, since } = query;
    let entries: HistoryEntry[] = record.history;
    if (state !== undefined) {
      entries = entries.filter((entry) => entry.kind === 'report' && entry.state === state);
    }
    if (since !== undefined) {
      entries = entries.filter((entry) => entry.timestamp > since);
    }
    const truncated = entries.length > limit;
    if (truncated) {
      // 保留最近 limit 条（最新优先观察，但保持时间升序输出）。
      entries = entries.slice(entries.length - limit);
    }
    return {
      uuid,
      ...(state === undefined ? {} : { state }),
      entries,
      truncated,
    };
  }
}
