@echo off
cd /d "%~dp0"
title ARCADE - download ViGEmClient.dll (virtual Xbox controller)
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
echo   Downloading ViGEmClient.dll for the virtual Xbox controller...
echo   (Needs internet. Run it once.)
echo.
echo   IMPORTANT: you ALSO need the ViGEmBus DRIVER installed (a separate
echo   one-time install) - see SETUP-STREAMING.txt section 4a.
echo.
node get-vigem.js %*
echo.
pause
