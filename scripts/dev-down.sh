#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT_DIR"

BACKEND_PID_FILE="$ROOT_DIR/tmp/backend.pid"
DASHBOARD_PID_FILE="$ROOT_DIR/tmp/dashboard.pid"

stop_pid() {
  local name="$1"
  local pid_file="$2"

  if [[ ! -f "$pid_file" ]]; then
    echo "$name not running (missing pid file)."
    return
  fi

  local pid
  pid=$(cat "$pid_file" || true)
  if [[ -z "$pid" ]]; then
    echo "$name not running (empty pid file)."
    rm -f "$pid_file"
    return
  fi

  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    sleep 0.5
    if kill -0 "$pid" 2>/dev/null; then
      echo "$name still running (pid $pid)."
      return
    fi
    echo "$name stopped (pid $pid)."
  else
    echo "$name not running (stale pid $pid)."
  fi

  rm -f "$pid_file"
}

stop_pid "Backend" "$BACKEND_PID_FILE"
stop_pid "Dashboard" "$DASHBOARD_PID_FILE"
