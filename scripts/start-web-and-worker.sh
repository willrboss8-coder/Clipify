#!/usr/bin/env bash
# Single-container entrypoint: Next.js web + transcribe worker + main worker (split pipeline).
# Shared STORAGE_ROOT/disk. If any process exits, the others are stopped and the container exits.
#
# Main worker runs with CLIP_PIPE_SPLIT_TRANSCRIBE=1 (post-transcribe stages only); transcribe
# worker claims queued jobs and runs extract+faster-whisper. See lib/runProcessJob.ts.

set -euo pipefail

term_handler() {
  [[ -n "${WEB_PID:-}" ]] && kill "$WEB_PID" 2>/dev/null || true
  [[ -n "${TRANSCRIBE_PID:-}" ]] && kill "$TRANSCRIBE_PID" 2>/dev/null || true
  [[ -n "${WORKER_PID:-}" ]] && kill "$WORKER_PID" 2>/dev/null || true
  [[ -n "${WEB_PID:-}" ]] && wait "$WEB_PID" 2>/dev/null || true
  [[ -n "${TRANSCRIBE_PID:-}" ]] && wait "$TRANSCRIBE_PID" 2>/dev/null || true
  [[ -n "${WORKER_PID:-}" ]] && wait "$WORKER_PID" 2>/dev/null || true
  exit 143
}
trap term_handler SIGTERM SIGINT

node server.js &
WEB_PID=$!

npm run worker:transcribe &
TRANSCRIBE_PID=$!

CLIP_PIPE_SPLIT_TRANSCRIBE=1 npm run worker &
WORKER_PID=$!

# First background job to terminate (success or failure).
set +e
wait -n
WAIT_STATUS=$?
set -e

kill "${WEB_PID}" "${TRANSCRIBE_PID}" "${WORKER_PID}" 2>/dev/null || true
set +e
wait "${WEB_PID}" 2>/dev/null || true
wait "${TRANSCRIBE_PID}" 2>/dev/null || true
wait "${WORKER_PID}" 2>/dev/null || true
set -e

exit "${WAIT_STATUS}"
