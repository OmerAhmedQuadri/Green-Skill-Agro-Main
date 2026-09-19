#!/usr/bin/env bash
# This app's pnpm, at the version package.json pins, installed with npm into
# .tools/ inside the app folder — no global install, no shell profile edits,
# nothing another app on the VPS relies on changes. Runs pnpm with any
# arguments given, e.g.  bash deploy/pnpm.sh --version
set -euo pipefail
cd "$(dirname "$0")/.."
want=$(node -p "require('./package.json').packageManager.split('@')[1]")
bin=.tools/node_modules/.bin/pnpm
if [[ "$("$bin" --version 2>/dev/null || true)" != "$want" ]]; then
  npm install --prefix .tools --no-fund --no-audit --loglevel=error "pnpm@$want" >/dev/null
fi
exec "$bin" "$@"
