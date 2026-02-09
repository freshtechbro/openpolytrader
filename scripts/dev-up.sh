#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT_DIR"

mkdir -p tmp

TOKEN="${OPS_API_TOKEN:-}"
if [[ -z "$TOKEN" && -f "$ROOT_DIR/dashboard/.env" ]]; then
  TOKEN=$(grep -m1 '^VITE_OPS_API_TOKEN=' "$ROOT_DIR/dashboard/.env" | cut -d= -f2- | tr -d '\r')
fi

if [[ -z "$TOKEN" ]]; then
  echo "Missing OPS token. Set OPS_API_TOKEN or add VITE_OPS_API_TOKEN to dashboard/.env." >&2
  exit 1
fi

DASHBOARD_PORT="${DASHBOARD_PORT:-5174}"
OPS_BASE_URL="${OPS_BASE_URL:-http://localhost:3000}"

BACKEND_PID_FILE="$ROOT_DIR/tmp/backend.pid"
DASHBOARD_PID_FILE="$ROOT_DIR/tmp/dashboard.pid"

start_backend() {
  if [[ -f "$BACKEND_PID_FILE" ]] && kill -0 "$(cat "$BACKEND_PID_FILE")" 2>/dev/null; then
    echo "Backend already running (pid $(cat "$BACKEND_PID_FILE"))."
    return
  fi

  OPS_API_TOKEN="$TOKEN" LOG_LEVEL=info TRADING_ENABLED=true TRADING_MODE=paper \
    nohup npm run dev \
    > "$ROOT_DIR/tmp/backend.log" 2>&1 &
  echo $! > "$BACKEND_PID_FILE"
  echo "Backend started (pid $(cat "$BACKEND_PID_FILE"))."
}

start_dashboard() {
  if [[ -f "$DASHBOARD_PID_FILE" ]] && kill -0 "$(cat "$DASHBOARD_PID_FILE")" 2>/dev/null; then
    echo "Dashboard already running (pid $(cat "$DASHBOARD_PID_FILE"))."
    return
  fi

  VITE_OPS_BASE_URL="$OPS_BASE_URL" VITE_OPS_API_TOKEN="$TOKEN" \
    nohup npm --prefix dashboard run dev -- --host 0.0.0.0 --port "$DASHBOARD_PORT" --strictPort \
    > "$ROOT_DIR/tmp/dashboard.log" 2>&1 &
  echo $! > "$DASHBOARD_PID_FILE"
  echo "Dashboard started (pid $(cat "$DASHBOARD_PID_FILE"))."
}

start_backend
start_dashboard

echo "Open: http://localhost:${DASHBOARD_PORT}"
echo "Logs: tmp/backend.log, tmp/dashboard.log"
