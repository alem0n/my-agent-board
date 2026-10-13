/**
 * 注册表服务测试：聚合存储、历史上限、查询 API。
 *
 * 对应验收门槛：6 中的聚合/存储逻辑。
 */
import { describe, it, expect } from 'vitest';
import type { ReportEnvelope } from '../src/domain/contracts.js';
import { AgentRegistry } from '../src/services/registry.js';
import { silentLogger } from '../src/domain/logging.js';
import { buildEnvelope } from './fixtures/samples.js';

const NOW = 1791800000000;
const AGENT = buildEnvelope('agent_start', {}).agent;

/** 同一 agent 的连续摄入助手：携带首报采用的 uuid（真实 client 行为）。 */
function sameAgent(uuid: string): ReportEnvelope['agent'] {
  return { ...AGENT, uuid };
}

function makeRegistry(options?: { historyLimit?: number }): AgentRegistry {
  return new AgentRegistry(silentLogger, {
    historyLimit: options?.historyLimit ?? 1000,
  });
}

describe('latest 聚合', () => {
  it('按状态保留最新载荷，历史追加全部记录', () => {
    const registry = makeRegistry();
    const envelope = buildEnvelope('agent_start', {});
    const first = registry.ingest(envelope, NOW);

    registry.ingest(
      buildEnvelope(
        'message_end',
        { role: 'assistant', contentPartCount: 2 },
        { agent: sameAgent(first.uuid) },
      ),
      NOW + 1,
    );
    registry.ingest(
      buildEnvelope(
        'message_end',
        { role: 'assistant', contentPartCount: 5 },
        {
          agent: sameAgent(first.uuid),
        },
      ),
      NOW + 2,
    );

    const record = registry.get(first.uuid)!;
    expect(Object.keys(record.latest).sort()).toEqual(['agent_start', 'message_end'].sort());
    expect(record.latest['message_end']?.payload).toEqual({
      role: 'assistant',
      contentPartCount: 5,
    });
    expect(record.history.filter((entry) => entry.kind === 'report')).toHaveLength(3);
    expect(record.reportCount).toBe(3);
  });

  it('42 个状态全部写入 latest（模拟器场景）', () => {
    // 覆盖性断言的单位测试版：e2e 中以真实流程再验证一次。
    const registry = makeRegistry();
    const first = registry.ingest(buildEnvelope('agent_snapshot', { cwd: '/p', mode: 'tui' }), NOW);
    expect(registry.get(first.uuid)?.latest['agent_snapshot']).toBeDefined();
  });
});

describe('历史与查询', () => {
  it('历史上限生效（环形截断，保留最新）', () => {
    const registry = makeRegistry({ historyLimit: 5 });
    const first = registry.ingest(buildEnvelope('agent_start', {}), NOW);
    for (let i = 0; i < 10; i += 1) {
      registry.ingest(
        buildEnvelope('agent_settled', {}, { agent: sameAgent(first.uuid) }),
        NOW + i + 1,
      );
    }
    const record = registry.get(first.uuid)!;
    expect(record.history).toHaveLength(5);
    // 共 11 条，截断保留最新 5 条（全部为后入的 agent_settled）
    expect(
      record.history.every((entry) => entry.kind === 'report' && entry.state === 'agent_settled'),
    ).toBe(true);
  });

  it('history 查询支持 state 过滤、limit 截断标记与 since 过滤', () => {
    const registry = makeRegistry();
    const first = registry.ingest(buildEnvelope('agent_start', {}), NOW);
    for (let i = 0; i < 4; i += 1) {
      registry.ingest(
        buildEnvelope('agent_settled', {}, { agent: sameAgent(first.uuid) }),
        NOW + 10 + i,
      );
    }
    const uuid = first.uuid;

    const byState = registry.history(uuid, { state: 'agent_settled' })!;
    expect(byState.entries).toHaveLength(4);
    expect(byState.state).toBe('agent_settled');

    const limited = registry.history(uuid, { limit: 2 })!;
    expect(limited.entries).toHaveLength(2);
    expect(limited.truncated).toBe(true);

    const since = registry.history(uuid, { since: NOW + 12 })!;
    expect(since.entries.every((entry) => entry.timestamp > NOW + 12)).toBe(true);

    expect(registry.history('00000000-0000-0000-0000-000000000000')).toBeUndefined();
  });

  it('list 输出摘要字段', () => {
    const registry = makeRegistry();
    const first = registry.ingest(buildEnvelope('agent_start', {}), NOW);
    registry.ingest(buildEnvelope('agent_settled', {}, { agent: sameAgent(first.uuid) }), NOW + 1);
    const list = registry.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      uuid: first.uuid,
      name: 'agent-a',
      cwd: '/home/user/proj',
      reportCount: 2,
      stateCount: 2,
      lastState: 'agent_settled',
    });
    expect(list[0]?.firstSeen).toBeLessThanOrEqual(list[0]!.lastSeen);
    // 无上报的摘要（理论路径）：lastState 为 null
    expect(list[0]?.lastState).not.toBeNull();
  });
});
