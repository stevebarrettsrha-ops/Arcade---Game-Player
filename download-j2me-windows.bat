@echo off
cd /d "%~dp0"
title ARCADE - set up the Java (J2ME) handset
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
echo   Setting up the Java handset so it runs INSIDE ARCADE...
echo   (This needs internet and downloads about 9 MB. Run it once.)
echo   Note: Java games also need internet while playing (the engine
echo   loads from its provider). Every other system works fully offline.
echo.
node get-j2me.js %*
echo.
pause
