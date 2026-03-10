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
ORACLE_REQUIREMENTS_PATH="$ROOT_DIR/services/ip-oracle/requirements.txt"
ORACLE_RUNTIME312_PYTHON="$ROOT_DIR/services/ip-oracle/.venv_runtime312/bin/python"
ORACLE_VENV312_PYTHON="$ROOT_DIR/services/ip-oracle/.venv312/bin/python"
ORACLE_VENV_PYTHON="$ROOT_DIR/services/ip-oracle/.venv/bin/python"
ORACLE_TIMEOUT_SECONDS="${IP_ORACLE_STARTUP_TIMEOUT_SECONDS:-20}"
ORACLE_IMPORT_TIMEOUT_SECONDS="${IP_ORACLE_IMPORT_TIMEOUT_SECONDS:-20}"
ORACLE_BOOTSTRAP_TIMEOUT_SECONDS="${IP_ORACLE_BOOTSTRAP_TIMEOUT_SECONDS:-240}"
BACKEND_TIMEOUT_SECONDS="${OPS_BACKEND_STARTUP_TIMEOUT_SECONDS:-30}"
BACKEND_READY_TIMEOUT_SECONDS="${OPS_BACKEND_READY_TIMEOUT_SECONDS:-45}"
DASHBOARD_TIMEOUT_SECONDS="${OPS_DASHBOARD_STARTUP_TIMEOUT_SECONDS:-20}"
DASHBOARD_RETRY_ATTEMPTS="${OPS_DASHBOARD_READY_RETRY_ATTEMPTS:-2}"
DASHBOARD_RETRY_BACKOFF_SECONDS="${OPS_DASHBOARD_READY_RETRY_BACKOFF_SECONDS:-1}"
DASHBOARD_RETRY_WINDOW_SECONDS="${OPS_DASHBOARD_READY_RETRY_WINDOW_SECONDS:-2}"
DASHBOARD_READY_CONFIRMED=false

is_pid_alive() {
  local pid="${1:-}"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

is_port_listening() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
    return $?
  fi
  if command -v ss >/dev/null 2>&1; then
    ss -ltn "sport = :$port" 2>/dev/null | grep -q LISTEN
    return $?
  fi
  return 1
}

dashboard_log_ready() {
  [[ -f "$ROOT_DIR/tmp/dashboard.log" ]] && grep -q "ready in" "$ROOT_DIR/tmp/dashboard.log"
}

oracle_solver_import_ok() {
  local python_bin="$1"
  timeout "$ORACLE_IMPORT_TIMEOUT_SECONDS" "$python_bin" -c 'from ortools.sat.python import cp_model' >/dev/null 2>&1
}

bootstrap_oracle_runtime_venv() {
  if [[ ! -f "$ORACLE_REQUIREMENTS_PATH" ]]; then
    return 1
  fi

  local bootstrap_python=""
  local runtime_dir="$ROOT_DIR/services/ip-oracle/.venv_runtime312"
  local runtime_python="$ORACLE_RUNTIME312_PYTHON"
  for candidate in /usr/local/bin/python3.12 python3.12 python3; do
    if [[ -x "$candidate" ]]; then
      bootstrap_python="$candidate"
      break
    fi
    if command -v "$candidate" >/dev/null 2>&1; then
      bootstrap_python=$(command -v "$candidate")
      break
    fi
  done
  if [[ -z "$bootstrap_python" ]]; then
    return 1
  fi

  echo "Bootstrapping oracle runtime venv with $bootstrap_python" >&2
  timeout "$ORACLE_BOOTSTRAP_TIMEOUT_SECONDS" "$bootstrap_python" -m venv "$runtime_dir" >/dev/null 2>&1 || return 1
  timeout "$ORACLE_BOOTSTRAP_TIMEOUT_SECONDS" "$runtime_python" -m pip install -r "$ORACLE_REQUIREMENTS_PATH" >/dev/null 2>&1 || return 1
  oracle_solver_import_ok "$runtime_python"
}

resolve_oracle_python() {
  local candidates=()
  local first_executable=""
  if [[ -n "${IP_ORACLE_PYTHON_BIN:-}" ]]; then
    candidates+=("$IP_ORACLE_PYTHON_BIN")
  fi
  candidates+=(
    "$ORACLE_RUNTIME312_PYTHON"
    "$ORACLE_VENV312_PYTHON"
    "$ORACLE_VENV_PYTHON"
    "python3.12"
    "python3"
  )

  for candidate in "${candidates[@]}"; do
    if [[ -x "$candidate" ]]; then
      if [[ -z "$first_executable" ]]; then
        first_executable="$candidate"
      fi
      if oracle_solver_import_ok "$candidate"; then
        echo "$candidate"
        return
      fi
      echo "Skipping oracle python (solver import failed): $candidate" >&2
      continue
    fi
    if command -v "$candidate" >/dev/null 2>&1; then
      local resolved
      resolved=$(command -v "$candidate")
      if [[ -z "$first_executable" ]]; then
        first_executable="$resolved"
      fi
      if oracle_solver_import_ok "$resolved"; then
        echo "$resolved"
        return
      fi
      echo "Skipping oracle python (solver import failed): $resolved" >&2
    fi
  done

  if bootstrap_oracle_runtime_venv; then
    echo "$ORACLE_RUNTIME312_PYTHON"
    return
  fi

  if [[ -n "$first_executable" ]]; then
    echo "Proceeding with oracle python despite failed import probe: $first_executable" >&2
    echo "$first_executable"
    return
  fi

  echo "No working python runtime found for oracle sidecar (ortools cp_model import failed)." >&2
  exit 1
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

wait_for_backend_ready() {
  local base_url="$1"
  local token="$2"
  local timeout_s="$3"
  local deadline=$((SECONDS + timeout_s))

  while (( SECONDS < deadline )); do
    local code
    code=$(curl --max-time 2 -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer ${token}" "${base_url}/health/ready" || true)
    if [[ "$code" == "200" ]]; then
      return 0
    fi
    sleep 0.2
  done
  return 1
}

wait_for_dashboard_ready() {
  local host="$1"
  local timeout_s="$2"
  local pid_file="${3:-}"
  local deadline=$((SECONDS + timeout_s))
  local alt_host="${host/127.0.0.1/localhost}"

  while (( SECONDS < deadline )); do
    if curl --max-time 2 -fsS "${host}" >/dev/null 2>&1; then
      return 0
    fi
    if [[ "$alt_host" != "$host" ]] && curl --max-time 2 -fsS "${alt_host}" >/dev/null 2>&1; then
      return 0
    fi
    if [[ -n "$pid_file" && -f "$pid_file" ]]; then
      local pid
      pid=$(tr -d '\r\n' < "$pid_file")
      if is_pid_alive "$pid" && is_port_listening "$DASHBOARD_PORT" && dashboard_log_ready; then
        return 0
      fi
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
  local started_backend=0

  if [[ -f "$BACKEND_PID_FILE" ]] && kill -0 "$(cat "$BACKEND_PID_FILE")" 2>/dev/null; then
    echo "Backend already running (pid $(cat "$BACKEND_PID_FILE"))."
  else
    OPS_API_TOKEN="$TOKEN" LOG_LEVEL=info TRADING_ENABLED=true TRADING_MODE=paper \
      OPS_DEV_SESSION_PREFILL_ENABLED="$OPS_DEV_SESSION_PREFILL_ENABLED" \
      FW_ORACLE_BASE_URL="$FW_ORACLE_BASE_URL" \
      nohup npm run dev \
      > "$ROOT_DIR/tmp/backend.log" 2>&1 &
    echo $! > "$BACKEND_PID_FILE"
    started_backend=1
    echo "Backend started (pid $(cat "$BACKEND_PID_FILE"))."
    echo "Ops token prefill default: OPS_DEV_SESSION_PREFILL_ENABLED=${OPS_DEV_SESSION_PREFILL_ENABLED}"
  fi

  if ! wait_for_backend_health "$OPS_BASE_URL" "$TOKEN" "$BACKEND_TIMEOUT_SECONDS"; then
    echo "Backend health check failed at ${OPS_BASE_URL}/health (timeout ${BACKEND_TIMEOUT_SECONDS}s)." >&2
    if (( started_backend )); then
      kill "$(cat "$BACKEND_PID_FILE")" 2>/dev/null || true
      rm -f "$BACKEND_PID_FILE"
    fi
    exit 1
  fi

  if ! wait_for_backend_ready "$OPS_BASE_URL" "$TOKEN" "$BACKEND_READY_TIMEOUT_SECONDS"; then
    echo "Backend readiness check failed at ${OPS_BASE_URL}/health/ready (timeout ${BACKEND_READY_TIMEOUT_SECONDS}s)." >&2
    if (( started_backend )); then
      kill "$(cat "$BACKEND_PID_FILE")" 2>/dev/null || true
      rm -f "$BACKEND_PID_FILE"
    fi
    exit 1
  fi
}

start_dashboard() {
  if [[ -f "$DASHBOARD_PID_FILE" ]] && kill -0 "$(cat "$DASHBOARD_PID_FILE")" 2>/dev/null; then
    echo "Dashboard already running (pid $(cat "$DASHBOARD_PID_FILE"))."
    return
  fi

  nohup bash -lc "cd \"$ROOT_DIR/dashboard\" && VITE_OPS_BASE_URL=\"$OPS_BASE_URL\" npm run dev -- --host 0.0.0.0 --port \"$DASHBOARD_PORT\" --strictPort" \
    > "$ROOT_DIR/tmp/dashboard.log" 2>&1 &
  echo $! > "$DASHBOARD_PID_FILE"
  echo "Dashboard started (pid $(cat "$DASHBOARD_PID_FILE"))."

  if ! wait_for_dashboard_ready "http://127.0.0.1:${DASHBOARD_PORT}" "$DASHBOARD_TIMEOUT_SECONDS" "$DASHBOARD_PID_FILE"; then
    local retry
    for ((retry = 1; retry <= DASHBOARD_RETRY_ATTEMPTS; retry += 1)); do
      local backoff_seconds=$((DASHBOARD_RETRY_BACKOFF_SECONDS * retry))
      echo "Dashboard readiness retry ${retry}/${DASHBOARD_RETRY_ATTEMPTS}: waiting ${backoff_seconds}s before re-probe."
      sleep "$backoff_seconds"
      if wait_for_dashboard_ready "http://127.0.0.1:${DASHBOARD_PORT}" "$DASHBOARD_RETRY_WINDOW_SECONDS" "$DASHBOARD_PID_FILE"; then
        echo "Dashboard became ready after retry ${retry}/${DASHBOARD_RETRY_ATTEMPTS}."
        DASHBOARD_READY_CONFIRMED=true
        return 0
      fi
    done

    local dashboard_pid
    dashboard_pid=$(tr -d '\r\n' < "$DASHBOARD_PID_FILE" || true)
    local pid_alive="no"
    local listener_alive="no"
    local log_ready="no"

    if is_pid_alive "$dashboard_pid"; then
      pid_alive="yes"
    fi
    if is_port_listening "$DASHBOARD_PORT"; then
      listener_alive="yes"
    fi
    if dashboard_log_ready; then
      log_ready="yes"
    fi

    echo "WARNING: Dashboard readiness probe timed out after ${DASHBOARD_TIMEOUT_SECONDS}s at http://127.0.0.1:${DASHBOARD_PORT}."
    echo "Keeping oracle/backend running. Dashboard details: pid=${dashboard_pid:-missing} pid_alive=${pid_alive} listener=${listener_alive} log_ready=${log_ready}."
    echo "Retry status: npm run dev:ops:status"
    echo "Inspect logs: tail -n 120 tmp/dashboard.log"
    DASHBOARD_READY_CONFIRMED=false
    return 0
  fi

  DASHBOARD_READY_CONFIRMED=true
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
if [[ "$DASHBOARD_READY_CONFIRMED" == "true" ]]; then
  echo "  - dashboard: http://127.0.0.1:${DASHBOARD_PORT} (ok)"
else
  echo "  - dashboard: http://127.0.0.1:${DASHBOARD_PORT} (warning: startup probe timed out; run npm run dev:ops:status)"
fi
echo "FW-coupled runtime components (inside backend): DependencyResolver, FwProjectionAgent, Scanner->Risk->Execution pipeline."
echo "Re-check anytime: npm run dev:ops:status"
