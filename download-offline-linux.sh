#!/bin/bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "  Node.js is not installed. Install it from https://nodejs.org then re-run."
  exit 1
fi
echo "  Downloading the emulator engine + cores for offline play..."
echo "  (This needs internet and may take a while. Run it once.)"
echo
node get-offline.js "$@"
