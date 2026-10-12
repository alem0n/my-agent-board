# my-agent-board server

pi agent 状态监控 server（自包含部署产物）。校验上报、分配 agent uuid、聚合最新状态与历史，对外提供 HTTP 查询 API。

## 启动

```bash
npm install --omit=dev    # 或 pnpm install --prod（仅 pino 一个依赖）
npm start                 # node dist/src/index.js，默认 127.0.0.1:7878
npm start -- --port=8099 --host=0.0.0.0 --data-dir=/var/lib/agent-board --log-level=info
```

参数：`--port`、`--host`、`--data-dir`、`--log-level`。注册表持久化为数据目录下的 `agents.json`（原子写 + 去抖合并）。

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/health` | 健康检查（状态、协议版本、agent 数） |
| GET | `/v1/agents` | agent 列表摘要 |
| GET | `/v1/agents/:uuid` | 单 agent 注册记录 + 逐状态最新载荷 |
| GET | `/v1/agents/:uuid/history?state=&limit=&since=` | 历史记录 |
| POST | `/v1/report` | 单信封上报 |
| POST | `/v1/report/batch` | 批量上报（原子批，上限 512 条 / 4MB） |

```bash
curl http://127.0.0.1:7878/v1/health
curl http://127.0.0.1:7878/v1/agents
```

## client 安装

client 是独立的 pi 扩展，与 server 分离部署。从仓库的 `client` 分支获取：

```bash
git clone --depth 1 --branch client <repo-url> my-ab-client
pi install ./my-ab-client
```

完整设计见主仓库 `docs/DESIGN.md`。
