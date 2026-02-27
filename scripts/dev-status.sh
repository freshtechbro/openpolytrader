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

oracle_status=$(http_code "${FW_ORACLE_BASE_URL}/health")
backend_status=$(http_code "${OPS_BASE_URL}/health" "$TOKEN")
backend_ready_status=$(http_code "${OPS_BASE_URL}/health/ready" "$TOKEN")
dashboard_status=$(http_code "http://127.0.0.1:${DASHBOARD_PORT}")

echo "Dev stack status"
echo "  oracle_health=${oracle_status} (${FW_ORACLE_BASE_URL}/health)"
echo "  backend_health=${backend_status} (${OPS_BASE_URL}/health)"
echo "  backend_ready=${backend_ready_status} (${OPS_BASE_URL}/health/ready)"
echo "  dashboard_http=${dashboard_status} (http://127.0.0.1:${DASHBOARD_PORT})"
echo "  fw_components=DependencyResolver,FwProjectionAgent,Scanner,Risk,Execution (inside backend process)"

if [[ "$oracle_status" != "200" ]]; then
  echo "Oracle health is not 200." >&2
  exit 1
fi
if [[ "$backend_status" != "200" ]]; then
  echo "Backend health is not 200." >&2
  exit 1
fi
if [[ "$dashboard_status" != "200" ]]; then
  echo "Dashboard HTTP status is not 200." >&2
  exit 1
fi

echo "All required dev:ops components are up."
