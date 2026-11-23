#!/usr/bin/env bash
# Avoid starting a duplicate local daemon when one is already serving the dashboard.
set -euo pipefail

port=8765
if command -v lsof >/dev/null 2>&1; then
  pid="$(lsof -nP -t -iTCP:"$port" -sTCP:LISTEN | head -n 1 || true)"
  if [[ -n "$pid" ]]; then
    command="$(ps -p "$pid" -o comm= || true)"
    if [[ "$command" == *mission_daemon* ]]; then
      echo "mission_daemon is already running (PID $pid) on 127.0.0.1:$port. Reuse it; no second instance started."
      exit 0
    fi
    echo "Port $port is already in use by PID $pid ($command). Close that process or choose another WebSocket port." >&2
    exit 1
  fi
fi

exec bash "$(dirname "$0")/run.sh" "$@"
