---
title: AttendWell desktop app
type: reference
status: current
---
# AttendWell desktop app

Electron app for the organiser's laptop: first run, the workshops library, the command palette, menus, Settings, update notices, and the register, pairing and connection screens. `main/runtime-port.ts` is the seam between the app and the register runtime.

## Commands (from the repository root)

| Command | What it does |
|---|---|
| `bun run desktop:dev` | Development run with hot reload. Set `ATTENDWELL_TEST=1` first for a run that shows no window. |
| `bun run desktop:build` | Builds and packages for this computer's platform: macOS dmg and zip (arm64, x64), Windows nsis (x64). Unsigned and not notarised; for local checks. Output in `desktop/release/`. |
| `bun run desktop:test` | Unit tests for the desktop code (also part of `bun test`). |
| `bun run desktop:smoke` | Headless smoke run: launches hidden, opens the palette, exits with no dialog. |
| `bun run desktop:icons` | Regenerates `desktop/build/icon.*` from `src/assets/app-icon.svg`. |

## Build and sign

| Command (repository root) | What it does |
|---|---|
| `bun run desktop:dist:mac` | Stages the arm64 register program and cloudflared, builds, and packages a signed macOS dmg and zip (arm64) in `desktop/release/`. Signed with the Developer ID Application certificate `DOMINIK LUKES (M7H45AGG8A)` from the login Keychain (the first run may show a Keychain access prompt; choose Always Allow), hardened runtime, each program with only its own entitlements: the app `build/entitlements.mac.plist` and Electron's helpers `build/entitlements.mac.inherit.plist` (JIT only), the register program `build/entitlements.sidecar.plist` (JIT only), cloudflared none (signed by `scripts/sign-bundled-programs.cjs` before the app; check with `codesign -d --entitlements :- <binary>`). Not notarised: for local use. |
| `bun run desktop:dist:mac:release` | The release build: the same signed build with notarisation on (`scripts/release-mac.sh`). electron-builder submits the app with `notarytool` using the Keychain profile in `APPLE_KEYCHAIN_PROFILE` (default `attendwell-notary`) and staples it; the script then signs, notarises and staples the dmg, runs `xcrun stapler validate` and `spctl -a -vvv -t install` on it, and leaves `AttendWell-<version>-arm64.dmg` in `desktop/release/` for upload to the GitHub Release. It refuses to start, and prints the `xcrun notarytool store-credentials` command to run, when the profile does not work. `bash desktop/scripts/release-mac.sh --check` only tests the profile. |
| `bun run desktop:dist:mac:test` | Same signing, but a test build: unpacked app in `desktop/release-test/`, with the marker `attendwellTestBuild` in its package.json so the test variables below work in a packaged app. For hidden checks only; never install or ship it. |
| `bun run desktop:dist:win` | Windows installer (nsis, x64), unsigned, in `desktop/release/`. Run on Windows; CI does this in `.github/workflows/desktop-windows.yml` (pushes to `main` and pull requests) and uploads the installer as an artifact. A `v*` tag runs `.github/workflows/release.yml`, which builds the same installer and attaches it to a draft GitHub Release; the notarised dmg is uploaded to that draft by hand. |

Version: `desktop/package.json` (`1.0.0`); `app.getVersion()` and Info.plist read it. `site/release.json` and `site/updates.json` carry the same number for the website and the update notice. A pre-release shows the What's new notes of the release it leads to (`resources/whats-new/1.0.0.md`).

On Windows the workshops folder defaults to `AppData\Local\AttendWell\Workshops`, and Settings refuses a folder outside AppData (the register runtime only accepts a private folder there).

## Test mode

`ATTENDWELL_TEST=1` creates every window hidden, hides the Dock icon, mocks the Keychain and never opens Finder, a browser or a dialog. Also read: `ATTENDWELL_USER_DATA` (a temporary user-data folder) and `ATTENDWELL_REGISTERS` (a temporary registers folder). Keep the real HOME; never launch the app visibly from a test. These variables work in development and in a test build (`desktop:dist:mac:test`); a release build removes every `ATTENDWELL_*` variable before reading anything (`main/test-mode.ts`).

In test mode the file pickers for a name list and an iPad recovery file show no dialog: they answer with the path in `ATTENDWELL_TEST_NAMES_FILE` or `ATTENDWELL_TEST_RECOVERY_FILE` (none set = cancelled). `node e2e/shots-names.mjs [outdir]` (after a build) saves hidden screenshots of the name-list and recovery sheets for comparison with the locked frames.

## Name lists and iPad recovery files

- Paste a name list and Import names from a file (⌘⇧I) work before Start, while check-in is open and after it has closed, but not while it is closing. Pasted lines are "Name, email", "Name <email>", tab-separated or a name alone; files are CSV, tab-separated text (UTF-8 with or without BOM, UTF-16 from Excel's "Unicode text") or XLSX, at most 5 MB, read in the main process only (`main/names-parse.ts`, `main/xlsx-read.ts`; formulas are never evaluated, their saved value is used).
- Every preview and every write goes to the register's own rules (`server/names-list.ts`) through the organiser listener; nothing is written until Add. When the workshop is not running the app opens the register on this computer only for the add (`RuntimePort.openRegister`) and closes it after. Each list's provenance is kept per workshop.
- Import iPad recovery file takes the `.attendance-recovery.json` an iPad exports (drop it on the sheet or choose it), shows what it would record, and records each check-in through the same step as a live upload, so importing twice records nothing twice.

## Layout

- `shared/` pure code used by main, renderer and tests: command registry (`commands.ts`), menus (`menu.ts`), settings schema, library view model (`workshops.ts`), Get started lifecycle.
- `main/` the process: windows, Settings host, update service, runtime port and fake, app state.
- `preload/` two preload files, each one bundled file (a sandboxed preload cannot load others), with channel names written inline.
- `renderer/` React: the main window and the Settings window page.
- `vendor/app-patterns/` the App Patterns 0.4.1 packages as tarballs.
