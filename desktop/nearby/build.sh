#!/bin/sh
# Release build of attendwell-nearby (arm64) staged into desktop/resources/nearby/darwin-arm64/ for electron-builder.
set -e
cd "$(dirname "$0")"
# The spike key is made on this Mac on first build and kept out of git (gitignored): main/nearby-spike.ts and spike/print-key.mjs read it.
if [ ! -f spike/spike-key.json ]; then
  node -e 'const k=require("crypto").randomBytes(32).toString("base64url");require("fs").writeFileSync("spike/spike-key.json",JSON.stringify({_note:"Local spike key, made by build.sh; not in git.",v:1,workshopId:"spike-workshop",key:k},null,2)+"\n",{mode:0o600})'
  echo "made spike/spike-key.json"
fi
swift build -c release --arch arm64
BIN="$(swift build -c release --arch arm64 --show-bin-path)/attendwell-nearby"
DEST="../resources/nearby/darwin-arm64"
rm -rf "$DEST"; mkdir -p "$DEST"
cp "$BIN" "$DEST/attendwell-nearby"
echo "staged $DEST/attendwell-nearby"
