// Device rows in the Kiosk wording, the pair-again rule after a new address, and the revoke text.
import { describe, expect, test } from 'bun:test';
import { agoText, deviceRow, repairBanner, repairTargets, revokeText, type DeviceContext, type DeviceRecord } from '../shared/devices-model.ts';
import { clockOf } from '../shared/register-model.ts';

const T0 = Date.UTC(2026, 9, 30, 13, 0, 0);
const iso = (ms: number): string => new Date(ms).toISOString();
const dev = (id: string, over: Partial<DeviceRecord> = {}): DeviceRecord => ({
  id, label: id === 'd1' ? 'Door iPad' : `iPad ${id}`, status: 'active', pairedAt: iso(T0 - 3_600_000), lastSeenAt: iso(T0 - 5_000), revokedAt: null, appVersion: '1.0.0', protocolVersion: 1,
  reportedPending: 0, reportedHeld: 0, oldestPendingAt: null, reportedAt: iso(T0 - 5_000), checkInsReceived: 4, needsReview: 0, unmatchedCheckIns: 0, ...over,
});
const ctx = (over: Partial<DeviceContext> = {}): DeviceContext => ({ now: T0, live: true, closedAt: null, repair: new Set(), ...over });

describe('device status text', () => {
  test('connected while heard from in the last minute and a half', () => {
    expect(deviceRow(dev('d1'), ctx())).toMatchObject({ tone: 'good', statusText: 'Connected · Last seen 5 s ago', unsent: '0', needsReview: '0', appVersion: '1.0.0' });
  });
  test('not seen, with the unsent figure, when it holds check-ins; last seen otherwise', () => {
    expect(deviceRow(dev('d1', { lastSeenAt: iso(T0 - 6 * 60_000), reportedPending: 3 }), ctx())).toMatchObject({ tone: 'warn', statusText: 'Not seen for 6 min', unsent: '3' });
    expect(deviceRow(dev('d2', { lastSeenAt: iso(T0 - 4 * 60_000) }), ctx())).toMatchObject({ tone: 'warn', statusText: 'Last seen 4 min ago' });
  });
  test('the unsent figure is marked last reported when the iPad is not connected, and not when it is', () => {
    expect(deviceRow(dev('d1'), ctx())).toMatchObject({ tone: 'good', unsentStale: false });
    expect(deviceRow(dev('d1', { lastSeenAt: iso(T0 - 6 * 60_000), reportedPending: 3 }), ctx())).toMatchObject({ statusText: 'Not seen for 6 min', unsent: '3', unsentStale: true });
    expect(deviceRow(dev('d2', { lastSeenAt: iso(T0 - 4 * 60_000) }), ctx())).toMatchObject({ statusText: 'Last seen 4 min ago', unsent: '0', unsentStale: true });
    expect(deviceRow(dev('d3', { status: 'revoked', revokedAt: iso(T0 - 600_000), reportedPending: 2 }), ctx())).toMatchObject({ unsentStale: true });
    expect(deviceRow(dev('d1'), ctx({ live: false, closedAt: iso(T0) }))).toMatchObject({ statusText: `Check-in closed ${clockOf(iso(T0))}`, unsentStale: true });
    expect(deviceRow(dev('d4', { protocolVersion: 2 }), ctx())).toMatchObject({ statusText: 'Update needed', unsentStale: true });
  });
  test('paired and never heard from', () => {
    expect(deviceRow(dev('d5', { lastSeenAt: null, reportedPending: null, appVersion: null }), ctx())).toMatchObject({ statusText: 'Paired – waiting for first contact', unsent: '—', appVersion: '—', icon: 'hourglass' });
  });
  test('revoked shows the time and the last reported figure, and offers Pair again', () => {
    const r = deviceRow(dev('d3', { status: 'revoked', revokedAt: iso(T0 - 600_000), reportedPending: 2 }), ctx());
    expect(r).toMatchObject({ tone: 'bad', statusText: `Revoked ${clockOf(iso(T0 - 600_000))}`, unsent: '2', unsentStale: true, pairAgainButton: true, revoked: true });
  });
  test('update needed when the iPad speaks another protocol', () => {
    expect(deviceRow(dev('d4', { protocolVersion: 2 }), ctx())).toMatchObject({ statusText: 'Update needed', icon: 'download' });
  });
  test('once check-in is closed the rows show the state at close', () => {
    expect(deviceRow(dev('d1'), ctx({ live: false, closedAt: iso(T0) }))).toMatchObject({ tone: 'neutral', statusText: `Check-in closed ${clockOf(iso(T0))}` });
  });
  test('ages in seconds, minutes and hours', () => {
    expect([agoText(5_000), agoText(6 * 60_000), agoText(2 * 3_600_000)]).toEqual(['5 s', '6 min', '2 h']);
  });
});

describe('pair again after a new address', () => {
  const since = iso(T0 - 60_000);
  test('devices not heard from since the address began need pairing again; a device paired or seen since does not', () => {
    const old = dev('d1', { pairedAt: iso(T0 - 7_200_000), lastSeenAt: iso(T0 - 3_600_000) });
    const seen = dev('d2', { pairedAt: iso(T0 - 7_200_000), lastSeenAt: iso(T0 - 5_000) });
    const fresh = dev('d3', { pairedAt: iso(T0 - 10_000), lastSeenAt: null });
    const revoked = dev('d4', { status: 'revoked', lastSeenAt: null });
    expect(repairTargets([old, seen, fresh, revoked], since).map((d) => d.id)).toEqual(['d1']);
    expect(repairTargets([old], null)).toEqual([]);
  });
  test('the row shows Not seen with a Pair again button, not Connected', () => {
    const r = deviceRow(dev('d1', { reportedPending: 3, lastSeenAt: iso(T0 - 5_000) }), ctx({ repair: new Set(['d1']) }));
    expect(r).toMatchObject({ tone: 'warn', pairAgainButton: true, needsRepair: true, statusText: 'Not seen for 5 s' });
  });
  test('one iPad: the banner names it, counts its saved check-ins and targets it (⇧⌘N)', () => {
    const b = repairBanner([dev('d1', { reportedPending: 3 })], since)!;
    expect(b.title).toBe('Door iPad needs pairing again.');
    expect(b.body).toBe(`AttendWell has a new check-in address since it restarted at ${clockOf(since)}. Door iPad has 3 check-ins saved; they arrive once it is paired again.`);
    expect(b.button).toBe('Pair Door iPad again');
    expect(b.targetId).toBe('d1');
  });
  test('two or more: one banner, no target, each row keeps its own Pair again', () => {
    const b = repairBanner([dev('d1', { reportedPending: 1 }), dev('d2', { reportedPending: 2 })], since)!;
    expect(b).toMatchObject({ title: '2 iPads need pairing again.', button: 'Pair an iPad', targetId: null, ids: ['d1', 'd2'] });
    expect(repairBanner([], since)).toBeNull();
  });
});

describe('revoke', () => {
  test('Kiosk wording, with the unsent figure when there is one', () => {
    expect(revokeText(dev('2', { label: 'iPad 2', reportedPending: 3 }))).toEqual({
      title: 'Revoke iPad 2?', body: "It will stop sending check-ins. It reported 3 check-ins that haven't arrived. They stay on the iPad; pair it again to receive them.",
    });
    expect(revokeText(dev('2', { label: 'iPad 2' })).body).toBe('It will stop sending check-ins.');
  });
});
