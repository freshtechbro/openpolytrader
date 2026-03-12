#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT_DIR"

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
IP_ORACLE_HOST="${IP_ORACLE_HOST:-127.0.0.1}"
IP_ORACLE_PORT="${IP_ORACLE_PORT:-7071}"
FW_ORACLE_BASE_URL="${FW_ORACLE_BASE_URL:-http://${IP_ORACLE_HOST}:${IP_ORACLE_PORT}}"
DASHBOARD_PID_FILE="$ROOT_DIR/tmp/dashboard.pid"
DASHBOARD_LOG_FILE="$ROOT_DIR/tmp/dashboard.log"

http_code() {
  local url="$1"
  local auth="${2:-}"
  local code
  if [[ -n "$auth" ]]; then
    code=$(curl --max-time 3 -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer ${auth}" "$url" || true)
  else
    code=$(curl --max-time 3 -s -o /dev/null -w "%{http_code}" "$url" || true)
  fi
  if [[ -z "$code" ]]; then
    code="000"
  fi
  echo "$code"
}

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

oracle_status=$(http_code "${FW_ORACLE_BASE_URL}/health")
backend_status=$(http_code "${OPS_BASE_URL}/health" "$TOKEN")
backend_ready_status=$(http_code "${OPS_BASE_URL}/health/ready" "$TOKEN")
dashboard_status_127=$(http_code "http://127.0.0.1:${DASHBOARD_PORT}")
dashboard_status_localhost=$(http_code "http://localhost:${DASHBOARD_PORT}")
dashboard_status="$dashboard_status_127"
dashboard_probe_url="http://127.0.0.1:${DASHBOARD_PORT}"
dashboard_ok=false
dashboard_pid=""
dashboard_pid_alive=false
dashboard_listener=false
dashboard_log_ready=false

if [[ -f "$DASHBOARD_PID_FILE" ]]; then
  dashboard_pid=$(tr -d '\r\n' < "$DASHBOARD_PID_FILE")
  if is_pid_alive "$dashboard_pid"; then
    dashboard_pid_alive=true
  fi
fi

if is_port_listening "$DASHBOARD_PORT"; then
  dashboard_listener=true
fi

if [[ -f "$DASHBOARD_LOG_FILE" ]] && grep -q "ready in" "$DASHBOARD_LOG_FILE"; then
  dashboard_log_ready=true
fi

if [[ "$dashboard_status_127" == "200" ]]; then
  dashboard_ok=true
elif [[ "$dashboard_status_localhost" == "200" ]]; then
  dashboard_ok=true
  dashboard_status="$dashboard_status_localhost"
  dashboard_probe_url="http://localhost:${DASHBOARD_PORT}"
elif [[ "$dashboard_log_ready" == "true" && "$dashboard_pid_alive" == "true" && "$dashboard_listener" == "true" ]]; then
  dashboard_ok=true
  dashboard_status="log-ready"
  dashboard_probe_url="$DASHBOARD_LOG_FILE (pid/listener verified)"
fi

echo "Dev stack status"
echo "  oracle_health=${oracle_status} (${FW_ORACLE_BASE_URL}/health)"
echo "  backend_health=${backend_status} (${OPS_BASE_URL}/health)"
echo "  backend_ready=${backend_ready_status} (${OPS_BASE_URL}/health/ready)"
echo "  dashboard_http=${dashboard_status} (${dashboard_probe_url})"
echo "  dashboard_pid=${dashboard_pid:-missing} alive=${dashboard_pid_alive} pid_file=${DASHBOARD_PID_FILE}"
echo "  dashboard_listener=${dashboard_listener} port=${DASHBOARD_PORT}"
echo "  dashboard_log_ready=${dashboard_log_ready} log=${DASHBOARD_LOG_FILE}"
echo "  fw_components=DependencyResolver,FwProjectionAgent,Scanner,Risk,Execution (inside backend process)"

if [[ "$oracle_status" != "200" ]]; then
  echo "Oracle health is not 200." >&2
  exit 1
fi
if [[ "$backend_status" != "200" ]]; then
  echo "Backend health is not 200." >&2
  exit 1
fi
if [[ "$backend_ready_status" != "200" ]]; then
  echo "Backend readiness is not 200." >&2
  exit 1
fi
if [[ "$dashboard_ok" != "true" ]]; then
  echo "Dashboard health is not confirmed (HTTP != 200 and no live log-ready fallback)." >&2
  exit 1
fi

echo "All required dev:ops components are up."
