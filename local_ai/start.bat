@echo off
setlocal
cd /d "%~dp0"
echo FIREWATCH AI - Local Scientific Intelligence by LH STUDIOS
echo Loopback only: http://127.0.0.1:8020  (Ctrl+C to stop)
python -m firewatch_ai.server %*
