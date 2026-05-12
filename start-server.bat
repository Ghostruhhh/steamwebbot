@echo off
setlocal ENABLEDELAYEDEXPANSION

cd /d "%~dp0"

set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
set "NPM_CMD=%ProgramFiles%\nodejs\npm.cmd"

if not exist "%NODE_EXE%" (
  echo Node.js was not found at:
  echo   %NODE_EXE%
  echo Install LTS from https://nodejs.org  then reopen this terminal.
  pause
  exit /b 1
)

if exist "node_modules\express\" goto HAVE_DEPS
echo Installing npm packages ^(first run only^)...
call "%NPM_CMD%" install
if errorlevel 1 (
  echo npm install failed.
  pause
  exit /b 1
)

:HAVE_DEPS
echo.
netstat -ano 2>nul | findstr "LISTENING" | findstr ":3000" >nul
if errorlevel 1 goto PORT_HINT_DONE
echo WARNING: Something is already listening on port 3000.
echo   That process is usually an OLD galaxy server — the browser hits it and
echo   API routes such as /api/check-url ^& /api/pc-threat-hints return 404.
echo   Fix: stop that terminal ^(Ctrl+C^) / End extra node.exe in Task Manager, then run this bat again.
echo.

:PORT_HINT_DONE
echo Galaxy hub:  http://localhost:3000/
echo Or set PORT in .env and use that port.
echo If APIs 404 after editing server.js, stop this window (Ctrl+C) and restart
echo   — or kill any other node.exe using the same port.
echo Press Ctrl+C to stop the server.
echo.
"%NODE_EXE%" server.js
if errorlevel 1 pause
