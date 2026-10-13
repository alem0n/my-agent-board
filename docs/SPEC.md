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
- 重复注册不产生重复 uuid：同 uuid 再注册复用；同进程同身份（name+cwd+sessionId）无 uuid 再注册复用。
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
- `GET /v1/agents`、`GET /v1/agents/:uuid`、`GET /v1/agents/:uuid/history`、`GET /v1/health`。
- 非法请求返回明确错误码（见 DESIGN.md §6）。

### REQ-008 持久化

- server 注册表持久化到本地 JSON 文件（原子写 + 串行化写队列）。
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

## 设计决策

- 传输协议：HTTP/1.1 + JSON，基于 `node:http` 与全局 `fetch`，零新增运行时依赖（`pino` 除外，已在模板内）。
- 契约校验自研轻量校验器（domain 层无外部依赖），契约以可读数据结构声明，版本化且独立演进。
- uuid 服务端权威分配（客户端未知 uuid 不被信任，改分配新 uuid 并让 client 采用）。
- 契约/协议版本号分离：信封协议版本 `1`；逐状态契约 semver `1.0.0`。
