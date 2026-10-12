# DESIGN — my-agent-board（pi agent 状态监控系统）

> 交付物①：设计文档。契约唯一来源为 `src/domain/contracts.ts`（代码即信源）；本文与之保持同步。
> 《手册》= pi 官方插件开发手册 `docs/extensions.md`（1.0.4）+ 扩展类型声明 `core/extensions/types.d.ts`。
> 经核对，1.0.4 与 npm 1.1.0 的事件清单完全一致（`ExtensionEvent` 联合类型 diff 为空）。

---

## 目录

1. [总体架构](#1-总体架构)
2. [状态清单（42 项，与手册一一对应）](#2-状态清单)
3. [逐状态契约（schema）](#3-逐状态契约)
4. [通用信封（envelope）](#4-通用信封)
5. [身份方案](#5-身份方案)
6. [接口、错误码与重连策略](#6-接口错误码与重连策略)
7. [时序图](#7-时序图)
8. [持久化与并发写入](#8-持久化与并发写入)
9. [隐私设计](#9-隐私设计)
10. [假设与待确认项](#10-假设与待确认项)
11. [测试与验收计划](#11-测试与验收计划)

---

## 1. 总体架构

### 1.1 职责边界

| 组件 | 职责 | 不做 |
|---|---|---|
| **client 扩展**（`extension/agent-board.ts` → `src/infrastructure/pi-extension.ts`） | 订阅 pi 全部受支持状态；映射为契约载荷；组信封；缓冲、重试、断线恢复、uuid 持久化 | 不渲染 UI（仅 `tui` 模式可选 `ui.notify`）；不修改会话内容 |
| **传输层**（`src/infrastructure/http-client.ts`） | HTTP POST、超时、退避重试、健康探测 | 不解析契约（校验在 server） |
| **server**（`src/index.ts` + `src/infrastructure/http-server.ts`） | 协议/契约校验、uuid 分配、注册表维护、聚合存储、查询 API | 不做 Web 前端；不做跨机编排 |
| **持久化**（`src/infrastructure/file-store.ts`） | 注册表原子写、身份文件 | 不使用数据库 |

### 1.2 分层（遵循 AGENTS.md §6）

```
src/domain/         契约、注册表、校验、身份规则、错误码、日志端口（无外部依赖）
src/services/       Reporter（采集编排）、Registry（uuid 分配/聚合）、退避策略
src/infrastructure/ HTTP server / HTTP client / 文件存储 / pi 扩展胶水 / 模拟器
src/index.ts        server 组合入口
src/simulate.ts     模拟 client 组合入口（演示用）
extension/agent-board.ts  pi 扩展入口（薄重导出）
```

依赖方向单向指向 domain（由 `.dependency-cruiser.cjs` 机器校验）：
`infrastructure → services → domain`；services 通过端口接口依赖 infrastructure 的实现（依赖倒置）。

### 1.3 传输协议与数据流

```
pi 进程                                          board server 进程
┌──────────────────────┐                         ┌────────────────────┐
│ pi 扩展（jiti 加载）  │   POST /v1/report[*]    │ node:http server   │
│  ├ adapter(订阅 pi)  │ ──────JSON over HTTP──▶ │  ├ 校验 envelope   │
│  ├ Reporter(映射/缓冲)│ ◀──────{uuid,assigned}─ │  ├ 分配/校验 uuid   │
│  ├ HttpTransport     │                         │  ├ Registry 聚合    │
│  └ identity          │   GET /v1/agents...      │  └ FileStore 持久化│
└──────────────────────┘ ──────────────────────▶ └────────────────────┘
```

`[*]` 批量上报走 `POST /v1/report/batch`（默认；缓冲多条时合并）。

### 1.4 依赖清单与理由

| 依赖 | 类型 | 理由 |
|---|---|---|
| `pino` | 运行时（模板已有） | Node 环境性能最优的结构化日志（AGENTS.md §4 指定） |
| `node:http` / `node:crypto` / `node:fs` / `node:path` | 内置 | 零依赖 HTTP server / uuid / 文件持久化 |
| 全局 `fetch`（Node ≥ 22） | 内置 | client 上报，无需 axios |
| `@earendil-works/pi-coding-agent` | dev（仅类型） | 扩展类型声明；`import type` 编译期消除，无运行时依赖 |
| vitest / eslint / prettier / dependency-cruiser / tsx | dev | 模板既有门禁工具 |

**无新增运行时依赖；不引入任何外部 SaaS 或付费服务。**

---

## 1.5 部署单元与分离契约

两个**独立部署单元**，唯一耦合是协议（§4 信封 + §6 错误码 + §3 契约版本）：

| 部署单元 | 产物 | 运行时依赖 | 部署位置 |
|---|---|---|---|
| **client** | `pnpm pack:client` → `build/client/`（15 个模块、pi 清单、peer 依赖声明宿主包） | 无（仅 Node 内置；宿主类型导入编译期剥离） | pi agent 所在任意主机 |
| **server** | `dist/src/index.js`（`pnpm build`） | `pino` | 任意可达主机 |

分离契约（全部机器校验，防回潮）：

- **模块级**：`make layers`（dependency-cruiser）含 `client-server-separation` 与
  `server-entry-separation` 两条规则——client 执行路径不得依赖 server 模块，反之亦然。
- **闭包级**：`tests/separation.spec.ts` 从 `extension/agent-board.ts` 做模块闭包扫描，
  断言闭包不含 server 模块、产物自包含、零第三方运行时导入。
- **IO 级**：`tests/async-io.spec.ts` 断言 client 侧无同步文件 IO、不导入 server 同步存储。
- **打包护栏**：`scripts/pack-client.mjs` 拒绝把产物写到仓库根之外（历史上一个参数解析
  bug 曾借此把产物写到仓库外文件，护栏为防同类事故）。

部署拓扑（均被实测覆盖）：

```
拓扑 A 同机开发：  pi --extension ./extension/agent-board.ts  +  pnpm dev（127.0.0.1:7878）
拓扑 B 独立 client 产物：pi install ./build/client           +  远端 server（url 指向）
拓扑 C 跨机：     client 配置 url 指向 server 主机；server 数据目录与端口独立配置
```

跨机时 client 配置文件（`~/.pi/agent/agent-board-server.json` 的 `url`）或环境变量
`AGENT_BOARD_SERVER_CONFIG`（覆盖配置路径）是唯一的部署期参数；协议版本与契约版本负责
两侧独立演进的兼容性裁决（§4.2、§3.3）。

---

## 2. 状态清单

### 2.1 推导规则（不编造）

《手册》中"受支持状态" = 扩展可观测的全部状态，由两部分组成：

1. **事件型状态（41 项）**：`ExtensionAPI.on()` 可订阅的全部事件，取自 `ExtensionEvent` 联合类型与 `on()` 重载清单（`types.d.ts`）。
2. **采样型状态（1 项）**：`agent_snapshot` —— `ExtensionContext` 暴露的可采样运行态（cwd / mode / model / thinkingLevel / idle / contextUsage / 会话标识 / 活动工具等）。

合计 **42 项**，与手册一一对应。`agent_snapshot` 之外，`ExtensionContext` 的所有可采样字段都已纳入该快照；`ExtensionEvent` 的每个事件都产生独立状态报告。

### 2.2 清单总表

标识即契约 key（事件名沿用 pi 事件名以确保可追溯）。频率策略（与代码 `FieldSpec.frequency` 一致）：`event`＝事件触发即报；`event+coalesce`＝事件触发、连续 1s 窗口内合并；`periodic`＝周期采样（默认 30s，并对 `session_start`/`agent_end` 边界补采）。

| # | 状态标识 | 数据类型摘要 | 触发时机 | 频率/策略 |
|---|---|---|---|---|
| 1 | `project_trust` | object{cwd} | 项目信任决策前（仅个人/显式扩展） | event（备注：低频） |
| 2 | `resources_discover` | object{cwd,reason} | session_start 后资源发现 | event |
| 3 | `mcp_servers_change` | object{serverCount,serverNames[]} | 扩展注册/注销 MCP server | event |
| 4 | `session_start` | object{reason,previousSessionFile?} | 会话启动/加载/重载/new/resume/fork | event |
| 5 | `session_info_changed` | object{name?} | 会话元数据变化 | event |
| 6 | `session_before_switch` | object{reason,targetSessionFile?} | 切换会话前（可取消） | event |
| 7 | `session_before_fork` | object{entryId,position} | 分叉会话前（可取消） | event |
| 8 | `session_before_compact` | object{reason,willRetry,branchEntryCount} | 上下文压缩前（可取消） | event |
| 9 | `session_compact` | object{reason,willRetry} | 压缩成功后 | event |
| 10 | `session_compact_failed` | object{reason,aborted,willRetry,errorMessage?} | 压缩失败/中止后 | event |
| 11 | `session_shutdown` | object{reason,targetSessionFile?} | 扩展运行时卸载前 | event |
| 12 | `session_before_tree` | object{targetId,oldLeafId?,userWantsSummary} | 会话树导航前（可取消） | event |
| 13 | `session_tree` | object{newLeafId?,oldLeafId?,fromExtension?} | 会话树导航后 | event |
| 14 | `context` | object{messageCount,roleCounts} | 每次 LLM 调用前（无系统消息） | event+coalesce |
| 15 | `context_with_system` | object{messageCount,roleCounts} | 每次 LLM 调用前（含系统消息） | event+coalesce |
| 16 | `cache_warming_decision` | object{action?,warmCost?,missCost?,continuationProbability?} | prompt 缓存预热决策时 | event |
| 17 | `before_provider_request` | object{}（仅出现次数） | provider 请求发送前 | event+coalesce |
| 18 | `before_provider_headers` | object{headerNames[]} | 请求头组装后、HTTP 调用前 | event |
| 19 | `after_provider_response` | object{status,headerNames[]} | 响应接收后、流消费前 | event |
| 20 | `provider_stream_event` | object{provider,api,model,eventType?} | 每个解析后的 provider 流事件 | event+coalesce |
| 21 | `before_agent_start` | object{promptLength,imageCount,systemPromptLength} | 用户提交 prompt、agent 循环前 | event |
| 22 | `agent_start` | object{} | agent 循环开始 | event |
| 23 | `agent_end` | object{messageCount,roleCounts} | agent 循环结束 | event |
| 24 | `agent_before_settle` | object{outcome,entryCount,willContinue} | 最终收尾前（可追加条目/续一轮） | event |
| 25 | `agent_settled` | object{} | run 完全定居，无自动续跑 | event |
| 26 | `ui_prompt_start` | object{kind,title?} | 阻塞式扩展 UI 提问开始 | event |
| 27 | `ui_prompt_end` | object{kind,title?} | 阻塞式扩展 UI 提问结束 | event |
| 28 | `turn_start` | object{turnIndex,eventTimestamp} | 每个 turn 开始 | event |
| 29 | `turn_end` | object{turnIndex,toolResultCount,messageRole,willContinue} | 每个 turn 结束 | event |
| 30 | `message_start` | object{role,contentPartCount,provider?,model?} | 消息开始（user/assistant/toolResult） | event |
| 31 | `message_update` | object{role,contentPartCount,eventType?} | assistant 流式逐 token 更新 | event+coalesce |
| 32 | `message_end` | object{role,contentPartCount,provider?,model?,stopReason?,usage?} | 消息结束 | event |
| 33 | `tool_execution_start` | object{toolCallId,toolName,parentToolCallId?,argKeys[]} | 工具开始执行 | event |
| 34 | `tool_execution_update` | object{toolCallId,toolName,hasPartialResult} | 工具执行部分输出 | event+coalesce |
| 35 | `tool_execution_end` | object{toolCallId,toolName,isError,contentPartCount,usageTotalTokens?} | 工具执行结束 | event |
| 36 | `model_select` | object{model,previousModel?,source} | 模型切换（/model、Ctrl+P、会话恢复） | event |
| 37 | `thinking_level_select` | object{level,previousLevel} | thinking 级别切换 | event |
| 38 | `user_bash` | object{commandLength,excludeFromContext,cwd} | 用户 `!`/`!!` 前缀执行 bash | event |
| 39 | `input` | object{textLength,imageCount,source,streamingBehavior?} | 用户输入接收后、agent 处理前 | event |
| 40 | `tool_call` | object{toolCallId,toolName,parentToolCallId?,inputKeys[]} | 工具执行前（可阻止；仅元数据） | event |
| 41 | `tool_result` | object{toolCallId,toolName,isError,usageTotalTokens?,contentPartCount,structuredContent} | 工具执行后（可修改；仅元数据） | event |
| 42 | `agent_snapshot` | object{sessionId?,sessionName?,cwd,mode,hasUI,isProjectTrusted,isIdle,hasPendingMessages,model?,thinkingLevel?,contextUsage?,activeToolCount,piVersion?,uptimeMs} | 每 reportIntervalMs（默认 30s）；session_start 与 agent_end 边界补采 | periodic |

### 2.3 覆盖性自检（验收标准 1 的证据）

- 事件型：`types.d.ts` 中 `ExtensionAPI.on()` 的全部 41 个事件重载逐一登记。
- 采样型：`ExtensionContext` 公开可采样字段全部进入 `agent_snapshot`。
- 测试 `contracts.spec.ts` 用独立硬编码 fixture（手册清单）与 `STATE_REGISTRY` 做双向集合比对，缺项/多项即失败。

---

## 3. 逐状态契约

每个状态拥有**独立**契约对象（`src/domain/contracts.ts` 中 `STATE_REGISTRY: Record<StateId, StateContract>`）。新增状态 = 向注册表追加条目，既有契约结构不变（加法式演进）。

### 3.1 契约结构（元 schema）

```ts
interface FieldSpec {
  name: string;                 // 字段名
  type: "string" | "integer" | "number" | "boolean" | "array" | "object";
  required?: boolean;           // 默认 false
  nullable?: boolean;           // 允许 JSON null（integer/number/object 可空字段）
  enum?: (string | number)[];   // 枚举取值
  min?: number;                 // number/integer 下界；array 为最小长度；string 为最小长度
  max?: number;                 // 对应上界
  items?: FieldSpec;            // array 元素契约
  fields?: FieldSpec[];         // object 字段契约
}
interface StateContract {
  state: StateId;               // 状态标识
  version: string;              // 契约 semver，如 "1.0.0"
  trigger: string;              // 触发时机（人类可读）
  frequency: "event" | "event+coalesce" | "periodic"（见 §2.2）
  coalesceWindowMs?: number;    // 仅 event+coalesce：合并窗口（默认 1000）
  description: string;
  payload: FieldSpec;           // type: "object"，字段表见 §3.2
}
```

**通用字段约束（所有契约共用，声明于元层）**

| 字段 | 类型 | 必填 | 取值范围 |
|---|---|---|---|
| 各 `*Count`/`*Length` | integer | 是 | ≥ 0 |
| `turnIndex` | integer | 是 | ≥ 0 |
| 各枚举字段 | string | 是 | 契约 enum 列表 |
| `uptimeMs` | integer | 是 | ≥ 0 |
| `model` / `previousModel` | string | 否 | `"provider/id"` 格式，1..128 |
| `errorMessage` | string | 否 | ≤ 1024（截断后上报） |

### 3.2 字段表（逐状态）

格式：`字段名 类型 必填 约束`。缺省 `必填=否`。共 42 个契约，对应 §2.2 的 42 行。

**project_trust** v1.0.0 — `cwd string 必填 1..4096`
**resources_discover** v1.0.0 — `cwd string 必填 1..4096`；`reason string 必填 enum{startup,reload}`
**mcp_servers_change** v1.0.0 — `serverCount integer 必填 ≥0`；`serverNames array<string> 必填 minItems 0 maxItems 256 items{string 1..128}`
**session_start** v1.0.0 — `reason string 必填 enum{startup,reload,new,resume,fork}`；`previousSessionFile string 否 1..4096`
**session_info_changed** v1.0.0 — `name string|undefined`：允许缺省或空串清除；契约 `name string 否 min 0 max 256`
**session_before_switch** v1.0.0 — `reason string 必填 enum{new,resume}`；`targetSessionFile string 否 1..4096`
**session_before_fork** v1.0.0 — `entryId string 必填 1..128`；`position string 必填 enum{before,at}`
**session_before_compact** v1.0.0 — `reason string 必填 enum{manual,threshold,overflow}`；`willRetry boolean 必填`；`branchEntryCount integer 必填 ≥0`
**session_compact** v1.0.0 — `reason string 必填 enum{manual,threshold,overflow}`；`willRetry boolean 必填`
**session_compact_failed** v1.0.0 — `reason string 必填 enum{manual,threshold,overflow}`；`aborted boolean 必填`；`willRetry boolean 必填`；`errorMessage string 否 ≤1024`
**session_shutdown** v1.0.0 — `reason string 必填 enum{quit,reload,new,resume,fork}`；`targetSessionFile string 否 1..4096`
**session_before_tree** v1.0.0 — `targetId string 必填 1..128`；`oldLeafId string 否 0..128`；`userWantsSummary boolean 必填`
**session_tree** v1.0.0 — `newLeafId string 否 0..128`；`oldLeafId string 否 0..128`；`fromExtension boolean 否`
**context** v1.0.0 — `messageCount integer 必填 ≥0`；`roleCounts object 必填`，字段：`user/assistant/toolResult/system integer 否 ≥0`（未知角色键拒绝）
**context_with_system** v1.0.0 — 同 `context`
**cache_warming_decision** v1.0.0 — `action string 否 enum{warm,stop}`；`warmCost number 否 ≥0`；`missCost number 否 ≥0`；`continuationProbability number 否 0..1`
**before_provider_request** v1.0.0 — 无字段（出现性事件；载荷为空对象）
**before_provider_headers** v1.0.0 — `headerNames array<string> 必填 maxItems 128 items{string 1..128}`（仅键名，见 §9）
**after_provider_response** v1.0.0 — `status integer 必填 100..599`；`headerNames array<string> 必填 maxItems 128`
**provider_stream_event** v1.0.0 — `provider string 必填 1..64`；`api string 必填 1..64`；`model string 必填 1..128`；`eventType string 否 1..64`（取 `data.type`，取不到则缺省）
**before_agent_start** v1.0.0 — `promptLength integer 必填 ≥0`；`imageCount integer 必填 ≥0`；`systemPromptLength integer 必填 ≥0`
**agent_start** v1.0.0 — 空对象
**agent_end** v1.0.0 — `messageCount integer 必填 ≥0`；`roleCounts object 必填`（同 context）
**agent_before_settle** v1.0.0 — `outcome string 必填 enum{completed,aborted,error}`；`entryCount integer 必填 ≥0`；`willContinue boolean 必填`
**agent_settled** v1.0.0 — 空对象
**ui_prompt_start** v1.0.0 — `kind string 必填 enum{select,confirm,input,editor,custom}`；`title string 否 0..256`
**ui_prompt_end** v1.0.0 — 同 `ui_prompt_start`
**turn_start** v1.0.0 — `turnIndex integer 必填 ≥0`；`eventTimestamp integer 必填 ≥0`（事件自带 timestamp）
**turn_end** v1.0.0 — `turnIndex integer 必填 ≥0`；`toolResultCount integer 必填 ≥0`；`messageRole string 必填 enum{user,assistant,toolResult}`；`willContinue boolean 必填`
**message_start** v1.0.0 — `role string 必填 enum{user,assistant,toolResult}`；`contentPartCount integer 必填 ≥0`；`provider string 否 1..64`；`model string 否 1..128`
**message_update** v1.0.0 — `role string 必填 enum{user,assistant,toolResult}`；`contentPartCount integer 必填 ≥0`；`eventType string 否 1..64`
**message_end** v1.0.0 — `role string 必填 enum{user,assistant,toolResult}`；`contentPartCount integer 必填 ≥0`；`provider string 否`；`model string 否`；`stopReason string 否 1..64`；`usage object 否{input integer ≥0,output integer ≥0,cacheRead integer ≥0,cacheWrite integer ≥0,totalTokens integer ≥0}`
**tool_execution_start** v1.0.0 — `toolCallId string 必填 1..128`；`toolName string 必填 1..128`；`parentToolCallId string 否 1..128`；`argKeys array<string> 必填 maxItems 64 items{string 1..64}`
**tool_execution_update** v1.0.0 — `toolCallId string 必填 1..128`；`toolName string 必填 1..128`；`hasPartialResult boolean 必填`
**tool_execution_end** v1.0.0 — `toolCallId string 必填 1..128`；`toolName string 必填 1..128`；`isError boolean 必填`；`contentPartCount integer 必填 ≥0`；`usageTotalTokens integer 否 ≥0`
**model_select** v1.0.0 — `model string 必填 ^[a-zA-Z0-9._-]+/[a-zA-Z0-9._-]+$ 1..128`；`previousModel string 否 同格式`；`source string 必填 enum{set,cycle,restore}`
**thinking_level_select** v1.0.0 — `level string 必填 1..32`；`previousLevel string 必填 1..32`
**user_bash** v1.0.0 — `commandLength integer 必填 ≥0`；`excludeFromContext boolean 必填`；`cwd string 必填 1..4096`
**input** v1.0.0 — `textLength integer 必填 ≥0`；`imageCount integer 必填 ≥0`；`source string 必填 enum{interactive,rpc,extension}`；`streamingBehavior string 否 enum{steer,followUp}`
**tool_call** v1.0.0 — `toolCallId string 必填 1..128`；`toolName string 必填 1..128`；`parentToolCallId string 否 1..128`；`inputKeys array<string> 必填 maxItems 64 items{string 1..64}`
**tool_result** v1.0.0 — `toolCallId string 必填 1..128`；`toolName string 必填 1..128`；`isError boolean 必填`；`usageTotalTokens integer 否 ≥0`；`contentPartCount integer 必填 ≥0`；`structuredContent boolean 必填`
**agent_snapshot** v1.0.0 — `sessionId string 否 0..256`；`sessionName string 否 0..256`；`cwd string 必填 1..4096`；`mode string 必填 enum{tui,rpc,json,print}`；`hasUI boolean 必填`；`isProjectTrusted boolean 必填`；`isIdle boolean 必填`；`hasPendingMessages boolean 必填`；`model string 否 provider/id 格式`；`thinkingLevel string 否 1..32`；`contextUsage object 否{tokens integer|null,min 0; contextWindow integer ≥0; percent number|null 0..100}`；`activeToolCount integer 必填 ≥0`；`piVersion string 否 1..64`；`uptimeMs integer 必填 ≥0`

### 3.3 契约演进规则

- 契约 semver：新增可选字段 / 放宽约束 = MINOR；收紧 / 删除 / 改类型 = MAJOR。
- server 按状态 + 主版本路由校验；未知状态 → `E_UNKNOWN_STATE`（不静默接受）。
- 新增状态 = 注册表追加条目，既有契约文件结构不动（满足"新增状态不需修改既有契约结构"）。
- 信封协议版本独立于契约版本（见 §4）。

---

## 4. 通用信封（envelope）

### 4.1 结构

```jsonc
{
  "protocolVersion": "1",              // 必填，string，协议大版本（当前 "1"）
  "state": "agent_snapshot",           // 必填，string，状态标识（注册表 key）
  "timestamp": 1719530000000,          // 必填，integer，epoch ms，≥0，不得超服务器时间+60s
  "agent": {                           // 必填，object，身份字段
    "uuid": "…",                       // 否，string，UUIDv4；首次上报缺省，由 server 分配
    "name": "feat/board",              // 必填，string 1..256；缺省配置时回退 session id
    "cwd": "/home/user/proj",          // 必填，string 1..4096
    "sessionId": "2026…",              // 否，string 0..256；可采集时携带
    "piVersion": "1.0.4"               // 否，string
  },
  "payload": { /* 状态载荷，按 §3 契约校验 */ }
}
```

批量请求体：`{ "reports": Envelope[] }`（数组内每条都是完整信封，满足"每次上报必须携带身份字段"）。

### 4.2 版本号语义

- `protocolVersion`：信封与传输结构。大版本不一致 → `E_UNSUPPORTED_PROTOCOL`。小版本通过 server `PROTOCOL_VERSIONS_SUPPORTED` 集合管理（当前仅 `"1"`）。
- 契约版本：每个状态独立 semver，携带于 server 端注册表与错误响应 `details`，供排障。

### 4.3 时间戳约束

- `timestamp` 落后于服务器时间超过 `maxReportAgeMs`（默认 7 天，缓冲陈旧数据保护）→ `E_STALE_REPORT`。
- 超前超过 60s → `E_INVALID_ENVELOPE`。

---

## 5. 身份方案

### 5.1 字手生成与传递规则

| 字段 | 生成 | 传递 | 变化处理 |
|---|---|---|---|
| `agent.name` | 配置文件 `name`；**未设置/空 → 回退当前 session id**（`ctx.sessionManager.getSessionId()`）；两者皆无 → 丢弃该条上报并 `warn` 日志（不静默） | 每条信封必带 | 变化时**保留 uuid**，更新注册表 name，追加 `identity_change` 历史 |
| `agent.cwd` | `ctx.cwd` | 每条信封必带 | 同上（字段=cwd） |
| `agent.sessionId` | `ctx.sessionManager.getSessionId()` | 可采集时携带 | 每条上报覆盖注册表 current sessionId（不带则保留旧值） |
| `agent.uuid` | **server 分配**（`crypto.randomUUID()`）首次通信返回；client 持久化 `~/.pi/agent/agent-board-identity.json` | 持久化后每条携带 | 未知于 server → server 改分配新 uuid 并返回 `replaced:true`，client 采用并覆盖持久化 |
| `agent.piVersion` | 扩展注入（`process.env.PI_VERSION` 或硬编码包版本） | 可选携带 | — |

### 5.2 uuid 分配规则（server 权威，防重复）

收到信封时按优先级：

1. `agent.uuid` 存在且在注册表 → 复用，`assigned=false`。
2. `agent.uuid` 存在但不在注册表（含格式非法） → **分配新 uuid**，`assigned=true, replaced=true`（不信任客户端未知 uuid —— 最小安全校验）。
3. `agent.uuid` 缺省：
   - 注册表中存在 (name, cwd, sessionId) 三者全同的记录 → 复用其 uuid（同进程重复注册不产生重复 uuid）。
   - 否则分配新 uuid，`assigned=true`。

`crypto.randomUUID()` 保证全局唯一；并发分配以注册表串行写队列序列化（§8）。

### 5.3 持久化与降级

- 身份文件路径：`~/.pi/agent/agent-board-identity.json`，内容 `{ uuid, assignedAt, serverUrl }`。
- 原子写（tmp + rename）；写入失败 → `error` 日志（含路径与原因）→ 降级为"不持久化"：每次会话由 server 分配 uuid（该 agent 的历史会按 sessionId 粘连复用，见 §5.2 规则 3，但跨会话不保证同 uuid）。降级明确记录，不静默。
- 首次通信成功获得 uuid 后立即持久化；后续携带；server 返回 `replaced:true` 时覆盖持久化。

### 5.4 name/cwd 变化处理（明确规则）

保留 uuid；更新注册表 `name`/`cwd`/`sessionId`/`lastSeen`；追加历史条目：

```jsonc
{ "type": "identity_change", "at": <epoch ms>, "fields": { "name": { "from": "a", "to": "b" } } }
```

server 端查询 API 永远返回当前值 + 可查变化历史。

---

## 6. 接口、错误码与重连策略

### 6.1 端点

| 方法 | 路径 | 请求 | 成功响应 |
|---|---|---|---|
| POST | `/v1/report` | 单信封 | `200 { ok:true, uuid, assigned:boolean, replaced?:boolean }` |
| POST | `/v1/report/batch` | `{ reports: Envelope[] }`（≤512 条，body ≤4MB） | `200 { ok:true, accepted:n, uuid, assigned, rejected:[{index,code,message,state?}] }`（原子批：非法信封所在批次整体拒绝并逐条返回；client 剔除被拒条目后重试剩余） |
| GET | `/v1/agents` | — | `200 { agents:[{uuid,name,cwd,sessionId,firstSeen,lastSeen,reportCount,stateCount}] }` |
| GET | `/v1/agents/:uuid` | — | `200 { …注册表当前值…, latest: Record<StateId,{timestamp,payload}> }` |
| GET | `/v1/agents/:uuid/history` | `?state=&limit=≤1000&since=epoch ms` | `200 { uuid, state?, entries:[HistoryEntry], truncated:boolean }` |
| GET | `/v1/health` | — | `200 { status:"ok", protocolVersion:"1", agents:n, uptimeMs }` |

### 6.2 错误码

所有错误响应：`{ error:{ code, message, details? } }`。

| code | HTTP | 含义 |
|---|---|---|
| `E_UNSUPPORTED_PROTOCOL` | 400 | protocolVersion 缺失/不支持 |
| `E_INVALID_ENVELOPE` | 400 | 信封结构错误（缺必填/类型错/时间戳非法） |
| `E_UNKNOWN_STATE` | 400 | state 不在注册表 |
| `E_INVALID_PAYLOAD` | 400 | 载荷违反状态契约（details 含 state/field/reason/contractVersion） |
| `E_STALE_REPORT` | 400 | timestamp 超期（> maxReportAgeMs） |
| `E_AGENT_IDENTITY` | 400 | name/cwd 缺失或非法 |
| `E_BATCH_TOO_LARGE` | 413 | 批量超过 512 条或 body >4MB |
| `E_NOT_FOUND` | 404 | 路径或 uuid 不存在 |
| `E_METHOD_NOT_ALLOWED` | 405 | 非 GET/POST |
| `E_INTERNAL` | 500 | 服务器内部错误 |

### 6.3 重连与重试策略（client）

- **发送失败重试**：每次 flush 失败按指数退避 + 全抖动重试：`delay = min(maxDelay, initial * factor^(attempt-1))`，抖动 `rand(0, delay)`。默认 `initial=500ms, factor=2, max=30s, maxAttempts=5`（可配置）。
- **缓冲保留**：重试耗尽后整批保留在内存缓冲；超 `maxBufferSize`（默认 1000）则丢弃最旧条目。
- **断线重连**：连续失败后标记 `unreachable`，停止 flush 循环，按相同退避执行 `GET /v1/health` 探测；探测成功 → 恢复 flush。
- **丢弃即终态**：监控状态持续刷新，旧状态价值快速衰减；不做离线持久化，恢复后直接发送新采集的状态。
- **优雅关闭**：`session_shutdown`（或进程信号）触发尽力 flush（超时 3s）；残留缓冲丢弃并计数。
- **毒信处理**：批量返回 400 且含 `rejected` → 剔除被拒条目（error 日志逐条记录）后重试剩余批次一次；仍失败则保留剩余。

### 6.4 超时与限制

- client 请求超时 `requestTimeoutMs` 默认 5s。
- server 每请求 body 上限 4MB；注册表历史上限 1000 条/agent（环形截断，`truncated` 标记）。

---

## 7. 时序图

### 7.1 首次上报与 uuid 分配

```
client(pi 扩展)                    server
    │                                │
    │ session_start → 采集           │
    │ 申请 uuid: 报告(无 uuid) ────▶ │ 校验信封/契约
    │                                │ 分配 uuid=U1，持久化注册表
    │ ◀──────── {ok,uuid:U1,assigned:true}
    │ 持久化 identity.json           │
    │ 后续报告(uuid=U1) ───────────▶ │ 复用 U1，更新 lastSeen
    │ ◀──────── {ok,uuid:U1,assigned:false}
```

### 7.2 断线 → 重连 → 排空

```
client                             server
    │ report batch ─────────────▶ │ ✗ 连接拒绝/ECONNREFUSED
    │ ◀ retry 1 (500ms+抖动) ───▶ │ ✗
    │ ◀ retry 2..5 (退避) ──────▶ │ ✗   → 标记 unreachable
    │ 缓冲保留(超限丢弃最旧)      │
    │ 健康探测(退避间隔) ────────▶ │ GET /v1/health ✗
    │ …                             │
    │ 探测 ──────────────────────▶ │ 200 ok → 标记 reachable
    │ 恢复后 flush(POST batch) ──▶ │ 200 → 发送新采集状态
    │ 恢复正常 flush 循环 ───────▶ │
```

### 7.3 批量上报与部分拒绝

```
client                              server
    │ POST /v1/report/batch ──────▶│ 逐条校验：index 3 载荷非法
    │ ◀──── 400 { rejected:[{index:3,code:E_INVALID_PAYLOAD,...}] }
    │ 剔除 index 3(error 日志)      │
    │ POST 剩余条目 ──────────────▶│ 200 { accepted:n }
```

---

## 8. 持久化与并发写入

### 8.1 性能约束：client 全异步（不阻塞 pi 主线程）

- client 扩展运行在 pi 交互进程内，其主线程同时承载 TUI 事件循环。client 侧
  **一切文件 IO 使用异步 API**（`node:fs/promises`）和网络 IO（`fetch`）。
- 同一文件的写经 `SerialFileWriter`（fifo Promise 链）串行化，保证顺序与一致性；
  日志与身份各自持有独立 writer。
- 采集路径（事件处理 → 信封入队）完全同步无 IO；溢出转储为 fire-and-forget 异步写，
  `Reporter.pendingWrites` 跟踪之，`stop()` 等待落盘。
- 静态守护：`tests/async-io.spec.ts` 扫描 client 源文件，出现 `fs.*Sync(` 即失败；
  并断言 client 执行路径不导入 server 同步存储模块。

### 8.2 server 注册表（独立进程，同步写为记录的权衡）

- 格式：单个 JSON 文件（默认 `data/agents.json`）：`{ "version": 1, "agents": { uuid: AgentRecord } }`。
- 实现位于 `infrastructure/registry-file-store.ts`，使用同步 IO：server 是独立专用进程，
  注册表写由去抖合并与关闭最终写触发，单次同步写仅短暂阻塞本进程的 HTTP 循环，
  且换取简单的单线程串行语义（无异步交错与写竞争）；与 client 分模块隔离（假设 A11）。
- 启动加载：文件缺失 → 空注册表（非错误，info 日志）；JSON 损坏 → `error` 日志 + 空注册表启动（保守丢弃，明确日志，不退出）。
- 写盘策略：去抖合并（默认 250ms 内多次变更合并一次写）+ 关闭时强制最终写。

### 8.3 client 文件

- 身份文件：异步原子写（tmp+rename，串行队列）；失败 → §5.3 降级。
- 上报缓冲为纯内存：重试耗尽、缓冲超限、关闭残留一律丢弃并计数（监控态持续刷新，离线持久化无收益）。
- 日志：JSON 行异步追加（串行队列）；扩展关闭时 `flush()` 等待落盘。

---

## 9. 隐私设计

- **仅采集状态与身份必需字段**（REQ-009）：提示词原文、bash 命令原文、工具参数与结果内容、provider header 值、流事件原始数据——**一律不上报**。
- 仅上报：长度、计数、键名、枚举、错误标志、provider/model 标识、用量 token 数。
- `before_provider_headers` / `after_provider_response`：仅 header **名称**。
- 配置文件不含凭据；身份文件仅含 uuid。
- 不采集文件路径内容、不采集环境变量值、不采集用户输入文本。

---

## 10. 假设与待确认项

> 不确定需求按保守假设实现并显式列出（任务 §6.2）。

| # | 假设 | 保守选择 | 影响 |
|---|---|---|---|
| A1 | "全部受支持状态"的确切口径未在任务中定义 | = 手册中扩展可订阅的 41 事件 + 1 上下文快照（`ExtensionContext` 全部可采样字段） | 若口径还应包含 MCP/会话文件内的其他状态，需另增（当前不编造） |
| A2 | server 是否需要跨进程/跨机集群 | 单进程、本地文件存储 | 满足范围内"本地可运行" |
| A3 | 同一 (name,cwd) 多个并行 pi 会话是否应合并为一个 agent | **不合并**（uuid 按客户端持久化身份区分） | 并行同目录会话各自独立 |
| A4 | 客户端未知 uuid 是否可信 | 不可信，server 改分配（最小安全校验） | server 重启后老 uuid 不复活 |
| A5 | 内容字段（prompt/命令/参数）是否上报 | 不上报，仅元数据 | 牺牲细粒度换隐私 |
| A6 | 协议是否需要鉴权 | 不需要（本地假定可信网络），仅保留 §A4 的 uuid 校验 | 生产环境需另加 |
| A7 | pi 扩展运行在无 pino 的 pi 进程内 | 扩展使用自实现 JSON 行文件日志器（满足 `BoardLogger` 端口） | 扩展零运行时依赖 |
| A8 | 批量上报中部分非法时的语义 | 原子批拒绝 + client 剔除重试（§6.3 毒信处理） | 防毒信阻塞缓冲 |
| A9 | server 重启后注册表是否保留 | 持久化到 JSON（默认 250ms 去抖写） | 极端崩溃可能丢失 ≤250ms 变更 |
| A10 | 报告时间戳上限 | 超前 ≤60s、落后 ≤7 天 | 仅内存重试，离线窗口由恢复后的新采集覆盖 |
| A11 | client 与 server 是否共享文件存储实现 | 不共享：client 全异步（pi 交互进程不可阻塞主线程），server 同步写（独立进程、去抖合并，简单串行语义） | 两模块分文件隔离并有静态守护测试 |

**待确认项**：部署拓扑（单机/集群）、是否需要鉴权、`agent_snapshot` 采样频率业务预期值、状态内容字段是否需要可配置放开（当前无条件不上报）。

---

## 11. 测试与验收计划

映射任务第五节质量门槛 → 验证方法（结果见 [ACCEPTANCE.md](./ACCEPTANCE.md)）：

| 门槛 | 验证方法 |
|---|---|
| 1 状态覆盖 | `contracts.spec.ts`：硬编码手册 fixture（42 项）与 `STATE_REGISTRY` 双向集合比对 |
| 2 契约完整 | `contracts.spec.ts`：逐状态合法样本通过 + 非法变异（缺必填/类型错/超范围/非法枚举）拒绝；`mapper` 覆盖断言（42 状态皆有映射器） |
| 3 身份正确 | `identity.spec.ts`：name 缺失回退 session id；首报分配并持久化 uuid；重复注册不产生重复 uuid（同 uuid / 同进程身份两条路径）；persist 失败降级日志；name/cwd 变化保留 uuid + `identity_change` 历史 |
| 4 配置正确 | `config.spec.ts`：合法（url / host+port / 全字段）；缺失文件；JSON 非法；逐字段非法；未知键告警 |
| 5 可运行 | `scripts/demo.sh`（`pnpm demo`）：启动 server + 模拟 client，42 状态全覆盖，打印 agent 列表与历史 |
| 6 测试 | `pnpm test` 100% 通过；四类必备测试 + e2e（真实 HTTP server + 真实 client 库）；`make check` 全绿（lint/typecheck/format/coverage/audit） |
| 7 文档 | 本文档 + SPEC.md + RUNBOOK.md + ACCEPTANCE.md 与实现一致；契约以 `src/domain/contracts.ts` 为唯一信源 |

### 11.1 测试矩阵

| 测试文件 | 覆盖类别 | 关键用例 |
|---|---|---|
| `tests/contracts.spec.ts` | 契约校验 / 状态覆盖 | 注册表完整性、信封合法/非法、42 状态×(合法+≥1 非法变异)、未知状态、枚举/范围边界 |
| `tests/identity.spec.ts` | 身份分配 | 首报分配、持久化、复用、同身份粘连、replaced 路径、name/cwd 变化、身份文件写失败降级 |
| `tests/config.spec.ts` | 配置解析 | 6 类配置场景与降级 |
| `tests/transport.spec.ts` | 重连重试 | 退避序列、重试耗尽保留缓冲、恢复后 flush、溢出丢弃、毒信剔除 |
| `tests/registry.spec.ts` | 聚合存储 | latest 聚合、历史上限截断、查询 API、持久化往返 |
| `tests/e2e.spec.ts` | 端到端 | 真实 server + 真实 Reporter（模拟适配器）→ 42 状态全部到达、uuid 流、history 查询、部分拒绝 |
| `tests/mapper.spec.ts` | 映射正确性 | 42 状态映射器存在 + 输出契约合法（含隐私约束：无原文字段） |
```
