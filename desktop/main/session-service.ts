// The live session, apart from Electron: which workshop's register is on screen, what it says, and what the organiser's actions do.
// It owns the connection to the register (the organiser client), keeps the roster and the device list fresh, runs the pairing sheet's
// state machine, and follows the runtime's states. The window renders `view()`; every action is a method that returns a Result.
import { reduce, IDLE, type PairingState } from '../shared/pairing-model.ts';
import type { DeviceList } from '../shared/devices-model.ts';
import type { Roster } from '../shared/register-model.ts';
import type { Result } from '../shared/ipc.ts';
import type { RuntimeSnapshot, WorkshopSummary } from '../shared/runtime-types.ts';
import { phaseOf, type SessionPhase, type SessionView } from '../shared/session-model.ts';
import { OrganiserError, type OrganiserClient, type OrganiserFactory } from './organiser-client.ts';
import type { RuntimePort } from './runtime-port.ts';

export interface SessionServiceDeps {
  port: RuntimePort;
  organiser: OrganiserFactory;
  hostName: string;
  /** Tells the window that the view changed. */
  changed(): void;
  now?: () => number;
  /** Milliseconds between register refreshes while check-in is open (default 3000; 0 = never, for tests that call `refresh()`). */
  pollMs?: number;
  /** While the pairing sheet is open (default 1500). */
  pairPollMs?: number;
  /** The app's diagnostic log (main/app-log.ts): failed actions and pairing steps in plain words. Never given a code or a key. */
  log?: (line: string) => void;
}

const EMPTY: Roster = { participants: [], conflicts: [] };
const say = (e: unknown, fallback: string): string => (e instanceof OrganiserError || e instanceof Error ? e.message : fallback);
const fail = (e: unknown, fallback = 'That did not work. Try again.'): { ok: false; error: string } => ({ ok: false, error: say(e, fallback) });
const OK = { ok: true } as const;

interface Undo { id: string; wasPresent: boolean }

export class SessionService {
  private viewing: string | null = null;
  private workshop: WorkshopSummary | null = null;
  private roster: Roster | null = null;
  private rosterError: string | null = null;
  private devices: DeviceList | null = null;
  private pairing: PairingState = IDLE;
  /** Moves on every pairing request and every close: an answer or a poll that belongs to an earlier one is not applied. */
  private pairGen = 0;
  private pairLabel: string | null = null;
  private client: OrganiserClient | null = null;
  private clientUrl: string | null = null;
  private readonly ended = new Set<string>();
  private addressSince: string | null = null;
  private addressChangedAt: string | null = null;
  private lastOnlineAt: string | null = null;
  private failedAt: string | null = null;
  private closedAt: string | null = null;
  private lastAddress: string | null = null;
  private undo: Undo[] = [];
  private busy = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private lastSession: RuntimeSnapshot['session'] = 'idle';
  private readonly unsubs: Array<() => void> = [];
  private readonly now: () => number;

  private readonly log: (line: string) => void;

  constructor(private readonly d: SessionServiceDeps) {
    this.now = d.now ?? (() => Date.now());
    this.log = d.log ?? (() => {});
    this.unsubs.push(d.port.status.onChange((s) => { void this.onRuntime(s); }));
    this.unsubs.push(d.port.status.onOriginChanged((c) => {
      if (c.workshopId !== this.viewing) return;
      this.addressChangedAt = this.iso(); this.addressSince = this.addressChangedAt; this.lastAddress = c.current;
      this.d.changed();
      void this.refresh();
    }));
  }

  private iso(): string { return new Date(this.now()).toISOString(); }

  // ---- what the window renders ------------------------------------------------------------------------------------------------

  view(): SessionView {
    const runtime = this.d.port.status.get();
    const w = this.workshop;
    const phase: SessionPhase = w ? phaseOf({ runtime, workshop: w, endedThisRun: this.ended.has(w.id) }) : 'ready';
    return {
      workshopId: this.viewing, phase, runtime, hostName: this.d.hostName, roster: this.roster, rosterError: this.rosterError, devices: this.devices, pairing: this.pairing,
      addressSince: this.addressSince, addressChangedAt: this.addressChangedAt, lastOnlineAt: this.lastOnlineAt, failedAt: this.failedAt, closedAt: this.closedAt,
      lastAddress: this.lastAddress, canUndo: this.undo.length > 0 && this.client !== null, registerOpen: this.client !== null && this.rosterError === null, busy: this.busy,
      otherLive: runtime.session !== 'idle' && runtime.workshopId !== this.viewing,
      pairLabel: this.pairLabel,
    };
  }

  /** The label typed on the pairing sheet (applied when the iPad pairs). */
  pendingLabel(): string | null { return this.pairLabel; }

  private async loadWorkshop(id: string): Promise<void> {
    const all = await this.d.port.workshops.list({ includeArchived: true });
    this.workshop = [...all.today, ...all.upcoming, ...all.past, ...all.archived].find((x) => x.id === id) ?? null;
  }

  /** The workshop whose register the window shows. Read-only until its check-in is open. */
  async show(id: string): Promise<Result> {
    try {
      if (this.viewing !== id) {
        await this.closePairing();
        this.viewing = id; this.roster = null; this.rosterError = null; this.devices = null; this.undo = [];
        this.addressSince = null; this.addressChangedAt = null; this.lastOnlineAt = null; this.failedAt = null; this.closedAt = null; this.lastAddress = null;
        this.client = null; this.clientUrl = null;
      }
      await this.loadWorkshop(id);
      await this.adopt(this.d.port.status.get());
      if (!this.client) this.roster = (await this.d.port.readRegister(id)) ?? EMPTY;
      this.d.changed();
      return OK;
    } catch (e) { return fail(e, 'That workshop could not be opened.'); }
  }

  /** Leaves the register view (back to the library): check-in, if open, keeps running. */
  async leave(): Promise<void> {
    await this.closePairing();
    this.viewing = null; this.roster = null; this.devices = null; this.client = null; this.clientUrl = null; this.undo = [];
    this.stopTimer();
    this.d.changed();
  }

  // ---- following the runtime --------------------------------------------------------------------------------------------------

  private async onRuntime(s: RuntimeSnapshot): Promise<void> {
    if (this.disposed) return;
    try { await this.adopt(s); } catch { /* the next refresh reports it */ }
    this.d.changed();
  }

  private async adopt(s: RuntimeSnapshot): Promise<void> {
    const mine = this.viewing !== null && s.workshopId === this.viewing;
    const was = this.lastSession;
    this.lastSession = mine ? s.session : 'idle';
    if (mine && was === 'idle' && s.session !== 'idle') {
      // A new check-in: its address is new, so any iPad paired before has to be paired again.
      this.addressSince = null; this.addressChangedAt = null; this.failedAt = null; this.closedAt = null; this.undo = [];
    }
    if (mine && s.session !== 'idle') {
      if (s.tunnel.state === 'online') {
        if (this.lastAddress !== null && this.lastAddress !== s.tunnel.url && this.addressSince !== null) this.addressChangedAt = this.iso();
        if (this.lastAddress !== s.tunnel.url || this.addressSince === null) this.addressSince = this.iso();
        this.lastAddress = s.tunnel.url; this.lastOnlineAt = this.iso(); this.failedAt = null;
      } else if (s.tunnel.state === 'failed') this.failedAt ??= this.iso();
      if (s.service.state === 'running' && s.session === 'running') {
        if (this.clientUrl !== s.service.organiserUrl) { this.client = this.d.organiser(s.service.organiserUrl); this.clientUrl = s.service.organiserUrl; void this.refresh(); }
        this.startTimer();
      }
    }
    if (mine && was !== 'idle' && s.session === 'idle') await this.afterClose();
    if (this.viewing !== null && s.workshopId === this.viewing && this.workshop === null) await this.loadWorkshop(this.viewing);
  }

  /** The register stopped (ended here, or by the runtime): read it from disk and keep the last device list. */
  private async afterClose(): Promise<void> {
    this.stopTimer();
    this.client = null; this.clientUrl = null;
    if (this.viewing === null) return;
    this.closedAt ??= this.iso();
    this.ended.add(this.viewing);
    this.pairing = IDLE; this.pairLabel = null; this.pairGen += 1;
    this.roster = (await this.d.port.readRegister(this.viewing)) ?? this.roster ?? EMPTY;
    await this.loadWorkshop(this.viewing);
  }

  // ---- polling ----------------------------------------------------------------------------------------------------------------

  private startTimer(): void {
    if (this.timer !== null || this.disposed || !(this.d.pollMs ?? 3000)) return;
    this.schedule();
  }
  private schedule(): void {
    const delay = this.pairing.phase === 'open' ? this.d.pairPollMs ?? 1500 : this.d.pollMs ?? 3000;
    if (!delay) return;
    this.timer = setTimeout(() => { this.timer = null; void this.refresh().finally(() => { if (this.client && !this.disposed) this.schedule(); }); }, delay);
  }
  private stopTimer(): void { if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; } }

  /** Reads the roster and the device list from the register now, and moves the pairing sheet on. */
  async refresh(): Promise<void> {
    const c = this.client;
    if (!c) return;
    const gen = this.pairGen;
    try {
      const [roster, devices] = await Promise.all([c.roster(), c.devices()]);
      if (c !== this.client) return;
      this.roster = roster; this.devices = devices; this.rosterError = null;
      // A list read before the code on the sheet was issued does not have it yet: it must not mark that code as gone.
      if (gen === this.pairGen) await this.afterPoll(devices);
    } catch (e) {
      if (c === this.client) this.rosterError = say(e, 'The register did not answer.');
    }
    this.d.changed();
  }

  private async afterPoll(list: DeviceList): Promise<void> {
    if (this.pairing.phase !== 'open') return;
    this.pairing = reduce(this.pairing, { type: 'poll', list, now: this.now() });
    if (this.pairing.phase === 'paired') { this.log(`Pair an iPad: ${this.pairing.device.label} paired.`); await this.applyPendingLabel(this.pairing.device); }
  }

  private async applyPendingLabel(device: { id: string; label: string }): Promise<void> {
    const want = this.pairLabel?.trim();
    this.pairLabel = null;
    if (!want || want === device.label || !this.client) return;
    try {
      const list = await this.client.renameDevice(device.id, want);
      this.devices = list;
      if (this.pairing.phase === 'paired') this.pairing = { ...this.pairing, device: { id: device.id, label: want } };
    } catch { /* the iPad stays paired under its default name; Rename is on its row */ }
  }

  // ---- lifecycle --------------------------------------------------------------------------------------------------------------

  private async guarded<T>(fn: () => Promise<T>): Promise<T> {
    this.busy = true; this.d.changed();
    try { return await fn(); } finally { this.busy = false; this.d.changed(); }
  }

  /** Start check-in (and Reopen check-in): gateway, tunnel and register for this workshop. */
  async start(): Promise<Result> {
    const id = this.viewing;
    if (!id) return { ok: false, error: 'Open a workshop first.' };
    const r = this.d.port.status.get();
    if (r.session !== 'idle') return { ok: false, error: r.workshopId === id ? 'Check-in is already open.' : "Another workshop's check-in is open. End it first." };
    return this.guarded(async () => {
      try {
        await this.d.port.openWorkshop(id);
        await this.d.port.startSession();
        await this.loadWorkshop(id);
        return OK;
      } catch (e) { return this.failed('Start check-in', e, 'Check-in could not start.'); }
    });
  }

  async retry(): Promise<Result> {
    return this.guarded(async () => {
      try { await this.d.port.retryTunnel(); await this.refresh(); return OK; } catch (e) { return this.failed('Retry connection', e, 'The connection could not be retried.'); }
    });
  }

  /** End check-in: the address closes, the register stays on this laptop. */
  async end(): Promise<Result<{ leftovers: string[] }>> {
    if (this.d.port.status.get().session === 'idle') return { ok: false, error: 'Check-in is not open.' };
    return this.guarded(async () => {
      try {
        await this.closePairing();
        this.closedAt = this.iso();
        const r = await this.d.port.endSession();
        await this.afterCloseIfNeeded();
        if (r.leftovers.length) this.log(`End check-in left something running: ${r.leftovers.join(' ')}`);
        return { ok: true as const, value: { leftovers: r.leftovers } };
      } catch (e) { return this.failed('End check-in', e, 'Check-in could not be ended.'); }
    });
  }
  private async afterCloseIfNeeded(): Promise<void> {
    // The runtime's idle snapshot normally arrives first; this covers an adapter that resolves endSession before it publishes.
    if (this.client !== null || (this.viewing !== null && !this.ended.has(this.viewing))) await this.afterClose();
  }

  // ---- the register -----------------------------------------------------------------------------------------------------------

  private need(): OrganiserClient | null { return this.client; }
  private static readonly OFFLINE = 'Check-in is not open. Reopen check-in to change the register.';

  private async change(fn: (c: OrganiserClient) => Promise<Roster>): Promise<Result> {
    const c = this.need();
    if (!c) return { ok: false, error: SessionService.OFFLINE };
    return this.guarded(async () => {
      try { this.roster = await fn(c); this.rosterError = null; return OK; } catch (e) {
        // A stale version or a vanished record: show what the register says now, then the plain reason.
        try { this.roster = await c.roster(); } catch { /* keep what is shown */ }
        return fail(e);
      }
    });
  }

  private person(id: string): { version: number; present: boolean } | null {
    const p = this.roster?.participants.find((x) => x.id === id);
    return p ? { version: p.version, present: p.present } : null;
  }

  /** Mark present, or undo (present = false), through the register. */
  async mark(id: string, present: boolean): Promise<Result> {
    const p = this.person(id);
    if (!p) return { ok: false, error: 'That person is not in the register.' };
    const r = await this.change((c) => c.setAttendance(id, present, p.version));
    if (r.ok) this.undo.push({ id, wasPresent: p.present });
    return r;
  }

  /** Undo the last attendance change made on this laptop. */
  async undoLast(): Promise<Result> {
    const u = this.undo.pop();
    if (!u) return { ok: false, error: 'There is nothing to undo.' };
    const p = this.person(u.id);
    if (!p) return { ok: false, error: 'That person is not in the register.' };
    return this.change((c) => c.setAttendance(u.id, u.wasPresent, p.version));
  }

  async resolve(id: string, action: 'check-in' | 'dismiss'): Promise<Result> {
    return this.change((c) => c.resolveConflict(id, action));
  }

  /** Add person (walk-in): only ever on the laptop. With markHere the person is checked in at once. */
  async addPerson(input: { name: string; email: string; markHere: boolean }): Promise<Result> {
    const c = this.need();
    if (!c) return { ok: false, error: SessionService.OFFLINE };
    return this.guarded(async () => {
      try {
        const known = new Set(this.roster?.participants.map((p) => p.id));
        let roster = await c.addParticipant(input.name, input.email.trim());
        if (input.markHere) {
          const added = roster.participants.find((p) => !known.has(p.id));
          if (added) { roster = await c.setAttendance(added.id, true, added.version); this.undo.push({ id: added.id, wasPresent: false }); }
        }
        this.roster = roster; this.rosterError = null;
        return OK;
      } catch (e) { return fail(e); }
    });
  }

  /** Names were added or an iPad's recovery file imported (main/names-service.ts): read the register again, live or from disk. */
  async reloadRegister(id: string): Promise<void> {
    if (this.viewing !== id) return;
    if (this.client) { await this.refresh(); return; }
    try { this.roster = (await this.d.port.readRegister(id)) ?? this.roster; await this.loadWorkshop(id); } catch { /* the next open reads it */ }
    this.d.changed();
  }

  // ---- devices and pairing ----------------------------------------------------------------------------------------------------

  private async deviceChange(fn: (c: OrganiserClient) => Promise<DeviceList>): Promise<Result> {
    const c = this.need();
    if (!c) return { ok: false, error: SessionService.OFFLINE };
    return this.guarded(async () => { try { this.devices = await fn(c); return OK; } catch (e) { return fail(e); } });
  }
  rename(id: string, label: string): Promise<Result> { return this.deviceChange((c) => c.renameDevice(id, label)); }
  revoke(id: string): Promise<Result> { return this.deviceChange((c) => c.revokeDevice(id)); }
  dismissHold(id: number): Promise<Result> { return this.deviceChange((c) => c.dismissHold(id)); }

  /** Show a code: a new iPad (named `label`, or "iPad N"), or Pair again for one row (`targetDeviceId`). */
  async pairOpen(input: { label?: string; targetDeviceId?: string } = {}): Promise<Result> {
    const c = this.need();
    if (!c || this.view().phase !== 'online') {
      const why = this.view().phase === 'online' ? 'The register is not answering yet. Try again in a moment.' : 'Pairing needs the connection to be online.';
      this.log(`Pair an iPad refused: ${why}`);
      return { ok: false, error: why };
    }
    const gen = ++this.pairGen;
    this.pairLabel = input.targetDeviceId ? null : input.label?.trim() || null;
    this.pairing = reduce(this.pairing, { type: 'request', label: this.pairLabel ?? '', targetDeviceId: input.targetDeviceId ?? null });
    this.d.changed();
    try {
      const offer = await c.createPairing({ ...(this.pairLabel ? { label: this.pairLabel } : {}), ...(input.targetDeviceId ? { targetDeviceId: input.targetDeviceId } : {}) });
      if (gen !== this.pairGen) {
        // The sheet was closed (or a newer code asked for) while this one was being made: nothing may pair with a code nobody sees.
        try { await c.cancelPairing(offer.sessionId); } catch { /* it expires in five minutes anyway */ }
        return OK;
      }
      this.pairing = reduce(this.pairing, { type: 'issued', offer, now: this.now() });
      this.log(`Pair an iPad: a code is shown${offer.targetDeviceId ? ' to pair an iPad again' : ''}, valid until ${offer.expiresAt}.`);
      this.startTimer();
      this.d.changed();
      return OK;
    } catch (e) {
      if (gen !== this.pairGen) return OK;
      this.pairing = reduce(this.pairing, { type: 'failed', message: say(e, "Couldn't create a pairing code.") });
      this.d.changed();
      return this.failed('Pair an iPad', e, "Couldn't create a pairing code.");
    }
  }

  /** Show a new code (the old one stops working). Keeps the target and the typed name. */
  async pairNew(): Promise<Result> {
    const p = this.pairing;
    const target = p.phase === 'open' || p.phase === 'paired' ? p.offer.targetDeviceId : p.phase === 'error' || p.phase === 'issuing' ? p.targetDeviceId : null;
    const label = this.pairLabel ?? undefined;
    return this.pairOpen({ ...(target ? { targetDeviceId: target } : {}), ...(label ? { label } : {}) });
  }

  /** The name typed on the sheet; it is applied when the iPad pairs. */
  setPairLabel(label: string): Result {
    this.pairLabel = label.slice(0, 40);
    return OK;
  }

  /** Close the sheet. A code that is still open is cancelled, so nothing pairs unseen. */
  async closePairing(): Promise<void> {
    const p = this.pairing;
    this.pairGen += 1;
    if (p.phase === 'open' && this.client) { try { await this.client.cancelPairing(p.offer.sessionId); } catch { /* it expires in five minutes anyway */ } }
    this.pairing = IDLE; this.pairLabel = null;
    this.d.changed();
  }

  /** An action that failed: the reason in plain words for the window, and the same line in the log. */
  private failed(action: string, e: unknown, fallback: string): { ok: false; error: string } {
    const r = fail(e, fallback);
    this.log(`${action} failed: ${r.error}`);
    return r;
  }

  dispose(): void {
    this.disposed = true;
    this.stopTimer();
    for (const u of this.unsubs.splice(0)) u();
  }
}

/** Quitting while check-in is open needs a confirmation; otherwise it does not. */
export function quitPlan(runtime: RuntimeSnapshot): 'quit' | 'confirm' {
  return runtime.session === 'idle' ? 'quit' : 'confirm';
}
