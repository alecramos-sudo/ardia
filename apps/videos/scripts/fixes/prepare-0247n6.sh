#!/bin/bash
set -euo pipefail
REPO=$(cd "$(dirname "$0")/../../../.." && pwd)
S=${FIXES_SCRATCH:-$HOME/ardia-scratch/film-n6/film}
PORT=${FIXES_SITES_PORT:-47311}
mkdir -p "$S"
for side in before after; do
  src=$([ "$side" = before ] && echo "${BEFORE_SRC:-}" || echo "${AFTER_SRC:-}")
  if [ ! -d "$S/$side/Ardia.app" ] && [ -n "$src" ]; then
    mkdir -p "$S/$side"
    ditto "$src" "$S/$side/Ardia.app"
    node "$REPO/scripts/lib/sign-test-copy.mjs" "$S/$side/Ardia.app"
  fi
done
node "$REPO/apps/videos/scripts/fixes/sessions-0247n6.mjs" "$S"
if ! lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  nohup node "$REPO/apps/videos/scripts/fixes/scenes/_47n3sites.mjs" "$PORT" >"$S/sites.log" 2>&1 &
  echo $! >"$S/sites.pid"
fi
echo "ready in $S"
