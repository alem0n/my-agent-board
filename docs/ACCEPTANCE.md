# ACCEPTANCE — my-agent-board 验收结果对照表

> 交付物④。逐条映射任务第五节"质量门槛"，标注通过/不通过及证据。
> 验证环境：Node v24.18.0、pnpm 12.9.1、Linux (WSL2)。全量结果可由 `make check` 复现。

## 对照表

### 1. 状态覆盖 — ✅ 通过

**要求**：状态注册表与《手册》清单一一对应，缺项或多项视为不通过。

**证据**：

- `src/domain/contracts.ts` 的 `STATE_REGISTRY` 恰好 42 项 = 41 个 `ExtensionAPI.on()` 可订阅事件
  （逐一取自 `types.d.ts` 的 `on()` 重载清单）+ 1 个周期采样 `agent_snapshot`
  （`ExtensionContext` 可采样字段全集）。
- `tests/contracts.spec.ts` 用**独立硬编码**的手册 fixture（42 项）与注册表做双向集合比对；
- `tests/contracts.spec.ts` 断言注册表大小为 42；`tests/mapper.spec.ts` 断言
  `EVENT_STATES` 恰为 41 项、`STATE_REGISTRY.size == 41 + 1`；
- `pnpm demo` 实际输出 `stateCount: 42`（server 收到的逐状态 latest 数）。

**复现**：`pnpm exec vitest run tests/contracts.spec.ts tests/mapper.spec.ts`、`pnpm demo`。

### 2. 契约完整 — ✅ 通过

**要求**：每个状态存在独立、可校验的契约定义，且有对应测试用例覆盖合法与非法输入。

**证据**：

- 每个状态在 `STATE_REGISTRY` 中拥有独立契约（标识 / semver 版本 / 触发时机 / 频率策略 /
  字段表 `FieldSpec`），新增状态=追加条目，既有结构不变（`src/domain/contracts.ts`）；
- `tests/contracts.spec.ts`：42 状态合法样本全部通过；删除任一必填字段、类型错误、
  越界、非法枚举、未知字段、边界值逐项拒绝；
- `tests/e2e.spec.ts` 在 server 端验证 `E_INVALID_PAYLOAD` / `E_UNKNOWN_STATE` /
  `E_STALE_REPORT` / `E_UNSUPPORTED_PROTOCOL` 等错误码；
- `tests/mapper.spec.ts`：模拟器真实事件经映射后全部通过契约（映射器×契约交叉验证）。

**复现**：`pnpm exec vitest run tests/contracts.spec.ts tests/e2e.spec.ts`。

### 3. 身份正确 — ✅ 通过

**要求**：name 缺失时回退 session id；首次通信获得并持久化 uuid；重复注册不产生重复 uuid——
以上均有自动化测试证明。

**证据**（`tests/identity.spec.ts` + `tests/transport.spec.ts` + `tests/e2e.spec.ts`）：

- `resolveIdentity`：name 未设置/空白 → 回退 session id；两者皆无 → 明确失败原因（不静默）；
- 首次通信（无 uuid）：server 分配 v4 uuid 并返回；client 持久化到
  `agent-board-identity.json`（原子写，`tests/identity.spec.ts` 往返断言）；
- uuid 处理的三条路径均有用例：
  - 携带已注册 uuid → 复用（`assigned: false`，注册表仅 1 条）；
  - 无 uuid 的请求 → 分配新 uuid（`assigned:true`，重复条目由 DELETE 治理，见下条）；
  - client 携带的 uuid 被信任（记录不存在则按该 uuid 建立）；
- server 不做身份研判（无 sticky / 无 replaced），孤儿或重复条目由 `DELETE /v1/agents/:uuid` 显式删除（不存在返回 404）；
- 持久化失败（权限/非目录父路径）→ `identity.persistFailed` 错误日志 + 仅内存降级
  （`tests/transport.spec.ts`）；
- name/cwd 变化：保留 uuid、更新注册信息、追加 `identity_change` 历史条目；
- 端到端：第二次 client 启动复用同一 uuid（`tests/e2e.spec.ts`）。

**复现**：`pnpm exec vitest run tests/identity.spec.ts tests/transport.spec.ts tests/e2e.spec.ts`。

### 4. 配置正确 — ✅ 通过

**要求**：合法配置可连接，缺失/非法配置产生可读错误信息。

**证据**（`tests/config.spec.ts`，文件层 + 纯解析层）：

- 合法配置（`url` / `host`+`port` / 全字段）逐字段解析；`url` 优先级与尾斜杠归一化；
- 文件缺失 → `client.config.missing` 错误日志（含路径与降级说明）+ 默认值；
- JSON 非法 → `client.config.invalidJson` 错误日志 + 默认值；
- 逐字段非法（数值越界、类型错误、非法 url、非法 retry、非法 name）→ 错误 issue + 字段级日志 + 默认值；
- 未知键告警并忽略；路径优先级（显式 > `AGENT_BOARD_SERVER_CONFIG` > 默认）；
- "合法配置可连接"由 `tests/e2e.spec.ts` 端到端证明（模拟 client 用真实配置文件连接临时 server）。

**复现**：`pnpm exec vitest run tests/config.spec.ts`。

### 5. 可运行 — ✅ 通过

**要求**：一条命令完成本地启动（server + client 模拟），输出可观察的状态上报记录。

**证据**：`pnpm demo`（`scripts/demo.sh`）：

- 启动 server（临时数据目录）→ 等待健康 → 运行模拟 client（真实 Reporter/Transport/身份，
  回放 42 个状态）→ 打印 client 统计、server 注册表与历史样本 → 优雅关闭并清理；
- 最近一次运行：`collected: 46, sent: 44, droppedRejected: 0, stateCount: 42`，退出码 0。

**复现**：`pnpm demo`。

### 5b. 真实 pi 集成实测 — ✅ 通过（补充证据）

在真实 pi 进程（v1.0.4）中加载扩展 `pi --extension ./extension/agent-board.ts --print …`，
同时运行 board server：

- 扩展无错加载（jiti 编译相对路径导入 `../src/…` 可解析）；
- `session_start` 启动 Reporter，生命周期事件全部按设计采集上报；
- 配置文件缺失时输出 `client.config.missing` 错误日志并降级默认地址；
- `name` 未配置时回退为 pi session id；server 分配 uuid 并回写
  `~/.pi/agent/agent-board-identity.json`（`identity.persisted`）；
- 缓冲超限按设计丢弃最旧条目并计数（`buffer.overflow`），验证监控态丢弃路径。

### 6. 测试 — ✅ 通过

**要求**：核心逻辑测试通过率 100%；至少包含契约校验、身份分配、配置解析、重连重试四类测试。

**证据**：

- **测试全绿**（当前 171 用例 / 16 个 spec 文件，随变更增长），`pnpm run test:coverage` 达 80% 阈值
  （lines/statements/branches/functions 全部达标），`make check` 全绿（lint + typecheck +
  format + 覆盖率 + `pnpm audit --prod` 无漏洞）；
- 四类必备测试齐备：
  - 契约校验：`tests/contracts.spec.ts`、`tests/mapper.spec.ts`、`tests/e2e.spec.ts`；
  - 身份分配：`tests/identity.spec.ts`、`tests/transport.spec.ts`、`tests/e2e.spec.ts`；
  - 配置解析：`tests/config.spec.ts`；
  - 重连重试：`tests/transport.spec.ts`（退避序列、重试/耗尽/恢复、缓冲溢出丢弃、
    毒信剔除、413 拆分）。

**复现**：`make check`。

### 7. 文档 — ✅ 通过

**要求**：设计文档覆盖第三节全部交付物，且与最终实现一致。

**证据**：

- `docs/SPEC.md`：意图与需求原子清单（SDD spec 面）；
- `docs/DESIGN.md`：① 状态清单（§2，42 项逐项含标识/类型/触发时机/频率策略）
  → ② 逐状态契约（§3，字段表逐字段含类型/必填/取值范围/版本）→ ③ 身份方案（§5）
  → ④ 架构与接口说明（§1/§6，职责边界、传输协议、端点、配置字段、错误码、重连策略、时序图 §7）
  → 假设与待确认项（§10）→ 测试与验收计划（§11）；
- `docs/RUNBOOK.md`：运行与测试说明（交付物③）；
- 契约唯一信源为代码（`src/domain/contracts.ts`），文档与实现经核对一致
  （状态清单 42 项双向比对、频率枚举与版本号已同步）。

**复现**：`pnpm exec vitest run tests/contracts.spec.ts`（文档-实现一致性断言）。

## 任务第三节交付物映射

| 交付物 | 位置 | 状态 |
|---|---|---|
| 1 状态清单 | `docs/DESIGN.md` §2 | ✅ |
| 2 逐状态契约（schema） + 通用信封 | `docs/DESIGN.md` §3/§4；`src/domain/contracts.ts` | ✅ |
| 3 身份方案 | `docs/DESIGN.md` §5；`src/domain/identity.ts`、`src/services/registry.ts` | ✅ |
| 4 架构与接口说明 | `docs/DESIGN.md` §1/§6/§7 | ✅ |
| 5 测试与验收计划 | `docs/DESIGN.md` §11；本文件 | ✅ |

## 任务第四节功能需求映射

| 需求 | 实现 | 测试证据 |
|---|---|---|
| 1a 采集手册全部状态并按契约封装 | `src/services/mapper.ts`（41 事件）+ `agent_snapshot` 采样 | mapper / e2e |
| 1b 配置解析与降级（不静默） | `src/infrastructure/client-config-loader.ts` + `src/domain/client-config.ts` | config |
| 1c 每次上报携带 name 与 cwd | `ReportEnvelope.agent`（`src/domain/contracts.ts`），Reporter 组装 | contracts / e2e |
| 1d name 缺失回退 session id | `src/domain/identity.ts` | identity |
| 1e uuid 分配与持久化、失败降级 | `src/services/registry.ts` + `FileIdentityStore` | identity / transport |
| 1f 断线重连 / 重试退避 / 本地缓冲（内存，不落盘） | `src/services/retry.ts` + `src/services/reporter.ts` | transport |
| 2a 端点、协议与契约校验、错误码 | `src/infrastructure/http-server.ts` + `src/domain/validation.ts` | e2e / errors |
| 2b uuid 分配与注册表 | `src/services/registry.ts`（纯内存） | identity / registry |
| 2c 按 uuid 聚合最新与历史 | `AgentRegistry.get/history` + 查询 API | registry / e2e |
| 2d name/cwd 变化规则 | 保留 uuid + 更新 + `identity_change` 历史 | identity |
| 3 契约独立演进、协议版本号 | `PROTOCOL_VERSION` + 逐状态 semver + 加法式注册表 | contracts |
