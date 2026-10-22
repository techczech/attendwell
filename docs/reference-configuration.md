---
title: Configuration reference
type: reference
status: current
---
# Configuration reference

## Workshop file (`ATTENDANCE_WORKSHOP_PATH`)

JSON, validated by `parseWorkshopConfig` in `server/workshop-config.ts`. Unknown fields are refused. The file holds no secrets.

| Field | Required | Rule | Example default |
|---|---|---|---|
| `sessionId` | yes | 1–64 letters, digits, `.`, `_` or `-` | `example-session-001` |
| `title` | yes | plain text, up to 200 characters | `Example Hands-On Workshop` |
| `date` | yes | real date, `YYYY-MM-DD` | `2030-01-15` |
| `startTime`, `endTime` | no | `HH:MM` (24-hour), start before end | `13:00`, `16:00` |
| `organiserHelp` | no | plain text, up to 300 characters; shown wherever participants are told to ask for help | `Please speak to the workshop organisers.` |
| `participantBasePath` | no | `/` followed by lower-case letters, digits and `-`, up to 64 characters; not `/check-in`, `/api`, `/assets`, `/sw.js` or `/index.html` | `/example-check-in` |
| `publicOrigin` | no | exact HTTPS origin, or `null` | `null` |
| `sourceStatuses` | no | 1–20 source labels, each mapped to `confirmed`, `cancelled` or `waiting` | `Confirmed`, `Cancelled`, `Waiting list` |

`bun run start` requires the first three fields. `bun run preview` fills in any missing field from the fictional example.

Participants see only `title`, `date`, `startTime`, `endTime` and `organiserHelp`.

## Service environment

| Variable | Purpose |
|---|---|
| `ATTENDANCE_CONFIG_PATH` | Private JSON with `origin` and `users`, stored outside the repository. A loopback `origin` gives password-free organiser access. Any other origin must be HTTPS and needs Argon2 users (`bun run configure`). |
| `ATTENDANCE_DATABASE_PATH` | SQLite file in a private directory, outside the repository. macOS and Linux: mode 700. Windows: the directory's access list may allow only the current user, SYSTEM and Administrators, as a folder in your AppData does; the service checks it and refuses to start otherwise. |
| `ATTENDANCE_WORKSHOP_PATH` | Workshop file (above). |
| `ATTENDANCE_PARTICIPANT_ORIGIN` | Optional. Exact HTTPS origin of the tunnel host; turns on the names-only listener. |
| `ATTENDANCE_PARTICIPANT_PORT` | Participant listener port (default 4319). |
| `ATTENDANCE_LISTEN_PORT`, `ATTENDANCE_BIND` | Organiser listener port and bind address (default `127.0.0.1`). |
| `ATTENDANCE_HOST_SECRET_PATH` | Optional. File holding the 32-byte host secret behind paired iPads' organiser-proof keys (docs/reference-device-api.md, "Organiser proof"). It keeps the secret out of the register database, so a copy of the database is not enough to derive the keys, and a workshop's laptop keeps proving itself to the iPads it paired across restarts and new tunnel addresses. A proof is issued only for an iPad paired in this workshop's register: an iPad new to this workshop needs the organiser PIN or a fresh pairing, even when every workshop uses the same file. Created with mode 600 if missing. On every platform the service refuses to start if the path is a symlink or the file does not hold exactly 32 bytes; on macOS and Linux it also refuses a file readable or writable by group or others, or belonging to another user. Keep it outside the application folder. On Windows mode bits say nothing about access, so those two checks are skipped: the desktop app creates the file inside its own private data folder (the per-user application data folder). If unset, each register database keeps its own secret, so proofs work only within that database and a copy of the database is enough to derive the keys. |
| `ATTENDANCE_SECRETS` | Optional; set to `stdin` by the desktop app. The service then reads one JSON line (at most 32 KB, ended by a newline) from standard input within 5 seconds, before it creates any file or binds any listener: `{"organiserToken": "<43 base64url characters>"}`, plus `"tlsKey"` and `"tlsCert"` when the participant listener is TCP. The organiser token is a fresh key for this start of the service (32 random bytes); every request to the organiser listener must then carry `Authorization: Bearer <key>` (compared in constant time) and anything else gets 401, so another program or account on the same computer cannot use the loopback organiser listener. Secrets never travel in the environment: the service refuses to start if `ATTENDANCE_ORGANISER_TOKEN` or the TLS key variables are set, or if the line is missing, late, malformed, too long, not ended by a newline, followed by more input (the service reads on to the end of input, which must come within the same 5 seconds), has an unknown key, or carries a TLS key and certificate that do not belong together. Never logged. The participant listener is unaffected. |
| `ATTENDANCE_ASSETS_PATH` | Optional. Folder of the built interface; defaults to `dist/` in the repository. The desktop app sets it for its compiled service. |

## Pages proxy environment

| Variable | Rule |
|---|---|
| `CHECKIN_PUBLIC_ORIGIN` | exact HTTPS origin participants open |
| `CHECKIN_PREFIX` | same rule as `participantBasePath` (a test keeps the two rules identical) |
| `CHECKIN_ORIGIN_HOST` | tunnel hostname only, with no scheme; must differ from the public host |
