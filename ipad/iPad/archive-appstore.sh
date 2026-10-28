#!/bin/bash
# Archives the Release build for the App Store (automatic signing, team from project.yml).
#   archive-appstore.sh [--archive-only]   archive only (default); nothing is uploaded
#   archive-appstore.sh --upload           archive, then export and upload to App Store Connect
# Uses the Apple account signed in to Xcode. Output: ipad/build/AttendWell.xcarchive
set -euo pipefail

# Apple rsync starts its helper through PATH; Homebrew rsync rejects its extended-attributes option.
export PATH="/usr/bin:/bin:/usr/sbin:/sbin"
here="$(cd "$(dirname "$0")" && pwd)"
build="$here/../build"
archive="$build/AttendWell.xcarchive"
mode="archive-only"
case "${1:-}" in
  ""|--archive-only) ;;
  --upload) mode="upload" ;;
  *) echo "usage: $0 [--archive-only|--upload]" >&2; exit 2 ;;
esac
mkdir -p "$build"
rm -rf "$archive"
xcodebuild archive -project "$here/AttendWell.xcodeproj" -scheme AttendWell -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$archive" \
  -derivedDataPath "$build/derived" -allowProvisioningUpdates -quiet
echo "Archive: $archive"
if [ "$mode" = "upload" ]; then
  xcodebuild -exportArchive -archivePath "$archive" -exportOptionsPlist "$here/ExportOptions-appstore.plist" \
    -exportPath "$build/export" -allowProvisioningUpdates
  echo "Uploaded to App Store Connect."
fi
