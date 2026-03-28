#!/usr/bin/env bash
# Single-container entrypoint: Next.js web + transcribe worker + main worker (split pipeline).
# Shared STORAGE_ROOT/disk. If any process exits, the others are stopped and the container exits.
#
# Portable: no wait -n (macOS bash 3.2). Each service runs inside a wrapper subshell that owns
# its child process; we never "wait" a PID that belongs to another shell (avoids
# "wait: pid N is not a child of this shell").
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

# Wrapper subshells: each runs one command and writes its exit code. Only this shell may wait
# on WEB_PID / TRANSCRIBE_PID / WORKER_PID (they are direct children of this script).
( node server.js; ec=$?; echo "$ec" >"$WAIT_TMP/exit.web"; exit "$ec" ) &
WEB_PID=$!

( npm run worker:transcribe; ec=$?; echo "$ec" >"$WAIT_TMP/exit.transcribe"; exit "$ec" ) &
TRANSCRIBE_PID=$!

( CLIP_PIPE_SPLIT_TRANSCRIBE=1 npm run worker; ec=$?; echo "$ec" >"$WAIT_TMP/exit.worker"; exit "$ec" ) &
WORKER_PID=$!

# First wrapper to finish writes its exit file; poll until one exists.
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
