#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${WORKER_COCKPIT_PORT:-7700}"
APP_DIR="${WORKER_COCKPIT_APP_DIR:-$DIR}"
STATE_DIR="${WORKER_COCKPIT_STATE_DIR:-$APP_DIR/.local/state}"
LOG_DIR="$STATE_DIR"
PID_FILE="$LOG_DIR/worker-cockpit.pid"
LOG_FILE="$LOG_DIR/worker-cockpit.log"

mkdir -p "$LOG_DIR"

is_gateway_up() {
  openclaw gateway status >/dev/null 2>&1
}

is_cockpit_running() {
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1
}

start_cockpit() {
  if is_cockpit_running; then
    return 0
  fi
  cd "$APP_DIR"
  nohup node server.js >> "$LOG_FILE" 2>&1 < /dev/null &
  echo $! > "$PID_FILE"
}

stop_cockpit() {
  if [ -f "$PID_FILE" ]; then
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
  fi

  lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | while read -r pid; do
    kill "$pid" 2>/dev/null || true
  done
}

if is_gateway_up; then
  start_cockpit
else
  stop_cockpit
fi
