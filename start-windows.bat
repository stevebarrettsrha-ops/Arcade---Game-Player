@echo off
cd /d "%~dp0"
title ARCADE home server
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed.
  echo   Install it from https://nodejs.org  (pick the LTS version^),
  echo   then double-click this file again.
  echo.
  pause
  exit /b
)
node server.js
echo.
echo   Server stopped. You can close this window.
pause
