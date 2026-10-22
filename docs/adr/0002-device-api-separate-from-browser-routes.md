# ADR 0002 — Device API is separate from browser routes

Status: accepted (2026-10-01)

## Context

The participant listener protects browser routes with an exact `Origin` and the `X-Attendance-Request` header: browser CSRF controls. A native client sends no meaningful `Origin`; faking one would quietly weaken the model.

## Decision

- **Browser routes stay exactly as they are.** No relaxation of Origin or header enforcement for any reason.
- Native devices use **`{base}/device/v1/`** routes with their own middleware: bearer device credential (except `hello` and `pair`); requests carrying `Origin`, `Cookie` or `Sec-Fetch-Site` are **rejected**; JSON only; `X-Attendance-Device-Protocol` required; no CORS headers; `OPTIONS` gets 405; 64 KB body limit.
- A device credential's reach is small: its event's visible names roster, check-in operations and heartbeats.
- Organiser device routes (pairing sessions, device list, rename, revoke, recovery import) are **loopback-only** and never forwarded by any front door.
- No device route returns or accepts email, booking status, source fields, counts or exports; an automated test scans every device response.

## Consequences

- A browser page cannot use device routes at all; a native client cannot use browser routes without the browser controls.
- The front-door allowlist gains the device paths and `/pair` under the configured prefix; organiser and export routes stay unforwarded.
