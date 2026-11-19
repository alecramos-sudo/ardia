#!/usr/bin/env bash
set -euo pipefail

usage="usage: SPARKLE_BIN=<dir> [SPARKLE_KEY_FILE=<file> | SPARKLE_ACCOUNT=<keychain account>] scripts/release/appcast.sh <dist> <version> <headline> <notes body file> <published appcast or empty file> [<phased rollout seconds>]"
dist="${1:?$usage}"
version="${2:?$usage}"
headline="${3:?$usage}"
body="${4:?$usage}"
base_feed="${5:?$usage}"
phased="${6:-}"
sparkle="${SPARKLE_BIN:?$usage}"
. "$(dirname "$0")/lib.sh"
sparkle_key_args

echo "==> Appcast"
updates="$dist/updates"
mkdir -p "$updates"
cp "$dist/Ardia-$version.zip" "$updates/"
{ printf '**%s**\n\n' "$headline"; cat "$body"; } > "$updates/Ardia-$version.md"
cp "$base_feed" "$dist/appcast.base.xml"
[ -s "$base_feed" ] && cp "$base_feed" "$updates/appcast.xml"
phased_args=()
[ -n "$phased" ] && phased_args=(--phased-rollout-interval "$phased")
[ "$(channel_of "$version")" = nightly ] && phased_args+=(--channel nightly)
"$sparkle/generate_appcast" "${sparkle_key[@]}" ${phased_args[@]+"${phased_args[@]}"} \
  --download-url-prefix "$REPO_URL/releases/download/v$version/" \
  --embed-release-notes --full-release-notes-url "$RELEASE_NOTES_URL" \
  --link "$REPO_URL" -o "$updates/appcast.xml" "$updates"
mv "$updates/appcast.xml" "$dist/appcast.xml"
appcast item "$dist/appcast.xml" "$version" >/dev/null || die "appcast.xml has no single item for $version"
feed_signed "$sparkle" "$dist/appcast.xml" \
  || die "appcast.xml carries no valid feed signature: generate_appcast signs it only when the app sets SURequireSignedFeed"
rm -rf "$updates"
