@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Installing for the first time...
  call npm install --no-audit --no-fund
)
node server.js
pause
