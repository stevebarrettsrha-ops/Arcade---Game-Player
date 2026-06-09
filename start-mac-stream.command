#!/bin/bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  Node.js is not installed."
  echo "  Install it from https://nodejs.org then run this again."
  echo ""
  read -n1 -r -p "  Press any key to close..."
  exit 1
fi
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo ""
  echo "  ffmpeg is not installed — streaming needs it to capture the screen."
  echo "  Install it (e.g. 'brew install ffmpeg') then run this again."
  echo "  See SETUP-STREAMING.txt for details."
  echo ""
  read -n1 -r -p "  Press any key to close..."
  exit 1
fi
echo "  Starting ARCADE with host-emulator streaming ON..."
echo "  (macOS will ask once for Screen Recording + Accessibility permission.)"
ARCADE_STREAM=1 node server.js
