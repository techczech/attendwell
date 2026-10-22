---
title: Privacy and data handling
type: policy
status: current
---
# Privacy and data handling

## Where data lives

| Data | Where | Who sees it |
|---|---|---|
| Names, emails, booking status, attendance, audit | SQLite on the organiser computer (outside the repository, directory mode 700, file mode 600) | Organiser register only |
| Names, opaque per-database tokens, checked-in flag, public workshop details | Participant listener responses, and `localStorage` on participant devices | Anyone with the participant link while check-in is open |
| Queued check-ins (token, name, operation ID, time) | `localStorage` on the participant device that took them | That device |
| Queued organiser changes (ID, name, intended state) | `localStorage` in the organiser browser on loopback | The organiser |
| Paired iPads: label, SHA-256 hash of the iPad's credential, times, reported outbox counts | SQLite on the organiser computer | Organiser register only |
| Names, device person tokens, check-in window, workshop title and date | Device API answers, and the paired iPad's own store | Paired iPads holding a valid credential |
| Credentials (Argon2 hashes) | Private config file outside the repository | The service |

There is no external data store. The Cloudflare proxy stores nothing, caches no names or check-ins, and forwards no cookies or authorisation headers. It is not a queue.

## Rules the code enforces

- Participant responses contain names and opaque tokens only. Cancelled and unadmitted waiting-list bookings are excluded, and emails, source IDs and source statuses never appear. Tests check each of these.
- The participant listener exposes exactly two browser API routes, plus the separate device routes for paired iPads. It cannot reach roster, import, export, admission or window control, even through the proxy.
- Device routes (`/device/v1/*`) answer names and opaque tokens only, and only to a paired, unrevoked iPad; pairing codes and device credentials are stored as hashes and never logged. Organiser device routes exist only on a loopback organiser listener. See [reference-device-api.md](reference-device-api.md).
- Password-free organiser access requires a loopback origin and a loopback bind.
- Writes need the exact configured origin, a custom request header and JSON. The proxy additionally refuses preview hostnames.
- The service refuses a config or database stored inside the application folder.
- Recipient export includes only checked-in, eligible people with a valid email, rechecked against saved attendance for every copy or download.

## Repository hygiene

- Never commit real rosters, exports, databases, credentials, screenshots of real people, or links to private documents. `.gitignore` covers `*.sqlite*`, `*.xlsx`, `*.csv`, `*.local.json`, `private/`, `.env*` and `test-results/`.
- Tests and examples use fictional names on `example.org`, `example.net` and similar reserved domains.
- Scan the repository for private data before every commit and before any publication.
