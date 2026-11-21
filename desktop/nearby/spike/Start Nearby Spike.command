#!/bin/sh
# Double-click to start the nearby spike: shows the pairing QR, then opens the AttendWell spike test build with throwaway data
# (never ~/AttendWell). Quit AttendWell (Cmd-Q) when done; the helper's log is then copied into docs/spike-evidence/.
cd "$(dirname "$0")/../../.." || exit 1
APP=desktop/release-test/mac-arm64/AttendWell.app/Contents/MacOS/AttendWell
[ -x "$APP" ] || { echo "The spike test build is missing: ask the agent to rebuild it (bun run desktop:dist:mac:test)."; read -r _; exit 1; }
node desktop/nearby/spike/print-key.mjs
echo; echo "Scan the QR above with the NearbySpike app on the iPad. Starting AttendWell (spike, test data only)..."
D=$(mktemp -d); R=$(mktemp -d)
ATTENDWELL_NEARBY_SPIKE=1 ATTENDWELL_USER_DATA="$D" ATTENDWELL_REGISTERS="$R" "$APP" >/dev/null 2>&1
OUT="docs/spike-evidence/device-mac-$(date +%Y-%m-%d-%H%M).log"
cp "$D/nearby-spike.log" "$OUT" 2>/dev/null && echo "Saved the Mac log to $OUT" || echo "No Mac log was written."
echo "You can close this window."
