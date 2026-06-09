#!/bin/bash
# ============================================================
#   STOP offline WiFi  (Linux)
#   Turns OFF the local WiFi network created by file 1.
#   This does NOT change your normal WiFi settings.
# ============================================================

echo "============================================================"
echo "   Stopping your offline WiFi network..."
echo "============================================================"
echo

if ! command -v nmcli >/dev/null 2>&1; then
    echo "  'nmcli' (NetworkManager) is not installed - nothing to stop."
    echo
    read -n 1 -s -r -p "  Press any key to close..."
    exit 1
fi

# The hotspot created by file 1 is named "Hotspot".
if nmcli connection down Hotspot 2>/dev/null; then
    OK=1
else
    sudo nmcli connection down Hotspot 2>/dev/null && OK=1
fi

echo
if [ "$OK" = "1" ]; then
    echo "  The offline WiFi is now OFF."
else
    echo "  No active offline WiFi was found (it may already be off)."
fi

echo
read -n 1 -s -r -p "  Press any key to close..."
echo
