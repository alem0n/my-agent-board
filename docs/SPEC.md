# SPEC — my-agent-board

> 记录项目意图（what/why）与需求原子清单。非平凡变更先在此记录意图。实现产生的新决策必须回写本文件。
> 完整设计见 [DESIGN.md](./DESIGN.md)；运行与测试见 [RUNBOOK.md](./RUNBOOK.md)；验收对照见 [ACCEPTANCE.md](./ACCEPTANCE.md)。

## 意图

构建 client-server 架构的 pi agent 状态监控系统：

- **client**：pi agent 扩展（`extension/agent-board.ts`），采集 pi agent 手册（《extensions.md》+ `types.d.ts`）中全部受支持状态，按契约封装后上报。
- **server**：独立 Node 进程，接收并校验上报，分配 agent uuid，维护注册表，按 uuid 聚合最新状态与历史，以 API + 结构化本地文件呈现。

状态注册表与《手册》一一对应：41 个扩展可订阅事件 + 1 个周期性上下文快照（`agent_snapshot`），共 42 项。不新增手册之外的状态。

## 需求清单

### REQ-001 状态注册表完整性

- `STATE_REGISTRY` 恰好包含 42 个状态标识（41 个事件名 + `agent_snapshot`）。
- 每个状态契约含标识、版本、触发时机、上报策略、字段表（名称/类型/必填/取值范围）。
- 测试断言注册表与手册 fixture 清单一一对应（缺项、多项均失败）。

### REQ-002 逐状态独立契约与校验

- 每个状态拥有独立契约与版本号；新增状态不改既有契约结构（注册表为加法式）。
- `validateReport()` 对信封与载荷逐项校验；非法输入返回结构化错误（状态、字段、原因）。
- 测试逐状态覆盖合法与非法输入。

### REQ-003 通用信封

- 上报信封承载 `protocolVersion`、`state`、`timestamp`、`agent`（身份）、`payload`（状态载荷）。
- 每次上报必须携带 `agent.name` 与 `agent.cwd`。

### REQ-004 身份方案

- `name` 未设置时回退使用当前 session id。
- 首次通信（无 uuid）由 server 分配全局唯一 uuid 并返回；client 持久化到 `~/.pi/agent/agent-board-identity.json`，后续上报携带。
- 持久化失败：明确错误日志 + 降级（每次会话由 server 分配新 uuid）。
- uuid 为请求级信任字段：client 携带即被信任（记录不存在则按该 uuid 建立）；未携带时 server 为整个请求分配一个 uuid 并返回 `assigned:true`，client 采用并持久化。一个批量请求共用首个 uuid。
- 心跳请求同样携带 uuid（REQ-013），信任来源一致。
- 重复注册：同 uuid 再注册复用；无 uuid 再注册 → 新 uuid（重复条目由 DELETE 治理，server 不研判合并）。
- name/cwd 变化：保留 uuid，更新注册信息，记录 `identity_change` 历史。

### REQ-005 配置解析

- client 从 `~/.pi/agent/agent-board-server.json` 解析 server 地址与上报参数。
- 文件缺失 / JSON 非法 / 字段非法：收集为结构化 issues，按内置默认值降级，不得静默失败（issues 在日志开启时输出，见 REQ-012）。
- 合法配置（`url` 或 `host`+`port`）能连通 server。

### REQ-006 传输可靠性

- 发送失败按指数退避 + 抖动重试；超出重试次数后保留缓冲。
- 服务端不可达时进入不可达态，周期性健康探测，恢复后恢复上报。
- 缓冲超限丢弃最旧条目（监控状态持续刷新，旧状态无需保留）；关闭时尽力排空（先等待进行中的 flush，再对剩余缓冲每批单次尝试，整体限时 3s），超时或不可达时残留丢弃并计数。

### REQ-007 server 接收与聚合

- `POST /v1/report`、`POST /v1/report/batch`（原子批，任一非法整体拒绝并返回逐条错误）。
- 注册表维护 uuid、name、cwd、sessionId、firstSeen、lastSeen、reportCount、逐状态 latest、上限历史。
- `GET /v1/agents`、`GET /v1/agents/:uuid`、`GET /v1/agents/:uuid/history`、`GET /v1/health`；响应含派生在线状态（`online` / `lastHeartbeat`，REQ-013）。
- `POST /v1/heartbeat`：更新 `lastHeartbeat`，记录不存在返回 404，不创建记录（REQ-013）。
- `DELETE /v1/agents/:uuid`：删除 agent 条目（latest + 历史一并删除），不存在返回 404。治理操作**请求即授权，server 不做本地研判**（无鉴权实现）。
- 非法请求返回明确错误码（见 DESIGN.md §6）。

### REQ-008 持久化（仅 client）

- server 注册表为**纯内存**：不写盘（无 `--data-dir`、无 `agents.json`），重启即清空——监控状态持续刷新，服务端状态无离线保留价值，且避免文件 IO 与损坏面。
- client uuid 使用本地文件（原子写）。

### REQ-009 隐私

- 仅采集状态与身份必需字段；提示词、命令、工具参数与结果内容一律不上报，仅上报结构化元数据（长度、计数、键名、错误标志）。

### REQ-010 本地可运行演示

- 一条命令启动 server + 模拟 client（驱动真实 client 库，覆盖全部 42 状态），输出可观察的上报记录。

### REQ-011 质量门禁

- `make check`（lint + typecheck + format + 覆盖率测试 + 生产依赖审计）全绿。
- 核心逻辑测试通过率 100%，含契约校验、身份分配、配置解析、重连重试四类。

### REQ-012 client 轻量性（默认零日志）

- client（pi 扩展）默认不产生任何日志输出：不创建日志文件、不执行日志 IO。
- 仅当用户显式配置时开启：配置文件 `logLevel` 字段，或环境变量 `AGENT_BOARD_LOG_LEVEL`（后者优先级更高，作为配置文件自身损坏时的诊断入口）。
- 取值 `silent` / `trace` / `debug` / `info` / `warn` / `error`；非法值记 issue 并保持 silent。
- 开启后日志为 JSON 行异步写入 `~/.pi/agent/agent-board-client.log`（串行写队列，不阻塞 pi 主线程，关闭时 flush 落盘）。

### REQ-013 在线检测（心跳 + 派生状态）

- 目标：server 能判断 client（pi 进程）是否在线，覆盖**无活跃会话**的静默期（REQ-004 的身份上报是会话级的：`session_start` 到 `session_shutdown` 之间）。
- client 进程级心跳：扩展**加载时**启动（与 session 生命周期解耦），周期 `heartbeatIntervalMs`（默认 20s，0 = 关闭）从 `agent-board-server.json` 配置。
- 心跳携带身份 uuid（信任来源与 REQ-004 一致：请求即信任）；uuid 尚未建立（身份文件不存在且从未上报）时跳过本周，不伪造身份。
- server 端点 `POST /v1/heartbeat`（body `{uuid}`）：记录存在则更新 `lastHeartbeat` 并返回 200；不存在返回 404（心跳**不创建/不复活**记录——DELETE 治理与下次真实上报才重建）。
- 派生状态：`online = now - max(lastSeen, lastHeartbeat) <= 60s`（阈值 = 3 × 默认心跳周期，覆盖网络抖动），经 `/v1/agents` 列表与 `GET /v1/agents/:uuid` 的 `online` 字段暴露；`lastHeartbeat` 一并暴露（0 = 从未心跳）。
- 心跳为通信探测，不作为监控状态落库（不写 latest、不计 reportCount、不入 history）。
- client 侧失败不阻塞采集、不进入重试队列（下一周期自然重试）；定时器 `unref()`，不阻止 pi 进程退出。

## 设计决策

- 传输协议：HTTP/1.1 + JSON，基于 `node:http` 与全局 `fetch`，零新增运行时依赖（`pino` 除外，已在模板内）。
- 契约校验自研轻量校验器（domain 层无外部依赖），契约以可读数据结构声明，版本化且独立演进。
- uuid 为请求级信任字段：client 携带即信任（信封格式校验后），server 不研判；未携带时为请求分配。
- 契约/协议版本号分离：信封协议版本 `1`；逐状态契约 semver `1.0.0`。
