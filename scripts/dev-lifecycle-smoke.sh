#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT_DIR"

START_CMD="${DEV_LIFECYCLE_START_CMD:-npm run dev:ops}"
STATUS_CMD="${DEV_LIFECYCLE_STATUS_CMD:-npm run dev:ops:status}"
DOWN_CMD="${DEV_LIFECYCLE_DOWN_CMD:-npm run dev:ops:down}"
EXPECT_DOWN_STATUS_EXIT_CODE="${DEV_LIFECYCLE_EXPECT_DOWN_STATUS_EXIT_CODE:-1}"
STATUS_DOWN_LOG="$ROOT_DIR/tmp/dev-lifecycle-smoke.status-down.log"

run_cmd() {
  local cmd="$1"
  bash -lc "$cmd"
}

cleanup() {
  run_cmd "$DOWN_CMD" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "[dev-lifecycle] step=preclean cmd=${DOWN_CMD}"
run_cmd "$DOWN_CMD" >/dev/null 2>&1 || true

echo "[dev-lifecycle] step=start cmd=${START_CMD}"
run_cmd "$START_CMD"

echo "[dev-lifecycle] step=status_up cmd=${STATUS_CMD}"
run_cmd "$STATUS_CMD"

echo "[dev-lifecycle] step=down cmd=${DOWN_CMD}"
run_cmd "$DOWN_CMD"

echo "[dev-lifecycle] step=status_down_expected_fail cmd=${STATUS_CMD}"
set +e
run_cmd "$STATUS_CMD" >"$STATUS_DOWN_LOG" 2>&1
status_down_code=$?
set -e

if [[ "$status_down_code" -ne "$EXPECT_DOWN_STATUS_EXIT_CODE" ]]; then
  echo "[dev-lifecycle] FAIL expected status-down exit code ${EXPECT_DOWN_STATUS_EXIT_CODE}, got ${status_down_code}." >&2
  echo "[dev-lifecycle] status-down output:" >&2
  cat "$STATUS_DOWN_LOG" >&2
  exit 1
fi

echo "[dev-lifecycle] PASS status-down exit code matched expected value (${EXPECT_DOWN_STATUS_EXIT_CODE})."
echo "[dev-lifecycle] status-down log: ${STATUS_DOWN_LOG}"

trap - EXIT
