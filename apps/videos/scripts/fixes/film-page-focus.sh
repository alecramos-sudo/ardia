#!/bin/bash
set -uo pipefail
REPO=$(cd "$(dirname "$0")/../../../.." && pwd)
BUILDS=${TMPDIR%/}/pagefocus-film
export FIXES_SCRATCH=${FIXES_SCRATCH:-$BUILDS/scratch}
S=$FIXES_SCRATCH
BEFORE_SRC=${BEFORE_SRC:-$BUILDS/Before.app}
AFTER_SRC=${AFTER_SRC:-$BUILDS/After.app}
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
node "$REPO/apps/videos/scripts/fixes/sessions-page-focus.mjs" "$S"
export FIXES_SITES_PORT=${FIXES_SITES_PORT:-47391}
if ! lsof -nP -iTCP:"$FIXES_SITES_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  node "$REPO/apps/videos/scripts/capture/sites/serve.mjs" "$FIXES_SITES_PORT" >"$S/serve.log" 2>&1 &
  SITES=$!
fi
export BEFORE_APP=$S/before/Ardia.app AFTER_APP=$S/after/Ardia.app
export FIXES_INPUT=1 FIXES_SELFREC=1 FIXES_SERIAL=1 FIXES_PORT_BASE=${FIXES_PORT_BASE:-9931}
node "$REPO/apps/videos/scripts/fixes/run.mjs" ${FIXES_SCENES:-pagefocus} "$@"
