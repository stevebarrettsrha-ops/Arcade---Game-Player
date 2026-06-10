#!/bin/bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then echo "Node.js not installed - get it from https://nodejs.org"; exit 1; fi
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "  ffmpeg is not installed — streaming needs it to capture the screen."
  echo "  Install it (e.g. 'sudo apt install ffmpeg xdotool') then run this again."
  echo "  See SETUP-STREAMING.txt for details."
  exit 1
fi
echo "  Starting ARCADE with host-emulator streaming ON..."
ARCADE_STREAM=1 node server.js
