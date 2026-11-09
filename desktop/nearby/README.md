# Nearby link spike (branch spike/multipeer-nearby-link)

Phase 1 of `docs/plan-reliable-sync.md`: does Apple's Multipeer Connectivity hold a reliable link between a Mac helper and the iPad?
Spike only. Nothing here runs unless `ATTENDWELL_NEARBY_SPIKE=1` is set (Mac, test builds and development only) or the spike app is opened.

- `Sources/NearbyLink`: transport and message model shared by the helper and the iPad spike app (`ipad/NearbySpike`).
- `Sources/attendwell-nearby`: the helper. `--role mac` (advertises; JSON lines on stdio) and `--role ipad-sim` (headless fake iPad).
  The shared key arrives as the first stdin line `{"type":"key","key":...,"workshopId":...}`, never on argv.
- `spike/harness.mjs`: Mac-to-Mac scenarios a-e, evidence in `docs/spike-evidence/`. `spike/sim-test.mjs`: iPad Simulator against the helper.
  `spike/print-key.mjs`: the fixed spike key and its QR. `spike/spike-key.json`: that key, made locally by `build.sh` on first run and gitignored.
- `build.sh`: release build, staged into `desktop/resources/nearby/darwin-arm64/` for electron-builder.

    sh desktop/nearby/build.sh && node desktop/nearby/spike/harness.mjs        # all scenarios, about 2 minutes
    cd desktop/nearby && swift test                                            # key, invitation, sealing, queue
