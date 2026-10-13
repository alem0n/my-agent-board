#!/usr/bin/env bash
# 本地一键演示：启动 board server + 模拟 client（驱动真实 client 库，覆盖全部 42 状态）。
# 输出可观察的状态上报记录（agent 列表 / 历史样本 / 覆盖检查）。
#
# 用法：
#   pnpm demo              # 默认端口 7878
#   PORT=8099 pnpm demo    # 指定端口
#   KEEP_DATA=1 pnpm demo  # 保留临时数据目录（排障）
set -euo pipefail

PORT="${PORT:-7878}"
HOST="127.0.0.1"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agent-board-demo-XXXXXX")"
CLIENT_DIR="${DATA_DIR}/client"
SERVER_URL="http://${HOST}:${PORT}"

SERVER_PID=""
cleanup() {
  if [[ -n "${SERVER_PID}" && -z "${KEEP_DATA:-}" ]]; then
    kill "${SERVER_PID}" 2>/dev/null || true
    wait "${SERVER_PID}" 2>/dev/null || true
    rm -rf "${DATA_DIR}"
  elif [[ -n "${SERVER_PID}" ]]; then
    kill "${SERVER_PID}" 2>/dev/null || true
    wait "${SERVER_PID}" 2>/dev/null || true
    echo "[demo] data dir kept: ${DATA_DIR}"
  fi
}
trap cleanup EXIT

echo "[demo] starting server on ${SERVER_URL}（注册表纯内存；data dir 仅存日志与 client 配置）"
cd "${ROOT}"
exec node --import tsx src/index.ts --host="${HOST}" --port="${PORT}" \
  >"${DATA_DIR}/server.log" 2>&1 &
SERVER_PID=$!

# 等待 server 健康（最多 20 秒）；同时确认进程存活，避免慢性绑定失败被旧实例掩盖
for _ in $(seq 1 40); do
  if ! kill -0 "${SERVER_PID}" 2>/dev/null; then
    echo "[demo] FAILED: server process exited during startup; server log:" >&2
    cat "${DATA_DIR}/server.log" >&2 || true
    exit 1
  fi
  if node -e "fetch('${SERVER_URL}/v1/health').then(r=>{if(!r.ok)throw 0}).catch(()=>{throw 1})" 2>/dev/null; then
    break
  fi
  sleep 0.5
done

if ! node -e "fetch('${SERVER_URL}/v1/health').then(r=>{if(!r.ok)throw 0})" 2>/dev/null; then
  echo "[demo] FAILED: server did not become healthy; server log:" >&2
  cat "${DATA_DIR}/server.log" >&2 || true
  exit 1
fi
echo "[demo] server healthy"

echo "[demo] writing hermetic client config"
cat >"${DATA_DIR}/client-config.json" <<JSON
{
  "url": "${SERVER_URL}",
  "name": "demo-agent",
  "reportIntervalMs": 30000,
  "flushIntervalMs": 2000
}
JSON

echo "[demo] running simulated client (all 42 states via real Reporter/Transport)"
node --import tsx src/simulate.ts --config="${DATA_DIR}/client-config.json" --agent-dir="${CLIENT_DIR}"

echo "[demo] server-side observation: registered agents"
node -e "fetch('${SERVER_URL}/v1/agents').then(r=>r.json()).then(j=>console.log(JSON.stringify(j,null,2)))"

echo "[demo] server server.log (last lines):"
tail -n 5 "${DATA_DIR}/server.log" || true

echo "[demo] DONE"
