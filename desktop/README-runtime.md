---
title: AttendWell desktop runtime
type: reference
status: current
---
# AttendWell desktop runtime

The headless part of the AttendWell desktop app: the workshops library, the register service (run as a compiled sidecar), the participant gateway and the Cloudflare quick tunnel. The Electron main process imports it from `desktop/runtime/index.ts`. It uses Node APIs only; a test fails if Bun APIs appear in `desktop/runtime/`.

## Interface

```ts
import {createRuntime} from './runtime/index.ts';

const rt = createRuntime({
  dataRoot,        // app.getPath('userData') + '/AttendWell data' (or similar); created private
  resourcesRoot,   // packaged: process.resourcesPath; development: desktop/resources
  settings: {tunnel: {mode: 'quick'}},  // or {mode: 'off'}; release 1 has no other mode
  // participantTransport: 'auto' (default: Unix socket on macOS, TCP + pinned TLS on Windows) or 'tcp-tls'
  // (the Windows path on any platform; for tests and the headless check on a Mac, not for the shipped app)
});
```

| Member | What it does |
|---|---|
| `rt.workshops.create({title, date, startTime?, endTime?, organiserHelp?})` | New workshop folder; returns the record. |
| `rt.workshops.list({includeArchived?})` | `{upcoming, today, past, archived}`; each item has `attended` (from the register, read-only; else the figure saved at the last session end; else `null`). |
| `rt.workshops.get(id)`, `setArchived(id, bool)`, `recordRosterProvenance(id, {...})` | Read, archive or unarchive, note where the name list came from. |
| `rt.openWorkshop(id)` | Chooses the workshop the next session runs. Refused while another workshop's session runs. |
| `await rt.startSession()` | Gateway, then tunnel (pointed at the gateway), then the register with the tunnel's public origin. Returns a snapshot. If the tunnel fails, the register still runs for the organiser and the snapshot carries the reason. Refused in plain words if the settings name any mode other than `quick` or `off`. |
| `await rt.testConnection()` | Checks the current public address with an eight-second deadline and a single-use gateway receipt. Returns `{ok: true}` or `{ok: false, reason, advice}`. Requires a running session and online address; does not start or restart either. A pass proves this laptop reached its gateway through the public address, not that a remote iPad can connect or that the register is healthy. |
| `await rt.retryTunnel()` | Tries the tunnel again without stopping the register. |
| `await rt.endSession()` | Stops the tunnel, saves the attended count, stops the register, then checks that nothing still runs or listens. Returns `{clean, leftovers}`. |
| `await rt.openRegister(id)` | `{organiserUrl, leaseId, live}`: the workshop's register on loopback only (no participant listener, no gateway, no tunnel, participant window untouched), for adding names before or after check-in. While that workshop's check-in runs, the session's own register is returned (`live: true`, nothing to release). One lease at a time; `startSession` stops a lease on its own workshop before it starts the register, so two registers never open one file. |
| `await rt.releaseRegister(leaseId)` | Stops a leased register. A lease id that has been replaced, or `null`, does nothing. |
| `rt.organiserAuth(organiserUrl)` | The organiser key of the register at that address (the session's or a lease's) while it runs, else `null`. For the app's organiser client only. |
| `rt.updateSettings(settings)` | Takes effect at the next session or `retryTunnel()`. Throws for any mode other than `quick` or `off`. |
| `rt.childPids()` | `{service, tunnel, lease}`: the process IDs of this runtime's own children, or `null`. For diagnostics and the headless check. |
| `await rt.shutdown()` | Call on quit (`before-quit`, after `event.preventDefault()` until it resolves). Cuts short a start in progress, ends the session, and reports leftovers, including processes from an earlier run that could not be confirmed or stopped. |
| `rt.status.get()` | Current snapshot. |
| `rt.status.on('change', snapshot => …)` | Every state change. |
| `rt.status.on('participant-origin-changed', ({workshopId, previous, current}) => …)` | A restarted quick tunnel has a new address. The register has already been restarted with it; prompt the organiser to re-pair the iPad. |
| `rt.status.on('log', line => …)` | One line from the register or cloudflared. Quick tunnels carry no credential; the host secret's contents are never read or logged. |

Snapshot: `{workshopId, session: 'idle'|'starting'|'running'|'ending', service, tunnel, orphans}`. `orphans` lists, in plain words, processes from an earlier run that AttendWell could not confirm as its own and so left running.

Start, retry, end, shutdown and the restart after a new quick-tunnel address all run through one queue, one at a time.

- `service`: `off` · `starting` · `running(organiserUrl, participant, participantOrigin)` · `restarting(attempt)` · `failed(reason, message)`. `participant` is `{socketPath}` on macOS, `{port, fingerprint}` on Windows (the SHA-256 of the certificate made for that register; public, not a secret), or `null` without a tunnel.
- `tunnel`: `off` · `starting` · `online(url)` · `reconnecting(attempt)` · `failed(reason, message)`.
- Tunnel failure reasons: `no-internet`, `blocked-by-network`, `cloudflared-missing`, `port-in-use`, `tunnel-refused` (Cloudflare refused the quick tunnel), `stopped-unexpectedly`. `message` is the plain-words text for the organiser.

## What the runtime guarantees

- **Quick tunnel only.** Release 1 runs `cloudflared tunnel --no-autoupdate --config <empty> --grace-period 1s --url http://127.0.0.1:<gatewayPort>`, with no account and no token. The empty config file stops a personal `~/.cloudflared/config.yml` from adding ingress rules. Own-domain tunnels return later with a locally managed config (credentials file + local ingress), never a remotely managed token.
- **cloudflared reaches only the participant gateway.** The gateway is an HTTP server in the runtime's own process (`participant-gateway.ts`, Node `http`), bound on 127.0.0.1 before cloudflared starts and kept bound for the whole session, through every restart of the register. It forwards only the participant and device paths the register serves on its participant listener (`/`, `/check-in`, `/sw.js`, `/assets/<file>`, `/api/participant-names`, `/api/participant-check-in`, `/pair`, `/device/v1/<name>`). Paths are matched after URL normalisation; anything else gets 404, absolute-form request targets 400. The gateway also answers `/_aw/probe/<token>` locally for Test connection: only a registered single-use random token is accepted, the receipt remains in the runtime, and the request is never forwarded to the register.
- **The gateway forwards only to this runtime's own live register.** The service supervisor switches forwarding off synchronously before it sends the register any signal and in the register's own exit handler, before anything else runs; until a register is healthy again every request gets 503.
  - **macOS:** the register's participant listener is a Unix socket (`ATTENDANCE_PARTICIPANT_SOCKET`), a fresh path for each register in the private run folder (or, if that path would pass the 104-byte socket limit, in a new private folder of the account's temporary directory, removed at shutdown). No participant TCP port exists. Only this account can bind in that folder, so when a register crashes, nothing else can take its place in the moment before its exit is seen: the gateway's connection is refused and it answers 503. The service refuses a socket path that already exists or whose folder is a link or not private.
  - **Windows:** loopback TCP (`ATTENDANCE_PARTICIPANT_PORT`), authenticated before any request byte is sent. For each register it starts, the runtime makes a fresh P-256 key pair and a self-signed certificate (`participant-tls.ts`, `node:crypto` only, built in memory; no new dependency) and gives both to that register on its standard input with its organiser key (see **Secrets** below; base64 DER; neither is written to disk or logged). The register's participant listener serves HTTPS on 127.0.0.1 with them. The gateway connects with TLS and uses the connection only if the peer's certificate has the SHA-256 fingerprint pinned for that register; no certificate authority or trust store is involved, and the Mac's or Windows' trust settings are never changed. The TLS handshake proves the peer holds that certificate's private key. Only after the pin matches, and only if forwarding is still on for that register, does the gateway write the request. So if the register crashes and another program (another Windows account included) binds its port before the exit is seen, that program receives a TLS ClientHello and nothing else: no request line, header or body, and it cannot forge a response; the gateway answers 503. Each restart gets a new certificate, so an earlier register's certificate is refused. The handshake is given at most 5 seconds. A TCP upstream without a pin is refused by the gateway, and the supervisor never starts a TCP participant listener without its certificate. The HTTP exchange on the verified connection is a small HTTP/1.1 client in `participant-tls.ts` (one request per connection; Content-Length, chunked and read-to-close responses; anything malformed gives 503), because Node's client cannot be handed an already-verified socket in every runtime the code runs in.
  - The same path runs on macOS with `participantTransport: 'tcp-tls'` (tests, and `node desktop/scripts/run-headless.ts --tcp-tls`).
  - On both platforms the Host header passes unchanged (the register checks it against the public origin), hop-by-hop headers are removed both ways, protocol upgrades are refused and request bodies are capped at 64 KB. The organiser listener is on another random loopback port, plain HTTP, and never leaves 127.0.0.1; the gateway cannot reach it (on Windows a plain HTTP listener fails the TLS handshake, so a mistaken upstream would also get 503 and no request bytes).
- **Organiser key**: every register spawn (session, lease, and every restart) gets a fresh 32-byte key (base64url), on its standard input (see **Secrets**). Its organiser listener refuses every request without `Authorization: Bearer <key>`, so another program or account on the computer cannot use it. The runtime's own health check and roster read send it; the app's organiser client gets it from `organiserAuth` on each call. It is never in a snapshot, a log line or a window.
- **Secrets**: children get a minimal environment (`PATH`, `HOME`, …), never the app's whole environment, and no secret is ever in a child's environment or arguments: other programs of the same account can read those for as long as the child runs (`ps eww` on macOS), even after the child deletes them from its own `process.env`. The register gets its environment with paths, ports and `ATTENDANCE_SECRETS=stdin` only. Its secrets go on its standard input, a pipe only the app holds: one JSON line of at most 32 KB ended by a newline, `{"organiserToken":…}` plus `"tlsKey"` and `"tlsCert"` on the TCP participant path, after which the app closes the pipe (`serviceSecrets` in `service-supervisor.ts`; `SpawnRequest.input` in `process-control.ts`). The register reads that line before it creates any file or binds any listener and refuses to start, naming no value, when the line does not arrive within 5 seconds, is not one JSON object, has an unknown entry, has a key that is not 32 bytes of base64url, lacks the key and certificate for a TCP participant listener or has them without one, or has a key and certificate that do not belong together. Input that ends before its newline, a longer line, any byte after the newline (in the same chunk of input or a later one) or a pipe still open 5 seconds after the start is refused too: after the newline the register keeps reading until the end of input, and accepts the line only then. It also refuses to start if any of `ATTENDANCE_ORGANISER_TOKEN`, `ATTENDANCE_PARTICIPANT_TLS_KEY` or `ATTENDANCE_PARTICIPANT_TLS_CERT` is in its environment. Standard input is used rather than an extra descriptor (fd 3) because Node's spawn and Bun's compiled sidecar handle it the same way on macOS and Windows. The runtime holds no tunnel credential.
- **Host secret**: `<dataRoot>/host-secret`, 32 random bytes created once, private like the register (POSIX 0600; Windows: the data root's private list), with the same link and containment checks. Its path goes to every register start as `ATTENDANCE_HOST_SECRET_PATH`; the runtime never reads, logs or exposes its contents. It lets the laptop prove itself to an iPad paired in an earlier session (device API).
- **Never two at once**: one register and one tunnel per runtime. Each child gets a pidfile `<dataRoot>/run/<kind>-<pid>.pid`. When the runtime is created, whatever the tunnel setting, it resolves every pidfile left by a crashed run:
  - The run folder is checked first: a real folder inside the data root (no link from the data root down, canonical path where it should be) and private like the data root. Otherwise no record in it is read, nothing is signalled, and the snapshot reports it.
  - A record that is not a private plain file is removed unread. macOS: a single-link regular file with no group or other permission bits. Windows: a single-link regular file whose access list (read for all records in one PowerShell call, before any record is read) allows only the current user, SYSTEM and Administrators, by the same SDDL rules as the data folder. If no access list can be read at all, no record is read, nothing is signalled, the records are kept and the snapshot reports it. A record naming any program other than this copy's bundled register or cloudflared is removed and nothing is signalled.
  - A process is signalled only if the system says it runs exactly this copy's bundled program (from `resourcesRoot`, never from the pidfile) and started when the pidfile says (within 5 seconds). macOS: the executable from `lsof` (the file the kernel maps as the program; `ps`'s command name follows argv[0], which any process can set) and the start time from `ps -o lstart=` in UTC. Windows: `Win32_Process.ExecutablePath` and `CreationDate`. This is checked again immediately before SIGTERM and again before SIGKILL, so a PID reused in the grace period is never hit.
  - A PID now used by another program is left alone and its record dropped. If identity cannot be proven, nothing is signalled, the record is kept and the snapshot and `shutdown()` report it. The Electron app must also take `app.requestSingleInstanceLock()`.
- **Restart**: the register restarts after a crash with backoff (0.5 s to 30 s, 7 tries, counter reset after a stable minute). cloudflared restarts the same way. A quick tunnel comes back with a new URL; the register is restarted on the same ports with the new origin and `participant-origin-changed` fires.
- **Stop**: SIGTERM, then SIGKILL after 3 seconds (Windows: immediate termination), sent through the child handle Node holds for a child this runtime spawned (its PID cannot be reused until Node has seen its exit).
- **A register that will not stop**: never two register processes on one register file. A register process stays recorded until its exit has been seen. If a stop fails (the process survives SIGKILL), the supervisor keeps the child and its pidfile and reports `failed` with reason `will-not-stop`; it starts nothing until that child has exited. The runtime keeps the lease (marked stuck) or the session's workshop recorded: every `startSession` and `openRegister` on that workshop, and every `openRegister` while a lease is stuck, tries the stop again and refuses in plain words until it succeeds or the process exits on its own. Another workshop's register can still be leased beside a stuck session register. The tunnel stops first, then the register, then the gateway. `endSession` and `shutdown` then confirm that the gateway, participant socket or port, and organiser port refuse connections.

## Workshops library on disk

```
<dataRoot>/workshops/<id>/workshop.json            service workshop file (server/workshop-config.ts)
<dataRoot>/workshops/<id>/library.json             created, archived, last attended count
<dataRoot>/workshops/<id>/roster-provenance.json   where the name list came from
<dataRoot>/workshops/<id>/service.json             loopback service config, rewritten each session
<dataRoot>/workshops/<id>/db/attendance.sqlite     the register
<dataRoot>/host-secret                             32 random bytes, the laptop's long-lived host secret
<dataRoot>/run/                                    pidfiles, empty cloudflared config, the register's participant socket (macOS)
                                                   (the Windows path keeps the register's key and certificate in memory only)
```

- **Links**: no symlink, junction or other reparse point anywhere from the data root down to a file AttendWell opens. Each component is checked with `lstat`, and its canonical path (`realpath`) must be the canonical data root plus the same relative path, before anything is read, opened or chmod-ed. The service repeats this for its database, `-wal` and `-shm` files at startup (`ATTENDANCE_DATA_ROOT`).
- **Permissions are never set by path.** New files (workshop files, pidfiles, the cloudflared config, the host secret) are created with `O_CREAT|O_EXCL|O_NOFOLLOW` and mode 0600, and 0600 is set on the open descriptor (`fchmod`); folders and the register are opened with `O_NOFOLLOW`, re-checked (containment, and the path still names the opened object) and then `fchmod`-ed (`server/private-path.ts`: `writeNewPrivateFile`, `chmodNoFollow`).
- **macOS**: folders 0700, files 0600, checked after writing; an existing register and its `-wal`/`-shm` files must already be 0600 (single-link plain files) before the service opens them.
- **Windows**: mode bits mean nothing there. The data root must sit in the user's AppData folder; its access list is read with Windows PowerShell through .NET (`GetAccessControl`, as SDDL: owner, group and access list; started without an inherited `PSModulePath`, so a PowerShell 7 parent cannot break it) and must allow only the current user, SYSTEM and Administrators. SDDL writes a few accounts as two-letter aliases, among them the built-in Administrator account (`LA`, RID 500); the probe asks Windows how it writes the current user's SID and counts that alias, and only that one, as the user. Each workshop folder gets its own protected list at creation (`icacls <dir> /inheritance:r /grant:r *<user SID>:(OI)(CI)F *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F`), and before a register is opened the workshop folder (must be protected), its `db` folder, the register and its `-wal`/`-shm` files are checked. DACL flags (`P`, `AI`, `AR`, `NO_ACCESS_CONTROL`) are parsed in any order; a null DACL or any syntax the parser does not recognise fails closed, as does an unreadable list. The service applies the same rules to its database folder and files (`server/private-path.ts`).
- Workshop ids are checked against `^[a-z0-9][a-z0-9-]{0,79}$` and must resolve inside the library; linked folders are not followed.
- Attended counts are read with Node's built-in SQLite (`node:sqlite`, Electron with Node 22.13 or later), opened read-only.

## Build resources

```sh
bun run build                 # web interface into dist/
bun run desktop:sidecar       # compiled service + dist/ for darwin-arm64, darwin-x64, windows-x64
bun run desktop:cloudflared   # pinned cloudflared, SHA-256 verified, for the same three platforms
bun run desktop:headless      # end-to-end check with a real quick tunnel (Node, no window, no prompt)
node desktop/scripts/run-headless.ts --tcp-tls   # the same, with the Windows participant path (TCP + pinned TLS)
```

Output (git-ignored):

```
desktop/resources/sidecar/<platform>/attendwell-service[.exe]
desktop/resources/sidecar/<platform>/dist/
desktop/resources/cloudflared/<platform>/cloudflared[.exe]
desktop/resources/cloudflared/LICENSE, about.json     for the About box
```

- **cloudflared** is pinned in `desktop/third-party/cloudflared.json`: version, licence (Apache-2.0), download URLs, the SHA-256 of each release file and of the binary inside it. To update it, change the version and all checksums together (the release notes list the binary checksums; GitHub lists the file digests). It is never downloaded at runtime.
- **Packaging** (for the Electron parcel): ship `sidecar/<platform>/` and `cloudflared/<platform>/` for the build's platform as `extraResources` under the same layout, and pass `process.resourcesPath` as `resourcesRoot`. On macOS both binaries are signed before the app (`scripts/sign-bundled-programs.cjs`, electron-builder `afterPack`), under the hardened runtime, each with only what it needs: the register program `build/entitlements.sidecar.plist` (`com.apple.security.cs.allow-jit` only: without it JavaScriptCore falls back to its interpreter; it needs none of the other entries in Bun's code-signing guide), cloudflared no entitlements. electron-builder's own pass skips them (`signIgnore`) and gives Electron's helpers `build/entitlements.mac.inherit.plist`.
