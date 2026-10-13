# Changelog

本项目遵守 [Keep a Changelog](https://keepachangelog.com/en/2.0.0/) 与 [Semantic Versioning](https://semver.org/spec/v2.0.0.html)。

## [Unreleased]

### Added

- pi agent 状态监控系统：client 为 pi 扩展（`extension/agent-board.ts`），采集全部 42 项受支持状态（41 个扩展事件 + 周期 agent_snapshot）按契约上报；server 聚合存储并提供查询 API。
- client/server 分离部署：`pnpm pack:client` 生成自包含 client 产物（build/client，零运行时依赖、pi 清单）；模块闭包经 dependency-cruiser 双向规则与 `tests/separation.spec.ts` 机器校验，协议（版本号+错误码+契约）为两侧唯一耦合。
- 移除离线 outbox 持久化：上报缓冲改为纯内存，重试耗尽/缓冲超限/关闭残留一律丢弃并计数。监控状态持续刷新，旧状态价值快速衰减，离线持久化无收益（JSONL-CHANGE）。
- git 分发设计：单开发仓 + 双 orphan 分支（client/server），由 `pnpm split:client` / `pnpm split:server` 从产物 force 重建（gh-pages 模式）。用户按需克隆单个分支，互不含对方代码；server 产物新增 `pnpm pack:server`（编译闭包 + pino 依赖声明）。
- 文档：client 三条安装路径与取舍（官方 URL `pi install https://github.com/alem0n/my-agent-board` / client 分支精简克隆 / 源码开发），记录 pi URL 安装只支持默认分支的实测结论；README.server.md 补 Web UI 用法、npm `--` 参数透传与端口占用处理说明：同端口挂载 `GET /` 与 `/ui`，单页应用渲染 agent 列表/逐状态最新载荷/历史筛选，自动刷新 3s，零外部资源。默认 404，用户可自行可视化（直接消费 /v1/* JSON API）。
- client 侧全异步 IO（日志/身份/outbox/配置均经 `fs/promises` + 串行写队列），不阻塞 pi 主线程；静态守护测试 `tests/async-io.spec.ts` 防止同步调用回潮。
- 状态注册表与逐状态契约（`src/domain/contracts.ts`），信封协议版本 `1`，加法式契约演进。
- agent 身份方案：name 缺失回退 session id；server 权威分配 uuid；身份文件持久化与降级。
- client 传输可靠性：指数退避重试、断线健康探测恢复、内存缓冲 + JSONL outbox 转储。
- server 端点：`/v1/report`、`/v1/report/batch`、`/v1/agents[/:uuid[/history]]`、`/v1/health`，原子文件持久化。
- 一键本地演示 `pnpm demo`（`scripts/demo.sh`），149 个测试用例，`make check` 全绿。

### Changed

- 《SPEC.md》需求清单由模板占位改为监控系统需求（REQ-001…REQ-012）。
- **client 默认零日志**（REQ-012）：未显式配置前不创建 `agent-board-client.log`、不产生任何日志 IO。开启方式：配置文件 `"logLevel": "info"`（取值 silent/trace/debug/info/warn/error），或环境变量 `AGENT_BOARD_LOG_LEVEL`（优先级更高，配置文件损坏时的诊断入口）。配置文件级 issues 改为解析后在级别确定时补输出（不再无条件在解析期打印）。

### Fixed

- 关闭时的「尽力 flush」原为死代码：`stop()` 先置 `running=false`，而 `flushCycle` 入口守卫即 `!this.running`，关闭路径从未尝试发送——`session_shutdown` 后缓冲（哪怕 server 可达）一律直接丢弃。现在关闭路径先等待进行中的 flush 退出，再对剩余缓冲每批单次尝试发送（整体限时 3s，不随 retry 配置重试），超时或不可达时才丢弃并计数（`report.shutdownDropped`）；`session_shutdown` 处理器改为 `await reporter.stop()`；关闭同时唤醒断线恢复探测的退避睡眠（可取消真实定时器），进程退出不再可能挂起最长一个退避周期（默认至 30s）。
- 修复提交钩子：`.githooks/*` 统一 LF 行尾（CRLF 使 `^M` 进入命令名，钩子在非 Windows 环境失效）；`pre-commit` 中 `make precommit` 失败现真正拦截提交（此前靠末行 `echo` 兜成退出码 0 的「假门禁」）；`make` 缺失时明确告警放行（与 gitleaks 同模式）。

## [0.1.0] - 2026-10-07

### Added

- 项目模板首版：分层目录、统一质量门禁（make check）、AGENTS.md 规范。
<!-- 版本链接：替换为项目的 compare/release 地址后使用。 -->
