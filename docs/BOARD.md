# BOARD — 看板派生层设计（my-agent-board）

> 看板展示层的设计依据：派生态计算、健康度标记、注意队列与实施路线。
> 采集层契约与协议见 [DESIGN.md](./DESIGN.md)；需求清单见 [SPEC.md](./SPEC.md)（REQ-014）；
> 运行与测试见 [RUNBOOK.md](./RUNBOOK.md)。
> 状态：**P0-P3 全部实施完成**（A1-A4 派生 + C1-C4 展示 + B1-B5 采集）。新增状态仍不进入注册表（REQ-013 保持 42 项）：B5 传输健康并入 `agent_snapshot` 契约（v1.1.0）。

## 1. 目标

展板必须让用户在数秒内回答三个问题：

1. 这个 agent **现在在做什么**（运行相位）。
2. 哪个 agent **需要我去处理**（注意队列）。
3. agent **运行是否良好**（健康度标记）。

当前实现只回答了"进程是否在线"（`online`），其余判断需要用户从原始事件名（如
`message_update`、`tool_execution_end`）自行反推。这与 5 秒规则所批评的"数据装饰"一致：
把采集项直接当展示项，而非决策所需的信息。

## 2. 调研基准

外部最佳实践（NOC/运维看板 + AI agent 可观测性）归纳为五条：

| 原则 | 内容 |
|---|---|
| 5 秒规则 | 用户应在 5 秒内看懂全局状态，否则看板只是数据装饰 |
| 异常优先 | 只突出需要关注的数据，不平铺全部指标 |
| 分级标记 + 明确阈值 | 每档标记须有具体数字门槛与对应的行动语义 |
| Agent 核心指标 | token 用量与成本、延迟、错误率、工具调用、决策序列 |
| 卡死检测 | 任务级超时 + **进度标记而非仅状态** + 重试计数 |

来源：

- 5 秒规则：<https://www.influxdata.com/blog/5-dashboard-design-best-practices/>、<https://www.domo.com/learn/article/top-10-dashboard-design-mistakes-and-what-to-do-about-them>
- 异常优先：<https://www.prosense.com.au/post/creating-effective-dashboards-using-exception-based-design-and-trend-analysis>
- 分级阈值：<https://www.clearpointstrategy.com/blog/establish-rag-statuses-for-kpis>、<https://www.accelo.com/glossary/rag-reporting-status>
- Agent 指标：<https://mlflow.org/articles/what-is-llm-observability-a-guide-for-ai-ops-teams>、<https://blog.sentry.io/ai-agent-observability-developers-guide-to-agent-monitoring/>、<https://www.groundcover.com/learn/observability/ai-agent-observability>
- 卡死检测：<https://www.agentcenter.cloud/blogs/how-to-detect-agent-stuck-or-looping>

本项目为符号化看板（见第 5 节），因此第 3 条取其**阈值与行动语义**思想，弃用其颜色表示。

## 3. 现状评估（三层模型）

| 层 | 现状 | 判断 |
|---|---|---|
| 采集层（client） | 42 项状态全覆盖（41 事件 + `agent_snapshot`），隐私化（仅长度/计数/键名/枚举/状态码） | 完整 |
| 派生层（server） | 仅 1 个派生态：`online`（60s 窗口） | **不足** |
| 展示层（Web UI） | agent 列表（在线符号、最后事件名、计数）+ 详情页两张原始 payload 表 | **不足** |

结论：**采集层完整，派生层与展示层不足**。缺口主要不在采集，而在把现有元数据聚合成
决策信息。P0 全部工作都在派生层与展示层，不触碰采集层契约。

## 4. 缺口分析

### 4.1 派生层缺口（不改动采集即可派生）

#### A1 运行相位

`lastState` 只是最后一条事件名，不能表达当前活动相位。现有数据足以派生：

| 相位 | 派生条件（现有数据） |
|---|---|
| 流式输出中 | `message_start`(assistant) 之后有 `message_update`、尚无 `message_end` |
| 工具执行中 | `tool_execution_start` 尚无配对的 `tool_execution_end` |
| 等待输入 | `ui_prompt_start` 尚无配对的 `ui_prompt_end`，且 kind ∈ {input, editor, custom}（用户需键入内容） |
| 等待人工 | 同上，且 kind ∈ {select, confirm}（用户选择/确认）；kind 缺失/未知时保守归此类 |
| 压缩中 | `session_before_compact` 之后尚无 `session_compact`/`session_compact_failed` |
| 空闲 | `agent_snapshot.isIdle` |
| 离线 | `!online`（REQ-013） |

配对按 `toolCallId`（工具）与事件先后（UI 提示）在 server 端历史内匹配。
`ui_prompt_*` 与 `tool_execution_*` 均为 `event` 频率（无合并窗口），配对可靠。
UI 提示未闭合即阻塞在用户响应上，是注意队列的第一来源。按用户操作形态拆成两个相位：键入型（input/editor/custom）为“等待输入”，选择/确认型（select/confirm）为“等待人工”——看板一眼区分“需要你打字”与“只需你点选”。

#### A2 注意队列（回答"哪个 agent 该我去管"）

按紧急度排序的注意信号，全部可从现有 42 项派生：

| 信号 | 派生条件 | 含义 |
|---|---|---|
| 阻塞等待人工 | A1 的等待人工/等待输入相位 + 已等待时长 | 最直接的“去处理”信号 |
| run 异常终止 | `agent_before_settle.outcome ∈ {error, aborted}`；或 `message_end.stopReason ∈ {error, aborted}` | 需检查或重试 |
| provider 不可用 | `after_provider_response.status ≥ 400`（429 限流 / 401-403 鉴权 / 5xx 服务端） | 需换模型或等待恢复 |
| 压缩失败 | `session_compact_failed`（含 errorMessage） | 上下文压力未释放 |
| 工具错误率 | 窗口内 `tool_result`/`tool_execution_end` 的 `isError` 占比超过阈值 | 工具或环境可能已损坏 |
| 疑似卡死 | 长时间无 `agent_settled` 且非空闲；或 `turnIndex` 停滞 | 对应"进度标记"卡死检测 |
| 离线且未 shutdown | `!online` 且历史中无 `session_shutdown` | 崩溃疑似，需排查 |
| 上下文压力 | `contextUsage.percent` 高 + 压缩频繁 | 即将自动压缩或溢出 |

具体阈值在实施时按测试数据标定，初值见第 5 节与第 6 节。

#### A3 健康度标记（符号体系）

见第 5 节。这是对 `online` 二值在线态的补位：在线 ≠ 健康。

#### A4 进度与工作量指标（progress markers）

历史中已有全部原料，缺的是聚合：

- 本 run 轮次数（`turn_start` 计数）、工具调用数、累计 token（`message_end.usage` 累加 + `tool_execution_end.usageTotalTokens`）。
- run 时长（`before_agent_start` 到 `agent_end`/`agent_settled` 的信封时间戳差）、轮时长（`turn_start` 到 `turn_end`）。
- 最近一次 run 摘要：outcome + 轮数 + 工具调用数 + 耗时 + token。作为详情页第一眼信息。

### 4.2 采集层缺口（pi 事件本提供、当前契约未取）

量小但价值高的字段。每个都需契约 MINOR 升级（新增可选字段）：

| # | 缺口 | 依据 | 影响 |
|---|---|---|---|
| B1 | `tool_execution_end` 缺 `durationMs` | pi 事件原生提供（`ToolExecutionEndEvent.durationMs`），mapper 未取 | 无法做工具延迟分析与慢工具定位 |
| B2 | `message_end.usage` 缺 `cost` | pi 已算好费用，mapper 只取 5 个 token 字段 | 无法展示成本（AgentOps 核心指标） |
| B3 | `message_end` 缺 `responseModel` | pi 事件字段 | 虚拟模型路由时实际响应模型与请求不同，排障价值高 |
| B4 | `before_agent_start` 缺 `messageType` | pi 区分 `"user"`/`"custom"` | 无法区分 run 由谁触发（用户 vs 扩展自定义消息） |
| B5 | client 传输健康未上报 | 缓冲超限丢弃、重试耗尽、不可达时段只写 client 本地日志（默认关闭，REQ-012） | **展板可信度风险**：agent 看着健康可能只是因为上报被丢 |

B5 最隐蔽：监控自身的数据链路无监控。建议把传输统计周期性并入 `agent_snapshot`
（或新增状态），使展板能标注"数据可能不完整"。

### 4.3 展示层缺口

| # | 缺口 | 对应目标 |
|---|---|---|
| C1 | 顶部 KPI 条：`! 需处理 N / ◐ 观察 M / ● 良好 K / ✗ 离线 L`（在线态另见列表在线列） | 5 秒规则 |
| C2 | 列表默认按关注度排序（现仅按 lastSeen）；健康度筛选与搜索 | 异常优先 |
| C3 | 详情页用事件时间线替代两张原始 JSON 表 | "真实了解运行过程" |
| C4 | 错误率 / token / 轮时长的趋势呈现（history 已有数据） | 健康度趋势判断 |
| C5 | 独立的"需处理"队列视图 | 第 1 节目标 2 |

## 5. 健康度标记（符号体系，不使用颜色）

### 5.1 符号表

沿用项目既有约定：在线状态以 `✓`/`✗` 文本符号表示、不使用颜色圆点
（见 [CHANGELOG.md](../CHANGELOG.md) Unreleased 与 Web UI 实现）。健康度同样用符号：

| 标记 | 级别 | 行动语义 |
|---|---|---|
| `●` | 良好 | 无需介入 |
| `◐` | 观察 | 留意，准备介入 |
| `!` | 需处理 | 立即处理 |
| `—` | 无数据 | 离线或首报未达，不评级 |

### 5.2 判定阈值（初值，实施时按测试数据标定）

| 标记 | 判定条件（现有数据派生） |
|---|---|
| `●` | online + 窗口内 0 错误 + `contextUsage.percent` 低（初值 <60%） |
| `◐` | 任一低危信号：工具错误率 >30%、`status=429`、压缩频繁、等待人工/等待输入、`contextUsage.percent >85%` |
| `!` | `agent_before_settle.outcome=error` / `message_end.stopReason=error` / 单次 5xx 或 401/403 / 长时停滞 |
| `—` | `!online`（复用 REQ-013 判定，不重复评级） |

### 5.3 设计要点

**与实现的取舍对照（P0 交付时记录）：**

- `—`（无数据）仅用于「离线且无错误信号」。离线但带 error 级信号（如 offline-unexpected 疑似崩溃）仍评为 `!`，以承接 A2 的注意信号。
- aborted 类信号（message stopReason aborted、run outcome aborted、压缩被中止）为 `◐` 而非 `!`（常为用户主动中断，非故障）；error 类仍为 `!`。
- provider 5xx/401/403 单次即为 `!`（含瞬时 503，提示人工确认）；429/其他 4xx 为 `◐`。
- 工具错误率需 ≥2 次失败且 >30% 才上榜（避免单次失败噪声）。
- `run-error` 只在最近一次 run 已结算时产生；新 run 进行中（出现更新的 `before_agent_start`）不沿用上一 run 的结局。
- 压缩失败信号只看当前会话（最近 `session_start` 之后）的最近一次压缩事件，成功即解除。

**为何用符号而非颜色：**

- 色盲友好，不依赖颜色感知即可传达级别。
- 本项目 Web UI 零外部资源，几何符号无需图标字体或图片。
- 与既有 `✓`/`✗`（在线态）风格统一。
- 实心→半实心的填充梯度本身即级别语义，单色终端同样可读。

**两条显式约定（避免符号混淆）：**

1. `!` 与 `✗` 分工：离线仍用既有 `✗`（在线列），最差健康级用 `!`（健康列）。避免相近符号（如 `✖`/`✗`）在小字号下混淆。
2. 二维分列：在线态（`✓`/`✗`）与健康度（`●`/`◐`/`!`/`—`）是两个独立列。离线 agent 健康列为 `—`，不把"离线"误读为"需处理"。

**渲染约定：** 符号旁附 `title` 悬停提示（沿用现有 `title="在线"` 做法），提示含级别名与
具体原因（如 `! 需处理 · outcome=error`），使符号与 A2 注意队列的归因对齐。

## 6. 实施路线

| 优先级 | 内容 | 改动范围 | 契约变更 | 状态 |
|---|---|---|---|---|
| P0 | A1 相位 + A2 注意队列 + A3 健康度 + A4 run 摘要 + C1 KPI 条 + C2 排序 | server 派生 + Web UI | 无 | **已交付** |
| P1 | B1 durationMs、B2 cost、B4 messageType | 契约加法式 MINOR（3 个状态 v1.0.0→v1.1.0） | 是（加法式，向后兼容） | **已交付** |
| P2 | C3 事件时间线、C4 趋势图（消息 token / 工具耗时 / 错误率） | Web UI | 无 | **已交付** |
| P3 | B5 传输健康上报（并入 `agent_snapshot`）、B3 responseModel | 采集 + 契约（`agent_snapshot`/`message_end` v1.1.0） | 是（加法式） | **已交付** |

P0 是投入产出比最高的一步：零契约变更、零隐私影响、直接覆盖第 1 节三个目标。
P1/P3 为加法式 MINOR：新增字段全部可选，旧载荷校验不受影响。
B5 落地为 `agent_snapshot.transport` 而非新增状态，维持 REQ-001 的 42 项注册表数量不变。

## 7. 隐私合规

- 全部派生只用现有元数据（计数、枚举、时间戳、状态码、长度）。
- B1–B4 新增字段同样不含提示词、命令、工具参数与结果内容。
- 因此不违反 REQ-009 与 DESIGN.md §9 的隐私边界，且无需放开任何内容上报开关。

## 8. 与需求清单的映射

- REQ-014（本设计，见 [SPEC.md](./SPEC.md)）：看板派生层与符号化健康度。
- 依赖 REQ-007（`/v1/agents` 与详情响应暴露派生字段）、REQ-013（在线态）。
- P1 的契约升级按 DESIGN.md §3.3 的加法式演进规则执行（新增可选字段 = MINOR）。
