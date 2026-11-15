@echo off
setlocal
cd /d "%~dp0"
python -m unittest discover -s tests -v
if errorlevel 1 (
  echo.
  echo TESTS FAILED - do not trust this installation yet.
  pause
  exit /b 1
)
echo.
echo OK - all offline tests passed.
