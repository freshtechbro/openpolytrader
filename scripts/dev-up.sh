#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT_DIR"

mkdir -p tmp

TOKEN="${OPS_API_TOKEN:-}"
if [[ -z "$TOKEN" && -f "$ROOT_DIR/.env" ]]; then
  TOKEN=$(grep -m1 '^OPS_API_TOKEN=' "$ROOT_DIR/.env" | cut -d= -f2- | tr -d '\r')
fi

if [[ -z "$TOKEN" ]]; then
  echo "Missing OPS token. Set OPS_API_TOKEN or add OPS_API_TOKEN to .env." >&2
  exit 1
fi

DASHBOARD_PORT="${DASHBOARD_PORT:-5174}"
OPS_BASE_URL="${OPS_BASE_URL:-http://localhost:3000}"
OPS_DEV_SESSION_PREFILL_ENABLED="${OPS_DEV_SESSION_PREFILL_ENABLED:-true}"
IP_ORACLE_HOST="${IP_ORACLE_HOST:-127.0.0.1}"
IP_ORACLE_PORT="${IP_ORACLE_PORT:-7071}"
FW_ORACLE_BASE_URL="${FW_ORACLE_BASE_URL:-http://${IP_ORACLE_HOST}:${IP_ORACLE_PORT}}"

BACKEND_PID_FILE="$ROOT_DIR/tmp/backend.pid"
DASHBOARD_PID_FILE="$ROOT_DIR/tmp/dashboard.pid"
ORACLE_PID_FILE="$ROOT_DIR/tmp/ip-oracle.pid"
ORACLE_LOG_FILE="$ROOT_DIR/tmp/ip-oracle.log"
ORACLE_APP_PATH="$ROOT_DIR/services/ip-oracle/app.py"
ORACLE_VENV_PYTHON="$ROOT_DIR/services/ip-oracle/.venv/bin/python"
ORACLE_TIMEOUT_SECONDS="${IP_ORACLE_STARTUP_TIMEOUT_SECONDS:-20}"
BACKEND_TIMEOUT_SECONDS="${OPS_BACKEND_STARTUP_TIMEOUT_SECONDS:-30}"
DASHBOARD_TIMEOUT_SECONDS="${OPS_DASHBOARD_STARTUP_TIMEOUT_SECONDS:-20}"

resolve_oracle_python() {
  if [[ -n "${IP_ORACLE_PYTHON_BIN:-}" ]]; then
    echo "$IP_ORACLE_PYTHON_BIN"
    return
  fi

  if [[ -x "$ORACLE_VENV_PYTHON" ]]; then
    echo "$ORACLE_VENV_PYTHON"
    return
  fi

  echo "python3"
}

wait_for_oracle_health() {
  local base_url="$1"
  local timeout_s="$2"
  local deadline=$((SECONDS + timeout_s))

  while (( SECONDS < deadline )); do
    if curl --max-time 2 -fsS "${base_url}/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.2
  done
  return 1
}

wait_for_backend_health() {
  local base_url="$1"
  local token="$2"
  local timeout_s="$3"
  local deadline=$((SECONDS + timeout_s))

  while (( SECONDS < deadline )); do
    if curl --max-time 2 -fsS -H "Authorization: Bearer ${token}" "${base_url}/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.2
  done
  return 1
}

wait_for_dashboard_ready() {
  local host="$1"
  local timeout_s="$2"
  local deadline=$((SECONDS + timeout_s))

  while (( SECONDS < deadline )); do
    if curl --max-time 2 -fsS "${host}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.2
  done
  return 1
}

start_oracle_sidecar() {
  if [[ ! -f "$ORACLE_APP_PATH" ]]; then
    echo "Missing oracle sidecar app: $ORACLE_APP_PATH" >&2
    exit 1
  fi

  if [[ -f "$ORACLE_PID_FILE" ]]; then
    local existing_pid
    existing_pid=$(cat "$ORACLE_PID_FILE" || true)
    if [[ -n "$existing_pid" ]] && kill -0 "$existing_pid" 2>/dev/null; then
      if wait_for_oracle_health "$FW_ORACLE_BASE_URL" 2; then
        echo "IP oracle already running (pid $existing_pid)."
        return
      fi
      echo "IP oracle pid $existing_pid is unhealthy; restarting."
      kill "$existing_pid" 2>/dev/null || true
      sleep 0.5
    fi
    rm -f "$ORACLE_PID_FILE"
  fi

  local python_bin
  python_bin=$(resolve_oracle_python)
  if [[ ! -x "$python_bin" ]] && ! command -v "$python_bin" >/dev/null 2>&1; then
    echo "Python runtime not found for oracle sidecar: $python_bin" >&2
    exit 1
  fi

  IP_ORACLE_HOST="$IP_ORACLE_HOST" IP_ORACLE_PORT="$IP_ORACLE_PORT" \
    nohup "$python_bin" "$ORACLE_APP_PATH" > "$ORACLE_LOG_FILE" 2>&1 &
  echo $! > "$ORACLE_PID_FILE"
  echo "IP oracle started (pid $(cat "$ORACLE_PID_FILE"), python $python_bin)."

  if ! wait_for_oracle_health "$FW_ORACLE_BASE_URL" "$ORACLE_TIMEOUT_SECONDS"; then
    echo "IP oracle health check failed at ${FW_ORACLE_BASE_URL}/health (timeout ${ORACLE_TIMEOUT_SECONDS}s)." >&2
    kill "$(cat "$ORACLE_PID_FILE")" 2>/dev/null || true
    rm -f "$ORACLE_PID_FILE"
    exit 1
  fi
}

start_backend() {
  if [[ -f "$BACKEND_PID_FILE" ]] && kill -0 "$(cat "$BACKEND_PID_FILE")" 2>/dev/null; then
    echo "Backend already running (pid $(cat "$BACKEND_PID_FILE"))."
    return
  fi

  OPS_API_TOKEN="$TOKEN" LOG_LEVEL=info TRADING_ENABLED=true TRADING_MODE=paper \
    OPS_DEV_SESSION_PREFILL_ENABLED="$OPS_DEV_SESSION_PREFILL_ENABLED" \
    FW_ORACLE_BASE_URL="$FW_ORACLE_BASE_URL" \
    nohup npm run dev \
    > "$ROOT_DIR/tmp/backend.log" 2>&1 &
  echo $! > "$BACKEND_PID_FILE"
  echo "Backend started (pid $(cat "$BACKEND_PID_FILE"))."
  echo "Ops token prefill default: OPS_DEV_SESSION_PREFILL_ENABLED=${OPS_DEV_SESSION_PREFILL_ENABLED}"

  if ! wait_for_backend_health "$OPS_BASE_URL" "$TOKEN" "$BACKEND_TIMEOUT_SECONDS"; then
    echo "Backend health check failed at ${OPS_BASE_URL}/health (timeout ${BACKEND_TIMEOUT_SECONDS}s)." >&2
    kill "$(cat "$BACKEND_PID_FILE")" 2>/dev/null || true
    rm -f "$BACKEND_PID_FILE"
    exit 1
  fi
}

start_dashboard() {
  if [[ -f "$DASHBOARD_PID_FILE" ]] && kill -0 "$(cat "$DASHBOARD_PID_FILE")" 2>/dev/null; then
    echo "Dashboard already running (pid $(cat "$DASHBOARD_PID_FILE"))."
    return
  fi

  VITE_OPS_BASE_URL="$OPS_BASE_URL" \
    nohup npm --prefix dashboard run dev -- --host 0.0.0.0 --port "$DASHBOARD_PORT" --strictPort \
    > "$ROOT_DIR/tmp/dashboard.log" 2>&1 &
  echo $! > "$DASHBOARD_PID_FILE"
  echo "Dashboard started (pid $(cat "$DASHBOARD_PID_FILE"))."

  if ! wait_for_dashboard_ready "http://127.0.0.1:${DASHBOARD_PORT}" "$DASHBOARD_TIMEOUT_SECONDS"; then
    echo "Dashboard health check failed at http://127.0.0.1:${DASHBOARD_PORT} (timeout ${DASHBOARD_TIMEOUT_SECONDS}s)." >&2
    kill "$(cat "$DASHBOARD_PID_FILE")" 2>/dev/null || true
    rm -f "$DASHBOARD_PID_FILE"
    exit 1
  fi
}

start_oracle_sidecar
start_backend
start_dashboard

echo "Open: http://localhost:${DASHBOARD_PORT}"
echo "Oracle: ${FW_ORACLE_BASE_URL}"
echo "Logs: tmp/backend.log, tmp/dashboard.log, tmp/ip-oracle.log"
echo "Startup checks:"
echo "  - oracle sidecar: ${FW_ORACLE_BASE_URL}/health (ok)"
echo "  - backend API: ${OPS_BASE_URL}/health (ok)"
echo "  - dashboard: http://127.0.0.1:${DASHBOARD_PORT} (ok)"
echo "FW-coupled runtime components (inside backend): DependencyResolver, FwProjectionAgent, Scanner->Risk->Execution pipeline."
echo "Re-check anytime: npm run dev:ops:status"
