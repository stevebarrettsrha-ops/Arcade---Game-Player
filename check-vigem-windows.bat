@echo off
cd /d "%~dp0"
title ARCADE - check the virtual Xbox controller (ViGEm)
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
echo   Checking the virtual Xbox controller (ViGEmBus driver + DLL)...
echo.
node check-vigem.js %*
echo.
pause
