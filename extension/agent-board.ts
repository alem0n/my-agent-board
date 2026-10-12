/**
 * pi 扩展入口：pi agent 状态监控 client。
 *
 * 装载方式（任选其一）：
 *   pi --extension ./extension/agent-board.ts
 *   或加入 ~/.pi/agent/settings.json 的 extensions 列表："+./extension/agent-board.ts"
 *
 * factory 为 async：配置文件异步读取（不阻塞 pi 启动主线程，期间不启动定时器/进程）。
 * 组件实现在 src/infrastructure/pi-extension.ts（便于在 src 树内做类型检查与门禁）。
 * jiti 会将此相对导入解析到 TypeScript 源码。
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createAgentBoard } from '../src/infrastructure/pi-extension.js';

export default async function agentBoardExtension(pi: ExtensionAPI): Promise<void> {
  await createAgentBoard(pi);
}
