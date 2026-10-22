---
title: Device API for paired iPads
type: reference
status: current
---
# Device API for paired iPads

The native iPad app (AttendWell) pairs with the laptop and then checks people in through **device protocol v1**. The contract lives in `ipad/contract/device-v1/`, with the decisions behind it in `docs/adr/` (0002 to 0004). This service conforms to it. Copies of the contract fixtures live in `tests/fixtures/device-v1/` (source commit in `SOURCE.md` there), and `tests/device-contract.test.ts` checks the host's answers against every one of them: roster, heartbeat, operations, pairing offer and success, and the revoked and protocol errors. `tests/device-organiser-proof.test.ts` pins the organiser proof against the proof fixtures.

## Where the code is

| Part | File | Role |
|---|---|---|
| Registry | `server/device-attendance.ts` | Event identity, pairing sessions, device records, the names-only snapshot, check-in operations, heartbeats. All decisions; no HTTP. |
| HTTP | `server/http-device-attendance.ts` | Device middleware on the participant listener, the static `/pair` page, organiser device routes, rate limits. |
| Host secret | `server/host-secret-attendance.ts` | Loads or creates the organiser-proof host secret file (`ATTENDANCE_HOST_SECRET_PATH`). |
| Wiring | `server/http-attendance.ts` | Sends `/device/*` and `/pair` to the device handler before any browser rule runs, and `/api/organiser/*` to the organiser device routes on a loopback organiser listener only. |

## Event identity

Each register database gets a stable `eventId` (`evt_…`) and a 4-character `eventCode` the first time the service opens it. Both are kept in the `metadata` table, so a backup of the database keeps them. The iPad keys its outbox by `eventId`, never by the address.

## Device routes (participant listener)

Base: the participant origin (`ATTENDANCE_PARTICIPANT_ORIGIN`). The iPad appends `device/v1/<route>`.

| Route | Auth | Request | Success |
|---|---|---|---|
| `POST /device/v1/hello` | none | `{"code"}`, optional `organiserProof: {deviceId, nonce}` | 200 `{eventId, eventCode, eventName, eventDate, deviceLabel}`, plus `organiserProof` when asked and able (see Organiser proof) |
| `POST /device/v1/pair` | none; optional `Authorization: Bearer` with the iPad's current credential as old-device proof | `{"code", "credentialHash"}` | 201 `{eventId, deviceId, deviceLabel, credentialHash, organiserProofKey}` |
| `GET /device/v1/roster` | bearer | — | 200 snapshot (below) |
| `POST /device/v1/operations` | bearer | `{eventId, operations:[{opId, personToken, baseRevision, windowRevisionSeen, recordedAt}]}`, 1–50 operations | 200 `{eventId, serverTime, window, results:[{opId, outcome, reason?}]}` |
| `GET` or `POST /device/v1/heartbeat` | bearer | optional `{pendingCount, heldCount, oldestPendingAt, appVersion}` | 200 `{eventId, serverTime, window, rosterVersion}` |
| `GET /pair` | none | — | Static scriptless HTML page, `no-store`, `no-referrer`. The QR's fragment never reaches the server. |

Every device request must:

- carry `X-Attendance-Device-Protocol: 1` (missing: 400; any other value: 426 `{"error":"protocol_unsupported","protocolVersions":[1]}`);
- carry no `Origin`, `Cookie` or `Sec-Fetch-Site` header (403), so a browser page cannot use these routes;
- use `Content-Type: application/json` on `POST` (415), with a JSON object body of at most 64 KB (413, 400).

The participant listener accepts bodies up to 64 KB for this reason. Browser check-ins on the same listener keep their own limit of 4 KB, counted in UTF-8 bytes before the body is parsed (413).

There are no CORS headers, and `OPTIONS` gets 405. Every answer is JSON with `Cache-Control: no-store`.

### Errors the iPad acts on

| Status | Body | Meaning on the iPad |
|---|---|---|
| 401 on `hello`/`pair` | `{"error":"invalid_or_expired_code"}` | Definite refusal: drop the pending attempt. The same body is used for wrong, expired, locked, spent and cancelled codes. |
| 401 elsewhere | `{"error":"device_revoked"}` | Unknown, malformed, replaced and revoked credentials all look the same. The iPad keeps every saved check-in. |
| 409 | `{"error":"event_moved"}` | The operations name a different event. |
| 426 | `protocol_unsupported` | Update needed. |
| 429 | `{"error":"rate_limited"}` with `Retry-After` | Slow down: kept, not retried at once; nothing is lost. |
| 500 | `{"error":"server_error"}` | Like any 5xx (including a tunnel's error page): the laptop cannot be reached; retried with backoff, nothing is lost. |

### Snapshot (`roster`)

```json
{"eventId":"evt_…","eventCode":"7Q2M","eventName":"Example Hands-On Workshop","eventDate":"2030-01-15",
 "serverTime":"…","rosterVersion":"rv_…",
 "window":{"state":"open","revision":3,"openedAt":"…","closesAt":"…"},
 "people":[{"personToken":"pt_…","displayName":"Alex Example","revision":1,"checkedIn":false}]}
```

- `people` holds the same eligible people the browser page lists (confirmed, or admitted from the waiting list), with names only. There are no emails, booking statuses or source fields; a test scans every device answer with the iPad's own names-only rule.
- **No address in device text.** The iPad refuses a whole answer if any value looks like an email address. So when a name or the workshop title contains one (for example `Alex Example <alex@example.org>`), the iPad gets it without the address: every word holding an `@` is dropped, then any empty brackets and trailing separators. A name that was only an address shows as `Name hidden`. Nobody is left out, the person's token is unchanged, and text without an address is sent as it is. The organiser's device list shows each changed text under `adjustedText` so the record can be corrected in the register.
- `personToken` is `pt_` plus 24 hex characters, derived with a per-database secret in a separate domain from the browser page's tokens.
- `revision` is the register's record version; the iPad sends it back as `baseRevision`.
- `window.revision` goes up each time the organiser opens or closes check-in. Natural expiry keeps the revision and reports `closed` once `closesAt` passes.
- `rosterVersion` (`rv_` + 16 hex) changes whenever anything in the snapshot except `serverTime` changes. It is the contract's only change token: the iPad compares the heartbeat's `rosterVersion` with its cached one for equality and fetches the roster only when they differ. It is not ordered. There is no `cursor` field; the contract no longer has one.
- The snapshot is served while check-in is closed too, so an iPad can prepare before the window opens.
- A full 500-person register stays under the iPad's 64 KB response limit (tested).

### Operations

Each operation goes through the register's own check-in rule (`AttendanceStore.participantCheckIn`), with kind `device-check-in`, actor `device:<deviceId>` and the device id on the operation row.

| Register result | Outcome |
|---|---|
| Applied | `applied` |
| Person already checked in (by anyone) | `already_applied` |
| Same `opId` seen before, from any device or pairing | the first answer again (`applied` is repeated as `already_applied`) |
| Record changed since the iPad saw it | `held`, reason `stale` |
| Two eligible people with the same name | `held`, reason `duplicate_name` |
| Not eligible | `held`, reason `not_on_form` |
| Token of a person a later roster import removed (the record is kept, inactive) | `held`, reason `not_on_form`; recorded in the register's conflict queue with reason `not-in-roster` (below) |
| Unknown person token | `held`, reason `unknown_person`; kept on the organiser's device list (below) |
| `opId` already used for another person or by the browser page | `held`, reason `invalid`; kept on the organiser's device list (below) |
| Check-in window closed | `closed` (not recorded; the iPad keeps it and resends after reopening) |

Held check-ins appear in the organiser's register as conflicts, exactly like held browser check-ins. Two cases need more:

- **Removed by a re-import.** An iPad can check someone in offline and upload after a re-import has removed that booking. The service still recognises the token, records the operation as a conflict with reason `not-in-roster`, and shows it in the conflict queue even though the booking is inactive. The organiser can only dismiss it (`Keep not checked in`); checking in answers 409 until the booking is imported again or the person is added. A replay of the same `opId` gets the same `held` answer.
- **No record to attach to.** `unknown_person` and `invalid` holds are kept in `device_holds`, once per operation, device and reason, and listed under `unmatchedCheckIns` on the organiser's device list until the organiser dismisses them.

## Pairing (ADR-0003)

1. The organiser creates a pairing on the laptop. The service keeps at most one open pairing; a new one cancels the previous one.
2. The laptop shows the QR, `{participantOrigin}/pair#v=1&code=XXXX-XXXX`, and the same 8-character code for typing. The code uses `A–Z` and `2–9` without `I`, `L`, `O`, `U`, `0` or `1`. The iPad normalises it to upper case without the dash.
3. The iPad calls `hello` to show the event and the iPad's label, then generates its own 32-byte credential (`dc_` + base64url), keeps it, and sends only its SHA-256 hash to `pair`.
4. The service records the device (id, label, credential hash, paired time) and marks the code spent.

Rules:

- A code works for **5 minutes** and **once**. It is stored only as an HMAC.
- **Wrong codes pause the open pairing; nothing locks it for good** (ADR-0003 amendment of 2026-10-21, which replaces the original "locks after 5 wrong tries"). Only a well-formed code (8 characters from the code alphabet) that matches no recent pairing counts as a wrong try. Malformed codes and codes of recent cancelled, expired or spent pairings are refused without counting, so junk from outside cannot spend the organiser's code. Every fifth wrong try pauses the open pairing: 30 seconds, then 60, 120 and 240 (a code lives 5 minutes). During a pause every code is refused, the right one included, and further tries are not counted, so guesses made during a pause can never succeed. The organiser's device list shows the pairing as `paused` with `wrongAttempts` and `pausedUntil`; showing a new code starts afresh.
  The reason, as the amendment gives it: the participant address is public, so a permanent lock let any stranger disable pairing with five requests; the pause keeps guessing cost negligible (about 20 checked guesses per 5-minute code against 30^8 codes, plus the listener rate limit).
- **Lost reply:** for 15 minutes after a code is spent, the same code with the same hash gets the same 201 and device, with the same `organiserProofKey`, as long as that device still holds that credential and is not revoked. Any other hash gets the generic refusal.
- **Same device record** only through the organiser's **Pair again** on a device row (`targetDeviceId`), or when `pair` carries that device's current, unrevoked credential as a bearer. The old credential stops working at once. Otherwise pairing creates a new record. A Pair again code sent with another paired iPad's credential as the bearer gets the generic refusal and changes nothing (it neither counts as a wrong try nor spends the code).
- The device's label is set by the organiser on the laptop. The iPad never sends its own name.
- The six-digit organiser PIN that locks the Kiosk is set on the iPad (Kiosk design). The laptop has no part in it.
- `hello` and `pair` share a budget of 30 requests a minute in the listener. Failed bearer checks have a budget of 60 a minute. All tunnel traffic arrives from one local address, so both budgets are global.
- Credentials and codes are compared in constant time.
- The audit table records pairing issued and cancelled, paired, re-paired, failed attempts, pauses, renamed and revoked, dismissed unmatched check-ins, with the device id where there is one. It never records codes, credentials or hashes.
- The service logs nothing about devices.

## Organiser proof (re-pairing without the PIN)

An iPad with a current pairing replaces it from a new QR only with organiser authority: the organiser PIN on the iPad, or, when the PIN is forgotten (Kiosk journey J6), proof that the host behind the new QR is the one that paired it. A stranger's HTTPS server cannot give that proof, so it can neither take over the iPad nor reset its PIN. The contract is in `contract/device-v1/pairing.md` ("Organiser proof") and the ADR-0003 amendment in `docs/adr/`.

**The key.** Every `pair` 201 carries `organiserProofKey`: `opk_` + 43 base64url characters (32 bytes, unpadded), computed as `HMAC-SHA256(hostSecret, "organiser-proof-key:" + deviceId)`. It is derived when the reply is built and never stored, so the same key comes back on a lost-reply replay, after a restart, on a new tunnel address and after **Pair again** (the device id is kept). Each device gets a different key. It is never logged, audited, exported or shown on an organiser route (a test scans a full run: console, every table, every organiser answer).

**The host secret.** With `ATTENDANCE_HOST_SECRET_PATH` set (docs/reference-configuration.md) the secret is a 32-byte file that outlives any one register database, so every workshop the app runs with that file derives the same key for a device id. That does not carry a proof across workshops: a proof is issued only for a device paired in the current register (below), so an iPad new to this workshop needs the organiser PIN or a fresh pairing. Without it the service falls back to a secret kept in the register database's `metadata` table: proofs then work only within that one database (the same workshop, across restarts), and anyone holding a copy or backup of the database can derive the keys.

**The proof.** In the forgotten-PIN route the iPad sends `hello` with `organiserProof: {deviceId, nonce}`, `nonce` being 32 random bytes as 64 lowercase hex. The 200 reply adds `organiserProof` only when all of these hold:

- the code is valid and usable (the reply would be 200 anyway);
- `organiserProof` is an object with a `deviceId` of 1–64 letters, digits, `_` or `-` and a `nonce` of exactly 64 lowercase hex characters;
- the device id is a device in this register that is not revoked. A device whose credential was replaced (by Pair again or a bearer re-pair) keeps its id and row, so it still gets a proof; its iPad still holds the same key. A revoked device gets none: the organiser removed it, so only the PIN, or Pair again on the laptop, may replace its pairing. A device known only to another workshop's register gets none, even with the same host secret file;
- when the code is a **Pair again** code for one device (`targetDeviceId`), the device id is that device. Any other device gets the plain offer.

`organiserProof` is lowercase hex `HMAC-SHA256`, keyed by the UTF-8 bytes of the whole `opk_…` key, over the UTF-8 text of **six lines joined by a single LF, with no trailing LF**:

```
attendwell-organiser-proof-v1
<deviceId>
<eventId of the offer>
<normalised code, 8 characters, upper case, no dash>
<nonce>
<participant origin>
```

The last line is the participant origin the QR points at, exactly as it appears in the QR base: `scheme://host[:port]`, scheme and host in lower case, no trailing slash (for example `https://quiet-river-fixture.trycloudflare.com`). This binds the proof to the address the iPad scanned, so a proof fetched from the real laptop and relayed through a different QR address does not verify there. The service uses the participant listener's configured origin (`ATTENDANCE_PARTICIPANT_ORIGIN`), which is also the base of every QR it issues; it has no path prefix. The pinned example is `tests/fixtures/device-v1/hello-reply-organiser-proof-origin-bound.example.json`.

Otherwise the field is omitted. Nothing else changes: no error, the same status and the same offer. A malformed `organiserProof` is treated as absent and never counts as a wrong code. For a well-formed request the key and proof are always computed and every unrevoked device id is compared in constant time, so the work done does not depend on whether the device exists; only the field's presence differs, and that is visible only to someone who already holds a valid code. A wrong, expired, paused or spent code gets the usual 401 and no proof.

## Organiser device routes (loopback organiser listener only)

These exist only when the organiser listener's origin is loopback. They use the existing `Origin` and `X-Attendance-Request` rules and are never served on the participant listener. Changes need the owner role.

| Route | Purpose |
|---|---|
| `POST /api/organiser/pairing-sessions` `{label?, targetDeviceId?}` | New pairing. Returns `{sessionId, label, targetDeviceId, shortCode, qrPayload, baseUrl, expiresAt, serverTime, eventCode}`. With `targetDeviceId` it is **Pair again** for that row. The label defaults to "iPad N". 409 if the participant link is off. |
| `DELETE /api/organiser/pairing-sessions/{id}` | Cancels the open pairing. |
| `GET /api/organiser/devices` | `{eventId, eventCode, eventName, eventDate, serverTime, pairing, devices, unmatchedCheckIns, adjustedText}`. `pairing` is the latest unspent session without its code: `state` (`waiting`, `paused` or `expired`), `wrongAttempts` (wrong codes from outside so far) and `pausedUntil`. Each device has `id, label, status (active or revoked), pairedAt, lastSeenAt, revokedAt, appVersion, protocolVersion, reportedPending, reportedHeld, oldestPendingAt, reportedAt, checkInsReceived, needsReview, unmatchedCheckIns`. `unmatchedCheckIns` lists the latest 100 undismissed `unknown_person` and `invalid` holds (`id, opId, deviceId, deviceLabel, reason, recordedAt, receivedAt`). `adjustedText` lists names and the title the iPads see without an address (`participantId` or null for the title, `original`, `shownAs`). |
| `POST /api/organiser/device-holds/{id}/dismiss` | Clears one unmatched check-in from the list. Returns the device list. |
| `PATCH /api/organiser/devices/{id}` `{label}` | Rename. |
| `POST /api/organiser/recovery-import` `{file, dryRun}` | An iPad's recovery file (`.attendance-recovery.json`, contract device-v1: `format` `attendance-recovery`, `version` 1, `eventId`, `eventCode`, `deviceId` or null, `exportedAt`, `operations`). Refused whole (400/409) for another format, a newer version, another register's `eventId`, a bad `deviceId`, or more than 1000 operations. Each operation goes through the same step as a live upload from that iPad (kind `device-check-in`, keyed by `opId`), so the file imported twice, or the iPad sending the same check-ins live later, records each once. The check-in window is not consulted. `dryRun: true` runs the same steps and rolls them back. Returns `{eventCode, deviceId, deviceLabel, exportedAt, rows:[{opId, name, outcome: recorded, already, review or refused, reason?}], counts:{recorded, already, review, refused}, written}`; `deviceId` is `recovery-file` when the file names no known iPad. |
| `POST /api/organiser/devices/{id}/revoke` | Unpair. The iPad's next request gets 401; everything it already sent stays in the register and the iPad keeps what it has not sent. **Pair again** on the row recovers it. |

`reportedPending` and `reportedHeld` are what the iPad last said about its own outbox in a heartbeat. `checkInsReceived` and `needsReview` are counted from the register.

## Not built here

- The Pages proxy (`cloudflare/worker/_worker.js`) does not forward device routes or `/pair`, and it strips `Authorization`. The desktop app's tunnel points straight at the participant listener, so it does not need the proxy.
- The same-Wi-Fi mode (release 1.1).
