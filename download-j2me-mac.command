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
echo "  Setting up the Java handset so it runs INSIDE ARCADE..."
echo "  (This needs internet and downloads about 9 MB. Run it once.)"
echo "  Note: Java games also need internet while playing. Other systems are offline."
echo
node get-j2me.js "$@"
echo
read -n 1 -s -r -p "  Done. Press any key to close."
