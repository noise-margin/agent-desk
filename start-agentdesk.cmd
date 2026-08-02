@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 20 or newer first.
  exit /b 1
)

where pnpm.cmd >nul 2>nul
if errorlevel 1 (
  echo pnpm was not found. Run: npm install -g pnpm
  exit /b 1
)

if not exist "node_modules" call pnpm.cmd install
if errorlevel 1 exit /b 1

if not exist "apps\web\dist\index.html" call pnpm.cmd build
if errorlevel 1 exit /b 1
if not exist "apps\server\dist\index.js" call pnpm.cmd build
if errorlevel 1 exit /b 1

echo.
echo AgentDesk is running at:
echo http://127.0.0.1:4310
echo Press Ctrl+C to stop.
echo.

node apps/server/dist/index.js
