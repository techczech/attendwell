#!/usr/bin/env bash
# Signed and notarised macOS release build (dmg and zip, arm64), run on the maintainer's Mac.
# Needs the Developer ID certificate in the login Keychain and notarytool credentials stored under a Keychain profile
# (APPLE_KEYCHAIN_PROFILE, default attendwell-notary). Refuses to start without them.
# electron-builder reads APPLE_KEYCHAIN_PROFILE (and APPLE_KEYCHAIN) itself and notarises and staples the app; this script then
# signs, notarises and staples the dmg too and verifies the result.
set -euo pipefail

PROFILE="${APPLE_KEYCHAIN_PROFILE:-attendwell-notary}"
IDENTITY="DOMINIK LUKES (M7H45AGG8A)"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if ! xcrun notarytool history --keychain-profile "$PROFILE" >/dev/null 2>&1; then
  cat >&2 <<MSG
release-mac: no usable notarytool credentials in the Keychain profile "$PROFILE".
Store them once (it asks for the app-specific password; nothing is written to this repository):

  xcrun notarytool store-credentials "$PROFILE" --apple-id <apple id> --team-id M7H45AGG8A

Then run this again. Use APPLE_KEYCHAIN_PROFILE=<name> for a profile with another name.
MSG
  exit 1
fi
[ "${1:-}" = "--check" ] && { echo "release-mac: profile \"$PROFILE\" works."; exit 0; }

export APPLE_KEYCHAIN_PROFILE="$PROFILE"
cd "$ROOT"
bun desktop/scripts/build-sidecar.ts darwin-arm64
bun desktop/scripts/fetch-cloudflared.ts darwin-arm64
(cd desktop && bun run dist:mac:release)

VERSION="$(node -p "require('./desktop/package.json').version")"
DMG="desktop/release/AttendWell-${VERSION}-arm64.dmg"
[ -f "$DMG" ] || { echo "release-mac: $DMG was not produced." >&2; exit 1; }

# The app inside is notarised and stapled by electron-builder; the dmg is a separate file Gatekeeper assesses on its own.
codesign --force --sign "$IDENTITY" --timestamp "$DMG"
xcrun notarytool submit "$DMG" --keychain-profile "$PROFILE" --wait
xcrun stapler staple "$DMG"
xcrun stapler validate "$DMG"
spctl -a -vvv -t install "$DMG"
echo "release-mac: $DMG is signed, notarised, stapled and accepted by Gatekeeper."
