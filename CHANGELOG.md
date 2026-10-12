# Changelog

本项目遵守 [Keep a Changelog](https://keepachangelog.com/en/2.0.0/) 与 [Semantic Versioning](https://semver.org/spec/v2.0.0.html)。

## [Unreleased]

### Added

- pi agent 状态监控系统：client 为 pi 扩展（`extension/agent-board.ts`），采集全部 42 项受支持状态（41 个扩展事件 + 周期 agent_snapshot）按契约上报；server 聚合存储并提供查询 API。
- client/server 分离部署：`pnpm pack:client` 生成自包含 client 产物（build/client，零运行时依赖、pi 清单）；模块闭包经 dependency-cruiser 双向规则与 `tests/separation.spec.ts` 机器校验，协议（版本号+错误码+契约）为两侧唯一耦合。
- 移除离线 outbox 持久化：上报缓冲改为纯内存，重试耗尽/缓冲超限/关闭残留一律丢弃并计数。监控状态持续刷新，旧状态价值快速衰减，离线持久化无收益（JSONL-CHANGE）。
- client 侧全异步 IO（日志/身份/outbox/配置均经 `fs/promises` + 串行写队列），不阻塞 pi 主线程；静态守护测试 `tests/async-io.spec.ts` 防止同步调用回潮。
- 状态注册表与逐状态契约（`src/domain/contracts.ts`），信封协议版本 `1`，加法式契约演进。
- agent 身份方案：name 缺失回退 session id；server 权威分配 uuid；身份文件持久化与降级。
- client 传输可靠性：指数退避重试、断线健康探测恢复、内存缓冲 + JSONL outbox 转储。
- server 端点：`/v1/report`、`/v1/report/batch`、`/v1/agents[/:uuid[/history]]`、`/v1/health`，原子文件持久化。
- 一键本地演示 `pnpm demo`（`scripts/demo.sh`），149 个测试用例，`make check` 全绿。

### Changed

- 《SPEC.md》需求清单由模板占位改为监控系统需求（REQ-001…REQ-011）。

## [0.1.0] - 2026-10-07

### Added

- 项目模板首版：分层目录、统一质量门禁（make check）、AGENTS.md 规范。
<!-- 版本链接：替换为项目的 compare/release 地址后使用。 -->
