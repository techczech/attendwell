#!/bin/bash
set -euo pipefail
# No signing, installation or SDK download. Uses the runner's existing SDK.
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
build_dir="${WORKSHOP_SIM_BUILD_DIR:-$repo_root/iPad/.build-simulator}"
sdk="$(xcrun --sdk iphonesimulator --show-sdk-path)"
arch="$(uname -m)"
target="$arch-apple-ios16.0-simulator"
mkdir -p "$build_dir/AttendWell.app"
core="$repo_root/WorkshopCheckInCore/Sources/WorkshopCheckInCore"
ui="$repo_root/WorkshopCheckInCore/Sources/WorkshopCheckInUI"
xcrun --sdk iphonesimulator swiftc -swift-version 5 -sdk "$sdk" -target "$target" -module-name WorkshopCheckInCore \
  -emit-module -emit-module-path "$build_dir/WorkshopCheckInCore.swiftmodule" -emit-library -static \
  "$core"/*.swift -o "$build_dir/libWorkshopCheckInCore.a"
xcrun --sdk iphonesimulator swiftc -swift-version 5 -parse-as-library -sdk "$sdk" -target "$target" \
  -I "$build_dir" -L "$build_dir" -lWorkshopCheckInCore -lsqlite3 \
  "$ui"/*.swift "$repo_root/iPad/AttendWellApp.swift" "$repo_root/iPad/PlatformProbe.swift" \
  -o "$build_dir/AttendWell.app/AttendWell"
cp "$repo_root/iPad/Info.plist" "$build_dir/AttendWell.app/Info.plist"
xcrun vtool -show-build "$build_dir/AttendWell.app/AttendWell"
printf 'Unsigned simulator build: %s\n' "$build_dir/AttendWell.app"
