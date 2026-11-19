REPO="mantrakp04/ardia"
REPO_URL="https://github.com/$REPO"
LATEST_DOWNLOAD_URL="$REPO_URL/releases/latest/download"
NIGHTLY_DMG_URL="$REPO_URL/releases/download/nightly/Ardia-Nightly.dmg"
RELEASE_NOTES_URL="https://ardia.dev/release-notes"
APPCAST_PY="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/.claude/skills/release/scripts/appcast.py"

channel_of() {
  if [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+-nightly\.[0-9]+$ ]]; then
    echo nightly
  elif [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo stable
  else
    echo "error: $1 is neither a stable (<major>.<minor>.<patch>) nor a nightly (<next stable>-nightly.<n>) version" >&2
    return 1
  fi
}

apple_version_of() {
  channel_of "$1" >/dev/null || return 1
  echo "${1%%-*}"
}

mac_marketing_version() {
  local root
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  sed -n 's/.*MARKETING_VERSION = "\{0,1\}\([^";]*\)"\{0,1\};/\1/p' "$root/apps/browser/macos/Ardia.xcodeproj/project.pbxproj" | sort -u
}

appcast() { python3 -I "$APPCAST_PY" "$@"; }

sparkle_tools() {
  echo "${SPARKLE_BIN:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/apps/browser/macos/Pods/Sparkle/bin}"
}

sparkle_key_args() {
  if [ -n "${SPARKLE_KEY_FILE:-}" ]; then
    sparkle_key=(--ed-key-file "$SPARKLE_KEY_FILE")
  else
    sparkle_key=(--account "${SPARKLE_ACCOUNT:-ardia}")
  fi
}

find_sparkle_key() {
  local tools="$1" account legacy
  if [ -n "${SPARKLE_KEY_FILE:-}" ]; then
    [ -s "$SPARKLE_KEY_FILE" ] || { echo "error: SPARKLE_KEY_FILE ($SPARKLE_KEY_FILE) is missing or empty" >&2; return 1; }
  else
    if [ -z "${SPARKLE_ACCOUNT:-}" ]; then
      legacy="$("$(dirname "${BASH_SOURCE[0]}")/legacy-name.sh" appName | tr '[:upper:]' '[:lower:]')"
      SPARKLE_ACCOUNT=ardia
      for account in ardia $legacy; do
        if "$tools/generate_keys" --account "$account" -p >/dev/null 2>&1; then SPARKLE_ACCOUNT="$account"; break; fi
      done
    fi
    "$tools/generate_keys" --account "$SPARKLE_ACCOUNT" -p >/dev/null 2>&1 || {
      echo "error: no Sparkle EdDSA key in the login keychain under account $SPARKLE_ACCOUNT (SPARKLE_ACCOUNT; docs/releasing.md)" >&2
      return 1
    }
    export SPARKLE_ACCOUNT
  fi
  sparkle_key_args
}

feed_signed() {
  "$1/sign_update" --verify "${sparkle_key[@]}" "$2" >/dev/null 2>&1
}

sign_feed() {
  "$1/sign_update" "${sparkle_key[@]}" "$2" >/dev/null && feed_signed "$1" "$2"
}

engine_symbols_name() { echo "ArdiaCore-${1#engine-}-symbols.tar.xz"; }
engine_uuids_name() { echo "ArdiaCore-${1#engine-}-uuids.txt"; }

latest_stable_tag() {
  local tag
  tag="$(gh release view -R "$REPO" --json tagName -q .tagName)"
  [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
    echo "error: the latest release is $tag, not a stable one: the feed lives on the latest stable release" >&2
    return 1
  }
  echo "$tag"
}

download_live_feed() {
  local tag="$1" dir="$2" names
  names="$(gh release view "$tag" -R "$REPO" --json assets -q '.assets[].name')" \
    || { echo "error: couldn't list $tag's assets" >&2; exit 1; }
  grep -qx appcast.xml <<<"$names" || return 1
  mkdir -p "$dir"
  gh release download "$tag" -R "$REPO" -p appcast.xml -D "$dir" --clobber
}
