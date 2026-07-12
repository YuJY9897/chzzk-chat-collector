@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed.
  echo Install the LTS version from https://nodejs.org and run this file again.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo First run setup. Installing dependencies...
  call npm.cmd install
  if errorlevel 1 (
    echo Dependency installation failed.
    pause
    exit /b 1
  )
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "$c=Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { exit 0 } else { exit 1 }"
if not errorlevel 1 (
  echo CHZZK Clip Scout is already running. Opening the app page...
  start "" "http://localhost:3000"
  exit /b 0
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process node -ArgumentList 'src/server.js' -WindowStyle Hidden"
timeout /t 1 >nul
start "" "http://localhost:3000"
exit /b 0
