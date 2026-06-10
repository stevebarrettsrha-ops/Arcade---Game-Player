#!/bin/bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed - get it from https://nodejs.org"
  exit 1
fi
node fix-emulator-paths.js
