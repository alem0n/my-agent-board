/**
 * AgentRegistry：server 侧 uuid 分配、注册表维护与聚合查询（services 层）。
 *
 * 职责契约：
 * - ingest() 为唯一写入入口：uuid 信任来源 = client 请求携带的 uuid（server 不研判：
 *   携带即复用，记录不存在则按该 uuid 建立）；client 未携带时才分配新 uuid。
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
import type { ReportEnvelope } from '../domain/contracts.js';
import type { BoardLogger } from '../domain/logging.js';

export interface RegistryOptions {
  /** 每个 agent 的历史上限（默认 1000）。 */
  historyLimit?: number;
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

  constructor(logger: BoardLogger, options: RegistryOptions = {}) {
    this.logger = logger;
    this.historyLimit = options.historyLimit ?? 1000;
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
        reportCount: 0,
        protocolVersion: envelope.protocolVersion,
        latest: {},
        history: [],
      };
      this.agents.set(uuid, record);
    } else {
      this.recordIdentityChanges(record, envelope, serverNow);
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

  list(): AgentSummary[] {
    return [...this.agents.values()].map((record) => {
      // 最后上报状态：history 按到达顺序追加，倒序找最近一条 report。
      let lastState: string | null = null;
      for (let i = record.history.length - 1; i >= 0; i -= 1) {
        const entry = record.history[i];
        if (entry !== undefined && entry.kind === 'report') {
          lastState = entry.state ?? null;
          break;
        }
      }
      if (lastState === null) {
        // 回退：latest 中时间戳最大者（history 滚动截断或仅含 identity_change 时）。
        let lastStateTs = -1;
        for (const [state, entry] of Object.entries(record.latest)) {
          if (entry.timestamp > lastStateTs) {
            lastStateTs = entry.timestamp;
            lastState = state;
          }
        }
      }
      return {
        uuid: record.uuid,
        name: record.name,
        cwd: record.cwd,
        sessionId: record.sessionId,
        firstSeen: record.firstSeen,
        lastSeen: record.lastSeen,
        reportCount: record.reportCount,
        stateCount: Object.keys(record.latest).length,
        lastState,
      };
    });
  }

  get(uuid: string): AgentRecord | undefined {
    return this.agents.get(uuid);
  }

  history(uuid: string, query: HistoryQuery = {}): HistoryResult | undefined {
    const record = this.agents.get(uuid);
    if (record === undefined) {
      return undefined;
    }
    const limit = query.limit ?? 1000;
    let entries = record.history;
    if (query.state !== undefined) {
      entries = entries.filter((entry) => entry.kind === 'report' && entry.state === query.state);
    }
    if (query.since !== undefined) {
      entries = entries.filter((entry) => entry.timestamp > query.since!);
    }
    const truncated = entries.length > limit;
    if (truncated) {
      // 保留最近 limit 条（最新优先观察，但保持时间升序输出）。
      entries = entries.slice(entries.length - limit);
    }
    return {
      uuid,
      ...(query.state === undefined ? {} : { state: query.state }),
      entries,
      truncated,
    };
  }
}
