#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
echo "FIREWATCH AI - Local Scientific Intelligence by LH STUDIOS"
echo "Loopback only: http://127.0.0.1:8020  (Ctrl+C to stop)"
exec python3 -m firewatch_ai.server "$@"
