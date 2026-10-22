#!/bin/bash
set -euo pipefail
# Boot an existing runner iPad runtime; never downloads an SDK/runtime.
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
build_dir="${WORKSHOP_SIM_BUILD_DIR:-$repo_root/iPad/.build-simulator}"
app_path="${WORKSHOP_SIM_APP:-$build_dir/AttendWell.app}"  # set to the xcodebuild .app (see build-xcode.sh) for a signed run
mkdir -p "$build_dir"
device_json="$build_dir/available-devices.json"
xcrun simctl list devices available --json > "$device_json"
device_id="$(python3 - "$device_json" <<'PY'
import json, sys
devices=json.load(open(sys.argv[1]))['devices']
ipads=[d for group in devices.values() for d in group if d.get('isAvailable') and 'iPad' in d['name']]
if not ipads:
    raise SystemExit('No available iPad simulator runtime; no download attempted')
print(ipads[0]['udid'])
PY
)"
xcrun simctl boot "$device_id"
trap 'xcrun simctl shutdown "$device_id" || true' EXIT
xcrun simctl bootstatus "$device_id" -b
xcrun simctl install "$device_id" "$app_path"
xcrun simctl launch "$device_id" net.dominiklukes.attendwell.ipad
sleep 5
xcrun simctl io "$device_id" screenshot "$build_dir/fixture-normal-launch.png"
# Relaunch exercises the same sandbox/Keychain launch path without clearing it.
xcrun simctl terminate "$device_id" net.dominiklukes.attendwell.ipad
xcrun simctl launch "$device_id" net.dominiklukes.attendwell.ipad
sleep 2
xcrun simctl spawn "$device_id" launchctl list | python3 -c 'import sys; rows=[s for s in sys.stdin if "net.dominiklukes.attendwell.ipad" in s]; assert any(s.split()[0].isdigit() for s in rows), "fixture app is not running"; print("".join(rows))'
xcrun simctl terminate "$device_id" net.dominiklukes.attendwell.ipad
xcrun simctl launch "$device_id" net.dominiklukes.attendwell.ipad --fixture-setup
sleep 3
xcrun simctl io "$device_id" screenshot "$build_dir/fixture-setup.png"
xcrun simctl terminate "$device_id" net.dominiklukes.attendwell.ipad
xcrun simctl launch "$device_id" net.dominiklukes.attendwell.ipad --fixture-home
sleep 3
xcrun simctl io "$device_id" screenshot "$build_dir/fixture-home-offline.png"
xcrun simctl terminate "$device_id" net.dominiklukes.attendwell.ipad
container="$(xcrun simctl get_app_container "$device_id" net.dominiklukes.attendwell.ipad data)"
report="$container/Documents/fictional-platform-probe.json"
rm -f "$report"  # never read a report left by an earlier run
xcrun simctl launch "$device_id" net.dominiklukes.attendwell.ipad --fixture-platform-probe
for attempt in {1..30}; do
  if [ -f "$report" ]; then break; fi
  sleep 1
done
cp "$report" "$build_dir/fictional-platform-probe.json"
python3 - "$report" <<'PY'
import json,sys
report=json.load(open(sys.argv[1]))
print(json.dumps(report,indent=2,sort_keys=True))
assert report.get('fictional') is True and report.get('passed') is True, 'iPad platform checks failed'
PY
