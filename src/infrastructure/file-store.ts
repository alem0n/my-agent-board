/**
 * 文件持久化实现：原子写与身份文件（infrastructure 层）。
 *
 * 职责契约：
 * - IdentityStore 端口的 client 侧实现（全部异步 IO，禁止阻塞 pi 主线程）。
 * - 并发写入策略（docs/DESIGN.md §8）：身份文件 tmp + rename 原子写；
 *   同一文件的写经 SerialFileWriter 串行化。
 * - 上报缓冲纯内存（监控状态持续刷新，失败即丢弃，无需落盘）。
 * - server 侧注册表存储（同步）在 registry-file-store.ts，按进程职责分离。
 * - 外部错误转译为可读日志/结果，不静默。
 */
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { PersistedIdentity } from '../domain/identity.js';
import type { IdentityStore } from '../domain/ports.js';
import type { BoardLogger } from '../domain/logging.js';

const TMP_SUFFIX = '.tmp';

/**
 * 串行写队列：同一文件的多个异步写串行化，保证顺序与一致性，且从不阻塞事件循环。
 * 失败不阻断后续写（错误冒泡到调用方，链保持存活）。
 */
export class SerialFileWriter {
  private tail: Promise<void> = Promise.resolve();

  enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.tail.then(task, task);
    this.tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** 等待全部排队写完成（关闭路径调用）。 */
  flush(): Promise<void> {
    return this.tail;
  }
}

/** 异步原子写 JSON（client 侧使用）：tmp + rename，不阻塞事件循环。 */
export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  const directory = path.dirname(filePath);
  await fsp.mkdir(directory, { recursive: true });
  const tmp = `${filePath}${TMP_SUFFIX}`;
  await fsp.writeFile(tmp, `${JSON.stringify(value)}\n`, 'utf8');
  await fsp.rename(tmp, filePath);
}

/** 异步读取 JSON；文件缺失返回 null（ENOENT），其他错误抛出。 */
export async function readJsonFileAsync(filePath: string): Promise<unknown | null> {
  let content: string;
  try {
    content = await fsp.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
  return JSON.parse(content) as unknown;
}

/** FileIdentityStore：client uuid 持久化。save 异步串行，失败返回结构化结果（不抛、不阻塞）。 */
export class FileIdentityStore implements IdentityStore {
  private readonly filePath: string;
  private readonly logger: BoardLogger;
  private readonly writer = new SerialFileWriter();

  constructor(filePath: string, logger: BoardLogger) {
    this.filePath = filePath;
    this.logger = logger;
  }

  async load(): Promise<PersistedIdentity | null> {
    try {
      const parsed = await readJsonFileAsync(this.filePath);
      if (parsed === null) {
        return null;
      }
      const identity = parsed as PersistedIdentity;
      if (
        typeof identity !== 'object' ||
        identity === null ||
        typeof identity['uuid'] !== 'string' ||
        typeof identity['assignedAt'] !== 'number'
      ) {
        this.logger.error('identityStore.loadFailed', {
          path: this.filePath,
          reason: 'invalid identity file',
          action: 'will request a new uuid',
        });
        return null;
      }
      return identity;
    } catch (error) {
      this.logger.error('identityStore.loadFailed', {
        path: this.filePath,
        error: String(error),
        action: 'will request a new uuid',
      });
      return null;
    }
  }

  async save(identity: PersistedIdentity): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      await this.writer.enqueue(() => writeJsonFile(this.filePath, identity));
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  }

  /** 等待排队写落盘（关闭路径调用）。 */
  flush(): Promise<void> {
    return this.writer.flush();
  }
}
