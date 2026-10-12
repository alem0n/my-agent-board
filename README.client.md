# my-agent-board client

pi agent 状态监控 client（自包含部署产物）。订阅 pi 扩展的 41 个事件并周期采样环境快照，共 42 项状态，HTTP+JSON 上报到独立部署的 server。

## 安装

```bash
pi install ./          # 作为 pi 包安装（含 pi 清单）
pi list                # 查看已配置包
```

或显式加载：

```bash
pi --extension ./extension/agent-board.ts
```

## 配置

配置文件 `~/.pi/agent/agent-board-server.json`（可选；缺失时输出错误日志并降级默认地址）：

```json
{
  "url": "http://your-server-host:7878",
  "name": "my-agent"
}
```

环境变量 `AGENT_BOARD_SERVER_CONFIG` 可覆盖配置文件路径。

## 运行足迹

- `~/.pi/agent/agent-board-identity.json` — server 分配的 uuid
- `~/.pi/agent/agent-board-client.log` — client 日志（JSON 行）

全异步 IO，不阻塞 pi 主线程。上报失败即丢弃（监控状态持续刷新，下一周期重采新状态）。

## 协议

信封协议版本 `1`；每个状态有独立 semver 契约。server 与 client 可独立演进，不兼容时 server 返回 `E_UNSUPPORTED_PROTOCOL`。

完整设计见主仓库 `docs/DESIGN.md`。
