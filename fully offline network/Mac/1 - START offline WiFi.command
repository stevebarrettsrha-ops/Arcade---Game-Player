#!/bin/bash
# ============================================================
#   START offline WiFi  (Mac)
#
#   Apple does NOT allow a WiFi network to be switched on with
#   a single command (it must be done in System Settings, for
#   safety/security reasons). This file opens the exact screen
#   for you and tells you the 3 clicks to make.
#
#   This is completely safe - it only OPENS a settings window.
# ============================================================

clear
echo "============================================================"
echo "   START offline WiFi  (Mac)"
echo "============================================================"
echo
echo "   Opening the Sharing settings for you now..."
echo
echo "   Then do these 3 steps:"
echo
echo "     1.  Turn ON  'Internet Sharing'"
echo "     2.  Click 'Wi-Fi Options...' and set:"
echo "            Network Name : REEL"
echo "            Password     : YourPassword"
echo "     3.  Click OK, then confirm 'Start'."
echo
echo "   Other devices can now connect to the WiFi named REEL."
echo "------------------------------------------------------------"

# Open the Sharing / Internet Sharing settings pane.
# (Works on modern macOS; falls back to the general Sharing pane.)
open "x-apple.systempreferences:com.apple.preferences.sharing?Internet" 2>/dev/null \
  || open "x-apple.systempreferences:com.apple.preferences.sharing" 2>/dev/null \
  || open "/System/Library/PreferencePanes/SharingPref.prefPane" 2>/dev/null

echo
echo "   When finished, run:  2 - STOP offline WiFi.command"
echo
echo "   You can close this window."
