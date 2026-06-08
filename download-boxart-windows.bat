@echo off
cd /d "%~dp0"
title ARCADE - download box-art
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
echo   Downloading real box-art for your games...
echo   (Needs internet. Matches by file name. Run it once, or after adding games.)
echo.
node get-boxart.js %*
echo.
pause
