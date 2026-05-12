@echo off
cd /d "%~dp0"
set "EXE=%~dp0dist\GalaxyLoader.exe"
if not exist "%EXE%" (
  echo Build pkg exe first:  npm run build:loader-exe
  pause
  exit /b 1
)
"%EXE%" --clipboard
if errorlevel 1 pause
