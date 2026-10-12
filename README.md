# my-agent-board

pi agent 状态监控系统。client 是一个 pi 扩展，采集 pi agent 的全部受支持状态并上报。server 接收、聚合并对外查询。

- **client**：`extension/agent-board.ts`，订阅 pi 的 41 个扩展事件，并周期采样一个环境快照，共 **42 项状态**。
- **server**：独立 Node 进程，校验上报、分配 agent uuid、按 uuid 聚合最新状态与历史。
- **协议**：HTTP + JSON。信封带协议版本，每个状态有独立带版本号的契约。

通信方式、状态清单、字段约束与错误码见 [`docs/DESIGN.md`](docs/DESIGN.md)。

## 功能特性

- 覆盖 pi 扩展手册中的全部受支持状态（41 事件 + 1 快照）。
- 每个状态一条独立契约（字段、类型、必填、取值范围、版本号）。
- agent 身份：name 未设置时回退 session id；uuid 由 server 分配并本地持久化。
- 可靠传输：指数退避重试、断线健康探测恢复、内存缓冲（超限丢弃最旧，监控态无需持久化）。
- 隐私设计：只上报长度、计数、键名和枚举，不采集提示词、命令与参数内容。
- client 全异步 IO，不阻塞 pi 主线程。
- client 与 server 可分别独立部署。

## 环境要求

- Node.js ≥ 22.19
- pnpm ≥ 10（仓库锁定 `pnpm@12.9.1`）
- 真实使用 client 时需要已安装 [pi](https://pi.dev)（`curl -fsSL https://pi.dev/install.sh | sh`）

server 与 client 均无外部 SaaS 或付费依赖。运行时依赖仅 `pino`（日志），其余全部使用 Node 内置模块。

## 快速开始

```bash
git clone <repo-url> my-agent-board
cd my-agent-board
pnpm install
```

一条命令完成本地启动（server + 模拟 client）：

```bash
pnpm demo
```

该脚本会启动 server、注入一个模拟 pi 环境驱动真实 client 库回放全部 42 项状态，并打印 server 端观察结果。成功时输出包含：

```
"emittedEvents":41,"collected":46,"sent":44,"droppedRejected":0,...,"snapshotStates":42
"agent":{"uuid":"<分配的 uuid>","name":"demo-agent",...,"reportCount":44,"stateCount":42}
[demo] DONE
```

server 退出后自动清理临时数据。指定端口或保留数据目录：

```bash
PORT=8099 pnpm demo
KEEP_DATA=1 pnpm demo
```

## 使用说明

### 1. 启动 server

```bash
pnpm dev          # 默认 127.0.0.1:7878，数据目录 ./data
pnpm dev -- --port=8099 --host=0.0.0.0 --data-dir=/var/lib/agent-board --log-level=debug
pnpm dev -- --web      # 挂载内置 Web UI（GET / 与 /ui）
```

参数：`--port`、`--host`、`--data-dir`、`--log-level`、`--web`。非法值自动回退默认并记录日志。

Web UI 为**开关参数、默认关闭**：你需要可视化时加 `--web`（同端口 `/` 与 `/ui`，自动刷新 3s，零外部资源）；想用自己的可视化（Grafana、自写面板……）时不开即可，直接消费 `/v1/*` JSON API。

### 2. server API

| 方法 | 路径                                            | 说明                                  |
| ---- | ----------------------------------------------- | ------------------------------------- |
| GET  | `/v1/health`                                    | 健康检查（状态、协议版本、agent 数）  |
| GET  | `/v1/agents`                                    | agent 列表摘要                        |
| GET  | `/v1/agents/:uuid`                              | 单 agent 注册记录 + 逐状态最新载荷    |
| GET  | `/v1/agents/:uuid/history?state=&limit=&since=` | 历史记录                              |
| POST | `/v1/report`                                    | 单信封上报                            |
| POST | `/v1/report/batch`                              | 批量上报（原子批，上限 512 条 / 4MB） |

示例：

```bash
curl http://127.0.0.1:7878/v1/health
curl http://127.0.0.1:7878/v1/agents | jq '.agents[] | {uuid, name, stateCount, reportCount}'
curl "http://127.0.0.1:7878/v1/agents/<uuid>/history?state=agent_snapshot&limit=5"
```

注册表持久化为 `--data-dir` 下的 `agents.json`（原子写 + 去抖合并）。

### 3. 安装 client 插件

前置条件：server 在可达地址运行。

**按需获取**——三条路径（均已实测）：

```bash
# 方式一：官方 URL 一行安装（克隆默认分支 main，根 package.json 自带 pi 清单）
pi install https://github.com/alem0n/my-agent-board

# 方式二：精简克隆，不含任何 server 代码（client 分支为 orphan 产物分支）
git clone --depth 1 --branch client https://github.com/alem0n/my-agent-board my-ab-client
pi install ./my-ab-client

# 方式三：源码开发
git clone --branch main https://github.com/alem0n/my-agent-board
```

取舍：方式一最省事，但磁盘上会带 server 源码（client 运行时闭包不含它们，由
`tests/separation.spec.ts` 保证）；方式二只拉 15 个 client 模块，适合严格精简的环境。

> pi 的 URL 安装只支持**默认分支**——`github:user/repo#branch`、`git+https://…#branch`、
> tarball URL 实测均不被 pi 的安装解析器支持（报路径不存在或 clone 失败）。
> 锁定特定 client 版本用方式二克隆指定分支。

**方式一：显式加载（开发推荐）**

```bash
pi --extension ./extension/agent-board.ts        # TypeScript 源码，jiti 直接编译
pi --extension ./dist/extension/agent-board.js   # pnpm build 后的编译产物
```

**方式二：用户级安装**（写入 `~/.pi/agent/settings.json`，对所有项目生效）

```jsonc
{
  "extensions": ["+/abs/path/to/my-agent-board/dist/extension/agent-board.js"]
}
```

**方式三：本地 pi 包安装**

```bash
pi install ./              # 仓库已声明 pi 清单（pi-package 关键字）
pi list                    # 查看已配置包
pi remove ./               # 卸载
```

**方式四：项目级安装**（仅当前项目，需项目信任）

```bash
pi install --local ./      # 写入 .pi/settings.json
```

或把独立 client 产物 `build/client` 整体拷贝到 `.pi/extensions/`。

### 4. client 配置

配置文件 `~/.pi/agent/agent-board-server.json`（可选）。缺失时输出错误日志并降级到默认地址。

```json
{
  "url": "http://127.0.0.1:7878",
  "name": "my-agent",
  "reportIntervalMs": 30000,
  "flushIntervalMs": 2000,
  "requestTimeoutMs": 5000,
  "maxBufferSize": 1000,
  "flushOnCount": 50,
  "retry": {
    "maxAttempts": 5,
    "initialDelayMs": 500,
    "maxDelayMs": 30000,
    "backoffFactor": 2,
    "jitter": true
  }
}
```

`url` 与 `host` + `port` 二选一。全字段语义见 [`docs/DESIGN.md`](docs/DESIGN.md) §6.3。环境变量 `AGENT_BOARD_SERVER_CONFIG` 可覆盖配置文件路径（用于测试与隔离部署）。

client 运行时写入三个本地文件：

| 文件                                    | 用途                   |
| --------------------------------------- | ---------------------- |
| `~/.pi/agent/agent-board-identity.json` | server 分配的 uuid     |
| `~/.pi/agent/agent-board-client.log`    | client 日志（JSON 行） |

client 在 TUI / RPC / print / JSON 全模式下均可运行。它只观察会话，不修改会话内容；`project_trust` 返回 `undecided`。

## 测试与质量门禁

```bash
pnpm test                    # 全量（159 个用例）
pnpm test -- tests/e2e.spec.ts
pnpm exec vitest run -t "uuid 分配"
pnpm run test:coverage
make check                   # 完整门禁：lint + typecheck + format + 覆盖率 + 依赖审计
make layers                  # 分层依赖契约 + client/server 分离规则
```

必测类别齐备：契约校验、身份分配、配置解析、重连重试，外加端到端、扩展胶水、pi 模拟器与文件存储。覆盖率阈值 80%。

## 项目结构

```
extension/agent-board.ts     pi 扩展入口（client 方式一/三的加载点）
src/domain/                  契约、状态注册表、校验、身份规则（无外部依赖）
src/services/                Reporter（client 采集编排）、AgentRegistry（server 聚合）
src/infrastructure/          HTTP server / HTTP client / 文件存储 / pi 扩展胶水 / 模拟器
src/index.ts                 server 入口
src/simulate.ts              模拟 client 入口（演示与手动验证）
scripts/demo.sh              一键本地演示
scripts/pack-client.mjs      client 独立打包产物
tests/                       测试镜像源码树
docs/                        设计文档与验收记录
```

分层依赖方向单向指向 domain（由 `make layers` 机器校验）。

## 开发指南

变更前请读 [`AGENTS.md`](AGENTS.md)（项目规范）与 [`docs/SPEC.md`](docs/SPEC.md)（需求清单）。

### 质量门禁

提交前执行 `make check`。`make precommit`（git 钩子）运行其快速子集。任何代码变更必须附带或更新对应测试。

### 修改或新增状态契约

契约的唯一信源是 `src/domain/contracts.ts` 的 `STATE_REGISTRY`。

1. 新增状态：向注册表追加条目（不修改既有契约结构）。
2. 字段变更：按 semver 升契约版本；收紧或删除字段升 MAJOR，放宽或新增可选字段升 MINOR。
3. 同步更新 `tests/fixtures/samples.ts` 合法样本。
4. `tests/contracts.spec.ts` 覆盖注册表完整性；`tests/mapper*.spec.ts` 覆盖映射器输出。

### 修改 client 运行时

client 在 pi 交互进程内运行，禁止同步文件 IO。`tests/async-io.spec.ts` 静态扫描 `fs.*Sync(`，`tests/separation.spec.ts` 断言 client 闭包不含 server 模块与第三方运行时导入。

## 部署拓扑

| 拓扑             | server     | client                                           |
| ---------------- | ---------- | ------------------------------------------------ |
| 同机开发         | `pnpm dev` | `pi --extension ./extension/agent-board.ts`      |
| 独立 client 产物 | 任意主机   | `pnpm pack:client` → `pi install ./build/client` |
| 跨机部署         | 远端主机   | 配置 `url` 指向远端 server                       |

```bash
pnpm pack:client      # 生成 build/client/（15 个模块、零运行时依赖、pi 清单）
```

分离契约与演进规则见 [`docs/DESIGN.md`](docs/DESIGN.md) §1.5 与 §3.3。

## 常见问题

| 现象                 | 排查                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| client 无上报        | 查看 `~/.pi/agent/agent-board-client.log` 中的 `client.config.*` 与 `transport.unreachable`                                     |
| server 无 agent 记录 | `GET /v1/health` 确认存活；检查 `--data-dir` 下 `agents.json` 是否损坏（损坏时以空注册表启动并记录 `registryStore.loadFailed`） |
| 上报被拒绝           | client 日志 `report.rejected` 含 code 与字段；错误码对照 [`docs/DESIGN.md`](docs/DESIGN.md) §6.2                                |
| uuid 每次变化        | 身份文件丢失或持久化失败（`identity.persistFailed` 指示降级）                                                                   |
| 端口被占用           | `PORT=...` 指定其他端口；确认无遗留进程                                                                                         |

## 文档导航

| 文档                                     | 内容                                                                             |
| ---------------------------------------- | -------------------------------------------------------------------------------- |
| [docs/DESIGN.md](docs/DESIGN.md)         | 完整设计：状态清单、逐状态契约、信封、身份、接口、错误码、时序图、假设、测试计划 |
| [docs/SPEC.md](docs/SPEC.md)             | 意图与需求原子清单                                                               |
| [docs/RUNBOOK.md](docs/RUNBOOK.md)       | 运行、安装、测试、部署与排障                                                     |
| [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md) | 验收门槛逐条对照表与证据                                                         |
| [CHANGELOG.md](CHANGELOG.md)             | 版本变更记录                                                                     |

## 许可

MIT。见 [LICENSE](LICENSE)。
