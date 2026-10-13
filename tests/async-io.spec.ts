/**
 * client 侧异步 IO 守护测试：client 代码（运行在 pi 交互进程内）不得出现
 * 同步文件系统调用（*Sync），避免阻塞 pi 主线程/TUI 事件循环。
 *
 * 判定方式：静态扫描 client 相关源文件。server 注册表为纯内存、无文件存储。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..');

/** client 侧源文件（在 pi 进程内执行的代码路径）。 */
const CLIENT_SOURCE_FILES = [
  'src/infrastructure/file-store.ts',
  'src/infrastructure/client-config-loader.ts',
  'src/infrastructure/pi-extension.ts',
  'src/infrastructure/http-client.ts',
  'src/services/reporter.ts',
  'src/services/mapper.ts',
  'src/services/retry.ts',
  'src/simulate.ts',
];

describe('client 侧不得使用同步文件 IO（不阻塞 pi 主线程）', () => {
  it('client 源文件中不存在 fs.*Sync( 调用', () => {
    const offenders: Array<{ file: string; line: number; text: string }> = [];
    for (const relative of CLIENT_SOURCE_FILES) {
      const filePath = path.join(ROOT, relative);
      if (!fs.existsSync(filePath)) {
        continue;
      }
      const lines = fs.readFileSync(filePath, 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (/\b(fs|node:fs|fsp)\.\w*Sync\s*\(/.test(line)) {
          offenders.push({ file: relative, line: index + 1, text: line.trim() });
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it('client 存储端口方法在运行时确实返回 Promise（异步契约）', async () => {
    const { FileIdentityStore } = await import('../src/infrastructure/file-store.js');
    const idStore = new FileIdentityStore('/tmp/ab-guard-identity.json', { ...silentLogger });
    const samples = [
      idStore.load(),
      idStore.save({ uuid: '12345678-1234-1234-1234-123456789012', assignedAt: 1 }),
    ];
    for (const sample of samples) {
      expect(sample).toBeInstanceOf(Promise);
      await sample.catch(() => undefined);
    }
  });
});

const silentLogger = {
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
