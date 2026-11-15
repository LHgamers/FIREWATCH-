#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
echo "============================================================"
echo " FIREWATCH AI - Local Scientific Intelligence by LH STUDIOS"
echo " Installer / first-run diagnostic"
echo "============================================================"
command -v python3 >/dev/null 2>&1 || { echo "[FAIL] python3 not found. Install Python 3.11+."; exit 1; }
python3 -c 'import sys; raise SystemExit(0 if sys.version_info >= (3,11) else 1)' \
  || { echo "[FAIL] Python 3.11 or newer is required."; exit 1; }
python3 -m firewatch_ai.selfcheck
echo
echo "[OK] Installation verified. Run ./start.sh to open FIREWATCH AI."
echo "     The model is NOT bundled. Pull it once with:"
echo "       ollama pull qwen2.5:7b-instruct"
