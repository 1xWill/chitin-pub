#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

stop_pid_file() {
  local f="$1"
  if [[ -f "$f" ]]; then
    local pid
    pid="$(cat "$f" || true)"
    if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" || true
    fi
    rm -f "$f"
  fi
}

stop_pid_file tools/.web-dev.pid
stop_pid_file tools/.mock-moltbook.pid
stop_pid_file tools/.mock-moltx.pid

echo "Stopped (best-effort)."
