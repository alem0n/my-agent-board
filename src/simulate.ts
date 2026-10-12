/**
 * 模拟 client 入口点（演示与手动验证用）。
 *
 * 职责契约：组合层。驱动真实 client 库（Reporter / HttpTransport / 身份），
 * 注入 SimulatedStateSource / SimulatedEnvironment，回放全部 42 个状态，并打印
 * server 端可观察结果（agent 列表 / 历史 / 身份）。
 *
 * 运行：pnpm tsx src/simulate.ts --url http://127.0.0.1:7878 --agent-dir ./.demo-client
 */
import * as path from 'node:path';
import * as process from 'node:process';
import { boardLogger as logger } from './logger.js';
import { loadClientConfig, resolveConfigPath } from './infrastructure/client-config-loader.js';
import { HttpTransport } from './infrastructure/http-client.js';
import { FileIdentityStore } from './infrastructure/file-store.js';
import {
  SimulatedEnvironment,
  SimulatedStateSource,
  checkSimulationCoverage,
  runAgentSimulation,
} from './infrastructure/simulator.js';
import { Reporter } from './services/reporter.js';
import { STATE_REGISTRY } from './domain/contracts.js';

function parseArgs(argv: readonly string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (const arg of argv.slice(2)) {
    const match = /^--([a-z-]+)=(.*)$/.exec(arg);
    if (match !== null) {
      args[match[1] ?? ''] = match[2] ?? '';
    }
  }
  return args;
}

export async function main(): Promise<number> {
  const args = parseArgs(process.argv);
  const urlOverride = args['url'];
  const agentDir = args['agent-dir'] ?? path.resolve('.demo-client');
  const configPath = args['config'] !== undefined ? resolveConfigPath(args['config']) : undefined;

  const config = await loadClientConfig({
    ...(configPath === undefined ? {} : { filePath: configPath }),
    logger,
  });
  const serverUrl = urlOverride ?? config.serverUrl;

  const identityStore = new FileIdentityStore(
    path.join(agentDir, 'agent-board-identity.json'),
    logger,
  );
  const transport = new HttpTransport({
    serverUrl,
    requestTimeoutMs: config.requestTimeoutMs,
    logger,
  });

  const source = new SimulatedStateSource();
  const env = new SimulatedEnvironment({ cwd: process.cwd() });

  const reporter = new Reporter({
    source,
    env,
    transport,
    identityStore,
    config: { ...config, serverUrl },
    logger,
  });

  logger.info('simulate.starting', {
    serverUrl,
    configPath: configPath ?? resolveConfigPath(),
    agentDir,
    registeredStates: STATE_REGISTRY.size,
  });

  reporter.start();
  const emitted = runAgentSimulation({ source, env });
  await reporter.collectSnapshotAndFlush();
  const stats = reporter.getStats();
  await reporter.stop();

  const coverage = checkSimulationCoverage(emitted);
  logger.info('simulate.done', {
    emittedEvents: emitted.length,
    collected: stats.collected,
    sent: stats.sent,
    droppedRejected: stats.droppedRejected,
    dropped: stats.dropped,
    identity: reporter.currentIdentity?.uuid,
    snapshotStates: STATE_REGISTRY.size,
    ...(coverage.missing.length === 0 ? {} : { missingEvents: coverage.missing }),
  });

  // 展示 server 端可观察结果：agent 列表与历史。
  const agentsResponse = await fetch(`${serverUrl}/v1/agents`);
  const agents = (await agentsResponse.json()) as { agents: Array<Record<string, unknown>> };
  const uuid = reporter.currentIdentity?.uuid;
  for (const agent of agents.agents) {
    logger.info('simulate.serverAgent', { agent });
  }
  if (uuid !== undefined) {
    const historyResponse = await fetch(`${serverUrl}/v1/agents/${uuid}/history?limit=5`);
    const history = (await historyResponse.json()) as Record<string, unknown>;
    const entries = (history['entries'] as Array<Record<string, unknown>> | undefined) ?? [];
    logger.info('simulate.serverHistorySample', {
      uuid,
      truncated: history['truncated'] ?? false,
      entries: entries.map((entry) => ({
        kind: entry['kind'],
        state: entry['state'],
        timestamp: entry['timestamp'],
      })),
    });
  }

  return stats.droppedRejected === 0 && coverage.missing.length === 0 ? 0 : 1;
}

if (!process.env['VITEST'] && process.env.NODE_ENV !== 'test') {
  void main().then((code) => {
    process.exit(code);
  });
}
