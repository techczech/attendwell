#!/bin/bash
# Headless XCUITest: pairs the real iPad app with a live laptop register and checks one person in.
# Usage: AW_PAIR_ADDRESS=... AW_PAIR_CODE=... AW_PIN=482915 AW_PARTICIPANT="Aisha Rahman" ui-test-pairing.sh <screenshot-folder>
# Nothing is committed: address, code and PIN come from the environment only. Never opens Simulator.app.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="${1:?usage: ui-test-pairing.sh <folder for exported screenshots>}"
sim="${WORKSHOP_UITEST_SIMULATOR:-iPad Air 11-inch (M4)}"
derived="${WORKSHOP_XCODE_DERIVED:-$here/.derived-data}"
work="$(mktemp -d /tmp/aw-uitest.XXXXXX)"
result="$work/result.xcresult"
for v in AW_PAIR_ADDRESS AW_PAIR_CODE AW_PIN AW_PARTICIPANT; do
  [ -n "${!v:-}" ] || { echo "Missing $v; the test would skip. Set AW_PAIR_ADDRESS, AW_PAIR_CODE, AW_PIN, AW_PARTICIPANT." >&2; exit 2; }
done
export TEST_RUNNER_AW_PAIR_ADDRESS="$AW_PAIR_ADDRESS" TEST_RUNNER_AW_PAIR_CODE="$AW_PAIR_CODE" \
       TEST_RUNNER_AW_PIN="$AW_PIN" TEST_RUNNER_AW_PARTICIPANT="$AW_PARTICIPANT"
mkdir -p "$out"
xcodebuild test -project "$here/AttendWell.xcodeproj" -scheme AttendWell \
  -destination "platform=iOS Simulator,name=$sim" -derivedDataPath "$derived" \
  -only-testing:AttendWellUITests -resultBundlePath "$result" -quiet
status=$?
if [ -d "$result" ]; then
  xcrun xcresulttool export attachments --path "$result" --output-path "$out" >/dev/null 2>&1 \
    && echo "Screenshots exported to $out" || echo "Could not export attachments" >&2
  # Give each exported PNG its step name (01-setup.png ...) instead of a GUID.
  python3 -I - "$out" <<'PY'
import json, os, re, sys
d = sys.argv[1]
m = os.path.join(d, "manifest.json")
if os.path.exists(m):
    for test in json.load(open(m)):
        for a in test.get("attachments", []):
            src = os.path.join(d, a["exportedFileName"])
            name = re.sub(r"_\d+_[0-9A-F-]{36}(\.\w+)$", r"\1", a["suggestedHumanReadableName"])
            if os.path.exists(src):
                os.replace(src, os.path.join(d, name))
    os.remove(m)
PY
fi
xcrun simctl shutdown all >/dev/null 2>&1 || true
echo "xcodebuild test exit status: $status (result bundle: $result)"
exit $status
