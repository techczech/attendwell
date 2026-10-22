# Device protocol v1 — PROVISIONAL

This is the contract the AttendWell host (the Bun service in
the repository root) conforms to. It has not yet been captured from, or
validated against, the laptop service. A normal app launch now uses the real
HTTPS transport (`LiveHostTransport`); `FixturePairingTransport` remains an
in-memory stand-in for tests and the `--fixture-*` launch modes.

| Request | Provisional shape |
|---|---|
| `POST {base}/device/v1/hello` | JSON `code`, optional `organiserProof` `{deviceId, nonce}`; 200 returns `PairingOffer` (event identity/code/name/date and organiser-chosen device label), plus `organiserProof` (64 lowercase hex) when asked and able. See "Organiser proof" |
| `POST {base}/device/v1/pair` | JSON `code`, `credentialHash`; 201 returns `PairingSuccess` (eventId, deviceId, label, matching credentialHash and `organiserProofKey`) |
| Same-event re-pair | Existing, unrevoked credential in `Authorization: Bearer …` only at its original host/session endpoint; the new credential is never sent |
| Generic definite rejection | 401 JSON `{"error":"invalid_or_expired_code"}` clears only the pending attempt |
| Ambiguous reply | Timeout, malformed body, mismatched event/hash, gateway error or unsupported response retains the pending attempt |
| Device failure | 401 revoked, 409 event moved, 426 update needed preserve every saved check-in |
| `GET {base}/device/v1/roster` | Bearer. 200 returns `roster.example.json`: `eventId`, `eventCode`, `eventName`, `eventDate`, `serverTime`, `rosterVersion`, `window`, `people`. `rosterVersion` (`rv_…`) changes whenever anything but `serverTime` changes; it is not ordered and is compared for equality only. Person tokens are `pt_` + 24 hex |
| `GET` or `POST {base}/device/v1/heartbeat` | Bearer. Optional body `heartbeat-request.example.json` (`pendingCount`, `heldCount`, `oldestPendingAt`, `appVersion`; counts only). 200 returns `heartbeat-response.example.json` (`eventId`, `serverTime`, `window`, `rosterVersion`). The iPad fetches the roster only when this `rosterVersion` differs from the cached one |
| `POST {base}/device/v1/operations` | Bearer. Body `operations-request.example.json` (1–50 operations; the iPad sends one); 200 returns `operations-response*.example.json`. Held reasons: `stale`, `duplicate_name`, `not_on_form`, `unknown_person`, `invalid`. A replayed applied `opId` answers `already_applied` |
| Errors | 401 `{"error":"device_revoked"}` on bearer routes (unknown, replaced, revoked alike); 409 `{"error":"event_moved"}`; 426 `{"error":"protocol_unsupported","protocolVersions":[1]}`; 429 `{"error":"rate_limited"}` with `Retry-After`; 403 `{"error":"browser_request_refused"}` (an `Origin`, `Cookie` or `Sec-Fetch-Site` header); 400 `{"error":"bad_request"}`; a missing protocol header is 400 and any value other than `1` is 426 |
| Gateway or overload | Any 5xx (including a tunnel's 502/530 page with an HTML body) means "can't reach the laptop": no definite answer, retried with backoff, pairing attempt kept. 429 means "slow down": kept, and the iPad sends nothing to that origin (automatic rounds and taps alike) until `Retry-After` has passed (delta-seconds or HTTP date; 60 s if absent or unreadable; at most 600 s) |

The echoed hash in the success response and `hello` request shape are
**provisional assumptions** that must be reconciled with the host contract.
No fixture implies that the laptop currently supports these routes.
An address change uses organiser-targeted Pair again on the laptop. The native
client never forwards an existing bearer to a QR's different host or prefix.

## Organiser authority to replace a pairing

While the iPad has a current pairing, a new QR may replace it (and lead to
choosing a new organiser PIN) only with organiser authority:

- **Organiser PIN:** the organiser unlocked the iPad (Organiser → Pair again,
  or Use a new pairing code on a stranded attempt).
- **Organiser proof (forgotten PIN, Kiosk journey J6):** the host behind the new QR
  proves it issued this device's organiser-proof key. A stranger's HTTPS server
  cannot, so it can neither replace the pairing nor reset the PIN. Without a
  stored key (a host that issued none) only the PIN can replace the pairing,
  and nothing is sent anywhere.

A first pairing (no current pairing) needs neither.

### Organiser proof

- `pair` 201 carries `organiserProofKey`: `opk_` + 43 base64url characters
  (32 bytes, unpadded). The same key comes back on a lost-reply replay. The
  iPad keeps it only in the device-only Keychain item with the credential.
  A malformed key is an invalid reply (pairing attempt kept). The host must be
  able to recompute it for the device after a restart and on a new tunnel
  address; deriving it from a host secret that outlives the workshop, for
  example `HMAC-SHA256(hostSecret, "organiser-proof-key:" + deviceId)`, does
  this without storing it. It is never shown, logged or exported.
- In the forgotten-PIN route the iPad sends `hello` with
  `organiserProof: {deviceId, nonce}`: its current `deviceId` and a fresh
  nonce (32 random bytes, 64 lowercase hex). It never sends the bearer to a
  different host or prefix.
- If, and only if, the code is valid and the host can derive the key for that
  `deviceId`, the 200 reply adds `organiserProof`: lowercase hex
  HMAC-SHA256, keyed by the UTF-8 bytes of the whole `opk_…` key, over the
  UTF-8 text of these five lines joined by a single LF, no trailing LF:
  `attendwell-organiser-proof-v1`, `deviceId`, the offer's `eventId`, the
  normalised `code`, `nonce`. Otherwise the field is omitted (no error, so no
  device-id oracle beyond what a valid code already gives).
- The iPad verifies in constant time, then allows only that address, code and
  offer to replace the pairing. A missing or wrong proof leaves everything as
  it was and asks for the PIN.
- Fixtures: `hello-request-organiser-proof.example.json`,
  `pairing-offer-organiser-proof.example.json` (reply) and the key in
  `pairing-success.example.json`; the recorded proof verifies with that key.

### Stranded pairing attempt

A saved attempt without a definite answer (its address gone, for example a
restarted quick tunnel) can be replaced by a new QR under the same organiser
authority. The new attempt replaces the old one in one Keychain write; the
current credential, the event's queued check-ins and their `opId`s are kept
until the new pairing succeeds. An attempt that already has a definite success
is finished locally and cannot be replaced.

The canonical base is HTTPS, with no user information, query or fragment.
Endpoints append `device`, `v1` and the route to the complete session prefix.
Ambiguous dot segments and encoded separators are refused. Redirects are not
followed. The ephemeral HTTP session has no cookie, cache or credential store.
Every request carries `X-Attendance-Device-Protocol: 1`, JSON headers and no
`Origin`, `Cookie` or `Sec-Fetch-Site`.

The QR is `{participantOrigin}/pair#v=1&code=XXXX-XXXX`, for example
`https://quiet-river-fixture.trycloudflare.com/pair#v=1&code=K7QM-4TZP` for a
quick tunnel. Its fragment is parsed locally and is never visited in a browser.
Host codes use `A–Z` and `2–9` without `I`, `L`, `O`, `U`, `0` or `1`; the iPad
normalises manual codes to upper case with separators removed and accepts any
8 letters or digits (the host gives the definite answer).

Credential generation uses `SecRandomCopyBytes` for 32 bytes, encoded as a
`dc_` string with unpadded base64url. SHA-256 hashes the full credential string.
One Keychain item holds active and pending state atomically, with
`AfterFirstUnlockThisDeviceOnly` and synchronisation disabled. The installation
marker is local only and never appears on the wire. Pending state includes the
same address, code, credential and old proof on every retry. Definite success
is saved before local pairing metadata changes, so a later storage failure can
resume promotion without spending the code again.

Host-side five-minute session expiry, five wrong-code lockout, fifteen-minute
same-code/hash replay, rate limits and targeted device identity are **not
verified** by this native fixture. Those are acceptance requirements for host integration.
