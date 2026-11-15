@echo off
setlocal
cd /d "%~dp0"
echo ============================================================
echo  FIREWATCH AI - Local Scientific Intelligence by LH STUDIOS
echo  Installer / first-run diagnostic
echo ============================================================
echo.

where python >nul 2>nul
if errorlevel 1 (
  echo [FAIL] Python was not found on PATH.
  echo        Install Python 3.11 or newer from python.org and tick
  echo        "Add python.exe to PATH", then run this file again.
  pause
  exit /b 1
)

python -c "import sys; raise SystemExit(0 if sys.version_info >= (3,11) else 1)"
if errorlevel 1 (
  echo [FAIL] Python 3.11 or newer is required.
  python --version
  pause
  exit /b 1
)

python -m firewatch_ai.selfcheck
if errorlevel 1 (
  echo.
  echo [FAIL] A required layer is missing. Fix it before starting.
  pause
  exit /b 1
)

echo.
echo [OK] Installation verified. Run start.bat to open FIREWATCH AI.
echo      The model is NOT bundled: pull it once with
echo        ollama pull qwen2.5:7b-instruct
echo      No account, no telemetry, no cloud inference.
pause
