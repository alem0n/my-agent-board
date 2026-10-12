# RUNBOOK — my-agent-board 运行与测试说明

> 交付物③。设计见 [DESIGN.md](./DESIGN.md)，需求见 [SPEC.md](./SPEC.md)，验收结果见 [ACCEPTANCE.md](./ACCEPTANCE.md)。

## 1. 环境要求

- Node.js ≥ 22.19（本实现使用全局 `fetch`、`AbortSignal.timeout`、`crypto.randomUUID`）
- pnpm ≥ 10（仓库固定 `pnpm@12.9.1`）
- 一键安装：`pnpm install`

依赖说明：运行时依赖仅 `pino`（日志）；其余全部使用 Node 内置模块（`http`/`crypto`/`fs`/`path`）。`@earendil-works/pi-coding-agent` 为 dev 依赖，仅类型导入（编译期消除）。

## 1.5 部署拓扑与独立部署产物

| 拓扑 | server | client | 说明 |
|---|---|---|---|
| A 同机开发 | `pnpm dev`（127.0.0.1:7878） | `pi --extension ./extension/agent-board.ts` | 本仓库 |
| B 独立 client 产物 | 任意主机 | `pnpm pack:client` → `pi install ./build/client` | client 自包含 15 模块、零运行时依赖 |
| C 跨机部署 | 远端主机（`--port`/`--data-dir` 独立配置） | 配置文件 `url` 指向远端 | 协议为唯一耦合 |

```bash
pnpm pack:client     # 生成 build/client/（入口 extension/agent-board.ts + client 模块闭包）
pi install ./build/client   # 作为独立 pi 包安装（含 pi 清单与宿主 peer 依赖声明）
```

分离契约由机器校验：`make layers` 的 client-server 双向规则、`tests/separation.spec.ts`
（闭包/产物自包含/零第三方运行时导入）、`tests/async-io.spec.ts`（client 无同步 IO）。
详见 DESIGN.md §1.5。

---

.## 2. 一键本地演示（验收门槛 5）

```bash
pnpm demo            # 或 make check 之后：bash scripts/demo.sh
# PORT=8099 pnpm demo  # 指定端口
# KEEP_DATA=1 pnpm demo # 保留临时数据目录用于排障
```

脚本依次完成（全部使用真实代码路径）：

1. 在临时目录启动 board server（`node --import tsx src/index.ts`）。
2. 等待 `/v1/health` 就绪（未就绪则打印 server 日志并失败）。
3. 启动模拟 client（`src/simulate.ts`）：真实 Reporter + HttpTransport + 身份文件，
   注入 `SimulatedStateSource` 回放全部 42 个状态（41 事件 + 1 快照）。
4. 打印 client 端统计（collected / sent / droppedRejected / 覆盖检查）。
5. 打印 server 端观察结果：`GET /v1/agents`（注册表）与历史样本。
6. 优雅关闭 server，清理临时目录。

**成功判据**：`sent` ≥ 42；`droppedRejected: 0`；agent 记录 `stateCount: 42`；退出码 0。

最近一次运行输出示例：

```
{"level":"info",...,"states":42,"msg":"reporter.start"}
{"level":"info",...,"emittedEvents":41,"collected":46,"sent":44,"droppedRejected":0,"stateCount":42,"msg":"simulate.done"}
{"level":"info",...,"agent":{"uuid":"…","name":"demo-agent",…,"reportCount":44,"stateCount":42}}
[demo] DONE
```

## 3. 手动启动

### server

```bash
pnpm dev                      # 默认 127.0.0.1:7878，数据目录 ./data
pnpm dev -- --port=8099 --host=0.0.0.0 --data-dir=/var/lib/agent-board --log-level=debug
```

端点（全部返回 `application/json`）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/health` | 健康检查（含协议版本、agent 数、运行时长） |
| GET | `/v1/agents` | agent 列表摘要 |
| GET | `/v1/agents/:uuid` | 单 agent 注册记录 + 逐状态最新载荷 |
| GET | `/v1/agents/:uuid/history?state=&limit=&since=` | 历史记录 |
| POST | `/v1/report` | 单信封上报 |
| POST | `/v1/report/batch` | 批量上报（原子批，≤512 条 / 4MB） |

### client（pi 扩展）安装

前置条件：

1. board server 在可达地址运行（见上节）。
2. 准备配置文件（可选；缺失时 `client.config.missing` 错误日志 + 默认 `http://127.0.0.1:7878`）。

方式一：显式加载（开发推荐，每次启动指定）

```bash
pi --extension ./extension/agent-board.ts            # TypeScript 源码（jiti 直接编译）
pi --extension ./dist/extension/agent-board.js        # 或 pnpm build 后的编译产物
```

方式二：用户级安装（所有项目生效，写入 `~/.pi/agent/settings.json`）

```jsonc
{
  "extensions": [
    "+/abs/path/to/my-agent-board/dist/extension/agent-board.js"
  ]
}
```

> 路径须为绝对路径或 `~` 开头（用户设置相对 agent 目录解析）。本项目入口跨 `../src/`
> 导入，因此须保持 `dist/extension/` 与 `dist/src/` 的目录结构，或直接引用仓库源文件。

方式三：本地 Pi 包安装（仓库已声明 `pi` 清单 + `pi-package` 关键字）

```bash
pi install ./                    # 安装本仓库为本地包（写入 settings.json 的 packages）
pi list                          # 查看已配置包
pi remove ./                     # 卸载
```

清单（`package.json`）：`"pi": { "extensions": ["./extension/agent-board.ts"] }`，
宿主包 `@earendil-works/pi-coding-agent` 声明在 `peerDependencies`（勿打包进依赖）。

方式四：项目级安装（仅当前项目，需项目信任）

```bash
pi install --local ./            # 写入 .pi/settings.json（项目信任后加载）
```

或直接放入项目扩展目录 `.pi/extensions/`。

验证安装

```bash
# 1) server 运行中，启动 pi 会话
pi --print "hello"
# 2) 查看 client 日志（应出现 reporter.start 与采集/上报记录）
tail -f ~/.pi/agent/agent-board-client.log
# 3) server 端查询（应出现该 agent 与状态计数）
curl http://127.0.0.1:7878/v1/agents | jq '.agents[] | {uuid, name, stateCount, reportCount}'
```

配置文件 `~/.pi/agent/agent-board-server.json`（可选；缺失时输出错误日志并降级默认值）：

```json
{
  "url": "http://127.0.0.1:7878",
  "name": "my-agent",
  "reportIntervalMs": 30000,
  "flushIntervalMs": 2000,
  "requestTimeoutMs": 5000,
  "maxBufferSize": 1000,
  "flushOnCount": 50,
  "retry": { "maxAttempts": 5, "initialDelayMs": 500, "maxDelayMs": 30000, "backoffFactor": 2, "jitter": true }
}
```

client 本地文件：

- `~/.pi/agent/agent-board-identity.json` — server 分配的 uuid（原子写）。
- `~/.pi/agent/agent-board-client.log` — client 日志（JSON 行）。

## 4. 测试

```bash
pnpm test                              # 全量（149 个用例）
pnpm test -- tests/contracts.spec.ts   # 单文件
pnpm exec vitest run -t "uuid 分配"    # 按用例名过滤
pnpm run test:coverage                 # 覆盖率报告（阈值 80%）
make check                             # 完整门禁：lint + typecheck + format + 覆盖率 + 审计
```

测试文件与覆盖类别：

| 文件 | 类别 |
|---|---|
| `tests/contracts.spec.ts` | 状态覆盖（42 项 vs 手册）、逐状态契约合法/非法、信封校验 |
| `tests/mapper.spec.ts`、`tests/mapper-edges.spec.ts` | 映射覆盖与降级路径、隐私约束 |
| `tests/identity.spec.ts` | name 回退 session id、uuid 分配/持久化/复用、name/cwd 变化 |
| `tests/config.spec.ts` | 配置解析 6 类场景（合法/缺失/JSON 非法/字段非法/未知键/路径优先级） |
| `tests/transport.spec.ts` | 退避序列、重试/耗尽/恢复、缓冲溢出丢弃、毒信剔除、413 拆分、身份持久化失败降级 |
| `tests/registry.spec.ts` | latest 聚合、历史上限与查询、持久化往返 |
| `tests/http-client.spec.ts` | HTTP 传输解析（成功/部分拒绝/413/非 2xx/网络失败） |
| `tests/file-store.spec.ts` | 原子写、损坏文件降级 |
| `tests/e2e.spec.ts` | 真实 server + 真实 Reporter：42 状态到达、uuid 流、全部错误码 |
| `tests/entry.spec.ts` | server 入口启停与优雅关闭、公共导出面 |
| `tests/async-io.spec.ts` | client 侧静态守护：无同步文件 IO、不导入 server 同步模块、存储端口运行时为 Promise |
| `tests/errors.spec.ts` | 错误码与协议错误类 |
| `tests/pi-extension.spec.ts` | FakeExtensionAPI 驱动扩展胶水：订阅绑定、环境快照、project_trust undecided |

## 5. 分层与门禁

```bash
pnpm lint:layers   # dependency-cruiser：domain ← services ← infrastructure
pnpm typecheck     # tsc（含 extension/）
pnpm lint          # eslint
pnpm format:check  # prettier
pnpm audit --prod  # 生产依赖审计
```

## 6. 常见排查

| 现象 | 排查 |
|---|---|
| client 无上报 | 查看 `~/.pi/agent/agent-board-client.log` 的 `client.config.*` 与 `transport.unreachable`；`GET /v1/health` 验证 server |
| server 无 agent | 确认 `data/agents.json` 损坏会以空注册表启动（`registryStore.loadFailed` 日志） |
| 上报被拒 | `report.rejected` 日志含 code/state/field；对照 DESIGN.md §6.2 错误码表 |
| uuid 变化 | 身份文件丢失或 server 重置；`identity.persistFailed` 日志指示持久化失败降级 |
