#!/bin/sh
set -eu

cleanup() {
  if [ -n "${POLLER_PID:-}" ]; then
    kill "$POLLER_PID" 2>/dev/null || true
  fi
}

trap cleanup INT TERM EXIT

node --import tsx ./scripts/poller.ts &
POLLER_PID=$!

PORT="${PORT:-35001}" node ./node_modules/@remix-run/serve/dist/cli.js build/server/index.js
