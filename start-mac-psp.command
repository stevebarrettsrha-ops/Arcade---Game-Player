#!/bin/bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then echo "Node.js not installed - get it from https://nodejs.org"; read -n1 -s; exit 1; fi
echo "  Starting ARCADE in PSP mode (experimental, threads enabled)..."
ARCADE_PSP=1 node server.js
