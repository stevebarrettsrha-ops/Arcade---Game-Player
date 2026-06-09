#!/bin/bash
# ============================================================
#   STOP offline WiFi  (Mac)
#
#   Opens the Sharing settings so you can switch the WiFi off.
#   This is completely safe - it only OPENS a settings window.
# ============================================================

clear
echo "============================================================"
echo "   STOP offline WiFi  (Mac)"
echo "============================================================"
echo
echo "   Opening the Sharing settings for you now..."
echo
echo "   Then just turn OFF 'Internet Sharing'."
echo "------------------------------------------------------------"

open "x-apple.systempreferences:com.apple.preferences.sharing?Internet" 2>/dev/null \
  || open "x-apple.systempreferences:com.apple.preferences.sharing" 2>/dev/null \
  || open "/System/Library/PreferencePanes/SharingPref.prefPane" 2>/dev/null

echo
echo "   The offline WiFi is now off once Internet Sharing is OFF."
echo
echo "   You can close this window."
