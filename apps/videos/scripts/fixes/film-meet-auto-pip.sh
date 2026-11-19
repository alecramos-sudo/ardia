#!/bin/bash
set -uo pipefail
REPO=$(cd "$(dirname "$0")/../../../.." && pwd)
export FIXES_SCRATCH=${FIXES_SCRATCH:-/tmp/meetpip-film}
S=$FIXES_SCRATCH
BEFORE_SRC=${BEFORE_SRC:-/Applications/Ardia.app}
AFTER_SRC=${AFTER_SRC:-/tmp/meetpip/film/Ardia-after.app}
mkdir -p "$S/before" "$S/after"
cleanup() {
  [ -n "${SITES:-}" ] && kill "$SITES" 2>/dev/null
  rm -rf "$S/before/Ardia.app" "$S/after/Ardia.app"
}
trap cleanup EXIT
for side in before after; do
  src=$([ "$side" = before ] && echo "$BEFORE_SRC" || echo "$AFTER_SRC")
  rm -rf "$S/$side/Ardia.app"
  ditto "$src" "$S/$side/Ardia.app"
  node "$REPO/scripts/lib/sign-test-copy.mjs" "$S/$side/Ardia.app" || exit 1
done
node "$REPO/apps/videos/scripts/fixes/sessions-meet-auto-pip.mjs" "$S"
export FIXES_SITES_PORT=${FIXES_SITES_PORT:-47251} FIXES_CALL_PORT=${FIXES_CALL_PORT:-47252}
if ! lsof -nP -iTCP:"$FIXES_SITES_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  node "$REPO/apps/videos/scripts/capture/sites/serve.mjs" "$FIXES_SITES_PORT" >"$S/serve.log" 2>&1 &
  SITES=$!
fi
export BEFORE_APP=$S/before/Ardia.app AFTER_APP=$S/after/Ardia.app
export FIXES_HOVER=1 FIXES_INPUT=1 FIXES_SERIAL=1 FIXES_PORT_BASE=${FIXES_PORT_BASE:-9681}
node "$REPO/apps/videos/scripts/fixes/run.mjs" meetpip "$@"
