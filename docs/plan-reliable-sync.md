---
title: Plan — reliable, simple sync between the Mac app and the iPad
type: plan
status: proposed (revision 2)
created: 2026-11-09
---

# Plan: reliable, simple sync between the Mac app and the iPad

## Why

At the 9 November 2026 workshop the iPad saved every check-in, but none of them reached the Mac:

1. **The address changed.** The Mac app uses a Cloudflare *quick tunnel*, and it gets a new random address every time check-in starts. Check-in started at 08:18, then again at 10:00. The iPad was paired to the 08:18 address and never reached the Mac after 08:24. Nothing told the iPad about the new address.
2. **Quick tunnels are best-effort.** They have no uptime guarantee and drop connections. That matches the "connection breaking up" seen in the evening.
3. **Everything goes through the internet.** The iPad and the Mac sit in the same room, yet every check-in travels through Cloudflare and depends on both devices' internet connections.
4. **Check-in closed by itself.** A 30-minute check-in window from the day before had stayed closed (fixed in PR #5).
5. **Too many locks.** The iPad needs a pairing code, an organiser PIN, organiser proofs, held check-ins for review, and re-pairing after every change of address. Each lock is one more way for a check-in to go nowhere. They protect against threats that don't matter here: the iPad shows only names, and anyone at the door can see who has checked in.

## Requirements (Dominik, 9 Nov 2026)

- Close to 100% reliable. Quick to set up, and quick to resume after a restart, a sleep or a network change.
- **Works without anyone's own account or server.** Other organisers must be able to use AttendWell as downloaded. No Cloudflare account, no iCloud.
- **Same room is enough.** The organiser is always in the room with the iPad; remote access is not needed.
- The Mac drives everything. What the Mac pushes appears on the iPad. Opening, closing and hiding are done on the Mac.
- No organiser PIN or organiser mode on the iPad, and fewer passwords overall.
- The Mac shows check-ins live.
- Email addresses stay on the Mac. Nothing sits openly on a public web page.
- Nice to have: set the iPad up from one Mac, then manage check-in from another Mac.

## Recommended design: nearby connection first, tunnel as fallback, file as last resort

### 1. Primary path: Apple's nearby peer-to-peer connection (Multipeer Connectivity)

Multipeer Connectivity is the Apple framework behind AirDrop-style sharing. It connects nearby Apple devices over Bluetooth and peer-to-peer Wi-Fi, and over the shared Wi-Fi if there is one. **It needs no internet, no shared network, no account and no server.** It works on eduroam, a hotel network or no network at all, as long as both devices are in the room with Bluetooth and Wi-Fi switched on (they don't need to be joined to a network).

Why this rather than plain Bluetooth: plain Bluetooth Low Energy is slow and fiddly to keep connected. Multipeer uses Bluetooth to find the other device and then moves data over the much faster peer-to-peer Wi-Fi. It reconnects by itself, and Apple maintains it.

How it fits the Mac app: the Mac app is Electron, which cannot call Apple frameworks directly. A small Swift helper program is bundled inside the app, as the register service already is. The helper handles the nearby connection and talks to the register service on the Mac. Windows has no Multipeer; Windows organisers use the tunnel path below.

### 2. Fallback path: the quick tunnel, with automatic re-handshake

Keep the quick tunnel for organisers on Windows and for when the nearby link can't form. Fix its main weakness:

- **Whenever the nearby link is up, the Mac sends the iPad the current tunnel address.** A new address after a restart reaches the iPad within seconds, with no rescanning.
- The iPad also asks again on launch and when it returns to the foreground.
- If neither works, a **Show iPad code** QR on the Mac carries the new address. Scanning it reconnects the same iPad without losing anything (no PIN, no new device record).
- The iPad tries both paths: nearby first, tunnel second, and sends through whichever answers.

### 3. Last resort: the recovery file over AirDrop

It stays as now: save on the iPad, AirDrop to the Mac and import. It needs no connection at all.

## The sync model (the same whatever the path)

Reliability comes from the data model, not the cable. Every path carries the same few messages:

- **Mac → iPad: a snapshot.** Workshop title, the names list (id, display name, shown or hidden), open or closed, and a version number. A full snapshot every time anything changes, so a missed message is corrected by the next one. No emails.
- **iPad → Mac: check-ins.** Each check-in is saved on the iPad first, with an operation id. It is resent until the Mac acknowledges it. The Mac records each operation id once, so retries never double-count.
- **On every (re)connection both sides exchange "what's the latest you have".** The iPad sends anything unacknowledged; the Mac sends the current snapshot. Resumption is automatic and takes a second or two.
- **The iPad keeps its own complete log** of the check-ins it took, acknowledged or not, until the workshop is archived. This makes handing over to a second Mac possible: the new Mac connects, and the iPad replays its log.
- **The Mac never refuses a check-in from its own iPad.** A check-in after closing is recorded and shown as "late". A name the Mac doesn't know (for example, removed meanwhile) is recorded and flagged. Nothing is held on the iPad waiting for review.

## Pairing and trust (simplified)

1. On the Mac: open the workshop and click **Show iPad code**. A QR code appears with the workshop id, a shared key and the current tunnel address.
2. On the iPad: scan it. There is no PIN to set.
3. From then on the iPad finds that Mac nearby on its own, and the pairing survives restarts, sleep and network changes.
4. **A second Mac:** open the same workshop file on it (exported from the first Mac, or the same booking list imported), then show its code and scan it on the iPad. The iPad replays its log to the new Mac. Phase 4, not needed for the first release.
5. **Lost iPad:** click **Reset iPad code** on the Mac. That changes the key, so the old iPad can no longer connect.

The shared key encrypts the nearby link and authenticates the tunnel requests, so a stranger in the room or on the web cannot read the list or add check-ins. That is the only security on the iPad path.

## Security we keep and security we drop

**Keep**
- Email addresses and booking exports never leave the Mac. The iPad gets display names only.
- One shared key per workshop, from the QR code; the Mac can reset it.
- The tunnel serves only the iPad routes, and only to holders of the key. Nothing is browsable on the web.

**Drop**
- The iPad organiser PIN and organiser mode, organiser proofs and PIN-based re-pairing.
- One-time pairing codes with wrong-attempt lockouts and pairing sessions.
- Holding check-ins for review because of a stale version or a closed window.
- Device revocation lists, beyond resetting the workshop key.
- The participant web page and the Pages proxy, if nobody else uses them (check before deleting).

## What the iPad shows

- The check-in screen only: search, tap your name, confirm.
- A small status line: "Connected to Dominik's MacBook Pro (nearby)" or "(internet)", or "Saved here: 3 to send".
- One small menu: **Scan new code**, **Save recovery file**, **About**. No organiser screens.

## What the Mac shows

- A live list of who has checked in, with time, updated within a second of each tap.
- A connection badge per iPad: "Nearby", "Via internet" or "Last heard 2 min ago, 3 waiting".
- Controls: open/close check-in, hide or unhide a name, add a person, refresh the booking list (PR #5), show or reset the iPad code, import a recovery file, export attendees.

## Reliability targets and tests

- 100% delivery of check-ins from a paired iPad, exactly once. Within 2 s when nearby. Within 10 s of reconnection otherwise.
- Automatic resumption, with no taps, after: Mac sleep and wake, Mac app restart, a new tunnel address, the iPad app being killed and relaunched, Wi-Fi switched or lost.
- Tests:
  - **Sync core** (shared rules for snapshots, acknowledgements and idempotency): unit tests on both sides against the same message fixtures.
  - **Soak test with a simulated iPad:** 500 check-ins while connections drop at random, the Mac service restarts and the tunnel address changes. Pass: every check-in arrives exactly once.
  - **On real devices, before release:** the iPad and Mac on different Wi-Fi networks; the Mac with Wi-Fi off but Bluetooth on; Mac sleep for 5 minutes during check-ins; the Mac app quit and reopened; airplane mode on the iPad with Wi-Fi and Bluetooth back on. Written as a checklist in `runbook-operations.md`.
  - One full rehearsal with the second-Mac handover once phase 4 exists.

## Phases

0. **Ship PR #5** (reopen check-in, status-updating import) as 1.0.2. It's already built.
1. **Spike (first, small): prove the nearby link.** A bundled Swift helper on the Mac and the iPad app exchange messages over Multipeer. Measure connection time, reconnection after sleep, behaviour on eduroam, and whether the macOS permissions (Local Network, Bluetooth) work for a helper inside a signed Electron app. **Stop and report** if the helper can't hold a reliable link; fall back to plan B below.
2. **Sync core and Mac side:** the message model above, the Swift helper, live check-in list, connection badges, QR with key and tunnel address, tunnel re-handshake.
3. **iPad side:** nearby plus tunnel transports, the simplified screens, PIN and organiser mode removed, log kept for replay. TestFlight build.
4. **Prove and remove:** soak test and device checklist, then delete the pairing, PIN, proof and hold machinery and supersede ADR 0003. Release 1.1. Then the second-Mac handover.

Most of the deleted code is security machinery, so both apps get smaller.

**Plan B, if the spike fails:** the iPad and Mac find each other with Bonjour on the shared Wi-Fi and talk directly. With the Mac's own hotspot or the iPhone's hotspot as the shared network when the venue blocks devices from seeing each other (eduroam often does), the quick tunnel stays the fallback.

## Today's data (9 Nov 2026)

The 9 November check-ins are on the iPad. Move them with the recovery file (iPad → Organiser → Save recovery file → AirDrop to the Mac → Mac app → Import iPad recovery file).
