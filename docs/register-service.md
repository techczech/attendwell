# Register service (browser interface and loopback organiser register)

A local-first attendance register for in-person workshops. The organiser runs it on their own computer; participants check themselves in by name on a shared tablet (or their own phone) through a names-only page. It keeps working through connection drops and never puts email addresses on the participant side.

## What it does

- **Participant page**: readable name list with person icons, search, “Is this you?” confirmation, and a checked-in list. Names and check-in status only.
- **Immediate check-in**: a tap is saved on the device and acknowledged at once. Sending runs in the background, and each name shows its real state: *saved on this device*, *checked in*, *held for an organiser*, or *not sent*. The queue lives on the participant device only.
- **Offline**: a service worker caches the page shell. Queued check-ins survive reloads and are replayed with the same operation ID, so each one is written once.
- **Organiser register** (loopback): no password on `127.0.0.1`. Add a participant (email optional), admit from the waiting list, undo, resolve held check-ins, and see changes queued on the organiser computer.
- **Check-in window**: opens for 30 minutes by default; set anything from 1 to 1440 whole minutes. Close early or reopen at the same link.
- **Email review**: select checked-in, eligible attendees, review the deduplicated recipients, then copy the Bcc list, copy names with emails, or download a CSV. Nothing is sent from the app.
- **Conflicts**: a stale device check-in never overwrites an organiser's undo. It is held for the organiser to decide.

## Requirements

- [Bun](https://bun.sh) 1.3 or later. Dependencies are pinned in `package.json` and `bun.lock`.
- Optional: Cloudflare Pages plus a named Cloudflare Tunnel for a public participant link.
- Optional: Python 3 (standard library only) for the CoSy roster adapter.

## Setup

```sh
bun install --frozen-lockfile   # installs exactly the pinned versions from bun.lock
bun run check                   # TypeScript
bun run test                    # unit and HTTP tests (fictional data only)
bun run build                   # builds the interface into dist/
```

## Try it with fictional data

```sh
bun run build
bun run preview
```

- Organiser register: <http://127.0.0.1:4318> (no password on loopback)
- Participant page: <http://127.0.0.1:4319/check-in>

The preview uses fictional names and the example workshop in `server/workshop-config.ts`. To preview your own wording, set `ATTENDANCE_WORKSHOP_PATH=path/to/workshop.json`.

## Run a real workshop

1. **Workshop file**: copy `examples/workshop.example.json` and set `sessionId`, `title` and `date`. The other fields are optional; see [docs/reference-configuration.md](reference-configuration.md).
2. **Private folder outside the repository**: the service refuses a config or database inside the app folder.
   ```sh
   mkdir -m 700 -p ~/workshop-private/db
   cp examples/service.loopback.example.json ~/workshop-private/service.json
   ```
   Remote facilitator sign-in is optional. To set it up, run `bun run configure ~/workshop-private/service-remote.json`, which stores Argon2 hashes and never prints passphrases.
3. **Roster**: convert your booking export to the [normalised roster format](reference-roster-import.md), then import it from *Settings → Import booking records*.
4. **Start**:
   ```sh
   ATTENDANCE_CONFIG_PATH=~/workshop-private/service.json \
   ATTENDANCE_DATABASE_PATH=~/workshop-private/db/attendance.sqlite \
   ATTENDANCE_WORKSHOP_PATH=./examples/workshop.example.json \
   bun run start
   ```
   To add a names-only participant listener for a tunnel, also set `ATTENDANCE_PARTICIPANT_ORIGIN=https://<tunnel-hostname>` (and optionally `ATTENDANCE_PARTICIPANT_PORT`, default 4319).
5. **Public link (optional)**: see [docs/runbook-operations.md](runbook-operations.md). The Pages proxy reads `CHECKIN_PUBLIC_ORIGIN`, `CHECKIN_PREFIX` and `CHECKIN_ORIGIN_HOST` from its environment and forwards nothing until all three are valid.

## Documentation

- [Architecture](reference-architecture.md): components, data flow, the immediate check-in queue
- [Privacy](policy-privacy.md): what is stored where; what never leaves the organiser computer
- [Operations](runbook-operations.md): day-of-workshop runbook, public link, recovery
- [Configuration](reference-configuration.md): workshop and proxy settings
- [Roster import](reference-roster-import.md): the normalised format and the optional CoSy adapter

## Browser checks (optional)

`tests/browser-*.mjs` drive a running preview with Playwright. Playwright is not a dependency: set `ATTENDANCE_PLAYWRIGHT_PACKAGE` to the `package.json` of an existing Playwright install. Screenshots go to `test-results/`, which is git-ignored.
