# Changelog

本项目遵守 [Keep a Changelog](https://keepachangelog.com/en/2.0.0/) 与 [Semantic Versioning](https://semver.org/spec/v2.0.0.html)。

## [Unreleased]

### Added

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
