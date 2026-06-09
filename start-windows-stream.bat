@echo off
cd /d "%~dp0"
title ARCADE (streaming mode - host emulators)
where node >nul 2>nul
if errorlevel 1 ( echo Node.js not installed - get it from https://nodejs.org & pause & exit /b )
where ffmpeg >nul 2>nul
if errorlevel 1 (
  echo.
  echo   ffmpeg is not installed - streaming needs it to capture the screen.
  echo   Install it ^(e.g. "winget install ffmpeg"^) then run this again.
  echo   See SETUP-STREAMING.txt for details.
  echo.
  pause
  exit /b
)
echo   Starting ARCADE with host-emulator streaming ON...
set ARCADE_STREAM=1
node server.js
echo.
pause
