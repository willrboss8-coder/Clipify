#!/usr/bin/env bash
# Single-container entrypoint: Next.js web + transcribe worker + main worker (split pipeline).
# Shared STORAGE_ROOT/disk. If any process exits, the others are stopped and the container exits.
#
# Portable: no wait -n (macOS ships bash 3.2). Uses parallel wait subshells + polling.
#
# Main worker runs with CLIP_PIPE_SPLIT_TRANSCRIBE=1 (post-transcribe stages only); transcribe
# worker claims queued jobs and runs extract+faster-whisper. See lib/runProcessJob.ts.

set -euo pipefail

WAIT_TMP=$(mktemp -d)
trap 'rm -rf "$WAIT_TMP" 2>/dev/null || true' EXIT

term_handler() {
  [[ -n "${WEB_PID:-}" ]] && kill "$WEB_PID" 2>/dev/null || true
  [[ -n "${TRANSCRIBE_PID:-}" ]] && kill "$TRANSCRIBE_PID" 2>/dev/null || true
  [[ -n "${WORKER_PID:-}" ]] && kill "$WORKER_PID" 2>/dev/null || true
  [[ -n "${WEB_PID:-}" ]] && wait "$WEB_PID" 2>/dev/null || true
  [[ -n "${TRANSCRIBE_PID:-}" ]] && wait "$TRANSCRIBE_PID" 2>/dev/null || true
  [[ -n "${WORKER_PID:-}" ]] && wait "$WORKER_PID" 2>/dev/null || true
  rm -rf "$WAIT_TMP" 2>/dev/null || true
  exit 143
}
trap term_handler SIGTERM SIGINT

node server.js &
WEB_PID=$!

npm run worker:transcribe &
TRANSCRIBE_PID=$!

CLIP_PIPE_SPLIT_TRANSCRIBE=1 npm run worker &
WORKER_PID=$!

# First process to exit: each subshell waits one child and writes its exit code (no wait -n).
( wait "$WEB_PID"; echo $? >"$WAIT_TMP/exit.web" ) &
( wait "$TRANSCRIBE_PID"; echo $? >"$WAIT_TMP/exit.transcribe" ) &
( wait "$WORKER_PID"; echo $? >"$WAIT_TMP/exit.worker" ) &

WAIT_STATUS=0
set +e
while true; do
  if [[ -f "$WAIT_TMP/exit.web" ]]; then
    WAIT_STATUS=$(cat "$WAIT_TMP/exit.web")
    break
  fi
  if [[ -f "$WAIT_TMP/exit.transcribe" ]]; then
    WAIT_STATUS=$(cat "$WAIT_TMP/exit.transcribe")
    break
  fi
  if [[ -f "$WAIT_TMP/exit.worker" ]]; then
    WAIT_STATUS=$(cat "$WAIT_TMP/exit.worker")
    break
  fi
  sleep 0.2
done
set -e

kill "${WEB_PID}" "${TRANSCRIBE_PID}" "${WORKER_PID}" 2>/dev/null || true
set +e
wait "${WEB_PID}" 2>/dev/null || true
wait "${TRANSCRIBE_PID}" 2>/dev/null || true
wait "${WORKER_PID}" 2>/dev/null || true
set -e

exit "${WAIT_STATUS}"
