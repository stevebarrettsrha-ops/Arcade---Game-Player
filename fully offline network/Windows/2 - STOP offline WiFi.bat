@echo off
REM ============================================================
REM   STOP offline WiFi  (Windows)
REM   Turns OFF the local WiFi network created by file 1.
REM   This does NOT change any of your normal WiFi settings.
REM ============================================================

REM --- Automatically ask for Administrator rights ---
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Asking Windows for permission to stop the WiFi...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

title  STOP offline WiFi
echo ============================================================
echo   Stopping your offline WiFi network...
echo ============================================================
echo.

netsh wlan stop hostednetwork

echo.
echo   The offline WiFi is now OFF.
echo.
echo   Press any key to close this window.
pause >nul
