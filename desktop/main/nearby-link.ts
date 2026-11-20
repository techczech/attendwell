// Starts the bundled Multipeer helper and bridges its stdio to the register. The
// per-install key reaches the helper over stdin and is never logged.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deviceText, HIDDEN_NAME } from '../../server/device-text.ts';
import { isNearbyCheckIn, nearbyNameId, type NearbyCheckIn, type NearbyReceipt } from '../../server/nearby-protocol.ts';
import { isEligible } from '../../server/eligibility-attendance.ts';
import type { Roster } from '../shared/register-model.ts';
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

export interface NearbyWorkshop {
  id: string;
  title: string;
  roster: Roster | null;
  open: boolean;
}

export interface NearbyLink {
  view(): NearbyView;
  extendPairingQR(payload: string): string;
  updateWorkshop(workshop: NearbyWorkshop | null): void;
  readonly logFile: string;
  stop(): void;
}

export interface NearbyOptions {
  env: NodeJS.ProcessEnv;
  userData: string;
  resourcesRoot: string;
  /** The app's diagnostic log (main/app-log.ts). */
  appLog: (line: string) => void;
  recordCheckIn(workshopId: string, checkIn: NearbyCheckIn): Promise<NearbyReceipt>;
  platform?: NodeJS.Platform;
  spawnFn?: (program: string, args: string[]) => ChildProcess;
  /** Delay before the one restart after an unexpected exit. */
  restartDelayMs?: number;
}

export function startNearbyLink(o: NearbyOptions): NearbyLink {
  const logFile = join(o.userData, 'nearby.log');
  const state = { available: false, connected: false, peerName: null as string | null, checkins: 0 };
  const inFlight = new Map<string, Promise<NearbyReceipt>>();
  let writes: Promise<unknown> = Promise.resolve();
  const peers = new Map<string, string>();
  const emptyTitle = 'No workshop open on the Mac';
  let workshop: NearbyWorkshop | null = null;
  let snapshot = { workshopId: '', title: emptyTitle, open: false, names: [] as Array<{ id: string; displayName: string; hidden: boolean; checkedIn: boolean }> };
  let version = 1;
  let key: NearbyKey | null = null;
  let stopping = false;
  let restarts = 0;
  let child: ChildProcess | null = null;
  let pairingCode: string | null = null;

  const link: NearbyLink = {
    logFile,
    view: () => {
      if (child && !stopping) send(child, { type: 'pairing-sheet' });
      return {
        available: state.available, state: state.connected ? 'connected' : 'waiting', peerName: state.peerName, checkins: state.checkins,
        workshopTitle: workshop?.title ?? emptyTitle,
        payload: state.available && key ? JSON.stringify({ v: 1, workshopId: key.workshopId, key: key.key }) : null,
        pairingCode,
      };
    },
    // Build 2 reads the fragment as query items. An escaped inner fragment
    // carries the key while leaving the two legacy items intact.
    extendPairingQR: (payload) => state.available && key ? `${payload}%23nearby=${key.key}` : payload,
    updateWorkshop: (w) => {
      workshop = w;
      if (!state.available) return;
      const next = {
        workshopId: w?.id ?? '',
        title: w ? deviceText(w.title, 'Workshop') : emptyTitle,
        open: w?.open ?? false,
        names: (w?.roster?.participants ?? []).map((p) => ({
          id: nearbyNameId(p.id), displayName: deviceText(p.name, HIDDEN_NAME), hidden: !isEligible(p), checkedIn: p.present,
        })),
      };
      if (JSON.stringify(next) === JSON.stringify(snapshot)) return;
      snapshot = next;
      version += 1;
      if (child) sendSnapshot(child);
    },
    stop: () => { stopping = true; try { child?.stdin?.end(); } catch { /* already gone */ } },
  };

  const platform = o.platform ?? process.platform;
  if (platform !== 'darwin') return link;
  if (o.env.ATTENDWELL_TEST === '1' && o.env.ATTENDWELL_NEARBY !== '1') return link;
  const program = join(o.resourcesRoot, 'nearby', 'darwin-arm64', 'attendwell-nearby');
  if (!existsSync(program)) { o.appLog('Nearby link: the helper is not in this build; the nearby link is off.'); return link; }

  const log = (line: string): void => { try { appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 }); } catch { /* the link must never break the app */ } };
  try { key = loadOrCreateKey(o.userData); } catch (e) { o.appLog(`Nearby link: could not make the key: ${(e as Error).message}`); return link; }

  const send = (c: ChildProcess, message: unknown): void => {
    try { c.stdin?.write(JSON.stringify(message) + '\n'); }
    catch (e) { log(`could not write to the helper: ${(e as Error).message}`); }
  };
  const sendSnapshot = (c: ChildProcess): void => send(c, { type: 'snapshot', version, acceptsWorkshopCheckIns: true, ...snapshot });
  const accept = (c: ChildProcess, op: NearbyCheckIn & { workshopId?: unknown }): void => {
    // New iPads include the workshop they saw, so a replay cannot follow the
    // organiser to a different register. Old spike operations have no scope.
    const id = typeof op.workshopId === 'string' ? op.workshopId : workshop?.id;
    if (!id || id === NEARBY_WORKSHOP_ID || stopping) return;
    const opKey = JSON.stringify([id, op.opId, op.nameId]);
    let receipt = inFlight.get(opKey);
    if (!receipt) {
      const checkIn = { opId: op.opId, nameId: op.nameId, at: op.at };
      const write = writes.then(() => o.recordCheckIn(id, checkIn));
      receipt = write.then((result) => {
        if (result.recorded) state.checkins += 1;
        return result;
      }).finally(() => { inFlight.delete(opKey); });
      inFlight.set(opKey, receipt);
      writes = receipt.catch(() => { log('Check-in not acknowledged: the register did not record it.'); });
    }
    void receipt.then(() => {
      if (child === c && !stopping) send(c, { type: 'ack', opIds: [op.opId] });
    }, () => { /* A replay will try the write again. */ });
  };

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
      pairingCode = null;
      peers.clear();
      state.connected = false; state.peerName = null;
      if (child === c) child = null;
      log(`helper stopped: ${why}`);
      if (stopping) return;
      o.appLog(`Nearby link: the helper stopped unexpectedly (${why}).`);
      if (restarts < 1) { restarts += 1; setTimeout(() => { if (!stopping) launch(); }, o.restartDelayMs ?? 1000).unref?.(); }
      else { state.available = false; o.appLog('Nearby link: not restarted again; the nearby link is off until AttendWell restarts.'); }
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
        let e: { type?: string; state?: string; peer?: string; workshopId?: unknown; code?: unknown };
        try { e = JSON.parse(line); } catch { continue; }
        if (!e || typeof e !== 'object') continue;
        if (e.type === 'pairing-code') {
          if (child === c) pairingCode = typeof e.code === 'string' && /^[2-9A-HJ-NP-Z]{8}$/.test(e.code) ? e.code : null;
          continue;
        }
        if (e.type !== 'checkin') log(line);
        if (e.type === 'peer' && typeof e.peer === 'string') {
          if (e.state === 'connected') peers.set(e.peer, e.peer.slice(0, 80));
          else if (e.state === 'notConnected') peers.delete(e.peer);
          state.connected = peers.size > 0;
          state.peerName = [...peers.values()].at(-1) ?? null;
        } else if (e.type === 'checkin' && isNearbyCheckIn(e)) {
          accept(c, e);
        }
      }
    });
    c.stdin?.on('error', () => undefined);
    send(c, { type: 'key', ...key });
    sendSnapshot(c);
  };
  launch();
  return link;
}
