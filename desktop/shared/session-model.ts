// The session screen's states and wording: which phase check-in is in, what the Connection panel says, whether Pair an iPad is
// available, and what the toolbar offers. Pure. The phases are the status bar's: connecting, online, trouble, ended (closed or past),
// plus "ready" (chosen but not started) and "ending" (the address is closing).
import type { RuntimeSnapshot, TunnelFailureReason, WorkshopSummary } from './runtime-types.ts';
import { clockOf, type Roster } from './register-model.ts';
import { repairTargets, type DeviceList } from './devices-model.ts';
import type { SessionCtx } from './commands.ts';
import type { PairingState } from './pairing-model.ts';
import { longDate } from './workshops.ts';

export type SessionPhase = 'ready' | 'connecting' | 'online' | 'trouble' | 'ending' | 'closed' | 'past';

export const isLive = (p: SessionPhase): boolean => p === 'connecting' || p === 'online' || p === 'trouble' || p === 'ending';
export const isReadOnly = (p: SessionPhase): boolean => p === 'closed' || p === 'past' || p === 'ready';

export interface PhaseInput {
  runtime: RuntimeSnapshot;
  workshop: Pick<WorkshopSummary, 'id' | 'when' | 'attended'>;
  /** This workshop's check-in was ended during this run of the app. */
  endedThisRun: boolean;
}

export function phaseOf(i: PhaseInput): SessionPhase {
  const { runtime: r, workshop: w } = i;
  if (r.workshopId === w.id && r.session !== 'idle') {
    if (r.session === 'ending') return 'ending';
    if (r.session === 'starting') return 'connecting';
    if (r.service.state === 'failed' || r.service.state === 'restarting') return 'trouble';
    if (r.service.state !== 'running') return 'connecting';
    if (r.tunnel.state === 'online') return 'online';
    if (r.tunnel.state === 'starting') return 'connecting';
    return 'trouble';
  }
  if (w.when === 'past') return 'past';
  // A saved count of arrivals means check-in ran and was ended; a register that has names but nobody here has not started.
  return i.endedThisRun || (w.attended ?? 0) > 0 ? 'closed' : 'ready';
}

// ---- Connection panel -------------------------------------------------------------------------------------------------------

export type ConnectionTone = 'good' | 'warn' | 'bad' | 'off';

export interface ConnectionModel {
  tone: ConnectionTone;
  chip: string;
  headline: string;
  detail: string;
  /** The check-in address, shown when there is one (struck through once closed). */
  address: string | null;
  addressClosed: boolean;
  copy: boolean;
  retry: boolean;
  advice: string | null;
  /** The pair button's footnote under the button when pairing is not available. */
  chooseFolder: boolean;
}

const FAILURES: Record<TunnelFailureReason, { headline: string; advice: string }> = {
  'blocked-by-network': { headline: "Can't reach Cloudflare from this network", advice: 'Venue networks sometimes block this. Join a phone hotspot on this laptop, then try again. Check-ins wait on the iPad until then.' },
  'tunnel-refused': { headline: "Can't reach Cloudflare from this network", advice: 'Venue networks sometimes block this. Join a phone hotspot on this laptop, then try again. Check-ins wait on the iPad until then.' },
  'no-internet': { headline: 'This laptop is not connected to the internet.', advice: 'Join a network, then try again. Check-ins wait on the iPad until then.' },
  'cloudflared-missing': { headline: 'AttendWell could not start its connection helper.', advice: 'Reinstall AttendWell, then try again.' },
  'port-in-use': { headline: 'Another program is using the port AttendWell needs.', advice: 'Quit it, then try again.' },
  'stopped-unexpectedly': { headline: 'The connection stopped.', advice: 'Try again. Check-ins wait on the iPad until then.' },
};

export interface ConnectionInput {
  phase: SessionPhase;
  runtime: RuntimeSnapshot;
  /** ISO times the app noted: when the address last went online, when it closed, when it failed. */
  lastOnlineAt: string | null;
  closedAt: string | null;
  failedAt: string | null;
  lastAddress: string | null;
  /** ISO time the address changed after a restart, shown on the Online line. */
  addressChangedAt: string | null;
}

const bare = (url: string): string => url;

export function connectionModel(i: ConnectionInput): ConnectionModel {
  const base: ConnectionModel = { tone: 'off', chip: 'Off', headline: '', detail: '', address: null, addressClosed: false, copy: false, retry: false, advice: null, chooseFolder: false };
  const { runtime: r } = i;
  switch (i.phase) {
    case 'ready': return { ...base, headline: 'Not started', detail: 'Start check-in to open the check-in address.' };
    case 'closed': case 'past': {
      const at = clockOf(i.closedAt);
      return { ...base, headline: 'Off · check-in address closed', detail: at ? `Closed at ${at}` : 'Closed', address: i.lastAddress ? bare(i.lastAddress) : null, addressClosed: true };
    }
    case 'ending': return { ...base, tone: 'warn', chip: 'Closing', headline: 'Closing the check-in address…', detail: 'The register stays on this laptop.' };
    case 'connecting': return { ...base, tone: 'warn', chip: 'Connecting', headline: 'Connecting…', detail: 'Opening the check-in address. This can take up to a minute.' };
    case 'online': {
      const url = r.tunnel.state === 'online' ? r.tunnel.url : null;
      const since = clockOf(i.addressChangedAt);
      return { ...base, tone: 'good', chip: 'Online', headline: 'Online', detail: `Check-in address ready${since ? ` · new since ${since}` : ''}`, address: url ? bare(url) : null, copy: url !== null };
    }
    case 'trouble': {
      if (r.service.state === 'failed') return { ...base, tone: 'bad', chip: "Can't connect", headline: 'The register could not start', detail: r.service.message, advice: 'Try again. If it keeps happening, quit and open AttendWell again.', retry: true, chooseFolder: /folder/i.test(r.service.message) };
      if (r.service.state === 'restarting') return { ...base, tone: 'warn', chip: 'Restarting', headline: 'Restarting the register…', detail: `Attempt ${r.service.attempt}`, advice: 'The iPad keeps saving check-ins while this happens.' };
      if (r.tunnel.state === 'reconnecting') {
        const last = clockOf(i.lastOnlineAt);
        return { ...base, tone: 'warn', chip: 'Reconnecting', headline: `Reconnecting… attempt ${r.tunnel.attempt}`, detail: last ? `Last online at ${last}` : 'Not online yet', advice: 'The iPad keeps saving check-ins while the address is down.', retry: true, address: r.tunnel.url ? bare(r.tunnel.url) : i.lastAddress ? bare(i.lastAddress) : null, addressClosed: true };
      }
      if (r.tunnel.state === 'failed') {
        const f = FAILURES[r.tunnel.reason];
        const at = clockOf(i.failedAt);
        return { ...base, tone: 'bad', chip: "Can't connect", headline: f.headline, detail: at ? `Failed at ${at}` : r.tunnel.message, advice: f.advice, retry: true, address: i.lastAddress ? bare(i.lastAddress) : null, addressClosed: true };
      }
      return { ...base, tone: 'warn', chip: 'Off', headline: 'The check-in address is off', detail: 'Try again to open it.', retry: true };
    }
  }
}

export interface Availability { ok: boolean; reason: string | null }

export const OTHER_LIVE_PAIR = 'Check-in is open for another workshop. Open that workshop to pair an iPad.';

/**
 * Whether Pair an iPad works now, and if not, why, in the lock notes' wording. `otherLive`: another workshop's check-in is open, so
 * this one cannot start; the reason then says where pairing works instead of asking for a start that would be refused.
 */
export function pairAvailability(phase: SessionPhase, runtime: RuntimeSnapshot, otherLive = false): Availability {
  if (phase === 'online') return { ok: true, reason: null };
  if (otherLive && (phase === 'ready' || phase === 'closed' || phase === 'past')) return { ok: false, reason: OTHER_LIVE_PAIR };
  if (phase === 'connecting') return { ok: false, reason: 'Pair an iPad works once the connection is online.' };
  if (phase === 'trouble') return { ok: false, reason: runtime.tunnel.state === 'reconnecting' ? 'Pairing waits until the connection is back.' : 'Pairing needs the connection.' };
  if (phase === 'ending') return { ok: false, reason: 'Check-in is closing.' };
  return { ok: false, reason: phase === 'ready' ? 'Start check-in to pair an iPad.' : 'Reopen check-in to pair an iPad.' };
}

// ---- Toolbar and banners ----------------------------------------------------------------------------------------------------

export interface ToolbarModel {
  /** The right-hand buttons, in order. */
  addPerson: 'enabled' | 'disabled';
  end: boolean;
  closedMarker: boolean;
  readOnlyMarker: boolean;
  start: boolean;
  reopen: boolean;
}

export function toolbarModel(phase: SessionPhase): ToolbarModel {
  return {
    addPerson: phase === 'online' || phase === 'trouble' || phase === 'connecting' ? 'enabled' : 'disabled',
    end: phase === 'online' || phase === 'trouble' || phase === 'connecting',
    closedMarker: phase === 'closed',
    readOnlyMarker: phase === 'past',
    start: phase === 'ready',
    reopen: phase === 'closed' || phase === 'past',
  };
}

/** "This session finished on Tue 21 Oct at 10:30. The register is shown as it was saved. Reopen check-in to accept late arrivals." */
export function pastBanner(w: Pick<WorkshopSummary, 'date' | 'endTime' | 'startTime'>): string {
  const when = longDate(w.date);
  const at = w.endTime || w.startTime;
  return `This session finished on ${when}${at ? ` at ${at}` : ''}. The register is shown as it was saved. Reopen check-in to accept late arrivals.`;
}

export interface SummaryModel { closedAt: string | null; arrived: number; total: number; walkIns: number; held: number }

// ---- What the main process sends the window ---------------------------------------------------------------------------------

export interface SessionView {
  workshopId: string | null;
  phase: SessionPhase;
  runtime: RuntimeSnapshot;
  hostName: string;
  roster: Roster | null;
  /** A plain sentence when the register could not be read. */
  rosterError: string | null;
  devices: DeviceList | null;
  pairing: PairingState;
  /** The name typed on the pairing sheet (applied when the iPad pairs); null before anything is typed. */
  pairLabel: string | null;
  /** The address began (or changed) at this ISO time; devices not heard from since need pairing again. */
  addressSince: string | null;
  addressChangedAt: string | null;
  lastOnlineAt: string | null;
  failedAt: string | null;
  closedAt: string | null;
  lastAddress: string | null;
  canUndo: boolean;
  /** The register is answering: people can be marked and added, iPads managed. */
  registerOpen: boolean;
  /** A change is being made (disables the buttons). */
  busy: boolean;
  /** Other workshop's check-in is open: this one cannot be started. */
  otherLive: boolean;
}

export interface SessionSelection {
  person: { held: boolean; present: boolean; canCheckIn: boolean } | null;
  device: { revoked: boolean } | null;
}
export const NO_SELECTION: SessionSelection = { person: null, device: null };

/** The iPads that need pairing again in this view (empty unless check-in is open). */
export function repairsIn(v: SessionView): ReturnType<typeof repairTargets> {
  return isLive(v.phase) ? repairTargets(v.devices?.devices ?? [], v.addressSince) : [];
}

/** What the command registry needs to know about the session screen. */
export function sessionCtxOf(v: SessionView, sel: SessionSelection): SessionCtx {
  const conn = connectionModel({ phase: v.phase, runtime: v.runtime, lastOnlineAt: v.lastOnlineAt, closedAt: v.closedAt, failedAt: v.failedAt, lastAddress: v.lastAddress, addressChangedAt: v.addressChangedAt });
  const people = v.roster?.participants ?? [];
  const repairs = repairsIn(v);
  return {
    phase: v.phase, registerOpen: v.registerOpen, pair: pairAvailability(v.phase, v.runtime, v.otherLive), canUndo: v.canUndo, hasAddress: conn.copy, canRetry: conn.retry,
    hasPeople: people.length > 0, hasPresent: people.some((p) => p.present), otherLive: v.otherLive, person: sel.person, device: sel.device,
    repairName: repairs.length === 1 ? repairs[0]!.label : null,
  };
}

/** The status bar's session state: connecting, online, trouble, or ended. */
export function statusChip(phase: SessionPhase): { tone: 'good' | 'warn' | 'bad' | 'off'; text: string } {
  switch (phase) {
    case 'connecting': return { tone: 'warn', text: 'Connecting…' };
    case 'online': return { tone: 'good', text: 'Online' };
    case 'trouble': return { tone: 'bad', text: 'Connection trouble' };
    case 'ending': return { tone: 'warn', text: 'Closing…' };
    case 'closed': return { tone: 'off', text: 'Check-in closed' };
    case 'past': return { tone: 'off', text: 'Read only' };
    case 'ready': return { tone: 'off', text: 'Check-in not started' };
  }
}
