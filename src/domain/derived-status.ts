/**
 * 派生态类型（docs/BOARD.md A1-A4）：纯类型模块。
 *
 * 职责契约：
 * - 只包含派生状态的结构类型，无运行时值、无外部依赖、无导入。
 * - 独立模块以打破 derivation.ts ↔ registry-model.ts 的类型环：
 *   derived-status ← registry-model ← derivation。
 * - 派生的计算逻辑在 derivation.ts；注册表模型在 registry-model.ts。
 */

/** 运行相位（A1）。优先级：离线 > 等待输入 > 等待人工 > 工具执行 > 压缩 > 流式 > 活动 > 空闲。
 *  等待输入/等待人工同为 UI 提示阻塞，按用户操作形态拆分（键入 vs 选择/确认）。 */
export type AgentPhase =
  | 'offline'
  | 'awaiting-input'
  | 'waiting-human'
  | 'tool'
  | 'compacting'
  | 'streaming'
  | 'active'
  | 'idle';

/** 健康级别（A3）。unknown = 离线且无错误信号，不评级。 */
export type HealthLevel = 'good' | 'watch' | 'attention' | 'unknown';

/** 注意项（A2）：severity 决定它在看板中的排队位置。 */
export interface AttentionItem {
  severity: 'error' | 'warn';
  /** 机器可读信号标识（稳定 key，供过滤/断言）。 */
  signal: string;
  /** 人类可读原因（中文）。 */
  detail: string;
}

export interface DerivedHealth {
  level: HealthLevel;
  attention: AttentionItem[];
}

/** 最近一次 run 摘要（A4，进度标记）。 */
export interface RunSummary {
  /** run 是否仍在进行（无收尾事件）。 */
  running: boolean;
  startedAt: number | null;
  endedAt: number | null;
  durationMs: number | null;
  outcome: 'completed' | 'aborted' | 'error' | null;
  turns: number;
  toolCalls: number;
  totalTokens: number;
}

export interface DerivedStatus {
  phase: AgentPhase;
  health: DerivedHealth;
  run: RunSummary;
}

/** deriveAgentStatus 的输入选项。 */
export interface DeriveOptions {
  now: number;
  online: boolean;
  /** 信号统计窗口（毫秒），默认 5 分钟。 */
  windowMs?: number;
  /** 流式相位无进展的卡死阈值（毫秒），默认 120s（message_update 合并窗口为 1s）。 */
  stuckStreamingMs?: number;
  /** 工具/压缩相位无进展的卡死阈值（毫秒），默认 300s（工具可长时间无部分输出）。 */
  stuckBusyMs?: number;
}
