// A stand-in for one running register, for development and tests: the same answers as the organiser API (names, versions, held
// check-ins, devices, one open pairing that pauses after wrong codes), in memory, on a clock the test controls. It opens no port.
import type { DeviceList, DeviceRecord, PairingInfo } from '../shared/devices-model.ts';
import type { PairingOffer } from '../shared/pairing-model.ts';
import type { Roster, RosterConflict, RosterPerson } from '../shared/register-model.ts';
import { OrganiserError, type OrganiserClient } from './organiser-client.ts';
import { planNames, type NameListRecord } from '../../server/names-list.ts';
import type { AddNamesRequest, AddNamesResult, RecoveryReport } from '../shared/names-model.ts';

/** The example workshop's booking labels (server/workshop-config.ts exampleWorkshop.sourceStatuses). */
const STATUSES = { Confirmed: 'confirmed', Cancelled: 'cancelled', 'Waiting list': 'waiting' } as const;
/** The fake's person token for an iPad: readable, so tests can write recovery files by hand. */
export const fakeToken = (id: string): string => `pt_${id}`;

const CODES = ['K7Q2-M9TX', 'H4RD-82NP', 'W3ZB-7QKC', 'T9XM-4DJF', 'P6VN-3HGE'];
const FIVE_MINUTES = 5 * 60_000;
/** Pauses after every fifth wrong code: 30 s, then 60, 120, 240 (docs/reference-device-api.md). */
const PAUSE_MS = [30_000, 60_000, 120_000, 240_000];

export interface FakeRegisterOptions {
  now?: () => number;
  participantOrigin?: () => string;
  eventCode?: string;
  eventName?: string;
  eventDate?: string;
}

interface OpenPairing { sessionId: string; label: string; targetDeviceId: string | null; code: string; expiresAt: number; wrong: number; pausedUntil: number | null; pauses: number }

export class FakeRegister implements OrganiserClient {
  people: RosterPerson[] = [];
  conflicts: RosterConflict[] = [];
  devicesList: DeviceRecord[] = [];
  holds: DeviceList['unmatchedCheckIns'] = [];
  private pairing: OpenPairing | null = null;
  private seq = 0;
  /** Everything the organiser asked for, in order, for tests to read. */
  readonly log: string[] = [];
  /** The next call fails with this (then clears). */
  failNext: OrganiserError | null = null;
  private readonly now: () => number;
  private readonly origin: () => string;

  constructor(private readonly o: FakeRegisterOptions = {}, roster?: Roster) {
    this.now = o.now ?? (() => Date.now());
    this.origin = o.participantOrigin ?? (() => 'https://quiet-river-1234.trycloudflare.com');
    if (roster) { this.people = roster.participants.map((p) => ({ ...p })); this.conflicts = roster.conflicts.map((c) => ({ ...c })); }
  }

  snapshot(): Roster { return { participants: this.people.map((p) => ({ ...p })), conflicts: this.conflicts.map((c) => ({ ...c })) }; }
  private check(what: string): void {
    this.log.push(what);
    if (this.failNext) { const e = this.failNext; this.failNext = null; throw e; }
  }

  async roster(): Promise<Roster> { this.check('roster'); return this.snapshot(); }

  async setAttendance(id: string, present: boolean, version: number): Promise<Roster> {
    this.check(`attendance ${id} ${present}`);
    const p = this.people.find((x) => x.id === id);
    if (!p) throw new OrganiserError('Participant is no longer in the active roster.', 404);
    if (p.version !== version) throw new OrganiserError('Attendance conflict: another facilitator updated this record. Refresh and try again.', 409);
    if (present && p.booking === 'waiting' && !p.admitted) throw new OrganiserError('Only a confirmed or admitted waiting-list booking can be checked in. Refresh the booking records first.', 400);
    p.present = present; p.version += 1; p.updatedAt = new Date(this.now()).toISOString();
    return this.snapshot();
  }

  async resolveConflict(id: string, action: 'check-in' | 'dismiss'): Promise<Roster> {
    this.check(`resolve ${id} ${action}`);
    const i = this.conflicts.findIndex((c) => c.participantId === id);
    if (i < 0) throw new OrganiserError('This check-in was already resolved. Refresh the register.', 404);
    const p = this.people.find((x) => x.id === id);
    if (action === 'check-in') {
      if (!p) throw new OrganiserError('This booking is no longer in the imported roster. Import it again or add the person, then check them in.', 409);
      if (!p.present) { p.present = true; p.version += 1; p.updatedAt = new Date(this.now()).toISOString(); }
    }
    this.conflicts.splice(i, 1);
    return this.snapshot();
  }

  async addParticipant(name: string, email: string): Promise<Roster> {
    this.check(`add ${name}`);
    const clean = name.trim().replace(/\s+/g, ' ');
    if (!clean) throw new OrganiserError('Enter a name and, if available, a valid email address.', 400);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new OrganiserError('Check the email address, or leave it blank.', 400);
    if (this.people.some((p) => p.name.toLowerCase() === clean.toLowerCase())) throw new OrganiserError('That name is already in the register. Check the existing record first.', 409);
    this.seq += 1;
    this.people.push({ id: `manual-fake-${this.seq}`, name: clean, email: email.trim().toLowerCase(), booking: 'confirmed', present: false, admitted: false, version: 0, updatedAt: null });
    return this.snapshot();
  }

  readonly nameLists: NameListRecord[] = [];
  private readonly ops = new Map<string, string>();

  /** The same plan as the register (server/names-list.ts), on the fake's people. */
  async addNames(input: AddNamesRequest, dryRun: boolean): Promise<AddNamesResult> {
    this.check(`names ${dryRun ? 'preview' : 'add'} ${input.rows.length}`);
    const plan = planNames({ existing: this.people, addedLists: Object.fromEntries(this.nameLists.map((l) => [l.listKey, { addedAt: l.addedAt, filename: l.filename }])), rows: input.rows, workshopDate: this.o.eventDate ?? '', statuses: { ...STATUSES } });
    if (dryRun) return { plan, written: false, roster: this.snapshot() };
    if (plan.alreadyAdded) throw new OrganiserError('This list was already added. Nothing was changed.', 409);
    if (plan.full) throw new OrganiserError(`The register holds up to 500 people; with this list it would hold ${plan.total}.`, 409);
    if (!plan.counts.added) return { plan, written: false, roster: this.snapshot() };
    for (const r of plan.rows) {
      if (r.result !== 'added') continue;
      this.seq += 1;
      this.people.push({ id: `list-fake-${this.seq}`, name: r.name, email: r.email, booking: r.booking ?? 'confirmed', present: false, admitted: false, version: 0, updatedAt: null });
    }
    this.nameLists.push({ kind: input.source.kind, filename: input.source.filename ?? null, sha256: input.source.sha256 ?? null, listKey: plan.listKey, addedAt: new Date(this.now()).toISOString(), rows: plan.rows.length, added: plan.counts.added, merged: plan.counts.merged, known: plan.counts.known, skipped: plan.counts.skipped });
    return { plan, written: true, roster: this.snapshot() };
  }

  /** A recovery file for event "evt_fake", persons by `fakeToken`; each opId counts once, like the register. */
  async importRecovery(file: unknown, dryRun: boolean): Promise<RecoveryReport> {
    this.check(`recovery ${dryRun ? 'preview' : 'import'}`);
    const f = file as { format?: unknown; version?: unknown; eventId?: unknown; deviceId?: unknown; operations?: unknown };
    if (f?.format !== 'attendance-recovery') throw new OrganiserError('This is not an iPad recovery file.', 400);
    if (f.eventId !== 'evt_fake') throw new OrganiserError('This recovery file is from another workshop. Open that workshop, then import it there.', 409);
    const rows: RecoveryReport['rows'] = [];
    const seen = new Map(this.ops);
    for (const raw of Array.isArray(f.operations) ? f.operations : []) {
      const o = raw as { opId?: unknown; personToken?: unknown; displayName?: unknown };
      const p = this.people.find((x) => fakeToken(x.id) === o.personToken);
      const opId = typeof o.opId === 'string' ? o.opId : '';
      if (!opId) { rows.push({ opId, name: String(o.displayName ?? ''), outcome: 'refused', reason: 'invalid' }); continue; }
      if (seen.has(opId)) { rows.push({ opId, name: p?.name ?? '', outcome: 'already' }); continue; }
      seen.set(opId, p?.id ?? '');
      if (!p) { rows.push({ opId, name: String(o.displayName ?? ''), outcome: 'review', reason: 'unknown_person' }); continue; }
      if (p.present) { rows.push({ opId, name: p.name, outcome: 'already' }); continue; }
      rows.push({ opId, name: p.name, outcome: 'recorded' });
      if (!dryRun) { p.present = true; p.version += 1; p.updatedAt = new Date(this.now()).toISOString(); }
    }
    if (!dryRun) for (const [k, v] of seen) this.ops.set(k, v);
    const n = (k: string): number => rows.filter((r) => r.outcome === k).length;
    return { eventCode: this.o.eventCode ?? 'H4KD', deviceId: typeof f.deviceId === 'string' ? f.deviceId : 'recovery-file', deviceLabel: this.devicesList.find((d) => d.id === f.deviceId)?.label ?? null, exportedAt: null, rows, counts: { recorded: n('recorded'), already: n('already'), review: n('review'), refused: n('refused') }, written: !dryRun };
  }

  async devices(): Promise<DeviceList> {
    this.check('devices');
    return this.deviceList();
  }

  deviceList(): DeviceList {
    const t = this.now();
    const p = this.pairing;
    const info: PairingInfo | null = p ? {
      sessionId: p.sessionId, label: p.label, targetDeviceId: p.targetDeviceId, expiresAt: new Date(p.expiresAt).toISOString(),
      state: p.expiresAt <= t ? 'expired' : p.pausedUntil && p.pausedUntil > t ? 'paused' : 'waiting', wrongAttempts: p.wrong,
      pausedUntil: p.pausedUntil && p.pausedUntil > t ? new Date(p.pausedUntil).toISOString() : null,
    } : null;
    return {
      eventId: 'evt_fake', eventCode: this.o.eventCode ?? 'H4KD', eventName: this.o.eventName ?? 'Workshop', eventDate: this.o.eventDate ?? '2026-10-30',
      serverTime: new Date(t).toISOString(), pairing: info, devices: this.devicesList.map((d) => ({ ...d })), unmatchedCheckIns: this.holds.map((h) => ({ ...h })), adjustedText: [],
    };
  }

  async createPairing(input: { label?: string; targetDeviceId?: string }): Promise<PairingOffer> {
    this.check(`pair ${input.targetDeviceId ?? input.label ?? ''}`);
    let label: string;
    let target: string | null = null;
    if (input.targetDeviceId) {
      const d = this.devicesList.find((x) => x.id === input.targetDeviceId);
      if (!d) throw new OrganiserError('That iPad is no longer in the device list.', 404);
      target = d.id; label = d.label;
    } else label = input.label?.trim() ? input.label.trim() : `iPad ${this.devicesList.length + 1}`;
    this.seq += 1;
    const code = CODES[this.seq % CODES.length]!;
    this.pairing = { sessionId: `ps_fake_${this.seq}`, label, targetDeviceId: target, code, expiresAt: this.now() + FIVE_MINUTES, wrong: 0, pausedUntil: null, pauses: 0 };
    const base = this.origin();
    return {
      sessionId: this.pairing.sessionId, label, targetDeviceId: target, shortCode: code, qrPayload: `${base}/pair#v=1&code=${code}`, baseUrl: base,
      expiresAt: new Date(this.pairing.expiresAt).toISOString(), serverTime: new Date(this.now()).toISOString(), eventCode: this.o.eventCode ?? 'H4KD',
    };
  }

  async cancelPairing(sessionId: string): Promise<void> {
    this.check(`cancel-pairing ${sessionId}`);
    if (this.pairing?.sessionId === sessionId) this.pairing = null;
  }

  async renameDevice(id: string, label: string): Promise<DeviceList> {
    this.check(`rename ${id} ${label}`);
    const d = this.devicesList.find((x) => x.id === id);
    if (!d) throw new OrganiserError('That iPad is no longer in the device list.', 404);
    if (!label.trim() || label.length > 40 || /[@<>]/.test(label)) throw new OrganiserError('Name the iPad in up to 40 characters (no @ < >).', 400);
    d.label = label.trim();
    return this.deviceList();
  }

  async revokeDevice(id: string): Promise<DeviceList> {
    this.check(`revoke ${id}`);
    const d = this.devicesList.find((x) => x.id === id);
    if (!d) throw new OrganiserError('That iPad is no longer in the device list.', 404);
    d.status = 'revoked'; d.revokedAt = new Date(this.now()).toISOString();
    return this.deviceList();
  }

  async dismissHold(id: number): Promise<DeviceList> {
    this.check(`dismiss-hold ${id}`);
    const n = this.holds.length;
    this.holds = this.holds.filter((h) => h.id !== id);
    if (this.holds.length === n) throw new OrganiserError('That check-in was already cleared. Refresh the device list.', 404);
    return this.deviceList();
  }

  // ---- what a test does to the register (the iPad and the outside world) ------------------------------------------------------

  /** An iPad scans the open code and pairs (or pairs again, for a targeted code). */
  simulatePaired(): DeviceRecord {
    const p = this.pairing;
    if (!p) throw new Error('No open pairing.');
    const at = new Date(this.now()).toISOString();
    let d = p.targetDeviceId ? this.devicesList.find((x) => x.id === p.targetDeviceId) : undefined;
    if (d) { d.pairedAt = at; d.revokedAt = null; d.status = 'active'; } else {
      this.seq += 1;
      d = { id: `dev_fake_${this.seq}`, label: p.label, status: 'active', pairedAt: at, lastSeenAt: null, revokedAt: null, appVersion: null, protocolVersion: 1, reportedPending: null, reportedHeld: null, oldestPendingAt: null, reportedAt: null, checkInsReceived: 0, needsReview: 0, unmatchedCheckIns: 0 };
      this.devicesList.push(d);
    }
    this.pairing = null;
    return d;
  }

  /** Wrong codes from outside; every fifth pauses the open pairing for 30 s, 60, 120, 240. */
  simulateWrongCodes(n: number): void {
    const p = this.pairing;
    if (!p) throw new Error('No open pairing.');
    for (let i = 0; i < n; i += 1) {
      if (p.pausedUntil && p.pausedUntil > this.now()) continue;
      p.wrong += 1;
      if (p.wrong % 5 === 0) { p.pausedUntil = this.now() + (PAUSE_MS[Math.min(p.pauses, PAUSE_MS.length - 1)] ?? 240_000); p.pauses += 1; }
    }
  }

  /** The open code runs out (five minutes have passed). */
  simulateExpired(): void {
    if (!this.pairing) throw new Error('No open pairing.');
    this.pairing.expiresAt = this.now() - 1000;
  }

  /** The iPad is heard from, with what it reports about its own outbox. */
  simulateHeartbeat(id: string, over: Partial<DeviceRecord> = {}): void {
    const d = this.devicesList.find((x) => x.id === id);
    if (!d) throw new Error('No such device.');
    const at = new Date(this.now()).toISOString();
    Object.assign(d, { lastSeenAt: at, reportedAt: at, appVersion: d.appVersion ?? '1.0.0', reportedPending: d.reportedPending ?? 0, reportedHeld: d.reportedHeld ?? 0 }, over);
  }

  /** A held check-in an iPad sent (an organiser changed the record after the iPad saved it). */
  simulateHeldCheckIn(personId: string, reason = 'changed'): void {
    const p = this.people.find((x) => x.id === personId);
    if (!p) throw new Error('No such person.');
    const at = new Date(this.now()).toISOString();
    this.conflicts.push({ participantId: p.id, name: p.name, reason, queuedAt: at, receivedAt: at, count: 1 });
  }
}
