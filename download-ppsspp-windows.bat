@echo off
cd /d "%~dp0"
title ARCADE - download PPSSPP for offline use
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
echo   Downloading PPSSPP (the better PSP engine) for offline use...
echo   (This needs internet and may take a while. Run it once.)
echo.
node get-ppsspp.js %*
echo.
pause
