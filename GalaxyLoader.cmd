@echo off
setlocal ENABLEDELAYEDEXPANSION
cd /d "%~dp0"

set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
set "NPM_CMD=%ProgramFiles%\nodejs\npm.cmd"

if not exist "%NODE_EXE%" (
  echo Node.js was not found at:
  echo   %NODE_EXE%
  echo Install LTS from https://nodejs.org  then run this shortcut again.
  pause
  exit /b 1
)

if exist "node_modules\express\" goto HAVE_DEPS
echo Installing npm packages ^(first run only for this loader^)...
call "%NPM_CMD%" install
if errorlevel 1 (
  echo npm install failed.
  pause
  exit /b 1
)

:HAVE_DEPS
echo.
echo Galaxy file loader — dist pkg: GalaxyLoader-clipboard.cmd  or dist\GalaxyLoader.exe --clipboard
echo Best UI: galaxy-desktop\release\GalaxyLoaderGUI.exe after npm run build:galaxy-gui
echo File UI: GalaxyLoader.hta  —  Terminal: this window.  See loader\README.txt — hub reachable for activation.
echo.
"%NODE_EXE%" "%~dp0loader\loader.js" %*
if errorlevel 1 pause
