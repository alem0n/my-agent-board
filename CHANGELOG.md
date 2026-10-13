# Changelog

本项目遵守 [Keep a Changelog](https://keepachangelog.com/en/2.0.0/) 与 [Semantic Versioning](https://semver.org/spec/v2.0.0.html)。

## [Unreleased]

### Added

- **看板派生层 P0（REQ-014，[docs/BOARD.md](docs/BOARD.md)）**：server 端新增纯函数派生 `src/domain/derivation.ts`，从既有 42 项状态元数据（不涉内容字段）派生四类展板信息——**运行相位**（A1：`offline`/`waiting-human`/`tool`/`compacting`/`streaming`/`active`/`idle`，按未闭合的 `ui_prompt_start`/`tool_execution_start`/`message_start`/`session_before_compact` 标记与 `session_start` 边界计算）、**注意队列**（A2：等待人工携带已等时长、run 出错、provider 4xx/5xx 分类、压缩失败/频繁、工具错误率>30%、上下文>85%、疑似卡死、离线无 shutdown 疑似崩溃）、**符号化健康度**（A3：`attention`/`watch`/`good`/`unknown` 四级，展示层映射为 `!`/`◐`/`●`/`—`）、**最近 run 摘要**（A4：outcome、轮数、工具调用数、token、用时）。派生字段随 `/v1/agents` 列表与 `/v1/agents/:uuid` 详情响应暴露（详情新增 `status` 块）。Web UI 同步升级：顶部 KPI 条（需处理/观察/良好/离线计数）、列表新增健康符号与相位列并按关注度排序（需处理→观察→良好→无数据，同档按 lastSeen 倒序）、详情页新增「运行状态」块（相位、健康度+原因清单、run 摘要）。全部为文本符号呈现，无颜色依赖。34 条派生单元测试 + e2e/API 契约断言。
- **文档：看板派生层设计**（[`docs/BOARD.md`](docs/BOARD.md)，REQ-014）：调研看板设计基准（5 秒规则、异常优先、分级标记阈值、Agent 指标、卡死检测）后给出缺口分析——采集层完整、派生层与展示层不足。P0 为 server 派生态（运行相位、注意队列、健康度、run 摘要）+ Web UI（KPI 条、关注度排序），零契约变更、零隐私影响；健康度用文本符号（`●` 良好 / `◐` 观察 / `!` 需处理 / `—` 无数据），沿用在线态 `✓`/`✗` 的既有符号约定，不使用颜色。P1 为契约加法式升级（`tool_execution_end.durationMs`、`message_end.usage.cost`、`before_agent_start.messageType`）；P3 补 client 传输健康上报（缓冲丢弃/重试耗尽当前仅写本地日志，存在“看着健康实为丢包”的可信度风险）。
- **看板 P1：契约加法式 MINOR 升级（BOARD.md P1）**：`tool_execution_end` 新增 `durationMs`（B1：pi 事件原生的单调时钟执行时长，补齐工具延迟可观测）；`message_end` 新增 `responseModel`（B3：虚拟模型路由时实际响应模型）与 `usage.cost`（B2：pi 已算好的分项费用，小数不取整）；`before_agent_start` 新增 `messageType`（B4：区分用户 prompt 与扩展自定义消息发起的 run）。四状态契约 v1.0.0→v1.1.0，字段全部可选，旧载荷校验不受影响。
- **看板 P3：client 传输健康上报（B5）**：`agent_snapshot` 新增 `transport` 对象（缓冲丢弃/毒信剔除/flush 失败累计 + 不可达标记与起始时间），由 Reporter 注入快照（不可达计时随恢复清空）。展板可信度闭环：派生层据此产生 `transport-drop` 注意信号（“运行良好”的结论不再掩盖丢包）。未新增状态，REQ-001 的 42 项注册表不变。
- **看板 P2：详情页事件时间线 + 趋势（C3/C4）**：历史区由两张原始 JSON 表改为事件时间线（时钟时间 + 中文状态标签 + 摘要字段 role/toolName/isError/status/stopReason/outcome/reason/durationMs，全量 payload 悬停查看，最新在上）与三条内联 SVG 迷你趋势线（消息 token / 工具耗时 ms / 分桶错误率，零外部资源、单色线条）。趋势数据全部来自既有 `/history` 端点，无新增 API。
- **Web UI 治理与展示**：在线状态以 `✓`/`✗` 文本符号表示（不使用颜色圆点）；详情面板新增「删除该 agent」按钮——确认后调 `DELETE /v1/agents/:uuid`（latest 与历史一并删除；提示存活进程会重建记录），删除后清除选中并刷新。
- **server 新增进程级在线检测（REQ-013）**：`POST /v1/heartbeat` 端点（`{uuid}` → 更新 `lastHeartbeat`，记录不存在返回 404、不创建/不复活记录）；client 扩展**加载时**启动心跳定时器（`heartbeatIntervalMs` 默认 20s，`0` = 关闭；与 session 生命周期解耦，覆盖无活跃会话的静默期；定时器 `unref()` 不阻止 pi 退出；失败不进重试队列）；`/v1/agents` 列表与 `GET /v1/agents/:uuid` 新增派生字段 `online`（`now - max(lastSeen, lastHeartbeat) ≤ 60s`）与 `lastHeartbeat`；Web UI 列表与详情显示在线状态圆点。
- pi agent 状态监控系统：client 为 pi 扩展（`extension/agent-board.ts`），采集全部 42 项受支持状态（41 个扩展事件 + 周期 agent_snapshot）按契约上报；server 聚合存储并提供查询 API。
- client/server 分离部署：`pnpm pack:client` 生成自包含 client 产物（build/client，零运行时依赖、pi 清单）；模块闭包经 dependency-cruiser 双向规则与 `tests/separation.spec.ts` 机器校验，协议（版本号+错误码+契约）为两侧唯一耦合。
- 移除离线 outbox 持久化：上报缓冲改为纯内存，重试耗尽/缓冲超限/关闭残留一律丢弃并计数。监控状态持续刷新，旧状态价值快速衰减，离线持久化无收益（JSONL-CHANGE）。
- git 分发设计：单开发仓 + 双 orphan 分支（client/server），由 `pnpm split:client` / `pnpm split:server` 从产物 force 重建（gh-pages 模式）。用户按需克隆单个分支，互不含对方代码；server 产物新增 `pnpm pack:server`（编译闭包 + pino 依赖声明）。
- 文档：client 三条安装路径与取舍（官方 URL `pi install https://github.com/alem0n/my-agent-board` / client 分支精简克隆 / 源码开发），记录 pi URL 安装只支持默认分支的实测结论；README.server.md 补 Web UI 用法、npm `--` 参数透传与端口占用处理说明：同端口挂载 `GET /` 与 `/ui`，单页应用渲染 agent 列表/逐状态最新载荷/历史筛选，自动刷新 3s，零外部资源。默认 404，用户可自行可视化（直接消费 /v1/* JSON API）。
- client 侧全异步 IO（日志/身份/配置均经 `fs/promises` + 串行写队列），不阻塞 pi 主线程；静态守护测试 `tests/async-io.spec.ts` 防止同步调用回潮。
- 状态注册表与逐状态契约（`src/domain/contracts.ts`），信封协议版本 `1`，加法式契约演进。
- agent 身份方案：name 缺失回退 session id；uuid 为请求级信任字段（client 携带即信任，未携带由 server 为请求分配）；身份文件持久化与降级；孤儿条目由 DELETE 治理。
- client 传输可靠性：指数退避重试、断线健康探测恢复、内存缓冲（不落盘；关闭时尽力排空）。
- server 端点：`/v1/report`、`/v1/report/batch`、`/v1/agents[/:uuid[/history]]`、`/v1/health`、`DELETE /v1/agents/:uuid`；注册表纯内存。
- 一键本地演示 `pnpm demo`（`scripts/demo.sh`）；`make check` 全绿（lint + typecheck + format + 覆盖率 + audit）。
- server 新增 `DELETE /v1/agents/:uuid`：删除 agent 条目（latest + 历史一并删除），不存在返回 404。治理操作**请求即授权**，server 不做本地鉴权研判。

### Changed

- **看板 P1-P3 审查修复（reviewer 独立审查后）**：`Reporter.start()` 承 stop→start 重启时未重置新增的 `unreachableSince`（上轮不可达成时间会泄漏到新会话快照）；`buildSnapshotPayload` 对 `unreachableSince` 做与计数器一致的钳制；`message_end` 的 cost 输出放宽——usage 仅含合法 cost 时也输出 `usage:{cost}`（此前注释与实现不一致，token 字段全非法时静默丢弃合法 cost）；派生层 `transport-drop` 信号文档化其“累计阈值”语义。
- **测试缺口补齐**：`tool_execution_end.durationMs` 的 mapper 降级断言（缺省/非数字/负值/取整）；Reporter 的 B5 接线测试（失败计数与不可达状态经 `agent_snapshot.transport` 快照携带至 server，含门控睡眠快照冻结）；嵌套对象未知键拒绝（`usage.cost.*`、`transport.*`）。
- **看板派生层审查修复（reviewer 独立审查后）**：热路径 O(N²)——`deriveAttention` 的 run 结局循环在条件中重复调用 O(N) 的 `aliveStart`（空闲 agent 为最常见且最坏情形，N=1000 时每次派生约 10⁶ 次比较）——提升为单次求值；`run-error`/`run-aborted` 信号扫描与新 run 边界对齐（新 run 进行中不沿用上一 run 的结局）；压缩失败信号限定当前会话（成功即解除，不再跨会话残留）；`run.totalTokens` 计入 `tool_execution_end.usageTotalTokens`（原仅计消息用量，低估）；详情页健康符号悬停提示修正（此前恒显示“无派生数据”）；非法百分编码 uuid 路径返回 404（原 500）；UI 排序函数防御原型键击穿。
- **测试夹具时间戳改为实时时钟**：`buildEnvelope` 默认 timestamp 由固定历史值改为 `Date.now()`——server 校验以真实时钟为准（±60s/7 天窗口），固定值导致 e2e 契约测试存在约 6 天的“保质期”（运行日期超过后全量失败）；contracts.spec 的 NOW 同步对齐。
- **`GET /v1/agents/:uuid` 响应不再内嵌 `history`**：详情端点此前返回完整注册记录（含至多 1000 条历史），与 `/v1/agents/:uuid/history` 端点职责重叠，Web UI 每 3s 轮询会重复传输全量历史。现在详情只返回注册记录字段 + `latest` + 派生 `online`，历史一律走 `/history` 端点。响应缩小、语义与文档表一致。
- **修复 `--log-level` 为死配置**：此前 `loadServerConfig()` 解析并校验了 `--log-level`，但无任何消费方——`src/logger.ts` 的 pino 实例只在模块导入时读 `process.env.LOG_LEVEL`，CLI 命令完全无效（与 README/RUNBOOK 宣传矛盾）。现在 `src/index.ts` 在显式提供 `--log-level` 时调用新增的 `configureLogging()` 生效（环境变量仍为未提供时的种子值），启动日志记录实际生效级别。
- **非法 CLI 参数不再静默回退**：`--port/--host/--log-level/--web` 非法值此前静默回落默认（文档却承诺"记录日志"）。现在 `loadServerConfig()` 生成 `warnings`（回退原因串），入口记 `server.configFallback` warn 日志，并暴露 `logLevelProvided` 供入口决定是否覆盖环境变量。
- **`POST /v1/report/batch` 简化**：移除恒为 false 的死代码（`assigned = assigned || ingest.assigned`，stamp 后信封均携带 uuid）；空批量不再无谓生成 uuid。
- **HTTP 请求处理增加 reject 兜底**：`handleRequest` 的 reject（如客户端断连后写已销毁响应）此前成为 unhandled rejection（Node 默认终止进程）。现在请求回调带 `.catch` + 防御性 `writeJsonSafe`（写入失败仅记日志），入口 `main()` 同样以结构化日志 + 退出码 1 处理启动失败。
- **路由判定重构**：agent 动态路由（`/v1/agents/:uuid` 与 `/:uuid/history`）由四段同族正则收敛为单次匹配；静态路径走 `STATIC_ROUTES` 方法允许表（Map 实现，避免 path 命中 Object.prototype 属性名如 `/constructor` 时取到继承值而退化为 500）。405/404 行为不变（测试覆盖 DELETE-on-history、非法方法、原型链路径名等）。
- **`AgentSummary.lastState` 改为增量记录**：原每次 `/v1/agents` 调用对每个 agent 倒序扫描全量 history（O(agents×historyLimit)），现 ingest 时增量写入 `lastState`，环形截断后仍正确。
- **`GET /v1/health` 的 uptimeMs 跟随注入的 `now`**（可测试性一致性，供测试控制运行时长）。

- **uuid 信任模型改为「请求即信任来源」**：server 不再做身份研判——client 请求携带的 uuid 直接被信任（记录不存在则按该 uuid 建立），无 sticky 匹配、无「未知 uuid 改分配」（`replaced` 字段从响应中移除）；无 uuid 的请求由 server 分配（批量请求共用首个 uuid，`assigned` 为请求级）。孤儿/重复条目改由 DELETE 显式治理。client 对异步加载身份完成前入队的信封在发送时补盖 uuid。
- **server 注册表改为纯内存**（REQ-008）：不写盘、无 `--data-dir`、无 `agents.json`，重启即清空。移除 `FileRegistryStore` 与去抖写队列 / 启动加载 / 关闭最终写。动机：监控状态持续刷新，服务端状态无离线保留价值，且消除文件 IO 与损坏面。
- **client 默认零日志**（REQ-012）：未显式配置前不创建 `agent-board-client.log`、不产生任何日志 IO。开启方式为配置文件 `"logLevel": "info"`（取值 silent/trace/debug/info/warn/error），或环境变量 `AGENT_BOARD_LOG_LEVEL`（优先级更高，配置文件损坏时的诊断入口）。配置文件级 issues 改为解析后在级别确定时补输出（不再无条件在解析期打印）。
- 《SPEC.md》需求清单由模板占位改为监控系统需求（REQ-001…REQ-012）。

### Fixed

- 修复 client 关闭排空死代码：`stop()` 先置 `running=false`，而 `flushCycle` 入口守卫即 `!this.running`，关闭路径从未尝试发送——`session_shutdown` 后缓冲（哪怕 server 可达）一律直接丢弃。现在关闭路径先等待进行中的 flush 退出，再对剩余缓冲每批单次尝试发送（整体限时 3s，不随 retry 配置重试），超时或不可达时才丢弃并计数（`report.shutdownDropped`）；`session_shutdown` 处理器改为 `await reporter.stop()`；关闭同时唤醒断线恢复探测的退避睡眠（可取消真实定时器），进程退出不再可能挂起最长一个退避周期（默认至 30s）。
- 修复提交钩子：`.githooks/*` 统一 LF 行尾（CRLF 使 `^M` 进入命令名，钩子在非 Windows 环境失效）；`pre-commit` 的 `make precommit` 失败现真正拦截（此前靠末行 `echo` 兜成退出码 0 的「假门禁」）；`make` 缺失时告警放行。
- server CLI 值参数（`--port` / `--host` / `--log-level`）支持 `--port 7899` 空格形式：此前空格形式被裸开关逻辑记为 `'1'`，导致 server 尝试绑定 1 号特权端口（EACCES）。

## [0.1.0] - 2026-10-07

### Added

- 项目模板首版：分层目录、统一质量门禁（make check）、AGENTS.md 规范。
<!-- 版本链接：替换为项目的 compare/release 地址后使用。 -->
