/**
 * AgentRegistry：server 侧 uuid 分配、注册表维护与聚合查询（services 层）。
 *
 * 职责契约：
 * - ingest() 为唯一写入入口：uuid 权威分配（未知客户端 uuid 不被信任）、
 *   身份变化检测、latest 聚合、历史上限、去抖持久化。
 * - 全部方法对内存模型同步操作（JS 单线程天然串行）；持久化经串行写队列。
 * - 不直接访问 IO：通过 RegistryStore 端口。
 * 设计文档：docs/DESIGN.md §5.2、§8.1。
 */
import { randomUUID } from 'node:crypto';
import type {
  AgentRecord,
  AgentSummary,
  HistoryQuery,
  HistoryResult,
  HistoryEntry,
  RegistrySnapshot,
  RegistryStore,
} from '../domain/registry-model.js';
import type { ReportEnvelope } from '../domain/contracts.js';
import type { BoardLogger } from '../domain/logging.js';

export interface RegistryOptions {
  /** 每个 agent 的历史上限（默认 1000）。 */
  historyLimit?: number;
  /** 持久化去抖毫秒（默认 250）。 */
  persistDebounceMs?: number;
}

export interface IngestResult {
  uuid: string;
  assigned: boolean;
  replaced: boolean;
}

export class AgentRegistry {
  private readonly agents = new Map<string, AgentRecord>();
  private readonly store: RegistryStore;
  private readonly logger: BoardLogger;
  private readonly historyLimit: number;
  private readonly persistDebounceMs: number;
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor(store: RegistryStore, logger: BoardLogger, options: RegistryOptions = {}) {
    this.store = store;
    this.logger = logger;
    this.historyLimit = options.historyLimit ?? 1000;
    this.persistDebounceMs = options.persistDebounceMs ?? 250;

    const snapshot = store.load();
    if (snapshot !== null) {
      for (const [uuid, record] of Object.entries(snapshot.agents)) {
        this.agents.set(uuid, record);
      }
      logger.info('registry.restored', { agents: this.agents.size });
    } else {
      logger.info('registry.empty', { reason: 'no persisted snapshot' });
    }
  }

  /** 摄入一条已通过契约校验的上报信封，返回 uuid 分配结果。 */
  ingest(envelope: ReportEnvelope, serverNow: number): IngestResult {
    const requested = envelope.agent.uuid;
    let uuid: string;
    let assigned = false;
    let replaced = false;

    if (requested === undefined) {
      const sticky = this.findSticky(envelope.agent);
      uuid = sticky ?? randomUUID();
      assigned = sticky === undefined;
    } else if (this.agents.has(requested)) {
      uuid = requested;
    } else {
      // 客户端未知 uuid：不信任，改分配新 uuid（最小安全校验）。
      uuid = randomUUID();
      assigned = true;
      replaced = true;
    }

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

    this.schedulePersist();
    return { uuid, assigned, replaced };
  }

  /** 同 (name, cwd, sessionId) 的无 uuid 重复注册：复用既有 uuid。 */
  private findSticky(agent: ReportEnvelope['agent']): string | undefined {
    if (agent.sessionId === undefined) {
      return undefined;
    }
    for (const record of this.agents.values()) {
      if (
        record.name === agent.name &&
        record.cwd === agent.cwd &&
        record.sessionId === agent.sessionId
      ) {
        return record.uuid;
      }
    }
    return undefined;
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
    return [...this.agents.values()].map((record) => ({
      uuid: record.uuid,
      name: record.name,
      cwd: record.cwd,
      sessionId: record.sessionId,
      firstSeen: record.firstSeen,
      lastSeen: record.lastSeen,
      reportCount: record.reportCount,
      stateCount: Object.keys(record.latest).length,
    }));
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

  snapshot(): RegistrySnapshot {
    return {
      version: 1,
      agents: Object.fromEntries(this.agents.entries()),
    };
  }

  /** 关闭：强制最终持久化。 */
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.persistTimer !== undefined) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    this.store.save(this.snapshot());
  }

  private schedulePersist(): void {
    if (this.closed) {
      return;
    }
    if (this.persistTimer !== undefined) {
      return;
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      try {
        this.store.save(this.snapshot());
      } catch (error) {
        this.logger.error('registry.persistFailed', { error: String(error) });
      }
    }, this.persistDebounceMs);
  }
}
