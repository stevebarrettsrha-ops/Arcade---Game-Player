#!/bin/bash
# ============================================================
#   START offline WiFi  (Linux)
#   Creates a local WiFi network so other devices can connect
#   and share with this computer WITHOUT internet.
#
#   Network name (SSID): REEL
#   Password           : YourPassword
#
#   To change them, edit the two values below.
# ============================================================

SSID="REEL"
PASS="YourPassword"

echo "============================================================"
echo "   Starting your offline WiFi network..."
echo "============================================================"
echo

# nmcli (NetworkManager) ships with most desktop Linux systems.
if ! command -v nmcli >/dev/null 2>&1; then
    echo "  This script needs 'NetworkManager' (the 'nmcli' command),"
    echo "  which is missing on this system."
    echo "  See 'READ ME FIRST.txt' for help."
    echo
    read -n 1 -s -r -p "  Press any key to close..."
    exit 1
fi

# Try as the normal user first; if that is not permitted, use sudo.
if nmcli device wifi hotspot ssid "$SSID" password "$PASS" 2>/dev/null; then
    OK=1
else
    echo "  Permission needed - you may be asked for your password:"
    sudo nmcli device wifi hotspot ssid "$SSID" password "$PASS" && OK=1
fi

echo
if [ "$OK" = "1" ]; then
    echo "  SUCCESS - your offline WiFi is ON."
    echo
    echo "  ----------------------------------------------------------"
    echo "    Connect other devices using:"
    echo "       Network name : $SSID"
    echo "       Password     : $PASS"
    echo "  ----------------------------------------------------------"
    echo
    echo "  When finished, run:  2 - STOP offline WiFi.sh"
else
    echo "  The WiFi could not start. See 'READ ME FIRST.txt'."
fi

echo
read -n 1 -s -r -p "  Press any key to close (the WiFi stays ON)..."
echo
