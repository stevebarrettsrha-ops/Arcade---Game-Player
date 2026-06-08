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
node server.js
