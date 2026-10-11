@echo off
REM Double-click to set up and run the backend on Windows.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-backend.ps1"
echo.
pause
