# WorkshopCheckInCore

Dependency-free Apple Swift package for durable check-ins, native pairing, the HTTPS connection to the laptop and the AttendWell iPad screens. The core uses Foundation, system SQLite, Security and CryptoKit; `WorkshopCheckInUI` uses SwiftUI. There are no package downloads.

```sh
swift test --package-path WorkshopCheckInCore   # run from ipad/
# On a personal Mac, skip the tests that write to the Mac's own Keychain:
swift test --package-path WorkshopCheckInCore --skip KeychainBoundaryTests
```

## Public interface

| Call | Guarantee |
|---|---|
| `CheckInStore(fileURL:clock:)` | Disk-backed SQLite, `journal_mode=DELETE`, `synchronous=FULL`. Backup exclusion (and file protection on iOS) is requested **best effort**: a failure to set it is ignored, not reported. |
| `recordCheckIn(eventId:personToken:)` | Returns `.saved(opId)` only after the commit. Errors throw and claim nothing. Repeated or concurrent taps get `.alreadyDone` with the same UUIDv4 `opId`. Refused once the window is closed or past `closesAt`. |
| `rows(eventId:)`, `status(…)`, `outboxSummary(…)` | Event-scoped. Precedence: Checked in → Saved on this iPad → With the organiser → Not checked in. |
| `applyRoster(_:)`, `applyWindow(…)` | Names-only roster per event; a snapshot with email-like values is refused before anything changes. Older snapshots are ignored and operations are never touched. A lower window revision never replaces a higher one, even at the same or a later server time; its server time still updates the clock. |
| `isWindowOpen(eventId:)`, `estimatedServerTime(…)` | Within a boot: server time plus continuous monotonic time. After a reboot: wall clock plus the last offset. |
| `deliverPending(eventId:via:)` | Sequential, one operation per request, oldest first. `applied`/`already_applied` acknowledge, `held` is terminal and `closed` stays pending. Failures resend the same `opId`. Never holds the store lock across the network. |
| `pruneAcknowledged()` | Prunes only acknowledged operations at least 7 days old that the roster confirms. |
| `exportRecovery(…)`, `confirmRecoverySaved(_:)` | Names and pending operations only. Saving changes no operation state. |
| `removalPreview(…)`, `removeEventData(confirming:)` | Refused while unsent operations lack a saved recovery file, or if the preview is out of date. |
| `setPairing(eventId:participantAddress:)` | Email-like values are refused. Address is metadata only. A different event is refused while unsent operations lack a saved recovery file. No rows are deleted. |
| `DeviceProtocol.decode/encode/privacyViolations` | Schema boundary. Rejects email/booking/source keys and email-like values; errors name the JSON path, not the value. Dates are written as ISO 8601 UTC with milliseconds; whole-second and fractional dates are both read. |

| `LiveHostTransport(vault:store:client:retry:appVersion:)` | The laptop over HTTPS (device protocol v1). Reads the active credential from the vault on every call, so a re-pair to a new address takes effect at once. Bearer only in the `Authorization` header. Retries only "no answer" failures (unreachable, timed out, any 5xx gateway page) with jittered backoff; never a 429 or a definite answer. With a cached names list, a heartbeat reports the outbox counts and its `rosterVersion` decides whether the names are fetched again. |
| `URLSessionNativeClient` | Ephemeral session, no cookies, cache, credential store or redirects; system TLS with no trust override; 15 s request and 30 s resource timeouts; replies over 64 KB (1 MB for the names list) refused. |
| `cachedRoster(eventId:)`, `rosterVersion(eventId:)` | The session cache. The roster version is stored in the same transaction as the names, and removed with them at hand over. |

`FixtureHost` is a **fictional** in-memory host for tests and previews. It is not an HTTP client and does not show how the real host behaves. Wire shapes are the **provisional** fixtures in `contract/device-v1/`.

## Not covered

The tests include pairing, Keychain and Kiosk fault-injection cases. The unsigned simulator fixture app can also be compiled and run with a platform probe; see `iPad/README.md`.

No real host or physical iPad has been verified. Host contracts still need confirmation against a live host. Heartbeat/live integration is not wired into the fixture app. Backup exclusion and file protection remain best-effort in storage; the platform probe checks Simulator metadata, not protection on a locked physical device. macOS legacy Keychain tests establish persistence and isolation. The required iPad probe fails with `-34018` at the pending write in the unsigned app: iPad accessibility, PIN and protection checks remain unverified. Linux portability is not claimed. The Darwin sleep/boot timing implementation and its existing injected-clock regressions remain intact.

## Pairing and screens

- `PairingCoordinator` saves a pending credential before a request, retries the same code/hash, persists definite success and promotes atomically. Re-pairing never clears attendance.
- `KeychainCredentialVault` and `KeychainPINVault` use local installation identity only. No credential enters SQLite, wire fixtures or logs.
- `ParticipantAddress` / `NativeDeviceAPI` preserve prefixes and browser/device separation. The provisional wire assumptions are in `contract/device-v1/pairing.md`.
- `KioskModel` makes durable save and protected recovery operations reviewable independently of the UI. A slow send does not block a participant save.
- `KioskView` provides large person/name actions, Find your name/Already done, status-specific confirmation, setup, PIN, paused/closed and send-first recovery. Dynamic Type uses a single flexible column at accessibility sizes. The app contains no animation requiring Reduce Motion handling.
