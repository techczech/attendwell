---
title: Spike — Multipeer Connectivity as the nearby Mac↔iPad link
type: spike-report
status: conditional go; waiting on the real-device checklist
created: 2026-11-09
plan: docs/plan-reliable-sync.md (phase 1)
branch: spike/multipeer-nearby-link
---

# Spike: Multipeer Connectivity as the nearby Mac↔iPad link

## Verdict

**Conditional go.** On one Mac, the Multipeer link does everything the plan asks. It connects in about a second, and it resumes by itself after the Mac helper is killed and after the iPad side is killed. It delivered 500 of 500 check-ins exactly once in both kill tests and refused a wrong key. The signed app bundle carries the permission keys, and the helper signs cleanly inside it.

Four questions can only be answered on a real iPad:
- whether it works over Bluetooth and peer-to-peer Wi-Fi with no shared network;
- whether macOS shows and honours the Local Network and Bluetooth prompts for the bundled helper;
- whether it resumes after Mac sleep;
- whether it resumes after the iPad app goes to the background.

Go becomes final if the device checklist below passes. Steps 2–4 matter most. If step 2 (no shared Wi-Fi) or step 6 (sleep) fails, use plan B (end of this document).

The iOS Simulator was not a reliable stand-in. It connected on 2 of 3 runs and hung on the third, so it cannot settle anything either way. The simulator's networking is not the real radio stack, so a hang there is weak evidence against Multipeer. It is still a reason to test on the device before building phase 2.

## What was built (spike only, not wired into production)

- `desktop/nearby/` is a Swift package with two parts:
  - The `NearbyLink` library holds the transport and messages, shared by the Mac and the iPad.
  - `attendwell-nearby` is the helper executable. In `--role mac` it advertises and talks JSON lines with its parent over stdio. In `--role ipad-sim` it is a headless fake iPad, for measurements on one Mac.
- Trust comes from the QR key: 32 random bytes and a workshop id.
  - The Mac advertises a tag derived from the key. The iPad invites only a Mac with the right tag.
  - The invitation carries an HMAC with a nonce and a timestamp. The Mac accepts only a valid HMAC from within the last 5 minutes.
  - Every message is also sealed with ChaChaPoly, using a key derived from the QR key. This is needed because Multipeer's own encryption without certificates proves nothing about who is on the other end.
  - The key reaches the helper on stdin, never on the command line.
- Messages follow the plan:
  - `hello` both ways on every connection;
  - `snapshot` from the Mac (ids, display names, hidden flag, open/closed, version; no emails);
  - `checkin {opId, nameId, at}` from the iPad;
  - `ack {opIds}` from the Mac, sent only after the parent has recorded the check-in.
  - The iPad keeps unacknowledged check-ins in a file and resends them.
- `desktop/nearby/spike/harness.mjs` holds the Mac-to-Mac scenarios. `sim-test.mjs` runs the simulator test. `print-key.mjs` prints the spike key as a QR code.
- `ipad/NearbySpike/` is a throwaway iPad app (bundle id `net.dominiklukes.attendwell.nearbyspike`):
  - paste or scan the key;
  - status line;
  - names list with tap to check in;
  - event log with Share.
- Mac app (spike branch only):
  - the helper is bundled at `Contents/Resources/nearby/darwin-arm64/attendwell-nearby` and signed with the hardened runtime and `com.apple.security.device.bluetooth`;
  - the app Info.plist gets `NSLocalNetworkUsageDescription`, `NSBonjourServices` (`_attendwell-nb._tcp`, `_udp`) and `NSBluetoothAlwaysUsageDescription`;
  - `main/nearby-spike.ts` starts the helper only when `ATTENDWELL_NEARBY_SPIKE=1` is set. That variable is honoured only where the other test switches are, and a release build ignores it.

## Evidence

The raw data is in `docs/spike-evidence/`.

| Question | Result | Source |
|---|---|---|
| Connection time | 10/10 runs connected. Helper start to connected: median 1.1 s, max 1.2 s. Connected to snapshot received: 2–3 ms. In a further 40 connection-only runs after the final fixes, all connected. | `mac-to-mac-…jsonl` (a) |
| 500-name snapshot | 39,358 bytes sealed; transferred in 1–2 ms | (b) |
| Mac helper killed and restarted mid-stream (stands in for app restart and helper crash) | 500/500 recorded exactly once; reconnected 1.0 s after restart | (c) |
| iPad side killed and relaunched with its saved queue | 500/500 exactly once; reconnected in 74 ms; 286 resent check-ins dropped as duplicates | (d) |
| Wrong key | No connection, no snapshot, no check-in in 25 s | (e) |
| iPad Simulator ↔ Mac helper | 2 of 3 runs connected: one in 2.4 s, one in 17.3 s after a stuck first invitation. Both delivered 20/20 check-ins with acks within 16 ms. One run hung for 180 s with invitations stuck in "connecting". | `simulator-to-host-…jsonl` |
| Signed bundle | `dist:mac:test` built and signed with no Keychain prompt. The three Info.plist keys are present. The helper is signed with hardened runtime, team M7H45AGG8A and the Bluetooth entitlement. `codesign --verify --deep --strict` passes. | builder run, 9 Nov |
| iPad device build | `xcodebuild -destination generic/platform=iOS` succeeded, signed with Apple Development and the team's wildcard profile | builder run, 9 Nov |
| No shared Wi-Fi; Mac sleep; iPad background/foreground; macOS permission prompts; eduroam | **Not yet measured**: needs the real iPad (checklist below) | — |

### What the spike taught about Multipeer (keep for phase 2)

The link only became reliable after these changes; without them, 2 of 10 runs failed.
- The iPad must not send a second invitation while one is in flight (10 s). A second invitation restarts the handshake, which then never finishes.
- An invitation stuck for 10 s means throwing the iPad's session away and making a fresh one.
- The iPad should restart browsing only after 10 s of finding nothing. Restarting on every retry kept resetting discovery.
- The Mac must restart advertising after any dropped connection. Otherwise its advertisement goes stale and the iPad never finds it again.
- When the same Mac name reappears as a new peer, the iPad drops the old connection at once. Multipeer otherwise reports a dead connection as alive for about 10 s. This cut reconnection after a Mac restart from about 10 s to 1 s.
- Every 3 s the iPad resends unacknowledged check-ins that were not sent in the last 3 s. That covers a lost ack, and a connection that one side thinks is still up.

These rules belong in the phase 2 sync core, with tests.

## Permissions: what we know and what is left

- macOS asks for Local Network and Bluetooth on behalf of the app that launched the helper: the "responsible process", here AttendWell.app. The keys are therefore on the app's Info.plist, and they are there.
- The helper itself carries the hardened-runtime Bluetooth entitlement. Without it, a hardened binary using Bluetooth can be refused.
- Still unproven: that the prompts actually appear for AttendWell and that, after Allow, the helper is discoverable. This is checklist step 3.

## Device checklist (for Dominik)

Needs: the Mac with this branch's test build, the iPad, about 25 minutes. Each step names what to do and what you should see. Send back the iPad log (Share) and `nearby-spike.log` from the Mac at the end.

1. **Install the spike app on the iPad.**
   - Open `ipad/NearbySpike/NearbySpike.xcodeproj` in Xcode, pick your iPad, and press Run.
   - On the Mac, run `node desktop/nearby/spike/print-key.mjs` and scan the QR (or paste the key) in the iPad app.
   - You should see: the app opens and shows "Searching".
2. **Start the Mac side, visible, with the iPad and the Mac on no shared network.**
   - On the Mac, switch Wi-Fi on but join no network. Bluetooth on.
   - On the iPad, do the same (Wi-Fi on, forget or leave the network).
   - Run `ATTENDWELL_NEARBY_SPIKE=1 ATTENDWELL_USER_DATA=$(mktemp -d) ATTENDWELL_REGISTERS=$(mktemp -d) desktop/release-test/mac-arm64/AttendWell.app/Contents/MacOS/AttendWell`.
   - You should see: within about 10 s the iPad says "Connected to … (nearby)" and lists 500 "Synthetic Person" names.
3. **Permission prompts.**
   - At step 2, note whether macOS asked to allow AttendWell to find devices on local networks and to use Bluetooth, and click Allow.
   - You should see: the prompts name AttendWell, and the connection forms after Allow. If no prompt appears and nothing connects, note it; that is the key failure.
4. **Check-ins arrive.**
   - Tap 10 names on the iPad.
   - You should see: the iPad status returns to "0 to send" within a couple of seconds.
5. **iPad background and kill.**
   - Press Home, wait 30 s, and reopen. Tap 2 names.
   - Then swipe the app away, reopen it, and tap 2 more.
   - You should see: it reconnects by itself each time, and "to send" returns to 0.
6. **Mac sleep.**
   - Tap 3 names, then close the Mac lid for 5 minutes. Tap 3 more names while it sleeps, then open the lid.
   - You should see: within about 10 s of waking, "to send" returns to 0 without touching anything.
7. **Mac app restart, and on a normal network.**
   - Quit the AttendWell spike (Cmd-Q) and start it again with the step 2 command. Then join both devices to your usual Wi-Fi and repeat step 4.
   - You should see: the iPad reconnects by itself both times.
   - Optional: if you are on eduroam soon, repeat step 4 there.

## Plan B (if steps 2, 3 or 6 fail)

The iPad and Mac find each other with Bonjour on a shared network and talk directly over TCP (Network framework on the iPad, a small socket server in the register service on the Mac).
- Where the venue's network keeps devices apart (eduroam often does), the Mac's own hotspot (Internet Sharing) or a phone hotspot becomes the shared network.
- The sync model, the QR key and the message sealing stay the same; only the transport changes.
- The quick tunnel stays the fallback, with the re-handshake described in the plan.

Plan B gives up the "no network at all" case and adds one setup step (join the hotspot), but it avoids Bluetooth permissions entirely.

## Not done (by design)

Phases 2–4: the real sync core, the live check-in list, connection badges, the QR with the tunnel address, and removing PIN and organiser mode. The spike code on this branch is not for merging as is.
