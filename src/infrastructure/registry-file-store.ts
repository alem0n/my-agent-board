/**
 * server 侧注册表文件存储（infrastructure 层）。
 *
 * 职责契约：
 * - RegistryStore 端口实现；同步 IO：server 是独立专用进程，注册表写由去抖合并与
 *   关闭时最终写触发（docs/DESIGN.md §8），短暂阻塞仅影响本进程，且换取简单的
 *   单线程串行语义（无异步交错）。
 * - 与 client 侧存储（file-store.ts，全异步）分模块隔离：client 禁止阻塞 pi 主线程，
 *   server 无此约束（职责与权衡，见设计文档 §10 假设 A11）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RegistrySnapshot, RegistryStore } from '../domain/registry-model.js';
import type { BoardLogger } from '../domain/logging.js';

const TMP_SUFFIX = '.tmp';

/** 原子写 JSON（同步，server 侧）：写临时文件后 rename。失败抛异常。 */
export function writeJsonAtomic(filePath: string, value: unknown): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const tmp = `${filePath}${TMP_SUFFIX}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

/** 读取 JSON 文件（同步，server 侧）；文件缺失返回 null，JSON 损坏抛异常。 */
export function readJsonFile(filePath: string): unknown | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const content = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(content) as unknown;
}

/** FileRegistryStore：{ version, agents } 单文件 JSON，原子写。 */
export class FileRegistryStore implements RegistryStore {
  private readonly filePath: string;
  private readonly logger: BoardLogger;

  constructor(filePath: string, logger: BoardLogger) {
    this.filePath = filePath;
    this.logger = logger;
  }

  load(): RegistrySnapshot | null {
    try {
      const parsed = readJsonFile(this.filePath);
      if (parsed === null) {
        return null;
      }
      const snapshot = parsed as RegistrySnapshot;
      if (
        typeof snapshot !== 'object' ||
        snapshot === null ||
        typeof snapshot['version'] !== 'number' ||
        typeof snapshot['agents'] !== 'object' ||
        snapshot['agents'] === null
      ) {
        throw new Error('registry snapshot has unexpected shape');
      }
      return snapshot;
    } catch (error) {
      // 损坏文件不阻断启动：记录错误并以空注册表启动（保守丢弃，明确日志）。
      this.logger.error('registryStore.loadFailed', {
        path: this.filePath,
        error: String(error),
        action: 'starting with empty registry',
      });
      return null;
    }
  }

  save(snapshot: RegistrySnapshot): void {
    writeJsonAtomic(this.filePath, snapshot);
  }
}
