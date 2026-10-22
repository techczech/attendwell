// Session phases, the Connection panel wording, when Pair an iPad works, the toolbar, and what the command registry is told.
import { describe, expect, test } from 'bun:test';
import { registry, type CommandCtx, IDLE_CTX } from '../shared/commands.ts';
import type { RuntimeSnapshot } from '../shared/runtime-types.ts';
import { NO_SELECTION, connectionModel, pairAvailability, pastBanner, phaseOf, sessionCtxOf, statusChip, toolbarModel, type SessionView } from '../shared/session-model.ts';
import { IDLE } from '../shared/pairing-model.ts';

const idle: RuntimeSnapshot = { workshopId: null, session: 'idle', service: { state: 'off' }, tunnel: { state: 'off' } };
const running = (tunnel: RuntimeSnapshot['tunnel'], over: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot => ({
  workshopId: 'w1', session: 'running', service: { state: 'running', organiserUrl: 'http://127.0.0.1:5000', participantPort: 5001, participantOrigin: 'https://x.trycloudflare.com' }, tunnel, ...over,
});
const w = (over: Partial<{ id: string; when: 'today' | 'past' | 'upcoming'; attended: number | null }> = {}) => ({ id: 'w1', when: 'today' as const, attended: null, ...over });
const phase = (runtime: RuntimeSnapshot, workshop = w(), endedThisRun = false) => phaseOf({ runtime, workshop, endedThisRun });

describe('phase', () => {
  test('connecting, online, trouble', () => {
    expect(phase({ ...idle, workshopId: 'w1', session: 'starting' })).toBe('connecting');
    expect(phase(running({ state: 'starting' }))).toBe('connecting');
    expect(phase(running({ state: 'online', url: 'https://x.trycloudflare.com' }))).toBe('online');
    expect(phase(running({ state: 'reconnecting', attempt: 2, url: null }))).toBe('trouble');
    expect(phase(running({ state: 'failed', reason: 'no-internet', message: 'm' }))).toBe('trouble');
    expect(phase(running({ state: 'online', url: 'u' }, { service: { state: 'restarting', attempt: 1 } }))).toBe('trouble');
    expect(phase({ ...running({ state: 'online', url: 'u' }), session: 'ending' })).toBe('ending');
  });
  test('ended: closed (today, ended here or with a saved count), past, or ready when never started', () => {
    expect(phase(idle, w(), true)).toBe('closed');
    expect(phase(idle, w({ attended: 12 }))).toBe('closed');
    expect(phase(idle, w({ when: 'past', attended: 12 }))).toBe('past');
    expect(phase(idle, w())).toBe('ready');
    expect(phase(idle, w({ attended: 0 }))).toBe('ready');
  });
  test("another workshop's check-in does not make this one live", () => {
    expect(phase(running({ state: 'online', url: 'u' }, { workshopId: 'other' }), w({ when: 'past' }))).toBe('past');
  });
});

const input = (over: Partial<Parameters<typeof connectionModel>[0]> = {}) => ({
  phase: 'online' as const, runtime: running({ state: 'online', url: 'https://quiet-river-1234.trycloudflare.com' }), lastOnlineAt: null, closedAt: null, failedAt: null, lastAddress: null, addressChangedAt: null, ...over,
});

describe('connection panel wording', () => {
  test('connecting and online', () => {
    expect(connectionModel(input({ phase: 'connecting', runtime: running({ state: 'starting' }) }))).toMatchObject({ chip: 'Connecting', headline: 'Connecting…', detail: 'Opening the check-in address. This can take up to a minute.', copy: false });
    expect(connectionModel(input())).toMatchObject({ chip: 'Online', headline: 'Online', detail: 'Check-in address ready', address: 'https://quiet-river-1234.trycloudflare.com', copy: true });
  });
  test('a new address after a restart says since when', () => {
    expect(connectionModel(input({ addressChangedAt: new Date(2026, 9, 30, 14, 4).toISOString() })).detail).toBe('Check-in address ready · new since 14:04');
  });
  test('reconnecting gives the attempt, the last time online and Try again', () => {
    const m = connectionModel(input({ phase: 'trouble', runtime: running({ state: 'reconnecting', attempt: 2, url: null }), lastOnlineAt: new Date(2026, 9, 30, 14, 19).toISOString() }));
    expect(m).toMatchObject({ chip: 'Reconnecting', headline: 'Reconnecting… attempt 2', detail: 'Last online at 14:19', retry: true, advice: 'The iPad keeps saving check-ins while the address is down.' });
  });
  test('every failure reason has its plain words and offers Try again', () => {
    const reasons = {
      'blocked-by-network': "Can't reach Cloudflare from this network", 'tunnel-refused': "Can't reach Cloudflare from this network", 'no-internet': 'This laptop is not connected to the internet.',
      'cloudflared-missing': 'AttendWell could not start its connection helper.', 'port-in-use': 'Another program is using the port AttendWell needs.', 'stopped-unexpectedly': 'The connection stopped.',
    } as const;
    for (const [reason, headline] of Object.entries(reasons)) {
      const m = connectionModel(input({ phase: 'trouble', runtime: running({ state: 'failed', reason: reason as keyof typeof reasons, message: 'm' }) }));
      expect(m, reason).toMatchObject({ tone: 'bad', chip: "Can't connect", headline, retry: true });
      expect(m.advice, reason).toBeTruthy();
    }
    expect(connectionModel(input({ phase: 'trouble', runtime: running({ state: 'failed', reason: 'blocked-by-network', message: 'm' }) })).advice).toContain('phone hotspot');
  });
  test('a register that cannot start names the folder problem and offers Choose folder', () => {
    const m = connectionModel(input({ phase: 'trouble', runtime: running({ state: 'off' }, { service: { state: 'failed', reason: 'folder', message: 'The registers folder is not available: /Volumes/X.' } }) }));
    expect(m).toMatchObject({ tone: 'bad', chooseFolder: true, retry: true });
  });
  test('closed: off, the address struck through, the time it closed', () => {
    expect(connectionModel(input({ phase: 'closed', runtime: idle, closedAt: new Date(2026, 9, 30, 16, 31).toISOString(), lastAddress: 'https://a.trycloudflare.com' })))
      .toMatchObject({ tone: 'off', chip: 'Off', headline: 'Off · check-in address closed', detail: 'Closed at 16:31', addressClosed: true, copy: false });
  });
});

describe('Pair an iPad availability, in the lock notes wording', () => {
  test('only while online; each other state says why', () => {
    expect(pairAvailability('online', idle)).toEqual({ ok: true, reason: null });
    expect(pairAvailability('connecting', idle).reason).toBe('Pair an iPad works once the connection is online.');
    expect(pairAvailability('trouble', running({ state: 'reconnecting', attempt: 1, url: null })).reason).toBe('Pairing waits until the connection is back.');
    expect(pairAvailability('trouble', running({ state: 'failed', reason: 'no-internet', message: '' })).reason).toBe('Pairing needs the connection.');
    expect(pairAvailability('closed', idle).ok).toBe(false);
    expect(pairAvailability('ready', idle).reason).toBe('Start check-in to pair an iPad.');
  });
  test('another workshop\'s check-in is open: this one says where pairing works, not to start a check-in that would be refused', () => {
    for (const phase of ['ready', 'closed', 'past'] as const) {
      expect(pairAvailability(phase, running({ state: 'online', url: 'https://quiet-river.trycloudflare.com' }), true)).toEqual({ ok: false, reason: 'Check-in is open for another workshop. Open that workshop to pair an iPad.' });
    }
    expect(pairAvailability('online', idle, true).ok).toBe(true);
  });
});

describe('toolbar and banners', () => {
  test('what each phase offers', () => {
    expect(toolbarModel('online')).toMatchObject({ end: true, addPerson: 'enabled', reopen: false, start: false });
    expect(toolbarModel('closed')).toMatchObject({ end: false, addPerson: 'disabled', closedMarker: true, reopen: true });
    expect(toolbarModel('past')).toMatchObject({ readOnlyMarker: true, reopen: true });
    expect(toolbarModel('ready')).toMatchObject({ start: true, reopen: false });
  });
  test('the past banner', () => {
    expect(pastBanner({ date: '2026-10-21', startTime: '09:00', endTime: '10:30' })).toBe('This session finished on Wed 21 Oct 2026 at 10:30. The register is shown as it was saved. Reopen check-in to accept late arrivals.');
  });
  test('the status bar chip: connecting, online, trouble, ended', () => {
    expect(['connecting', 'online', 'trouble', 'closed'].map((p) => statusChip(p as never).text)).toEqual(['Connecting…', 'Online', 'Connection trouble', 'Check-in closed']);
  });
});

const view = (over: Partial<SessionView> = {}): SessionView => ({
  workshopId: 'w1', phase: 'online', runtime: running({ state: 'online', url: 'u' }), hostName: 'Mac', roster: { participants: [{ id: 'p', name: 'P', email: '', booking: 'confirmed', present: false, admitted: false, version: 0, updatedAt: null }], conflicts: [] },
  rosterError: null, devices: null, pairing: IDLE, pairLabel: null, addressSince: null, addressChangedAt: null, lastOnlineAt: null, failedAt: null, closedAt: null, lastAddress: null, canUndo: false,
  registerOpen: true, busy: false, otherLive: false, ...over,
});
const ctx = (v: SessionView, sel = NO_SELECTION): CommandCtx => ({ ...IDLE_CTX, view: 'session', liveSession: true, session: sessionCtxOf(v, sel) });
const why = (id: string, c: CommandCtx) => registry.byId(id)!.available!(c);

describe('commands on the session screen', () => {
  test('while online: pair, add, end and copy work; check-in needs a selected person who is not here', () => {
    const c = ctx(view());
    for (const id of ['ipad.pair', 'person.add', 'checkin.end', 'connection.copy-address', 'register.find', 'register.sort', 'export.csv']) expect(why(id, c), id).toBeNull();
    expect(why('register.check-in', c)).toBe('Select a person first.');
    expect(why('register.check-in', ctx(view(), { person: { held: false, present: false, canCheckIn: true }, device: null }))).toBeNull();
    expect(why('register.check-in', ctx(view(), { person: { held: false, present: true, canCheckIn: false }, device: null }))).toBe('This person is already checked in.');
    expect(why('held.check-in', c)).toBe('Select a person held for review first.');
    expect(why('held.check-in', ctx(view(), { person: { held: true, present: false, canCheckIn: true }, device: null }))).toBeNull();
    expect(why('checkin.reopen', c)).toBe('Check-in is already open.');
    expect(why('register.undo', c)).toBe('There is nothing to undo.');
    expect(why('register.undo', ctx(view({ canUndo: true })))).toBeNull();
  });
  test('iPad commands need a selected iPad; Pair again also needs the connection', () => {
    expect(why('ipad.rename', ctx(view()))).toBe('Select an iPad first.');
    expect(why('ipad.revoke', ctx(view(), { person: null, device: { revoked: false } }))).toBeNull();
    expect(why('ipad.pair-again', ctx(view(), { person: null, device: { revoked: false } }))).toBeNull();
    expect(why('ipad.pair-again', ctx(view({ phase: 'trouble', runtime: running({ state: 'reconnecting', attempt: 1, url: null }) }), { person: null, device: { revoked: false } }))).toBe('Pairing waits until the connection is back.');
  });
  test('connecting: pair says why; retry only in trouble', () => {
    expect(why('ipad.pair', ctx(view({ phase: 'connecting', runtime: running({ state: 'starting' }) })))).toBe('Pair an iPad works once the connection is online.');
    expect(why('connection.retry', ctx(view()))).toBe('The connection does not need a retry.');
    expect(why('connection.retry', ctx(view({ phase: 'trouble', runtime: running({ state: 'failed', reason: 'no-internet', message: '' }) })))).toBeNull();
  });
  test('closed: reopen and export work; marking, pairing and ending do not', () => {
    const c = ctx(view({ phase: 'closed', runtime: idle, registerOpen: false }));
    expect(why('checkin.reopen', c)).toBeNull();
    expect(why('export.csv', c)).toBeNull();
    expect(why('checkin.end', c)).toBe('Check-in is not open.');
    expect(why('person.add', c)).toBe('Check-in is closed. Reopen check-in first.');
    expect(why('ipad.pair', c)).toBe('Reopen check-in to pair an iPad.');
    expect(why('checkin.reopen', ctx(view({ phase: 'closed', runtime: idle, registerOpen: false, otherLive: true })))).toBe("Another workshop's check-in is open. End it first.");
  });
  test('Email review needs someone who is here', () => {
    expect(why('review.email', ctx(view({ phase: 'closed', runtime: idle })))).toBe('Nobody is checked in yet.');
  });
  test('the name list and recovery commands are on; printing stays disabled with a reason (a later release)', () => {
    for (const id of ['names.paste', 'names.import', 'ipad.import-recovery']) expect(why(id, ctx(view())), id).toBeNull();
    expect(why('register.print', ctx(view()))).toBe('Not available yet in this version.');
  });
  test('exactly one iPad needing pairing again is named for the ⇧⌘N command', () => {
    const d = { id: 'd1', label: 'Door iPad', status: 'active' as const, pairedAt: new Date(2026, 9, 30, 12).toISOString(), lastSeenAt: new Date(2026, 9, 30, 12, 30).toISOString(), revokedAt: null, appVersion: '1.0.0', protocolVersion: 1,
      reportedPending: 3, reportedHeld: 0, oldestPendingAt: null, reportedAt: null, checkInsReceived: 0, needsReview: 0, unmatchedCheckIns: 0 };
    const v = view({ addressSince: new Date(2026, 9, 30, 14, 4).toISOString(), devices: { eventId: 'e', eventCode: 'H4KD', eventName: 'W', eventDate: '', serverTime: '', pairing: null, devices: [d], unmatchedCheckIns: [], adjustedText: [] } });
    expect(sessionCtxOf(v, NO_SELECTION).repairName).toBe('Door iPad');
    expect(sessionCtxOf({ ...v, devices: { ...v.devices!, devices: [d, { ...d, id: 'd2', label: 'iPad 2' }] } }, NO_SELECTION).repairName).toBeNull();
  });
});
