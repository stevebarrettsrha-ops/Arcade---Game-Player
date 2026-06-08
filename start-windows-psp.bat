@echo off
cd /d "%~dp0"
title ARCADE (PSP mode - experimental)
where node >nul 2>nul
if errorlevel 1 ( echo Node.js not installed - get it from https://nodejs.org & pause & exit /b )
echo   Starting ARCADE in PSP mode (experimental, threads enabled)...
set ARCADE_PSP=1
node server.js
echo.
pause
