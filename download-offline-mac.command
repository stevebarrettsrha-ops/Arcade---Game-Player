#!/bin/bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  Node.js is not installed."
  echo "  Install it from https://nodejs.org (pick the LTS version),"
  echo "  then double-click this file again."
  echo
  read -n 1 -s -r -p "  Press any key to close."
  exit 1
fi
echo "  Downloading the emulator engine + cores for offline play..."
echo "  (This needs internet and may take a while. Run it once.)"
echo
node get-offline.js "$@"
echo
read -n 1 -s -r -p "  Done. Press any key to close."
