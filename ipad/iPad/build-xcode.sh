#!/bin/bash
set -euo pipefail
# xcodebuild simulator build, ad-hoc signed ("Sign to Run Locally") so the keychain entitlement
# is applied with no Apple account. Prints the .app path; use it as WORKSHOP_SIM_APP for smoke-simulator.sh.
here="$(cd "$(dirname "$0")" && pwd)"
derived="${WORKSHOP_XCODE_DERIVED:-$here/.derived-data}"
dest="${WORKSHOP_SIM_DESTINATION:-generic/platform=iOS Simulator}"
xcodebuild -project "$here/AttendWell.xcodeproj" -scheme AttendWell -destination "$dest" \
  -derivedDataPath "$derived" build -quiet
printf 'WORKSHOP_SIM_APP=%s\n' "$derived/Build/Products/Debug-iphonesimulator/AttendWell.app"
