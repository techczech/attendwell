# AttendWell for iPad

Native SwiftUI participant screens follow the kiosk design. A normal launch is the real app: it pairs with the organiser's laptop
by scanning its QR (or typing the address and code), keeps the credential in the
iOS Keychain (device only, not synchronised), downloads the names list into
local SQLite and works from that cache whether or not the laptop is reachable.
Check-ins queue in the outbox until the laptop acknowledges them. When the
laptop's quick-tunnel address changes, the organiser uses Pair again on the
laptop and the iPad's organiser menu; queued check-ins then go to the same event
at the new address. The home-screen name is AttendWell; the bundle identifier
is net.dominiklukes.attendwell.ipad. There is no same-Wi-Fi mode.

The fictional modes below (`--fixture-*`) keep their own data folders and the
"Fictional fixture demonstration" banner. `--fixture-demo` is the former
default launch: the fixture laptop with connection, close and reopen controls.

On an Apple machine with an existing iOS Simulator SDK/runtime:

```sh
From the `ipad/` folder:

swift test --package-path WorkshopCheckInCore
bash iPad/build-simulator.sh
bash iPad/smoke-simulator.sh
```

The scripts compile an unsigned simulator app and use an existing iPad runtime.
They do not install Xcode, download an SDK, sign, deploy or distribute the app.
The `.app` is for Simulator only; this is not a physical-iPad installation route.

Normal launch uses real Keychain storage. The unsigned simulator process
currently receives `-34018` (missing entitlement) at the first Keychain write;
it cannot complete real pairing until the app is signed. The required platform probe remains failing, rather
than falling back to insecure credential storage. No signing is authorised.

`--fixture-setup` offers a separate in-memory credential/PIN fixture for
reviewing the setup and check-in journeys without claiming Keychain persistence.
Manual fictional pairing uses
`https://checkin.example.org/s/k3v9` and `K7QM-4TZP`, confirms the event and sets
a six-digit organiser PIN. The event is labelled on the fictional laptop.
Only the organiser menu exposes the demo connection/close/reopen controls.
Selecting a name and confirming it writes SQLite before the saved screen.
Foreground sends then change the status only on a definite fixture acknowledgement.

`--fixture-home` is an isolated screenshot fixture: it uses a separate sandbox
database, in-memory credentials/PIN, an offline transport, an already-confirmed
person and a saved person. It does not exercise pairing and is never a host test.
`--fixture-platform-probe` runs isolated iPad-process checks for Keychain
pending/relaunch/promotion, device-only accessibility, non-synchronisation,
installation isolation, persistent PIN lockout, file-protection metadata and
backup-exclusion metadata. The report contains boolean results, the stage and
an optional numeric Keychain status; it never contains credentials, pairing
codes or raw errors.

The system file exporter marks recovery coverage only after successful saving.
The saved URL is shared through the system share interface. Exporting bytes or
opening a share interface does not mark delivery/import. Handover uses a fresh
removal preview and refuses uncovered or newly-added pending operations.

Apple-specific limits remain: Simulator metadata cannot prove protection while
a physical iPad is locked, keychain behaviour after a real reinstall, actual
camera scanning, hardware readability, VoiceOver, keyboard and suspension
behaviour. Real host contracts, recovery import and two-iPad host integration
are not yet verified on hardware.
