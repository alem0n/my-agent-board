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
