---
title: Architecture
type: reference
status: current
---
# Architecture

## Components

| Part | Location | Role |
|---|---|---|
| Workshop configuration | `server/workshop-config.ts` | Validates the workshop file once. Provides the fictional example and the public subset shown to participants. |
| Store | `server/store-attendance.ts` | SQLite (WAL) register: import, attendance with versions, operations log for idempotent replay, audit, check-in window, recipient export. |
| Eligibility | `server/eligibility-attendance.ts` | The single rule: confirmed bookings, or waiting-list bookings the organiser has admitted. |
| HTTP handler | `server/http-attendance.ts` | One factory, two modes. The organiser handler covers loopback without a password, or HTTPS with Argon2 sign-in and roles. The participant handler is names-only with a fixed two-route API allowlist. |
| Device API | `server/device-attendance.ts`, `server/http-device-attendance.ts` | Pairing and check-in for the native iPad app on the participant listener (`/device/v1/*`, `/pair`), plus loopback-only organiser device routes. See [reference-device-api.md](reference-device-api.md). |
| Service entry | `server/start-attendance.ts` | Reads the private config, database path and workshop file. Refuses unsafe combinations before binding. |
| Participant sync | `src/offline-participant.ts` | The device queue: durable enqueue, background flush, subscriptions, and names-only snapshot. |
| Organiser queue | `src/offline-organiser.ts` | Loopback-only queue of organiser changes, used when the service is briefly unreachable. |
| Interface | `src/main.tsx`, `src/participant-check-in.tsx` | React organiser register and participant page. Both come from one Vite build with relative asset URLs. |
| Service worker | `public/sw.js` | Caches the participant shell and hashed assets only; never `/api/`. |
| Edge proxy | `cloudflare/worker/_worker.js` | Pages advanced-mode worker. Forwards the allowlisted participant paths to the tunnel host and does nothing else. |
| CoSy adapter | `scripts/convert-cosy-roster.py` | Optional. Converts a CoSy XLSX export to the normalised roster, driven by the workshop file. |

## Data flow

```
participant device ──HTTPS──▶ Pages proxy (/<prefix>/…) ──tunnel──▶ participant listener (names only)
   localStorage queue                no storage                     │
                                                                    ▼
organiser browser ──loopback──▶ organiser listener ───────▶ SQLite on the organiser computer
                                (emails, exports)
```

Both listeners share one database, so the organiser's window control, undo and admissions reach every participant device within one poll (5 s).

## Immediate check-in (the participant queue seam)

`participantSync(storage, transport, now, newId, base)` is the only interface the page uses:

- `enqueue(choice) → Ack` is synchronous. It writes the operation to device storage, reads it back, then returns `queued` (or `closed`). No network call happens before it returns, and a check-in is acknowledged even when the transport takes 5 s. If storage is full, blocked or silently ignores the write, it returns `failed`: nothing is queued or sent, and the page shows an alert asking the person to tell an organiser.
- `flush()` sends pending operations oldest first. It also picks up operations queued while it runs. It stops at the first transient failure (network, 429, 5xx) or closure (410).
- `refresh()` polls the names list only. The page runs it and `flush()` independently, so a slow send never delays closure or an organiser undo. A check-in acknowledged by the server after a poll started is kept when that poll's older answer arrives; a poll started later shows the server state, including an undo.
- `link()` reports connectivity from finished requests only: `names` from the last poll, `delivery` from the last send (`failing` when it did not reach the register). A request still in flight never changes it, and a failing send is shown even while polls succeed.
- `subscribe(listener)` is called after every storage or connectivity change, including background results. The UI redraws from `entries()`, so labels show what actually happened.
- `checkIn(choice)` is `enqueue` plus waiting for delivery. Use it only when you need the outcome.

Device storage keys and the service worker cache are namespaced by participant path (`/check-in` locally keeps the unsuffixed keys), so two sessions on one origin never mix names, queue or shell. A worker deletes only superseded versions of its own path's cache.

The outcome of each operation:

| Server answer | Device state | Shown as |
|---|---|---|
| 200 | removed from queue; snapshot marked checked in | Checked in |
| 409 with `conflict` | removed; snapshot marked for review (the server holds the record) | Held for an organiser |
| 410 | kept; snapshot closed | Saved on this device, sent if check-in reopens |
| network, 429, 5xx, non-JSON | kept | Saved on this device, waiting to sync |
| other 4xx | kept as `unsent` with the reason | Not sent, tell an organiser |

Idempotency comes from the server. Each operation carries a device-generated `opId` and the record version the device saw (`basis`). Replays of the same `opId` return the first outcome. A stale `basis` on a record that is not checked in means an organiser changed it (for example, an undo), so the server holds the check-in for review instead of applying it.

To swap in another front-end design, keep this seam: call `enqueue` on tap and handle `failed`, render from `entries()` and `link()` inside a `subscribe` callback, and drive `refresh()` and `flush()` separately on a timer, when the page becomes visible, and on the `online` event.

## Organiser queue

On loopback only, organiser check-in and undo are queued on the organiser computer and shown at once. They are sent in the background, again with operation IDs. A refused change stays visible as a conflict until the organiser discards it.
