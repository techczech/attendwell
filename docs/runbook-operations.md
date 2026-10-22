---
title: Operations runbook
type: runbook
status: current
---
# Operations runbook

## Before the day

1. Write the workshop file (see [reference-configuration.md](reference-configuration.md)) and start the service with it (README, *Run a real workshop*).
2. Import the roster from *Settings → Import booking records*. Re-importing is safe: saved attendance is kept, and rows missing from the new export become inactive but recoverable.
3. On each participant device, open the participant link once while online. This caches the page and the name list for offline use.

## Public participant link (optional)

The organiser computer stays the only place with data. The public path is:

`https://<public-origin>/<prefix>/` → Pages proxy → `https://<tunnel-host>/check-in` → participant listener on `127.0.0.1`.

1. Create a named Cloudflare Tunnel that routes `<tunnel-host>` to `http://127.0.0.1:4319`.
2. Start the service with `ATTENDANCE_PARTICIPANT_ORIGIN=https://<tunnel-host>`.
3. Build the Pages output with `bun run build:pages`. This writes only `cloudflare/dist/_worker.js`.
4. In the Pages project, set these environment variables:
   - `CHECKIN_PUBLIC_ORIGIN`: for example `https://check-in.example.org`
   - `CHECKIN_PREFIX`: the workshop's `participantBasePath`, for example `/example-check-in`
   - `CHECKIN_ORIGIN_HOST`: `<tunnel-host>`, for example `origin.example.net`

   Until all three are valid, every request gets a 503 and nothing is forwarded.
5. Deploy it yourself with your own Cloudflare account. The repository has no deployment automation and no account identifiers.

Set `publicOrigin` in the workshop file to the same public origin, so the register shows the participant link.

## During the workshop

- **Window**: the first start opens a 30-minute window. Use the register to open it for 1–1440 minutes, close it early, or reopen it. A restart keeps the last setting.
- **Held check-ins**: they appear under *Participant check-ins held for your decision*. Choose *Check in* or *Keep not checked in*.
- **Missing person**: use *Add participant*. The name is required; the email is optional and stays on the organiser computer.
- **Waiting list**: use *Admit*, then check the person in (or let them check themselves in).

## After closing

If a device shows *saved on this device but not sent*, either reopen check-in (the device sends the queue automatically) or record those names in the register, then tap *Organiser: mark as handed over* on that device.

A device's queue belongs to one session identity: the participant origin and path, and the database behind them. The local preview is one configured service. Do not reuse an origin and path for another session, or point them at another database, while any device still holds unsent check-ins: hand those over first. Otherwise the old queue would be replayed against the new session.

## Recovery

| Symptom | Action |
|---|---|
| Participant page says *Offline* | Keep it open. Check-ins queue on the device and send when the connection returns. |
| Participant page says *Not reaching the register* | Names load but sends fail. Check the tunnel and service; queued check-ins retry automatically. |
| Participant page says *Not saved … could not be saved on this device* | The browser's storage is full or blocked (for example, private browsing). Record that person in the register, and use another device or browser. |
| The proxy shows *not configured* | Check the three Pages environment variables. |
| The proxy shows *cannot reach the register* | Check that the service and the tunnel are running on the organiser computer. |
| A new link was issued mid-session | Queued check-ins stay with the old link. Open the old link on that device to send or hand them over. |
| Service restarted | Tokens are stable per database. Devices replay their queues automatically. |
