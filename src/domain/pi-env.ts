/**
 * pi agent 环境抽象：client 库与具体 pi 扩展 API 之间的端口。
 *
 * 职责契约：services 层（Reporter）只依赖此抽象，不导入 pi 扩展类型。
 * infrastructure/pi-extension.ts 将真实 ExtensionAPI/ExtensionContext 适配到此接口；
 * infrastructure/simulator.ts 提供用于测试与演示的模拟实现。
 */

/** pi 运行模式（与扩展 ExtensionMode 一致）。 */
export type ExtensionMode = 'tui' | 'rpc' | 'json' | 'print';

/** 上下文用量（与扩展 ContextUsage 一致）。 */
export interface ContextUsageSnapshot {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

/** 当前 pi agent 环境的可采样状态快照（对应 agent_snapshot 契约）。 */
export interface PiEnvironmentSnapshot {
  sessionId: string | undefined;
  sessionName: string | undefined;
  cwd: string;
  mode: ExtensionMode;
  hasUI: boolean;
  isProjectTrusted: boolean;
  isIdle: boolean;
  hasPendingMessages: boolean;
  model: { provider: string; id: string } | undefined;
  thinkingLevel: string | undefined;
  contextUsage: ContextUsageSnapshot | undefined;
  activeTools: string[];
  piVersion: string | undefined;
  /** 扩展加载时刻（client 库注入），用于计算 uptimeMs。 */
  startedAt: number;
}

/** 提供环境快照的端口。 */
export interface PiEnvironmentProvider {
  snapshot(): PiEnvironmentSnapshot;
}

/**
 * 事件订阅端口：subscribe(event, handler) 语义与 pi.on() 一致。
 * handler 仅接收事件对象；环境快照通过 PiEnvironmentProvider 获取。
 */
export interface PiStateSource {
  subscribe(event: string, handler: (event: unknown) => void): () => void;
}
