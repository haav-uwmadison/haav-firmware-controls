#!/usr/bin/env bash
# Avoid starting a duplicate local daemon when one is already serving the dashboard.
set -euo pipefail

port=8765
want_sim=0
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  case "${args[$i]}" in
    --ws)
      if (( i + 1 < ${#args[@]} )); then port="${args[$((i + 1))]}"; fi
      ;;
    --ws=*)
      port="${args[$i]#--ws=}"
      ;;
    --sim)
      want_sim=1
      ;;
  esac
done

if command -v lsof >/dev/null 2>&1; then
  pid="$(lsof -nP -t -iTCP:"$port" -sTCP:LISTEN | head -n 1 || true)"
  if [[ -n "$pid" ]]; then
    command="$(ps -p "$pid" -o comm= || true)"
    cmdline="$(ps -p "$pid" -o args= || true)"
    if [[ "$command" == *mission_daemon* ]]; then
      has_sim=0
      [[ "$cmdline" =~ (^|[[:space:]])--sim([[:space:]]|$) ]] && has_sim=1
      if [[ "$want_sim" != "$has_sim" ]]; then
        echo "mission_daemon (PID $pid) is already running on 127.0.0.1:$port with different mode ($cmdline). Stop it first before switching between real boat and --sim." >&2
        exit 1
      fi
      echo "mission_daemon is already running (PID $pid) on 127.0.0.1:$port. Reuse it; no second instance started."
      exit 0
    fi
    echo "Port $port is already in use by PID $pid ($command). Close that process or choose another WebSocket port." >&2
    exit 1
  fi
fi

exec bash "$(dirname "$0")/run.sh" "$@"
