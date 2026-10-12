/**
 * infrastructure 层：外部交互实现。
 *
 * 高内聚低耦合契约：
 * - 封装 HTTP / 文件系统等外部依赖，对 services 层提供端口实现（依赖倒置）。
 * - 将外部错误转译为领域错误。禁止原始库错误泄漏到上层。
 *
 * - http-server.ts：server 端 HTTP 端点。
 * - http-client.ts：client 端 HTTP 传输。
 * - file-store.ts：client 侧文件持久化（身份文件，全部异步）。
 * - registry-file-store.ts：server 侧注册表持久化（同步，独立进程权衡）。
 * - client-config-loader.ts：client 配置文件读取。
 * - simulator.ts：测试与演示用 pi 环境模拟器。
 * - pi-extension.ts：pi 扩展胶水（真实 ExtensionAPI 适配）。
 */
export { BoardHttpServer } from './http-server.js';
export type { BoardServerOptions } from './http-server.js';
export { HttpTransport } from './http-client.js';
export type { HttpTransportOptions } from './http-client.js';
export {
  FileIdentityStore,
  writeJsonFile,
  readJsonFileAsync,
  SerialFileWriter,
} from './file-store.js';
export { FileRegistryStore, writeJsonAtomic, readJsonFile } from './registry-file-store.js';
export {
  loadClientConfig,
  resolveConfigPath,
  DEFAULT_CONFIG_PATH,
  CONFIG_PATH_ENV,
} from './client-config-loader.js';
export {
  SimulatedStateSource,
  SimulatedEnvironment,
  runAgentSimulation,
  checkSimulationCoverage,
} from './simulator.js';
export { createAgentBoard } from './pi-extension.js';
export type { AgentBoardPaths, AgentBoardComponents } from './pi-extension.js';
