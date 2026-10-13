# my-agent-board client

> 📦 **本分支（仓库默认分支）是 client 安装产物**：15 个模块、零运行时依赖。
> 源码、测试与完整文档在 `main` 分支：`git clone -b main https://github.com/alem0n/my-agent-board`

pi agent 状态监控 client。订阅 pi 扩展的 41 个事件并周期采样环境快照，共 42 项状态，HTTP+JSON 上报到独立部署的 server（server 分支单独部署）。

## 安装

官方一行安装（克隆本默认分支，即此产物）：

```bash
pi install https://github.com/alem0n/my-agent-board
pi list                # 查看已配置包
```

锁定版本（发布 tag；pi 的 URL 安装不支持 `#tag` 引用，用两步）：

```bash
git clone --depth 1 --branch v0.1.0 https://github.com/alem0n/my-agent-board my-ab-client
pi install ./my-ab-client
```

或克隆本分支后本地安装：

```bash
git clone --depth 1 https://github.com/alem0n/my-agent-board my-ab-client
pi install ./my-ab-client
```

或显式加载：

```bash
pi --extension ./extension/agent-board.ts
```

**安装位置**：URL 安装落在 `~/.pi/agent/git/github.com/alem0n/my-agent-board`（路径按 URL
推导，与分支/tag 无关）；本地路径安装不复制，settings 存源目录的相对引用。

## 配置

配置文件 `~/.pi/agent/agent-board-server.json`（可选；缺失时降级默认地址，问题记录到 issues）：

```json
{
  "url": "http://your-server-host:7878",
  "name": "my-agent",
  "logLevel": "info"
}
```

字段：`url`（或 `host`+`port`）、`name`、`logLevel`、`reportIntervalMs`、`flushIntervalMs`、`requestTimeoutMs`、`maxBufferSize`、`flushOnCount`、`heartbeatIntervalMs`（默认 20s，`0` = 关闭）、`retry`。非法值一律降级默认，不静默失败。

**进程级心跳**：扩展加载即启动（与 session 生命周期解耦），周期性向 server 发送携带身份 uuid 的心跳，使 server 能在无活跃会话的静默期判断本进程是否在线（server 侧 `online` 派生，见 README.server）。身份尚未建立时跳过（不伪造身份）；失败不进入重试队列（下一周期自然重试）。

环境变量 `AGENT_BOARD_SERVER_CONFIG` 可覆盖配置文件路径。

## 日志（默认关闭）

client 默认**零日志**：不创建日志文件、不产生任何日志 IO。两种方式显式开启：

- 配置文件 `"logLevel": "info"`（取值 `silent` / `trace` / `debug` / `info` / `warn` / `error`）；
- 环境变量 `AGENT_BOARD_LOG_LEVEL`（优先级更高；配置文件本身损坏时的诊断入口）。

开启后日志为 JSON 行，写入 `~/.pi/agent/agent-board-client.log`，内容含 `reporter.start`、`report.retry`、`transport.unreachable`、`report.shutdownDropped`、`client.config.issue` 等键。

## 运行足迹

- `~/.pi/agent/agent-board-identity.json` — server 分配的 uuid
- `~/.pi/agent/agent-board-client.log` — 日志（**仅 logLevel 开启时存在**，默认不创建）

全异步 IO，不阻塞 pi 主线程。发送失败按指数退避重试并保留缓冲；server 不可达时停止上报并周期健康探测，恢复后继续；会话关闭时尽力排空缓冲（限时 3s），超时或不可达时丢弃残留并计数。

## 排障

- **先开日志**：默认零日志，排障前在配置文件加 `"logLevel": "info"`（或设 `AGENT_BOARD_LOG_LEVEL=info`）后复现。
- 日志出现 `transport.unreachable`：server 未运行，或 `agent-board-server.json` 的 `url` 与实际部署不一致。client 自动重试与探测，不影响 pi 本身。
- 日志出现 `report.shutdownDropped`（字段 `dropped`）：关闭时缓冲未能发出（server 不可达）。启动 server 后，下一会话重新采集全部当前状态。
- 日志出现带 `reason: "shutdown"` 的 `buffer.overflow`：关闭排空超过 3s 限时后的残留丢弃，原因同上。
- 运行中出现 `buffer.overflow`（无 reason）：server 不可达期间缓冲饱和（默认 1000 条）。server 恢复后自动排空最新 1000 条。

## 协议

信封协议版本 `1`；每个状态有独立 semver 契约。server 与 client 可独立演进，不兼容时 server 返回 `E_UNSUPPORTED_PROTOCOL`。

完整设计见主仓库 `docs/DESIGN.md`。
