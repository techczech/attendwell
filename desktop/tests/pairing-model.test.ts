// The pairing sheet's state machine: issuing, waiting with a countdown, paired, expired, paused after wrong codes, error.
import { describe, expect, test } from 'bun:test';
import type { DeviceList, DeviceRecord, PairingInfo } from '../shared/devices-model.ts';
import { IDLE, clock, pairingMessage, pairingView, reduce, type PairingOffer, type PairingState } from '../shared/pairing-model.ts';

const T0 = Date.UTC(2026, 9, 30, 13, 0, 0);
const iso = (ms: number): string => new Date(ms).toISOString();
const offer = (over: Partial<PairingOffer> = {}): PairingOffer => ({
  sessionId: 'ps_1', label: 'iPad 1', targetDeviceId: null, shortCode: 'K7Q2-M9TX', qrPayload: 'https://quiet-river-1234.trycloudflare.com/pair#v=1&code=K7Q2-M9TX',
  baseUrl: 'https://quiet-river-1234.trycloudflare.com', expiresAt: iso(T0 + 300_000), serverTime: iso(T0), eventCode: 'H4KD', ...over,
});
const device = (id: string, over: Partial<DeviceRecord> = {}): DeviceRecord => ({
  id, label: 'iPad 1', status: 'active', pairedAt: iso(T0 + 20_000), lastSeenAt: null, revokedAt: null, appVersion: null, protocolVersion: 1, reportedPending: null, reportedHeld: null,
  oldestPendingAt: null, reportedAt: null, checkInsReceived: 0, needsReview: 0, unmatchedCheckIns: 0, ...over,
});
const list = (pairing: PairingInfo | null, devices: DeviceRecord[] = []): DeviceList => ({
  eventId: 'e', eventCode: 'H4KD', eventName: 'W', eventDate: '2026-10-30', serverTime: iso(T0), pairing, devices, unmatchedCheckIns: [], adjustedText: [],
});
const info = (over: Partial<PairingInfo> = {}): PairingInfo => ({ sessionId: 'ps_1', label: 'iPad 1', targetDeviceId: null, expiresAt: iso(T0 + 300_000), state: 'waiting', wrongAttempts: 0, pausedUntil: null, ...over });
const open = (o: PairingOffer = offer()): PairingState => reduce(reduce(IDLE, { type: 'request', label: '', targetDeviceId: o.targetDeviceId }), { type: 'issued', offer: o, now: T0 });

describe('issuing and showing a code', () => {
  test('request shows "Creating a pairing code…"; the offer shows the code with a countdown', () => {
    const issuing = reduce(IDLE, { type: 'request', label: 'Door iPad', targetDeviceId: null });
    expect(pairingView(issuing, T0)).toMatchObject({ kind: 'issuing', label: 'Door iPad' });
    expect(pairingMessage(pairingView(issuing, T0)!)).toBe('Creating a pairing code…');
    const v = pairingView(open(), T0)!;
    expect(v).toMatchObject({ kind: 'waiting', step: 2, shortCode: 'K7Q2-M9TX', countdown: '5:00', eventCode: 'H4KD', repair: false });
    expect(pairingMessage(v)).toBe('This code pairs one iPad and expires in 5:00.');
  });
  test('the countdown runs on the register clock, however far this clock is from it', () => {
    // This laptop's clock is 40 s behind the register's: the offer says 5:00 left at the register's time.
    const behind = reduce(reduce(IDLE, { type: 'request', label: '', targetDeviceId: null }), { type: 'issued', offer: offer(), now: T0 - 40_000 });
    expect(pairingView(behind, T0 - 40_000 + 48_000)!.countdown).toBe('4:12');
  });
  test('a failure is an error state with the reason, from which a new request starts again', () => {
    const e = reduce(reduce(IDLE, { type: 'request', label: '', targetDeviceId: null }), { type: 'failed', message: 'Turn on the participant link first.' });
    expect(pairingView(e, T0)).toMatchObject({ kind: 'error', message: 'Turn on the participant link first.' });
    expect(reduce(e, { type: 'request', label: '', targetDeviceId: null }).phase).toBe('issuing');
  });
});

describe('expiry', () => {
  test('after five minutes the code has expired, locally, without waiting for the next poll', () => {
    const v = pairingView(open(), T0 + 300_000)!;
    expect(v).toMatchObject({ kind: 'expired', countdown: '0:00' });
    expect(pairingMessage(v)).toBe('This code has expired.');
  });
  test('a poll that reports the pairing as expired, or no longer there, ends in expired', () => {
    expect(pairingView(reduce(open(), { type: 'poll', list: list(info({ state: 'expired' })), now: T0 + 1000 }), T0 + 1000)!.kind).toBe('expired');
    expect(pairingView(reduce(open(), { type: 'poll', list: list(null), now: T0 + 1000 }), T0 + 1000)!.kind).toBe('expired');
  });
});

describe('wrong codes pause the open pairing; nothing locks for good', () => {
  test('paused shows the wait, then works again when the pause ends', () => {
    const paused = reduce(open(), { type: 'poll', list: list(info({ state: 'paused', wrongAttempts: 5, pausedUntil: iso(T0 + 30_000) })), now: T0 + 1000 });
    const v = pairingView(paused, T0 + 1000)!;
    expect(v).toMatchObject({ kind: 'paused', wrongAttempts: 5, pausedMs: 29_000 });
    expect(pairingMessage(v)).toContain('Too many wrong codes');
    expect(pairingMessage(v)).toContain('0:29');
    const resumed = reduce(paused, { type: 'poll', list: list(info({ state: 'waiting', wrongAttempts: 5 })), now: T0 + 31_000 });
    expect(pairingView(resumed, T0 + 31_000)!.kind).toBe('waiting');
  });
  test('a pause that has run out locally shows as waiting even before the next poll says so', () => {
    const paused = reduce(open(), { type: 'poll', list: list(info({ state: 'paused', wrongAttempts: 5, pausedUntil: iso(T0 + 30_000) })), now: T0 + 1000 });
    expect(pairingView(paused, T0 + 31_000)!.pausedMs).toBe(0);
  });
});

describe('paired', () => {
  test('the code disappears and a new device is there: paired, with its name', () => {
    const s = reduce(open(), { type: 'poll', list: list(null, [device('dev_1', { label: 'iPad 1' })]), now: T0 + 25_000 });
    expect(pairingView(s, T0 + 25_000)).toMatchObject({ kind: 'paired', step: 3, device: { id: 'dev_1', label: 'iPad 1' }, repair: false });
    expect(pairingMessage(pairingView(s, 0)!)).toBe('iPad 1 is paired. It will appear as Connected once it has the names list.');
  });
  test('Pair again: the targeted row is paired again (same row), and says so', () => {
    const o = offer({ targetDeviceId: 'd1', label: 'Door iPad' });
    const s = reduce(open(o), { type: 'poll', list: list(null, [device('d1', { label: 'Door iPad', pairedAt: iso(T0 + 20_000) }), device('other', { pairedAt: iso(T0 + 21_000) })]), now: T0 + 25_000 });
    expect(pairingView(s, 0)).toMatchObject({ kind: 'paired', repair: true, device: { id: 'd1' } });
    expect(pairingMessage(pairingView(s, 0)!)).toBe('Door iPad is paired again.');
  });
  test('a device paired before the code was shown does not count', () => {
    const s = reduce(open(), { type: 'poll', list: list(null, [device('old', { pairedAt: iso(T0 - 600_000) })]), now: T0 + 25_000 });
    expect(pairingView(s, T0 + 25_000)!.kind).toBe('expired');
  });
});

describe('closing', () => {
  test('close returns to idle; a poll in any state but open changes nothing', () => {
    expect(reduce(open(), { type: 'close' })).toEqual(IDLE);
    expect(reduce(IDLE, { type: 'poll', list: list(null), now: T0 })).toEqual(IDLE);
    expect(pairingView(IDLE, T0)).toBeNull();
  });
  test('the clock reads minutes and seconds', () => expect([clock(252_000), clock(0), clock(-5)]).toEqual(['4:12', '0:00', '0:00']));
});
