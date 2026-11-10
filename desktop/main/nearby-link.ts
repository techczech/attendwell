// The nearby link test (phase 1 of docs/plan-reliable-sync.md): starts the bundled attendwell-nearby helper (macOS, when the helper
// is in the app's resources), gives it the per-install key and a 500-name synthetic snapshot, acknowledges every check-in, and keeps
// the count, the connected iPad's name and the connection state in memory for the "Nearby link test…" sheet. A missing helper or a
// helper that stops never breaks the app: it is written to the diagnostic log and the app carries on (one restart after an
// unexpected exit). The key is made once per install in <userData>/nearby-key.json (0600); it goes to the helper over stdin, never
// on argv, and never into a log. Helper output goes to <userData>/nearby.log. Under ATTENDWELL_TEST=1 it stays off unless
// ATTENDWELL_NEARBY=1 asks for it.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NearbyView } from '../shared/ipc.ts';

export const NEARBY_WORKSHOP_ID = 'nearby-test';

export interface NearbyKey { key: string; workshopId: string }
/** The per-install key: read from <dir>/nearby-key.json, or made (32 random bytes, base64url) and written 0600 on first use. */
export function loadOrCreateKey(dir: string): NearbyKey {
  const file = join(dir, 'nearby-key.json');
  try {
    const o = JSON.parse(readFileSync(file, 'utf8')) as Partial<NearbyKey>;
    if (typeof o.key === 'string' && /^[A-Za-z0-9_-]{43}$/.test(o.key)) return { key: o.key, workshopId: NEARBY_WORKSHOP_ID };
  } catch { /* none yet, or unreadable: made below */ }
  const made: NearbyKey = { key: randomBytes(32).toString('base64url'), workshopId: NEARBY_WORKSHOP_ID };
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify({ v: 1, ...made }, null, 2) + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);
  return made;
}

export interface NearbyLink {
  view(): NearbyView;
  readonly logFile: string;
  stop(): void;
}

export interface NearbyOptions {
  env: NodeJS.ProcessEnv;
  userData: string;
  resourcesRoot: string;
  /** The app's diagnostic log (main/app-log.ts). */
  appLog: (line: string) => void;
  platform?: NodeJS.Platform;
  spawnFn?: (program: string, args: string[]) => ChildProcess;
  /** Delay before the one restart after an unexpected exit. */
  restartDelayMs?: number;
}

export function startNearbyLink(o: NearbyOptions): NearbyLink {
  const logFile = join(o.userData, 'nearby.log');
  const state = { available: false, connected: false, peerName: null as string | null, checkins: 0 };
  const seen = new Set<string>();
  let key: NearbyKey | null = null;
  let stopping = false;
  let restarts = 0;
  let child: ChildProcess | null = null;

  const link: NearbyLink = {
    logFile,
    view: () => ({
      available: state.available, state: state.connected ? 'connected' : 'waiting', peerName: state.peerName, checkins: state.checkins,
      payload: state.available && key ? JSON.stringify({ v: 1, workshopId: key.workshopId, key: key.key }) : null,
      key: state.available && key ? key.key : null,
    }),
    stop: () => { stopping = true; try { child?.stdin?.end(); } catch { /* already gone */ } },
  };

  const platform = o.platform ?? process.platform;
  if (platform !== 'darwin') return link;
  if (o.env.ATTENDWELL_TEST === '1' && o.env.ATTENDWELL_NEARBY !== '1') return link;
  const program = join(o.resourcesRoot, 'nearby', 'darwin-arm64', 'attendwell-nearby');
  if (!existsSync(program)) { o.appLog('Nearby link: the helper is not in this build; the link test is off.'); return link; }

  const log = (line: string): void => { try { appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 }); } catch { /* the link must never break the app */ } };
  try { key = loadOrCreateKey(o.userData); } catch (e) { o.appLog(`Nearby link: could not make the key: ${(e as Error).message}`); return link; }

  const launch = (): void => {
    let c: ChildProcess;
    try { c = (o.spawnFn ?? ((p, a) => spawn(p, a, { stdio: ['pipe', 'pipe', 'pipe'] })))(program, ['--role', 'mac']); } catch (e) {
      o.appLog(`Nearby link: could not start the helper: ${(e as Error).message}`); state.available = false; return;
    }
    child = c;
    state.available = true;
    log(`started helper pid ${c.pid}`);
    let ended = false;
    const gone = (why: string): void => {
      if (ended) return;
      ended = true;
      state.connected = false; state.peerName = null;
      if (child === c) child = null;
      log(`helper stopped: ${why}`);
      if (stopping) return;
      o.appLog(`Nearby link: the helper stopped unexpectedly (${why}).`);
      if (restarts < 1) { restarts += 1; setTimeout(() => { if (!stopping) launch(); }, o.restartDelayMs ?? 1000).unref?.(); }
      else { state.available = false; o.appLog('Nearby link: not restarted again; the link test is off until AttendWell restarts.'); }
    };
    c.on('error', (e) => gone(`error ${e.message}`));
    c.on('exit', (code, sig) => gone(`code=${code} signal=${sig}`));
    c.stderr?.on('data', (d: Buffer) => log(`stderr: ${d.toString().trimEnd()}`));
    let buffer = '';
    c.stdout?.on('data', (d: Buffer) => {
      buffer += d.toString();
      let i: number;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
        log(line);
        let e: { type?: string; state?: string; peer?: string; opId?: string };
        try { e = JSON.parse(line); } catch { continue; }
        if (e.type === 'peer') {
          if (e.state === 'connected') { state.connected = true; state.peerName = typeof e.peer === 'string' ? e.peer.slice(0, 80) : null; }
          else if (e.state === 'notConnected') { state.connected = false; }
        } else if (e.type === 'checkin' && typeof e.opId === 'string') {
          if (!seen.has(e.opId)) { seen.add(e.opId); state.checkins = seen.size; }
          c.stdin?.write(JSON.stringify({ type: 'ack', opIds: [e.opId] }) + '\n');
        }
      }
    });
    c.stdin?.on('error', () => undefined);
    try {
      // The key goes over stdin, never argv (visible in ps).
      c.stdin?.write(JSON.stringify({ type: 'key', key: key!.key, workshopId: key!.workshopId }) + '\n');
      const names = Array.from({ length: 500 }, (_, n) => ({ id: `n${n}`, displayName: `Synthetic Person ${n}`, hidden: false }));
      c.stdin?.write(JSON.stringify({ type: 'snapshot', version: 1, workshopId: key!.workshopId, title: 'Nearby link test', open: true, names }) + '\n');
    } catch (e) { log(`could not write to the helper: ${(e as Error).message}`); }
  };
  launch();
  return link;
}
