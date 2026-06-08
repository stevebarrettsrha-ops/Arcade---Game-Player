#!/bin/bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  Node.js is not installed."
  echo "  Install it (e.g. 'sudo apt install nodejs') then run this again."
  echo ""
  exit 1
fi
node server.js
