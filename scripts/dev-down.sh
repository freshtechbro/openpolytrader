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
    local pgid
    pgid=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ' || true)
    if [[ -n "$pgid" ]]; then
      kill -TERM -"$pgid" 2>/dev/null || true
    else
      kill "$pid" 2>/dev/null || true
    fi
    sleep 0.5
    if kill -0 "$pid" 2>/dev/null; then
      if [[ -n "$pgid" ]]; then
        echo "$name still running (pid $pid, pgid $pgid)."
      else
        echo "$name still running (pid $pid)."
      fi
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

# Best-effort cleanup for tmux-based dev session and stray Vite servers.
if command -v tmux >/dev/null 2>&1; then
  if tmux has-session -t openpoly 2>/dev/null; then
    tmux kill-session -t openpoly 2>/dev/null || true
    echo "Stopped tmux session openpoly."
  fi
fi

if command -v lsof >/dev/null 2>&1; then
  VITE_PIDS=$(lsof -ti tcp:5174 2>/dev/null || true)
  if [[ -n "$VITE_PIDS" ]]; then
    kill $VITE_PIDS 2>/dev/null || true
    sleep 0.5
    echo "Stopped Vite on port 5174 (pids: $VITE_PIDS)."
  fi
fi
