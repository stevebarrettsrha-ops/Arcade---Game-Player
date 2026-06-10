#!/bin/bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  Node.js is not installed - get it from https://nodejs.org"
  echo
  read -n 1 -s -r -p "Press any key to close..."
  exit 1
fi
node fix-emulator-paths.js
echo
read -n 1 -s -r -p "Press any key to close..."
