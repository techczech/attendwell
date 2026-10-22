# ADR 0003 — Pairing exchange, credentials and device identity

Status: accepted (2026-10-01)

## Context

The first draft returned a server-generated credential in the pair reply and matched devices by an `installId`. A lost reply then left the iPad unpaired with a spent code, and an `installId` (copied or guessed) could take over another device's record.

## Decision

- The **iPad generates its credential** (32 random bytes, `dc_` prefix), stores it in Keychain as pending (`AfterFirstUnlockThisDeviceOnly`, not synchronisable) and sends only its **SHA-256 hash** in `pair`. The host stores hashes only and never holds the plaintext.
- **The one-time exchange survives a lost reply:** for 15 minutes after a code is spent, a repeat with the same code and the same hash returns the same 201 and device; any other hash gets the generic `invalid_or_expired_code`. The iPad retries until it has a definite answer, then promotes or deletes the pending credential.
- **`installId` never proves device ownership.** It is not sent and is used only locally to clean up stale Keychain items. A pair exchange creates a new device record unless (a) the session was created by the organiser's **Pair again** on that device's row (`targetDeviceId`), or (b) the request carries that device's current, unrevoked credential as old-device proof.
- Pairing codes: one-time, 5-minute expiry, bound to one event, hashed at rest; the 8-character manual code locks the session after 5 wrong tries; the pair route is rate-limited in the Bun listener itself.
- The QR is an HTTPS URL to `{base}/pair` with parameters in the fragment; `/pair` is a static, scriptless, `no-store`, `no-referrer` page.
- Operation idempotency is keyed by `(eventId, opId)`, never by device, so a re-paired iPad's retries are still `already_applied`.

## Consequences

- Re-pairing never duplicates a device in the list when done through Pair again or from a still-valid iPad; otherwise a second record appears and the organiser can rename or revoke it.
- Revocation keeps every pending row on the iPad; Pair again on the laptop row is the recovery route.

## Amendment · 2026-10-21 (AttendWell release 1)

- **Wrong-code rule:** instead of a permanent lock, only a well-formed code (8 characters from the code alphabet) that matches no recent pairing counts as a wrong try; every fifth wrong try pauses the open pairing for 30 s, then 60, 120 and 240 s, and every code is refused during a pause. Malformed codes and codes of recent spent, expired or cancelled pairings never count. Reason: the participant address is public, so a permanent lock let any stranger disable pairing with five requests; the pause keeps guessing cost negligible (about 20 checked guesses per 5-minute code against 30^8 codes, plus the listener rate limit).
- **Organiser proof for re-pairing (forgotten-PIN route, Kiosk journey J6):** `pair` returns an `organiserProofKey` the iPad keeps device-only; a later fresh code replaces an existing pairing without the PIN only if the new host proves it holds that key (HMAC over device id, event id, code, an iPad nonce in `hello`, and the participant origin the iPad sent `hello` to). Without a proof the iPad asks for the organiser PIN. Exact wire format: `contract/device-v1/pairing.md`. Reason: a stranger's HTTPS server could otherwise act as "the laptop" and reset the PIN; the origin line stops it relaying the real laptop's proof through its own QR address.

