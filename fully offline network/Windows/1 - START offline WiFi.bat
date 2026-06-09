@echo off
REM ============================================================
REM   START offline WiFi  (Windows)
REM   Creates a local WiFi network so other devices can
REM   connect and share with this computer WITHOUT internet.
REM
REM   Network name (SSID): REEL
REM   Password           : YourPassword
REM
REM   To change them, edit the two values on the SET lines below.
REM ============================================================

REM --- Settings you can change ---
set "SSID=REEL"
set "KEY=YourPassword"

REM --- Automatically ask for Administrator rights ---
REM (Creating a WiFi network requires admin permission.)
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Asking Windows for permission to start the WiFi...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

title  START offline WiFi
echo ============================================================
echo   Starting your offline WiFi network...
echo ============================================================
echo.

REM Allow and configure the local network
netsh wlan set hostednetwork mode=allow ssid="%SSID%" key="%KEY%"

REM Turn the network on
netsh wlan start hostednetwork

echo.
if %errorlevel% equ 0 (
    echo   SUCCESS - your offline WiFi is ON.
) else (
    echo   The WiFi could not start on this computer.
    echo   See "READ ME FIRST.txt" for the most common fix
    echo   ^(turn on Windows "Mobile hotspot" instead^).
)
echo.
echo   ----------------------------------------------------------
echo     Connect other devices using:
echo        Network name : %SSID%
echo        Password     : %KEY%
echo   ----------------------------------------------------------
echo.
echo   When you are finished, run:  2 - STOP offline WiFi.bat
echo.
echo   Press any key to close this window (the WiFi stays ON).
pause >nul
