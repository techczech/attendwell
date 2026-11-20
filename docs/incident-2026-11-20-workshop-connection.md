---
title: Incident record — Mac↔iPad connection, 19–20 Nov 2026 workshop
type: incident-record
created: 2026-11-20
branch: spike/multipeer-nearby-link
related: docs/spike-multipeer-nearby-link.md, docs/plan-reliable-sync.md
pattern: _SKILLS/skills/dev/app-design-elements/references/device-connectivity.md (element 22)
---

# Incident record: Mac↔iPad connection, 19–20 Nov 2026

FOR AGENTS. What broke between the night before and the morning of the "Building Workflows" workshop (Fri 20 Nov 2026, Oxford venue, MacBook Air + an older iPad on TestFlight), what was done on the spot, and what is still open. The general lessons are in the app pattern (element 22, linked above); this file keeps the AttendWell-specific facts.

## Outcome

Check-in ran over the local Multipeer link with real names from 08:02. Two outages during the morning (Mac sleep at 08:42 and 09:50) were recovered by hand; at 10:27 the link was up again and check-ins were not lost (iPad queue + Mac register held). The internet route (Cloudflare quick tunnel) never worked at the venue.

## Issues, in the order they surfaced

| # | Issue | Cause | Done on the spot | Status |
|---|---|---|---|---|
| 1 | TestFlight build not on the iPad | Builds uploaded from Xcode are never added to an internal group automatically ("Manual for Xcode Builds") | Owner added each build by hand; steps in `docs/howto-testflight-build.md` | Open: App Store Connect API key would remove the step |
| 2 | iPad on another Apple ID could not get the build | Redeem codes exist only for external testers | Documented both routes (sign App Store into own Apple ID, or external group + code) | Done (doc) |
| 3 | Connection test hidden: Help menu only, small grey link on iPad, test unusable from the iPad's main scanner ("this isn't a pairing code") | Spike UI never designed for the owner; two QR formats, two scanners | Big Connect iPad / Settings buttons (Mac alpha.2); one scanner accepts every Mac QR (iPad build 3+) | Done |
| 4 | Owner believed the app needed Tailscale | Tailscale was only the agent's remote path to the Air; UI never said which route is in use | Explained | Open: UI must name the route in use |
| 5 | Pairing needed check-in started; could not set up the night before | Old route's QR only exists while the tunnel runs | Local link pairs at any time | Done for local route |
| 6 | iPad first screen looked "all white" | Low-contrast secondary links on a light background | High-contrast filled buttons, no small links (build 4) | Done |
| 7 | Nearby check-in screen lost the participant kiosk ("about 8 lines") | Spike list view used instead of KioskView | Original participant screens over the local link; admin behind one Connections button (build 6) | Done |
| 8 | Old camera-less / camera-unavailable iPad could not scan | Older iPad reported camera unavailable | Eight-character local code (build 4/5) | Done |
| 9 | Could not add people while check-in was starting/open | Register edits gated on session/tunnel state | Edits allowed in every state (Mac alpha.5) | Done |
| 10 | Commands only in menus | Menu-first design | Rule: every menu command has a visible button where it applies (Mac alpha.5 for the workshop window) | Partly done |
| 11 | Needed names/emails on the clipboard during check-in | Only CSV export existed | Copy… with four formats (Mac alpha.5) | Done |
| 12 | Names in one column in landscape | Kiosk rebuild used a single-column stack | Two columns in landscape (build 7) | Done |
| 13 | Teal colour disliked | — | Navy matching the Mac (build 8; built, upload blocked by #17) | Open: upload |
| 14 | Start check-in took ~90 s before the iPad got "open" | Session start waits for the internet tunnel to fail on a network that blocks Cloudflare QUIC | Waited it out | Open: start must not wait for an optional route |
| 15 | Mac said "Can't connect", "Connection trouble", "Devices 0" while the iPad was connected locally | Connection panel and Devices describe only the internet route | Told owner to ignore those boxes | Open: show the local link first |
| 16 | At the venue the iPad never saw the Mac | eduroam isolates clients (no Bonjour between devices); the no-shared-network path (Bluetooth / peer-to-peer Wi-Fi) also failed — never tested on real hardware (spike checklist steps 2–4 still open) | Both devices onto the same non-isolated network (phone hotspot / "spinoza") | Open: investigate entitlements/permissions of the helper inside the Electron bundle; guidance on screen |
| 17 | Uploads failed "Failed to Use Accounts" | Xcode's App Store Connect session lapsed twice in one morning | Owner re-signed in once; build 8 still not uploaded | Open |
| 18 | Link dropped when the Air slept and did not come back | No sleep assertion; helper did not rebuild session/advertiser on wake; iPad did not rebuild on foreground | `caffeinate -i -m -s -w <AttendWell pid>` started over ssh; owner kept the lid open; AttendWell restarted at 10:23 | Open: delegated (reconnect after sleep, Reconnect buttons) |
| 19 | Second helper restart impossible | Mac app restarts the helper once per app run | App quit and reopened | Open: delegated (unlimited restarts with backoff) |
| 20 | No "connection lost" state or Reconnect button on either side | Not designed | Agent watched `nearby.log` over ssh and told the owner | Open: delegated |

## What made the remote rescue possible

- `~/Library/Application Support/AttendWell/nearby.log`: one timestamped JSON line per peer state, invitation, snapshot and helper start. Every diagnosis above came from it.
- `logs/attendwell.log`: session, tunnel and check-in-window lines.
- ssh to the Air over Tailscale (agent access only; not part of the product).

## Follow-up work

- Delegated 20 Nov 10:13: reconnect after sleep/wake and network change, Reconnect buttons and lost states on both sides, local link shown first on the Mac, venue-network investigation and on-screen guidance (Mac 1.1.0-alpha.6, iPad build 9).
- Still to plan: session start independent of the tunnel (#14); App Store Connect API key (#1, #17); real-device checklist from the spike doc, run in an eduroam building, before the next workshop.
