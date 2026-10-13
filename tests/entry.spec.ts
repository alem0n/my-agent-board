/**
 * server 入口与公共导出面测试。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { main } from '../src/index.js';
import { logger as rootLogger } from '../src/logger.js';
import * as servicesIndex from '../src/services/index.js';
import * as infraIndex from '../src/infrastructure/index.js';
import * as domainIndex from '../src/domain/index.js';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.listen(0, '127.0.0.1', () => {
      const address = socket.address();
      socket.close(() => {
        if (address && typeof address === 'object') {
          resolve(address.port);
        } else {
          reject(new Error('no port'));
        }
      });
    });
  });
}

describe('server 入口 main()', () => {
  it('启动 server、响应 SIGINT 优雅关闭（注册表不落盘）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-entry-'));
    const port = await freePort();
    const argv = process.argv;
    process.argv = [
      'node',
      'src/index.ts',
      `--port=${port}`,
      '--host=127.0.0.1',
      '--log-level=warn',
    ];

    const running = main();
    // 轮询健康端点（启动时间受机器/插桩负载影响，固定等待会时序脆弱）
    let healthy = false;
    for (let attempt = 0; attempt < 100 && !healthy; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      healthy = await fetch(`http://127.0.0.1:${port}/v1/health`)
        .then((response) => response.ok)
        .catch(() => false);
    }
    expect(healthy).toBe(true);

    // --log-level 接线：显式提供时覆盖环境变量种子值（S1 回归保护）
    expect(rootLogger.level).toBe('warn');

    process.emit('SIGINT');
    const code = await running;
    expect(code).toBe(0);
    process.argv = argv;
    // 恢复默认级别，避免污染同 worker 后续测试
    rootLogger.level = 'info';

    // 注册表纯内存：关闭不落盘（不依赖机器状态：断言 main() 未向任何路径写出 agents.json）
    expect(fs.existsSync(path.join(dir, 'agents.json'))).toBe(false);
  }, 20_000);
});

describe('公共导出面（barrels）', () => {
  it('domain/services/infrastructure 桶导出关键成员', () => {
    expect(domainIndex.STATE_REGISTRY.size).toBe(42);
    expect(typeof domainIndex.parseClientConfig).toBe('function');
    expect(typeof domainIndex.validateEnvelope).toBe('function');
    expect(typeof domainIndex.resolveIdentity).toBe('function');
    expect(typeof servicesIndex.Reporter).toBe('function');
    expect(typeof servicesIndex.AgentRegistry).toBe('function');
    expect(servicesIndex.EVENT_STATES).toHaveLength(41);
    expect(typeof infraIndex.BoardHttpServer).toBe('function');
    expect(typeof infraIndex.HttpTransport).toBe('function');
    expect(typeof infraIndex.SimulatedStateSource).toBe('function');
    expect(typeof infraIndex.createAgentBoard).toBe('function');
  });
});
