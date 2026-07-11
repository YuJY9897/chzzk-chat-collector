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
  echo.
  echo CHZZK Clip Scout is already using port 3000.
  echo Another app window may already be running, or an old process may be stuck.
  echo.
  echo 1. Open existing app
  echo 2. Stop old process and restart
  echo 3. Cancel
  echo.
  choice /c 123 /n /m "Choose 1, 2, or 3: "
  if errorlevel 3 exit /b 0
  if errorlevel 2 goto restart_existing
  if errorlevel 1 (
    start "" "http://localhost:3000"
    exit /b 0
  )
)

start "" "http://localhost:3000"
node src/server.js

echo.
echo App stopped.
pause
exit /b 0

:restart_existing
echo.
echo Stopping existing process on port 3000...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$conns=Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue; foreach ($c in $conns) { if ($c.OwningProcess -and $c.OwningProcess -ne 0) { Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue } }"
timeout /t 1 >nul
goto start_app

:start_app
start "" "http://localhost:3000"
node src/server.js

echo.
echo App stopped.
pause
