---
title: Plan — reliable, simple sync between the Mac app and the iPad
type: plan
status: proposed
created: 2026-11-09
---

# Plan: reliable, simple sync between the Mac app and the iPad

## Why

At the 9 November 2026 workshop the iPad saved every check-in, but none of them reached the Mac:

1. **The address changed.** The Mac app uses a Cloudflare *quick tunnel*, and it gets a new random address every time check-in starts. Check-in started at 08:18, then again at 10:00. The iPad was paired to the 08:18 address and never reached the Mac after 08:24.
2. **Quick tunnels are best-effort.** They have no uptime guarantee and drop connections. That matches the "connection breaking up" seen this evening.
3. **The Mac has to be reachable.** The iPad can only send while the Mac is awake, online and running its tunnel. When the Mac sleeps or changes network, nothing gets through.
4. **Check-in closed by itself.** A 30-minute check-in window from the day before had stayed closed (fixed in PR #5).
5. **Too many locks.** The iPad needs a pairing code, an organiser PIN, organiser proofs, held check-ins for review, and re-pairing after every change of address. Each lock is one more way for a check-in to go nowhere. Most of them protect against threats that don't matter here: the iPad only ever shows names, and anyone at the door can see who has checked in.

## What Dominik asked for (9 Nov 2026)

- Close to 100% reliable. Pair once, in a rush, on any network, and it keeps working.
- The Mac drives everything. What the Mac pushes appears on the iPad. Opening, closing and hiding are done on the Mac.
- No organiser PIN or organiser mode on the iPad, and fewer passwords overall.
- The Mac shows check-ins live, so nobody has to go to the iPad to see them.
- Names are not secret. Email addresses stay on the Mac. Nothing should sit openly on a public web page.
- Bluetooth or Cloudflare both acceptable. What matters is robust and quick to set up again.

## Recommended design: a small relay both devices talk to

Replace "the iPad calls the Mac through a tunnel" with **a relay that both devices call out to**: one Cloudflare Worker with one Durable Object per workshop, on Dominik's own Cloudflare account, at a fixed address.

```
Mac app  ──outbound HTTPS/WebSocket──▶  relay (fixed address, one room per workshop)  ◀──outbound HTTPS──  iPad
```

Why this fixes the failures:

| Failure on 9 Nov | With a relay |
|---|---|
| New tunnel address after each restart | The address never changes. The iPad pairs once per workshop. |
| Quick tunnel dropping | The relay runs on Cloudflare's network; neither device hosts a server. |
| Mac asleep, offline or on another network | The iPad still sends to the relay. The Mac catches up when it wakes. |
| iPad and Mac on different networks | Irrelevant: each device only needs internet access. |
| Check-in window closed by surprise | The Mac app sets open or closed explicitly, and the iPad shows that state. |

### What the relay holds

- For each workshop room: the workshop title, the names list (id, display name, status: confirmed / waiting-admitted / hidden), the open-or-closed flag, and the check-in events (person id, time, device id, an operation id so retries count once).
- **No email addresses**, and none of the other booking data. The Mac keeps the full register.
- The room key is a long random secret in the QR code. Without it the room cannot be read or written. No room is listed, indexed or browsable. This replaces the pairing code, PIN and organiser proof.
- Rooms delete themselves a set time after the workshop (default 7 days) or when the Mac archives the workshop.

### How the devices sync

- **Mac → relay:** pushes the names list and the open/closed state whenever either changes. Each push is a full snapshot with a version number, so a missed push is corrected by the next one. The Mac holds a WebSocket to the relay and receives check-ins the moment they arrive, plus a catch-up pull ("everything since cursor N") on every reconnect.
- **iPad → relay:** check-ins go into a local queue first (as now) and are sent with retry and backoff until the relay acknowledges them. Operation ids make each send idempotent, so repeating it never double-counts. The iPad pulls the names and state on launch, on foreground, and every few seconds while open.
- **Fallbacks that need no network:** the iPad recovery file stays (AirDrop to the Mac and import). Optionally, the same sync over the local network when both devices are on one Wi-Fi, found by Bonjour. That is phase 3, only if the relay ever proves insufficient.

### Pairing

1. On the Mac: open the workshop and click **Show iPad code**. A QR code appears; it holds the relay address, room id and room key.
2. On the iPad: scan it. Done. There is no PIN to set.
3. The pairing survives restarts of either app, changes of network and Mac sleep. To move the iPad to another workshop, scan that workshop's code. To cut off a lost iPad, click **Reset iPad code** on the Mac, which rotates the room key.

### What the iPad shows and does

- The check-in screen only: search, tap your name, confirm.
- A small status line: "Sent to laptop" / "Saved here, will send" with a count. No organiser screens, PIN or handover flow.
- An unobtrusive menu with three items: **Save recovery file**, **Scan new code**, **About**.

### What the Mac shows

- A live list of who has checked in, with time and iPad, updated within a second or two of each tap.
- A connection badge for the relay and each iPad ("last heard 5 s ago", "3 waiting to send").
- Controls: open/close check-in, hide or unhide a name, add a person, import or refresh the booking list (PR #5), show or reset the iPad code, export attendees.

## Security we keep and security we drop

**Keep**
- Email addresses and booking exports never leave the Mac.
- The relay requires the room key and never lists rooms; HTTPS only.
- Rooms expire, and the Mac can delete one at once.
- A separate Mac key, kept on the Mac, for the Mac's own writes (names, open/closed), so a lost iPad cannot change the list. The iPad key can only add check-ins and read names.

**Drop**
- The iPad organiser PIN and organiser mode, organiser proofs and re-pairing with a PIN.
- Holding check-ins for review because of a stale version or a closed window. A check-in from a paired iPad is accepted. A check-in that arrives after closing is recorded and flagged "late" on the Mac, never refused.
- One-time pairing codes with wrong-attempt lockouts.
- The quick tunnel, the Pages proxy and the participant web listener for the iPad path.

## Reliability targets and how they are tested

- A check-in tapped on a paired iPad reaches the Mac with 100% delivery, within 3 s when both are online, and within 10 s of the Mac coming back online otherwise.
- No duplicates: the same operation id is recorded once.
- Test harness (automated, in CI and locally):
  - Relay unit tests (Durable Object with Miniflare): idempotency, cursors, expiry, key checks.
  - Soak test: a simulated iPad sends 500 check-ins while the network is cut and restored at random, the relay restarts and the Mac goes offline for 2 minutes. Pass: every check-in arrives exactly once.
  - Mac sleep and network-change test on real hardware before release (manual checklist in `runbook-operations.md`).
  - iPad: the queue survives app kill and relaunch mid-send (XCTest on the store, plus one simulator run).
- One rehearsal on real devices on two different networks (iPad on a phone hotspot, Mac on eduroam) before the next workshop.

## Phases

1. **Ship PR #5** (reopen check-in, status-updating import) as 1.0.2. It's small and already built.
2. **Relay and Mac side** (biggest step): Worker + Durable Object in `cloudflare/relay/`, deploy instructions for Dominik's account, Mac sync client with live list and connection badge, QR with room key. Keep the old tunnel path behind a setting until phase 4.
3. **iPad side:** new transport (relay), remove the PIN, organiser screen and handover; keep the queue, recovery file and names cache. TestFlight build.
4. **Prove and remove:** soak test, two-network rehearsal, then delete the tunnel, Pages proxy and pairing/PIN code and their ADRs (supersede ADR 0003). Release 1.1.
5. **Optional:** a local-network path via Bonjour, only if rehearsals show it is needed.

Rough size: phase 2 is two or three focused build sessions, phase 3 one or two, phase 4 one. Most of the deleted code is security machinery, so the app gets smaller.

## Decisions for Dominik

1. **Relay on Cloudflare (recommended)** versus keeping a direct connection with a fixed named tunnel. A named tunnel fixes the changing address but still needs the Mac awake and reachable at every tap; the relay does not. Both need his Cloudflare account and a hostname.
2. **Names on the relay.** Display names (no emails), behind a room key, deleted after 7 days by default. OK, or a shorter expiry?
3. **Bluetooth.** Not recommended as the main path: the Mac app is Electron, so Bluetooth would need a native helper, and its range is a room. Kept as a possible later phase, after the local-network option.

## Today's data (9 Nov 2026)

The 9 November check-ins are on the iPad. Move them with the recovery file (iPad → Organiser → Save recovery file → AirDrop to Mac → Mac app → Import iPad recovery file). That needs no network connection between the devices.
