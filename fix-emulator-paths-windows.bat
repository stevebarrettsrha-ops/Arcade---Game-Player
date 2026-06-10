@echo off
cd /d "%~dp0"
title ARCADE - fix host emulator paths
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed - get it from https://nodejs.org
  echo.
  pause
  exit /b
)
node fix-emulator-paths.js
echo.
pause
