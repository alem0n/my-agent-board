# my-agent-board server

pi agent 状态监控 server（自包含部署产物）。校验上报、分配 agent uuid、聚合最新状态与历史，对外提供 HTTP 查询 API。

## 启动

```bash
npm install --omit=dev    # 或 pnpm install --prod（仅 pino 一个依赖）
npm start                 # node dist/src/index.js，默认 127.0.0.1:7878
```

参数示例（**注意 `--` 分隔符不可省**：npm 靠它把参数透传给启动脚本，缺了会被 npm 吞掉）：

```bash
npm start -- --port=8099 --host=0.0.0.0 --log-level=info
```

参数：`--port`、`--host`、`--log-level`、`--web`（值参数同时支持 `--port=8099` 与 `--port 8099` 两种形式）。

**注册表为纯内存**：进程内聚合，不写盘、无数据目录，重启即清空——监控状态持续刷新，服务端状态无离线保留价值。

## 内置 Web UI（可选）

加 `--web` 挂载单页可视化界面（同端口的 `GET /` 与 `/ui`）：

```bash
npm start -- --web
npm start -- --web --port=8099
```

功能：agent 列表（uuid / name / cwd / lastSeen / 状态数 / 上报数）、单 agent 逐状态最新载荷、历史记录筛选，每 3 秒自动刷新，零外部资源（离线可用）。

**默认关闭**：想用自己的可视化（Grafana、自写面板等）时不加 `--web` 即可，直接消费 `/v1/*` JSON API。

## 端口被占用

`EADDRINUSE` 表示端口已被占用（通常是上一实例未退出）。换端口或先杀掉旧进程：

```powershell
# Windows（PowerShell）
netstat -ano | findstr :7878        # 查到最后一列的 PID
taskkill /PID <PID> /F
```

```bash
# Linux / macOS
lsof -i :7878                       # 或 ss -tlnp | grep 7878
kill <PID>                          # 或 kill -9 <PID>
```

或直接换端口：`npm start -- --web --port=7879`。

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

client 是独立的 pi 扩展，与 server 分离部署。仓库默认分支即 client 产物：

```bash
pi install https://github.com/alem0n/my-agent-board    # 官方一行安装（克隆默认分支）
```

完整设计见主仓库 `docs/DESIGN.md`。
