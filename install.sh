#!/usr/bin/env sh
# ai-pack - macOS / Linux entry point: sh install.sh [command] [options]. Needs Node.js 18+ (https://nodejs.org).
set -eu
if ! command -v node >/dev/null 2>&1; then
  echo "ai-pack needs Node.js 18 or newer: https://nodejs.org (or: brew install node / your package manager)" >&2
  exit 1
fi
exec node "$(dirname "$0")/install.mjs" "$@"
