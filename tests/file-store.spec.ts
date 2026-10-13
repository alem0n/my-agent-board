/**
 * client 侧文件持久化测试：异步原子写与降级。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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
