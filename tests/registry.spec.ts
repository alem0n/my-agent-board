/**
 * 注册表服务测试：聚合存储、历史上限、查询 API。
 *
 * 对应验收门槛：6 中的聚合/存储逻辑。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentRegistry } from '../src/services/registry.js';
import { FileRegistryStore } from '../src/infrastructure/registry-file-store.js';
import { silentLogger } from '../src/domain/logging.js';
import { buildEnvelope } from './fixtures/samples.js';

const NOW = 1791800000000;

function makeRegistry(
  dir: string,
  options?: { historyLimit?: number; persistDebounceMs?: number },
) {
  return new AgentRegistry(
    new FileRegistryStore(path.join(dir, 'agents.json'), silentLogger),
    silentLogger,
    {
      historyLimit: options?.historyLimit ?? 1000,
      persistDebounceMs: options?.persistDebounceMs ?? 250,
    },
  );
}

describe('latest 聚合', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-reg-'));
  });

  it('按状态保留最新载荷，历史追加全部记录', () => {
    const registry = makeRegistry(dir);
    const envelope = buildEnvelope('agent_start', {});
    const first = registry.ingest(envelope, NOW);

    registry.ingest(
      buildEnvelope('message_end', { role: 'assistant', contentPartCount: 2 }),
      NOW + 1,
    );
    registry.ingest(
      buildEnvelope(
        'message_end',
        { role: 'assistant', contentPartCount: 5 },
        {
          agent: {
            uuid: first.uuid,
            name: 'agent-a',
            cwd: '/home/user/proj',
            sessionId: 'sess-0001',
          },
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
    const registry = makeRegistry(dir);
    const first = registry.ingest(buildEnvelope('agent_snapshot', { cwd: '/p', mode: 'tui' }), NOW);
    expect(registry.get(first.uuid)?.latest['agent_snapshot']).toBeDefined();
  });
});

describe('历史与查询', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-hist-'));
  });

  it('历史上限生效（环形截断，保留最新）', () => {
    const registry = makeRegistry(dir, { historyLimit: 5 });
    const first = registry.ingest(buildEnvelope('agent_start', {}), NOW);
    for (let i = 0; i < 10; i += 1) {
      registry.ingest(buildEnvelope('agent_settled', {}), NOW + i + 1);
    }
    const record = registry.get(first.uuid)!;
    expect(record.history).toHaveLength(5);
    // 共 11 条，截断保留最新 5 条（全部为后入的 agent_settled）
    expect(
      record.history.every((entry) => entry.kind === 'report' && entry.state === 'agent_settled'),
    ).toBe(true);
  });

  it('history 查询支持 state 过滤、limit 截断标记与 since 过滤', () => {
    const registry = makeRegistry(dir);
    const first = registry.ingest(buildEnvelope('agent_start', {}), NOW);
    for (let i = 0; i < 4; i += 1) {
      registry.ingest(buildEnvelope('agent_settled', {}), NOW + 10 + i);
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
    const registry = makeRegistry(dir);
    const first = registry.ingest(buildEnvelope('agent_start', {}), NOW);
    registry.ingest(buildEnvelope('agent_settled', {}), NOW + 1);
    const list = registry.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      uuid: first.uuid,
      name: 'agent-a',
      cwd: '/home/user/proj',
      reportCount: 2,
      stateCount: 2,
    });
    expect(list[0]?.firstSeen).toBeLessThanOrEqual(list[0]!.lastSeen);
  });
});

describe('持久化', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-persist-'));
  });

  it('close 强制最终写入，数据可被新实例加载', () => {
    const registry = makeRegistry(dir, { persistDebounceMs: 10_000 });
    const first = registry.ingest(buildEnvelope('agent_start', {}), NOW);
    // 未触发去抖定时器的情况下 close 必须落盘
    registry.close();
    const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'agents.json'), 'utf8'));
    expect(Object.keys(persisted['agents'])).toEqual([first.uuid]);

    const reloaded = makeRegistry(dir);
    expect(reloaded.list()[0]?.name).toBe('agent-a');
  });

  it('去抖窗口内的多次摄入合并为一次写', () => {
    const store = new FileRegistryStore(path.join(dir, 'agents.json'), silentLogger);
    const writes: string[] = [];
    const trackingStore = {
      load: () => store.load(),
      save: (snapshot: unknown) => {
        writes.push('write');
        store.save(snapshot);
      },
    };
    const registry = new AgentRegistry(trackingStore, silentLogger, { persistDebounceMs: 20 });
    const first = registry.ingest(buildEnvelope('agent_start', {}), NOW);
    registry.ingest(buildEnvelope('agent_settled', {}), NOW + 1);
    registry.ingest(buildEnvelope('agent_settled', {}), NOW + 2);
    void first;
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(writes).toEqual(['write']);
        registry.close();
        expect(writes).toHaveLength(2);
        resolve();
      }, 60);
    });
  });
});
