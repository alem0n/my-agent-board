/**
 * 身份测试：name 回退、uuid 分配与持久化、重复注册不产生重复 uuid、name/cwd 变化规则。
 *
 * 对应验收门槛：3 身份正确。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentRegistry } from '../src/services/registry.js';
import { FileIdentityStore } from '../src/infrastructure/file-store.js';
import { resolveIdentity } from '../src/domain/identity.js';
import { buildEnvelope } from './fixtures/samples.js';
import { silentLogger } from '../src/domain/logging.js';

const NOW = 1791800000000;

function makeRegistry(): AgentRegistry {
  return new AgentRegistry(silentLogger);
}

function env(overrides: { sessionId?: string; cwd?: string } = {}) {
  return {
    sessionId: 'sess-0001',
    sessionName: undefined,
    cwd: '/home/user/proj',
    mode: 'tui' as const,
    hasUI: true,
    isProjectTrusted: true,
    isIdle: true,
    hasPendingMessages: false,
    model: undefined,
    thinkingLevel: undefined,
    contextUsage: undefined,
    activeTools: [],
    piVersion: undefined,
    startedAt: NOW,
    ...overrides,
  };
}

describe('name 解析（4d）', () => {
  it('name 未设置时回退使用当前 session id', () => {
    const result = resolveIdentity(undefined, env());
    expect(result.ok).toBe(true);
    expect(result.ok && result.identity.name).toBe('sess-0001');
  });

  it('空字符串 name 视为未设置并回退', () => {
    const result = resolveIdentity('   ', env());
    expect(result.ok && result.identity.name).toBe('sess-0001');
  });

  it('已配置 name 优先于 session id', () => {
    const result = resolveIdentity('board-agent', env());
    expect(result.ok && result.identity.name).toBe('board-agent');
  });

  it('name 与 session id 皆不可用时明确失败（不静默）', () => {
    const result = resolveIdentity(undefined, env({ sessionId: undefined }));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('name_missing');
  });

  it('cwd 缺失时明确失败', () => {
    const result = resolveIdentity('agent', env({ cwd: '' }));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('cwd_missing');
  });
});

describe('uuid 分配与持久化（4e）', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-ident-'));
  });

  it('首次通信（无 uuid）由 server 分配 uuid', () => {
    const registry = makeRegistry();
    const envelope = buildEnvelope('agent_start', {});
    const result = registry.ingest(envelope, NOW);
    expect(result.assigned).toBe(true);
    expect(result.uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(registry.get(result.uuid)).toBeDefined();
  });

  it('携带已注册 uuid 复用，不产生重复', () => {
    const registry = makeRegistry();
    const first = registry.ingest(buildEnvelope('agent_start', {}), NOW);
    const second = registry.ingest(
      buildEnvelope(
        'agent_start',
        {},
        { agent: { ...buildEnvelope('agent_start', {}).agent, uuid: first.uuid } },
      ),
      NOW + 1,
    );
    expect(second.assigned).toBe(false);
    expect(second.uuid).toBe(first.uuid);
    expect(registry.list()).toHaveLength(1);
  });

  it('无本地研判：同身份无 uuid 再注册 → 分配新 uuid（互外条目，由 DELETE 治理）', () => {
    const registry = makeRegistry();
    const first = registry.ingest(buildEnvelope('agent_start', {}), NOW);
    // 同身份（name/cwd/sessionId 与首报相同）但无 uuid：server 不研判，分配新 uuid
    const second = registry.ingest(
      buildEnvelope(
        'session_start',
        { reason: 'startup' },
        { agent: buildEnvelope('agent_start', {}).agent },
      ),
      NOW + 1,
    );
    expect(second.assigned).toBe(true);
    expect(second.uuid).not.toBe(first.uuid);
    expect(registry.list()).toHaveLength(2);
  });

  it('client 携带的 uuid 被信任：记录不存在时按该 uuid 建立', () => {
    const registry = makeRegistry();
    const known = buildEnvelope('agent_start', {});
    const result = registry.ingest(
      buildEnvelope(
        'agent_start',
        {},
        { agent: { ...known.agent, uuid: '99999999-9999-9999-9999-999999999999' } },
      ),
      NOW,
    );
    expect(result.assigned).toBe(false);
    expect(result.uuid).toBe('99999999-9999-9999-9999-999999999999');
    expect(registry.list()).toHaveLength(1);
  });

  it('不同（name,cwd）的并行会话互不合并：各自独立条目', () => {
    const registry = makeRegistry();
    const first = registry.ingest(buildEnvelope('agent_start', {}), NOW);
    const second = registry.ingest(
      buildEnvelope(
        'agent_start',
        {},
        { agent: { name: 'other', cwd: '/other/dir', sessionId: 'sess-0002' } },
      ),
      NOW,
    );
    expect(second.uuid).not.toBe(first.uuid);
    expect(registry.list()).toHaveLength(2);
  });

  it('身份文件持久化与加载往返', async () => {
    const store = new FileIdentityStore(path.join(dir, 'identity.json'), silentLogger);
    expect(await store.load()).toBe(null);
    expect(
      (await store.save({ uuid: '12345678-1234-1234-1234-123456789012', assignedAt: NOW })).ok,
    ).toBe(true);
    const loaded = await store.load();
    expect(loaded?.uuid).toBe('12345678-1234-1234-1234-123456789012');
  });

  it('身份文件写入失败：明确失败结果，上层可降级（不静默）', async () => {
    const readonlyDir = path.join(dir, 'sub');
    fs.mkdirSync(readonlyDir);
    fs.chmodSync(readonlyDir, 0o500);
    try {
      const store = new FileIdentityStore(path.join(readonlyDir, 'identity.json'), silentLogger);
      const result = await store.save({
        uuid: '12345678-1234-1234-1234-123456789012',
        assignedAt: NOW,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.length).toBeGreaterThan(0);
      }
    } finally {
      fs.chmodSync(readonlyDir, 0o700);
    }
  });

  it('client 身份文件丢失：每次会话分配新 uuid（条目去重由 DELETE 显式治理）', () => {
    const registry = makeRegistry();
    registry.ingest(buildEnvelope('agent_start', {}), NOW);
    // 丢失 identity.json 后无 uuid 再上报（同身份）
    const second = registry.ingest(buildEnvelope('agent_start', {}), NOW + 1);
    expect(second.assigned).toBe(true);
    expect(registry.list()).toHaveLength(2); // 旧条目保留，由 DELETE /v1/agents/:uuid 清理
    expect(registry.delete(second.uuid)).toBe(true);
    expect(registry.list()).toHaveLength(1);
  });

  it('server 重启（内存清空）后 client 持旧 uuid 上报：旧 uuid 被信任复用', () => {
    const old = makeRegistry();
    const first = old.ingest(buildEnvelope('agent_start', {}), NOW);

    // server 重启 = 新实例（内存注册表为空）；client 仍持有旧 uuid
    const restarted = makeRegistry();
    const known = buildEnvelope('agent_start', {});
    const result = restarted.ingest(
      buildEnvelope('agent_start', {}, { agent: { ...known.agent, uuid: first.uuid } }),
      NOW + 1,
    );
    expect(result.assigned).toBe(false);
    expect(result.uuid).toBe(first.uuid);
  });
});

describe('name/cwd 变化处理（4d/§5.4）', () => {
  it('name 变化保留 uuid，更新注册信息，记录 identity_change 历史', () => {
    const registry = makeRegistry();
    const first = registry.ingest(buildEnvelope('agent_start', {}), NOW);
    // 真实 client 会携带已持久化的 uuid；仅 name 发生变化。
    const changed = registry.ingest(
      buildEnvelope(
        'agent_start',
        {},
        {
          agent: {
            uuid: first.uuid,
            name: 'renamed',
            cwd: '/home/user/proj',
            sessionId: 'sess-0001',
          },
        },
      ),
      NOW + 1,
    );
    expect(changed.uuid).toBe(first.uuid);
    expect(changed.assigned).toBe(false);

    const record = registry.get(first.uuid)!;
    expect(record.name).toBe('renamed');
    const identityChanges = record.history.filter((entry) => entry.kind === 'identity_change');
    expect(identityChanges).toHaveLength(1);
    if (identityChanges[0]?.kind === 'identity_change') {
      expect(identityChanges[0].fields['name']).toEqual({ from: 'agent-a', to: 'renamed' });
    }
  });

  it('cwd 变化保留 uuid 并记录，old cwd 历史可查', () => {
    const registry = makeRegistry();
    const first = registry.ingest(buildEnvelope('agent_start', {}), NOW);
    registry.ingest(
      buildEnvelope(
        'agent_start',
        {},
        { agent: { uuid: first.uuid, name: 'agent-a', cwd: '/new/dir', sessionId: 'sess-0001' } },
      ),
      NOW + 1,
    );
    const record = registry.get(first.uuid)!;
    expect(record.cwd).toBe('/new/dir');
    expect(record.history.filter((entry) => entry.kind === 'identity_change')).toHaveLength(1);
  });
});
