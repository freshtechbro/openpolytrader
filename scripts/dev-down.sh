#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT_DIR"

BACKEND_PID_FILE="$ROOT_DIR/tmp/backend.pid"
DASHBOARD_PID_FILE="$ROOT_DIR/tmp/dashboard.pid"
ORACLE_PID_FILE="$ROOT_DIR/tmp/ip-oracle.pid"

has_listener_on_port() {
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

listener_pids_on_port() {
  local port="$1"
  if ! command -v lsof >/dev/null 2>&1; then
    echo "unknown"
    return
  fi
  local pids
  pids=$(lsof -ti tcp:"$port" 2>/dev/null | tr '\n' ' ' | xargs || true)
  if [[ -z "$pids" ]]; then
    echo "none"
    return
  fi
  echo "$pids"
}

stop_pid() {
  local name="$1"
  local pid_file="$2"
  local port="${3:-}"
  local has_port=false
  if [[ -n "$port" ]]; then
    has_port=true
  fi

  if [[ ! -f "$pid_file" ]]; then
    if [[ "$has_port" == "true" ]] && has_listener_on_port "$port"; then
      echo "$name pid file missing, but listener is active on port $port (pids: $(listener_pids_on_port "$port"))."
    else
      echo "$name not running (missing pid file)."
    fi
    return
  fi

  local pid
  pid=$(cat "$pid_file" || true)
  if [[ -z "$pid" ]]; then
    if [[ "$has_port" == "true" ]] && has_listener_on_port "$port"; then
      echo "$name pid file empty, but listener is active on port $port (pids: $(listener_pids_on_port "$port"))."
    else
      echo "$name not running (empty pid file)."
    fi
    rm -f "$pid_file"
    return
  fi

  if kill -0 "$pid" 2>/dev/null; then
    local current_pgid
    current_pgid=$(ps -o pgid= -p "$$" 2>/dev/null | tr -d ' ' || true)
    local pgid
    pgid=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ' || true)
    if [[ -n "$pgid" && "$pgid" != "$current_pgid" ]]; then
      kill -TERM -"$pgid" 2>/dev/null || true
    else
      kill "$pid" 2>/dev/null || true
    fi
    sleep 0.5
    if kill -0 "$pid" 2>/dev/null; then
      # Escalate once if graceful stop did not terminate the process group.
      if [[ -n "$pgid" && "$pgid" != "$current_pgid" ]]; then
        kill -KILL -"$pgid" 2>/dev/null || true
      else
        kill -KILL "$pid" 2>/dev/null || true
      fi
      sleep 0.5
      if kill -0 "$pid" 2>/dev/null; then
        if [[ -n "$pgid" && "$pgid" != "$current_pgid" ]]; then
          echo "$name still running (pid $pid, pgid $pgid)."
        else
          echo "$name still running (pid $pid)."
        fi
        return
      fi
    fi
    if [[ "$has_port" == "true" ]] && has_listener_on_port "$port"; then
      echo "$name process stopped (pid $pid), but listener is still active on port $port (pids: $(listener_pids_on_port "$port"))."
    else
      echo "$name stopped (pid $pid)."
    fi
  else
    if [[ "$has_port" == "true" ]] && has_listener_on_port "$port"; then
      echo "$name pid file is stale (pid $pid), but listener is active on port $port (pids: $(listener_pids_on_port "$port"))."
    else
      echo "$name not running (stale pid $pid)."
    fi
  fi

  rm -f "$pid_file"
}

stop_listeners_on_port() {
  local name="$1"
  local port="$2"

  if ! command -v lsof >/dev/null 2>&1; then
    return
  fi

  local pids
  pids=$(lsof -ti tcp:"$port" 2>/dev/null || true)
  if [[ -z "$pids" ]]; then
    return
  fi

  kill $pids 2>/dev/null || true
  sleep 0.5

  local remaining
  remaining=$(lsof -ti tcp:"$port" 2>/dev/null || true)
  if [[ -n "$remaining" ]]; then
    kill -9 $remaining 2>/dev/null || true
    sleep 0.5
  fi

  echo "Stopped ${name} on port ${port} (pids: $pids)."
}

stop_pid "Backend" "$BACKEND_PID_FILE" "3000"
stop_pid "Dashboard" "$DASHBOARD_PID_FILE" "5174"
stop_pid "IP oracle" "$ORACLE_PID_FILE" "7071"

# Best-effort cleanup for tmux-based dev session and stray Vite servers.
if command -v tmux >/dev/null 2>&1; then
  if tmux has-session -t openpoly 2>/dev/null; then
    tmux kill-session -t openpoly 2>/dev/null || true
    echo "Stopped tmux session openpoly."
  fi
fi

stop_listeners_on_port "Backend" "3000"
stop_listeners_on_port "Vite" "5174"
stop_listeners_on_port "IP oracle" "7071"
