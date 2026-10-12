/**
 * 文件持久化测试：原子写与损坏文件降级。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  FileRegistryStore,
  writeJsonAtomic,
  readJsonFile,
} from '../src/infrastructure/registry-file-store.js';
import {
  FileIdentityStore,
  SerialFileWriter,
  writeJsonFile,
  readJsonFileAsync,
} from '../src/infrastructure/file-store.js';
import { silentLogger } from '../src/domain/logging.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-fs-'));
});

describe('writeJsonAtomic / readJsonFile', () => {
  it('写入可读回，且创建嵌套目录', async () => {
    const file = path.join(dir, 'a', 'b', 'x.json');
    writeJsonAtomic(file, { v: 1 });
    expect(readJsonFile(file)).toEqual({ v: 1 });
  });

  it('文件缺失返回 null；损坏 JSON 抛错', async () => {
    expect(readJsonFile(path.join(dir, 'missing.json'))).toBe(null);
    const file = path.join(dir, 'broken.json');
    fs.writeFileSync(file, '{oops');
    expect(() => readJsonFile(file)).toThrow();
  });

  it('原子写不残留临时文件', async () => {
    const file = path.join(dir, 'x.json');
    writeJsonAtomic(file, { v: 2 });
    expect(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});

describe('client 侧异步工具', () => {
  it('writeJsonFile 异步原子写 + readJsonFileAsync 读取（含并发 enqueue）', async () => {
    const file = path.join(dir, 'async', 'x.json');
    await writeJsonFile(file, { v: 1 });
    expect(await readJsonFileAsync(file)).toEqual({ v: 1 });
    // 并发 enqueue 保证顺序与最终值一致性
    const writer = new SerialFileWriter();
    const writes = [3, 2, 1].map((value) =>
      writer.enqueue(() => writeJsonFile(file, { v: value })),
    );
    await Promise.all(writes);
    await writer.flush();
    expect(await readJsonFileAsync(file)).toEqual({ v: 1 });
    expect(fs.readdirSync(path.join(dir, 'async')).filter((name) => name.endsWith('.tmp'))).toEqual(
      [],
    );
  });

  it('readJsonFileAsync：文件缺失返回 null', async () => {
    expect(await readJsonFileAsync(path.join(dir, 'missing.json'))).toBe(null);
  });

  it('SerialFileWriter：失败不阻断后续写', async () => {
    let calls = 0;
    const writer = new SerialFileWriter();
    const failing = writer.enqueue(async () => {
      calls += 1;
      throw new Error('boom');
    });
    const ok = writer.enqueue(async () => {
      calls += 1;
    });
    await expect(failing).rejects.toThrow('boom');
    await ok;
    expect(calls).toBe(2);
  });
});

describe('FileRegistryStore', () => {
  it('损坏快照：记录错误并以空注册表启动（不抛、不静默）', async () => {
    const errorMessages: string[] = [];
    const logger = { ...silentLogger, error: (msg: string) => errorMessages.push(msg) };
    const file = path.join(dir, 'agents.json');
    fs.writeFileSync(file, 'corrupt');
    const store = new FileRegistryStore(file, logger);
    expect(await store.load()).toBe(null);
    expect(errorMessages.some((msg) => msg === 'registryStore.loadFailed')).toBe(true);
  });

  it('结构不合法的快照同样降级', async () => {
    const file = path.join(dir, 'agents.json');
    fs.writeFileSync(file, JSON.stringify({ wrong: true }));
    expect(await new FileRegistryStore(file, silentLogger).load()).toBe(null);
  });

  it('合法快照往返', async () => {
    const file = path.join(dir, 'agents.json');
    const store = new FileRegistryStore(file, silentLogger);
    store.save({
      version: 1,
      agents: {
        u1: {
          uuid: 'u1',
          name: 'a',
          cwd: '/c',
          sessionId: 's',
          firstSeen: 1,
          lastSeen: 2,
          reportCount: 3,
          protocolVersion: '1',
          latest: {},
          history: [],
        },
      },
    });
    expect((await store.load())?.agents['u1']?.reportCount).toBe(3);
  });
});

describe('FileIdentityStore', () => {
  it('损坏身份文件：记录错误并返回 null（将请求新 uuid）', async () => {
    const errorMessages: string[] = [];
    const logger = { ...silentLogger, error: (msg: string) => errorMessages.push(msg) };
    const file = path.join(dir, 'identity.json');
    fs.writeFileSync(file, JSON.stringify({ garbage: true }));
    const store = new FileIdentityStore(file, logger);
    expect(await store.load()).toBe(null);
    expect(errorMessages.some((msg) => msg === 'identityStore.loadFailed')).toBe(true);
  });

  it('save 失败返回结构化错误（不抛）', async () => {
    // 父路径是一个已存在的普通文件：mkdir/rename 失败
    fs.writeFileSync(path.join(dir, 'file'), 'x');
    const store = new FileIdentityStore(path.join(dir, 'file', 'identity.json'), silentLogger);
    const result = await store.save({
      uuid: '12345678-1234-1234-1234-123456789012',
      assignedAt: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.length).toBeGreaterThan(0);
    }
  });
});
