# Device protocol fixtures — PROVISIONAL

These JSON files describe the shapes the native iPad core (`WorkshopCheckInCore`) reads and writes for device protocol v1. They are **provisional**: written for the native iPad core from ADR-0004 (`docs/adr/`), with fictional names, tokens and ids. They were not captured from the host, and no host code has been checked against them. Host integration must confirm or correct them before anyone treats them as evidence of server behaviour.

| File | Shape |
|---|---|
| `device-v1/roster.example.json` | Roster: event identity, names-only people, window, server time and `rosterVersion` |
| `device-v1/heartbeat-request.example.json` | Heartbeat body: outbox counts and app version, never names |
| `device-v1/heartbeat-response.example.json` | Heartbeat reply: window, server time and `rosterVersion` |
| `device-v1/error-*.example.json` | Error bodies the iPad acts on (401 revoked, 426 update needed) |
| `device-v1/pairing-offer.example.json` | `hello` reply: event identity and organiser-chosen label |
| `device-v1/pairing-success.example.json` | `pair` reply: device id and the echoed credential hash |
| `device-v1/operations-request.example.json` | One sequential operation (`opId` UUIDv4, `baseRevision`, `windowRevisionSeen` audit only) |
| `device-v1/operations-response.example.json` | `applied`, `already_applied` and `held` results |
| `device-v1/operations-response-closed.example.json` | `closed`: not recorded, stays pending on the device |
| `device-v1/recovery.example.attendance-recovery.json` | Recovery file: names and operations only |

Rules the package tests enforce on every file here:

- A top-level `_provisional` marker is required.
- No key containing `email` or `booking`, and no `source` key, anywhere. No email-like values.
- Each file decodes into its package type (by file-name prefix).

Native-side pairing wire assumptions now live in `device-v1/pairing.md`. They remain provisional and are not evidence of actual host behaviour.
