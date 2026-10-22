# AttendWell

AttendWell is a workshop check-in app. The organiser runs it on a Mac or Windows laptop and keeps the register there; participants check themselves in by name on an iPad at the door. The register stores names and check-in status, and email addresses stay on the organiser's computer. The iPad keeps working if the connection drops, and sends each check-in once the laptop can be reached again.

Website: <https://techczech.github.io/attendwell/>

## Parts

- **Organiser app** (`desktop/`, with the register service in `server/` and `src/`): an Electron app for Mac and Windows. It runs the register, shows the pairing QR code, lists paired iPads and can export a list of attendees.
- **iPad door app** (`ipad/`): a native SwiftUI app for iPad. It pairs with the organiser app, keeps the names list and its queue of check-ins on the iPad, and sends them to the laptop.
- **Device protocol** (`ipad/contract/device-v1/`, `docs/reference-device-api.md`): the HTTPS interface between the two.

## How the iPad reaches the laptop

The organiser app starts a Cloudflare quick tunnel (the `cloudflared` program, bundled with the app) and gives the register a temporary public address. The iPad pairs by scanning a QR code or typing the address and a one-time code. No Cloudflare account is needed. The address changes each time check-in starts; pair again from the organiser app to move an iPad to the new address.

## Build from source

### Organiser app

You need [Bun](https://bun.sh) 1.3 or later and Node.js 22.

```sh
bun install
(cd desktop && bun install)
bun run check                  # TypeScript (covers the register service and the desktop app)
bun run test                   # unit and HTTP tests

bun run desktop:dev            # run in development
bun run desktop:dist:win       # Windows installer (run on Windows)
bun run desktop:dist:mac:test  # unpacked macOS test build
```

`desktop/README.md` describes the commands, test mode and signing; `desktop/README-runtime.md` describes the register runtime. The macOS release scripts expect the author's signing identity, so replace `-c.mac.identity` in the `dist:mac` scripts of `desktop/package.json` with your own, or use `bun run desktop:build` for an unsigned build.

### iPad app

You need a Mac with Xcode (iOS 16 or later SDK). From the `ipad/` folder:

```sh
swift test --package-path WorkshopCheckInCore
bash iPad/build-simulator.sh     # unsigned simulator build, no Apple account needed
bash iPad/smoke-simulator.sh     # launches it in an existing iPad simulator
```

To open the project in Xcode, use `ipad/iPad/AttendWell.xcodeproj` (regenerate it with `xcodegen generate` in `ipad/iPad` after editing `project.yml`). Signing for a real iPad needs your own development team and bundle identifier. See `ipad/iPad/README.md`.

## Documentation

- [Architecture](docs/reference-architecture.md)
- [Device API](docs/reference-device-api.md)
- [Configuration](docs/reference-configuration.md)
- [Roster import](docs/reference-roster-import.md)
- [Operations runbook](docs/runbook-operations.md)
- [Privacy policy source](docs/policy-privacy.md)
- [Register service on its own](docs/register-service.md)
- [Design decisions](docs/adr/)

## Licence

MIT. See [LICENSE](LICENSE) and [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
