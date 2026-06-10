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
if exist "emulators\xemu\app\xemu.exe" goto :run
echo.
echo   Host emulators are not fully set up yet (xemu / Java not downloaded;
echo   PCSX2, PPSSPP and Project64 install with their own installers).
choice /c YN /t 15 /d N /m "  Set them up now (downloads xemu + Java emulators)"
if errorlevel 2 goto :run
node get-emulators.js
:run
set ARCADE_STREAM=1
node server.js
echo.
pause
