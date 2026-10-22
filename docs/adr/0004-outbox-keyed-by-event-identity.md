# ADR 0004 — The iPad outbox is keyed by event identity, not network address

Status: accepted (2026-10-01)

## Context

A browser queue lives under the page's origin, so a changed IP address or URL orphans it. The iPad must survive address changes, re-pairing, app updates and crashes without losing or duplicating a check-in.

## Decision

- Each event has a **stable `eventId`** generated once on the host and kept in backups; a 4-character event code is shown for human cross-checking.
- The iPad's outbox and names are keyed by **`eventId` and person token**. The base URL is pairing metadata only; changing it never touches the outbox.
- A check-in **commits to local SQLite (`synchronous=FULL`, Application Support) before the Done screen appears**; every operation carries a device-generated `opId` reused on every retry.
- Row status precedence: Checked in (server or acknowledged) → Saved on this iPad (pending or sending) → With the organiser (held) → Not checked in. Only the first is ever described as "checked in".
- `closed` results are non-terminal (the row stays pending until the same event reopens); `held` is terminal and reported.
- Pending and held rows are never pruned automatically; acknowledged rows are pruned 7 days after settling once the roster confirms them.

## Consequences

- Re-pairing to the same event drains the existing outbox; re-pairing to a different event is blocked while the current one has pending rows.
- Handover and reset are blocked while pending rows exist unless a recovery file has been saved.
