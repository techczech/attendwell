# AttendWell for iPad

The iPad app for the door at a workshop. The organiser runs AttendWell on a Mac
or Windows computer; the iPad pairs with it by scanning the QR code the
computer shows (the link is HTTPS through a Cloudflare quick tunnel).
Participants tap their name and confirm. Names are kept in a local database on
the iPad, check-ins queue until the organiser's computer acknowledges them, and
the pairing credential and organiser PIN live in the iOS Keychain (this device
only). The app collects no data for the developer. iPad only, iOS 16 or later,
bundle identifier `net.dominiklukes.attendwell.ipad`, version 1.0.0.

All commands run from the `ipad/` folder.

## Build and test

```sh
swift test --package-path WorkshopCheckInCore --skip KeychainBoundaryTests
bash iPad/build-simulator.sh          # unsigned simulator app, Debug
xcodebuild test -project iPad/AttendWell.xcodeproj -scheme AttendWell \
  -destination 'platform=iOS Simulator,name=iPad Pro 13-inch (M5)'
```

`KeychainBoundaryTests` need a signed host and are skipped in the package run.
The UI tests include the demo journey; the live pairing test skips itself
unless `ui-test-pairing.sh` supplies a laptop address and code.

The Xcode project is generated from `iPad/project.yml` (`xcodegen generate
--spec iPad/project.yml` from `ipad/iPad`) and the result is committed.

## Run on a device

Open `iPad/AttendWell.xcodeproj`, choose your iPad and Run. Signing is
automatic with team M7H45AGG8A. Pairing, the Keychain and the camera need a
signed build on a real iPad (or a signed simulator build).

## Try a demo

The set-up screen has a small "Try a demo" link. It opens a practice workshop
("Demo workshop") with ten made-up names. Tapping a name and confirming shows it
checked in. A banner at the top says the names are made up and nothing is sent;
"Leave demo" returns to set-up. The demo makes no network calls, uses no Keychain
items and deletes its temporary data when you leave. It has no organiser or
pairing screens.

## Debug-only fixtures

Debug builds also accept `--fixture-setup`, `--fixture-home`, `--fixture-demo`
and `--fixture-platform-probe` launch arguments for screenshots and platform
checks (see `smoke-simulator.sh`). Release builds do not contain them.

## Archive for the App Store

```sh
bash iPad/archive-appstore.sh            # archive only: ipad/build/AttendWell.xcarchive
bash iPad/archive-appstore.sh --upload   # also export and upload to App Store Connect
```

Both use the Apple account signed in to Xcode. The app icon is built from the
desktop icon by `iPad/make-appstore-icon.py` (no alpha channel). The privacy
manifest `iPad/PrivacyInfo.xcprivacy` declares no tracking and no collected data,
and one required-reason API (system boot time, reason 35F9.1, used to time
retry and window checks). Store screenshots are in `appstore/screenshots/`.
