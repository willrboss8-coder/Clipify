#!/usr/bin/env bash
# Single-container entrypoint: Next.js web + background job worker, shared STORAGE_ROOT/disk.
# If either process exits, the other is stopped and the container exits with that exit code.

set -euo pipefail

term_handler() {
  [[ -n "${WEB_PID:-}" ]] && kill "$WEB_PID" 2>/dev/null || true
  [[ -n "${WORKER_PID:-}" ]] && kill "$WORKER_PID" 2>/dev/null || true
  [[ -n "${WEB_PID:-}" ]] && wait "$WEB_PID" 2>/dev/null || true
  [[ -n "${WORKER_PID:-}" ]] && wait "$WORKER_PID" 2>/dev/null || true
  exit 143
}
trap term_handler SIGTERM SIGINT

node server.js &
WEB_PID=$!

npm run worker &
WORKER_PID=$!

# First background job to terminate (success or failure).
# Temporarily disable errexit: a failed child makes wait -n non-zero; we still must stop the sibling.
set +e
wait -n
WAIT_STATUS=$?
set -e

kill "${WEB_PID}" "${WORKER_PID}" 2>/dev/null || true
set +e
wait "${WEB_PID}" 2>/dev/null || true
wait "${WORKER_PID}" 2>/dev/null || true
set -e

exit "${WAIT_STATUS}"
