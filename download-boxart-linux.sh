#!/bin/bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "  Node.js is not installed. Install it from https://nodejs.org then re-run."; exit 1
fi
echo "  Downloading real box-art for your games..."
echo "  (Needs internet. Matches by file name. Run it once, or after adding games.)"
echo
node get-boxart.js "$@"
