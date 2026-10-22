// The live session against the fake runtime and the fake organiser client: start, the register, pairing, devices, trouble and recovery,
// a new address, end, reopen, quit, and read-only views of other workshops.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OrganiserError, type OrganiserFactory } from '../main/organiser-client.ts';
import { createFakeRuntime, type FakeRuntime } from '../main/fake-runtime.ts';
import { SessionService, quitPlan } from '../main/session-service.ts';
import { repairsIn } from '../shared/session-model.ts';
import type { Roster, RosterPerson } from '../shared/register-model.ts';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const T0 = new Date(2026, 9, 30, 14, 0, 0).getTime();
const person = (id: string, name: string, over: Partial<RosterPerson> = {}): RosterPerson => ({
  id, name, email: `${name.toLowerCase().replace(/ /g, '.')}@example.ac.uk`, booking: 'confirmed', present: false, admitted: false, version: 0, updatedAt: null, ...over,
});
const nobodyYet: Roster = {
  participants: [person('p1', 'Aisha Rahman'), person('p2', 'Ben Okoye'), person('p3', 'Marta Silva'), person('p4', 'Dev Patel')],
  conflicts: [],
};
/** The earlier session: Dev Patel was checked in. */
const names: Roster = { participants: nobodyYet.participants.map((p) => (p.id === 'p4' ? { ...p, present: true, version: 1, updatedAt: new Date(2026, 9, 21, 9, 10).toISOString() } : p)), conflicts: [] };

async function setup(opts: { seedNames?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aw-sess-'));
  dirs.push(dir);
  const clock = { ms: T0 };
  const rt: FakeRuntime = createFakeRuntime({ dataRoot: dir, now: () => new Date(clock.ms), seed: ({ title }) => (opts.seedNames === false ? null : title === 'Earlier session' ? names : nobodyYet) });
  const today = await rt.workshops.create({ title: 'Generative AI for Researchers', date: '2026-10-30', startTime: '14:00', endTime: '16:30' });
  const past = await rt.workshops.create({ title: 'Earlier session', date: '2026-10-21', startTime: '09:00', endTime: '10:30' });
  let changes = 0;
  const svc = new SessionService({ port: rt, organiser: rt.fake.organiserFactory, hostName: 'Mac', changed: () => { changes += 1; }, now: () => clock.ms, pollMs: 0 });
  return { rt, svc, clock, today, past, changes: () => changes, dir };
}
type Setup = Awaited<ReturnType<typeof setup>>;

async function online(s: Setup): Promise<void> {
  await s.svc.show(s.today.id);
  const r = await s.svc.start();
  expect(r.ok).toBe(true);
  await settle();
  await s.svc.refresh();
}

describe('starting check-in', () => {
  test('a workshop with no session yet is ready, shows its names read-only, and Start check-in opens it', async () => {
    const s = await setup();
    await s.svc.show(s.today.id);
    expect(s.svc.view()).toMatchObject({ phase: 'ready', registerOpen: false });
    expect(s.svc.view().roster!.participants).toHaveLength(4);
    await online(s);
    const v = s.svc.view();
    expect(v).toMatchObject({ phase: 'online', registerOpen: true, workshopId: s.today.id });
    expect(v.devices).not.toBeNull();
    expect(v.addressSince).toBe(new Date(T0).toISOString());
    expect(v.lastAddress).toContain('trycloudflare.com');
  });
  test('a tunnel that fails leaves the register running for the organiser, in trouble, and Retry connection recovers', async () => {
    const s = await setup();
    s.rt.fake.failNextTunnel('blocked-by-network', 'blocked');
    await s.svc.show(s.today.id);
    await s.svc.start();
    await settle();
    expect(s.svc.view()).toMatchObject({ phase: 'trouble', registerOpen: true });
    expect(s.svc.view().failedAt).not.toBeNull();
    expect((await s.svc.pairOpen()).ok).toBe(false);
    expect((await s.svc.mark('p1', true)).ok).toBe(true);
    expect((await s.svc.retry()).ok).toBe(true);
    await settle();
    expect(s.svc.view().phase).toBe('online');
    expect(s.svc.view().failedAt).toBeNull();
  });
  test('starting twice is refused in plain words', async () => {
    const s = await setup();
    await online(s);
    expect(await s.svc.start()).toEqual({ ok: false, error: 'Check-in is already open.' });
  });
});

describe('the register on the laptop', () => {
  test('mark present, then undo', async () => {
    const s = await setup();
    await online(s);
    expect((await s.svc.mark('p1', true)).ok).toBe(true);
    expect(s.svc.view().roster!.participants.find((p) => p.id === 'p1')).toMatchObject({ present: true, version: 1, updatedAt: new Date(T0).toISOString() });
    expect(s.svc.view().canUndo).toBe(true);
    expect((await s.svc.undoLast()).ok).toBe(true);
    expect(s.svc.view().roster!.participants.find((p) => p.id === 'p1')!.present).toBe(false);
    expect(s.svc.view().canUndo).toBe(false);
    expect(await s.svc.undoLast()).toEqual({ ok: false, error: 'There is nothing to undo.' });
  });
  test('a walk-in is added on the laptop and marked here at once; a duplicate name is refused with the register\'s words', async () => {
    const s = await setup();
    await online(s);
    expect((await s.svc.addPerson({ name: '  Tomasz   Kowalski ', email: '', markHere: true })).ok).toBe(true);
    const t = s.svc.view().roster!.participants.find((p) => p.name === 'Tomasz Kowalski')!;
    expect(t).toMatchObject({ present: true, email: '' });
    expect(t.id.startsWith('manual-')).toBe(true);
    const dup = await s.svc.addPerson({ name: 'tomasz kowalski', email: '', markHere: false });
    expect(dup).toEqual({ ok: false, error: 'That name is already in the register. Check the existing record first.' });
    expect((await s.svc.addPerson({ name: 'No Mark', email: 'bad address', markHere: false })).ok).toBe(false);
    expect(s.svc.view().roster!.participants.some((p) => p.name === 'No Mark')).toBe(false);
  });
  test('a held check-in is resolved with Check in or Keep not checked in', async () => {
    const s = await setup();
    await online(s);
    const reg = s.rt.fake.register(s.today.id);
    reg.simulateHeldCheckIn('p3');
    reg.simulateHeldCheckIn('p2', 'duplicate-name');
    await s.svc.refresh();
    expect(s.svc.view().roster!.conflicts).toHaveLength(2);
    expect((await s.svc.resolve('p3', 'check-in')).ok).toBe(true);
    expect((await s.svc.resolve('p2', 'dismiss')).ok).toBe(true);
    const r = s.svc.view().roster!;
    expect(r.conflicts).toEqual([]);
    expect(r.participants.find((p) => p.id === 'p3')!.present).toBe(true);
    expect(r.participants.find((p) => p.id === 'p2')!.present).toBe(false);
  });
  test('a change on a record someone else changed shows the register as it is now, and says why', async () => {
    const s = await setup();
    await online(s);
    const reg = s.rt.fake.register(s.today.id);
    reg.people.find((p) => p.id === 'p1')!.version = 5; // changed behind the window's back
    const r = await s.svc.mark('p1', true);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain('another facilitator');
    expect(s.svc.view().roster!.participants.find((p) => p.id === 'p1')!.version).toBe(5);
    expect(s.svc.view().canUndo).toBe(false);
  });
  test('a register that stops answering is reported and the last roster stays on screen', async () => {
    const s = await setup();
    await online(s);
    s.rt.fake.register(s.today.id).failNext = new OrganiserError('The register did not answer. Check the connection panel, then try again.', 0);
    await s.svc.refresh();
    expect(s.svc.view().rosterError).toContain('did not answer');
    expect(s.svc.view().roster!.participants).toHaveLength(4);
    expect(s.svc.view().registerOpen).toBe(false);
    await s.svc.refresh();
    expect(s.svc.view().rosterError).toBeNull();
  });
  test('nothing changes while check-in is closed', async () => {
    const s = await setup();
    await s.svc.show(s.today.id);
    expect(await s.svc.mark('p1', true)).toEqual({ ok: false, error: 'Check-in is not open. Reopen check-in to change the register.' });
    expect((await s.svc.addPerson({ name: 'X Y', email: '', markHere: false })).ok).toBe(false);
  });
});

describe('pairing', () => {
  test('a new code, then the iPad pairs: the sheet moves from waiting to paired and the device is in the list', async () => {
    const s = await setup();
    await online(s);
    expect((await s.svc.pairOpen({ label: 'Door iPad' })).ok).toBe(true);
    let st = s.svc.view().pairing;
    expect(st.phase).toBe('open');
    if (st.phase === 'open') expect(st.offer).toMatchObject({ label: 'Door iPad', targetDeviceId: null, qrPayload: expect.stringContaining('/pair#v=1&code=') });
    s.clock.ms += 20_000;
    s.rt.fake.register(s.today.id).simulatePaired();
    await s.svc.refresh();
    st = s.svc.view().pairing;
    expect(st).toMatchObject({ phase: 'paired', device: { label: 'Door iPad' }, repaired: false });
    expect(s.svc.view().devices!.devices.map((d) => d.label)).toEqual(['Door iPad']);
  });
  test('the name typed on the sheet is applied to the iPad when it pairs', async () => {
    const s = await setup();
    await online(s);
    await s.svc.pairOpen();
    s.svc.setPairLabel('Side door');
    s.rt.fake.register(s.today.id).simulatePaired();
    await s.svc.refresh();
    expect(s.svc.view().devices!.devices.map((d) => d.label)).toEqual(['Side door']);
    expect(s.svc.view().pairing).toMatchObject({ phase: 'paired', device: { label: 'Side door' } });
    expect(s.svc.view().pairLabel).toBeNull();
  });
  test('wrong codes pause the open pairing and the sheet follows; a new code starts afresh', async () => {
    const s = await setup();
    await online(s);
    await s.svc.pairOpen();
    s.rt.fake.register(s.today.id).simulateWrongCodes(5);
    await s.svc.refresh();
    const st = s.svc.view().pairing;
    expect(st.phase === 'open' && st.info).toMatchObject({ state: 'paused', wrongAttempts: 5 });
    expect((await s.svc.pairNew()).ok).toBe(true);
    await s.svc.refresh();
    const again = s.svc.view().pairing;
    expect(again.phase === 'open' && again.info).toMatchObject({ state: 'waiting', wrongAttempts: 0 });
  });
  test('a code left alone for five minutes shows as expired', async () => {
    const s = await setup();
    await online(s);
    await s.svc.pairOpen();
    s.clock.ms += 301_000;
    await s.svc.refresh();
    const st = s.svc.view().pairing;
    expect(st.phase === 'open' && st.info?.state).toBe('expired');
  });
  test('closing the sheet cancels a code that is still open, so nothing pairs unseen', async () => {
    const s = await setup();
    await online(s);
    await s.svc.pairOpen();
    await s.svc.closePairing();
    const reg = s.rt.fake.register(s.today.id);
    expect(reg.log.some((l) => l.startsWith('cancel-pairing'))).toBe(true);
    expect(s.svc.view().pairing.phase).toBe('idle');
    expect(() => reg.simulatePaired()).toThrow();
  });
  test('Pair again for one row keeps the row: same device, no new name, the old credential would stop', async () => {
    const s = await setup();
    await online(s);
    const reg = s.rt.fake.register(s.today.id);
    await s.svc.pairOpen({ label: 'Door iPad' });
    reg.simulatePaired();
    await s.svc.refresh();
    const id = s.svc.view().devices!.devices[0]!.id;
    await s.svc.closePairing();
    s.clock.ms += 60_000;
    expect((await s.svc.pairOpen({ targetDeviceId: id, label: 'ignored' })).ok).toBe(true);
    const open = s.svc.view().pairing;
    expect(open.phase === 'open' && open.offer).toMatchObject({ targetDeviceId: id, label: 'Door iPad' });
    s.clock.ms += 10_000;
    reg.simulatePaired();
    await s.svc.refresh();
    expect(s.svc.view().pairing).toMatchObject({ phase: 'paired', repaired: true, device: { id } });
    expect(s.svc.view().devices!.devices).toHaveLength(1);
  });
  test('pairing is refused unless the connection is online, with the register unchanged', async () => {
    const s = await setup();
    await s.svc.show(s.today.id);
    expect((await s.svc.pairOpen()).ok).toBe(false);
    expect(s.svc.view().pairing.phase).toBe('idle');
  });
  test('a register that refuses the code shows the error state with its reason', async () => {
    const s = await setup();
    await online(s);
    s.rt.fake.register(s.today.id).failNext = new OrganiserError('Turn on the participant link first: the iPad pairs through it.', 409);
    expect((await s.svc.pairOpen()).ok).toBe(false);
    expect(s.svc.view().pairing).toMatchObject({ phase: 'error', message: 'Turn on the participant link first: the iPad pairs through it.' });
  });
});

describe('pairing after a failed or abandoned attempt', () => {
  /** A service whose organiser client holds createPairing or devices() until the test lets them go. */
  async function held(s: Setup, lines: string[] = []) {
    const gates: { pairing?: () => void; devices?: () => void } = {};
    const hold = { pairing: false, devices: false };
    const organiser: OrganiserFactory = (url) => {
      const c = s.rt.fake.organiserFactory(url);
      return new Proxy(c, {
        get(target, prop) {
          const v = Reflect.get(target, prop, target);
          if (prop === 'createPairing' && hold.pairing) return async (input: { label?: string }) => { await new Promise<void>((r) => { gates.pairing = r; }); return target.createPairing(input); };
          // The list is read now, and answered when the test lets it go: a list from before the code was issued.
          if (prop === 'devices' && hold.devices) return async () => { const list = await target.devices(); await new Promise<void>((r) => { gates.devices = r; }); return list; };
          return typeof v === 'function' ? v.bind(target) : v;
        },
      });
    };
    s.svc.dispose();
    const svc = new SessionService({ port: s.rt, organiser, hostName: 'Mac', changed: () => {}, now: () => s.clock.ms, pollMs: 0, log: (l) => lines.push(l) });
    await svc.show(s.today.id);
    expect((await svc.start()).ok).toBe(true);
    await settle();
    await svc.refresh();
    return { svc, gates, hold, lines };
  }
  const until = async (ok: () => boolean): Promise<void> => { for (let i = 0; i < 50 && !ok(); i += 1) await settle(); expect(ok()).toBe(true); };

  test('a code that fails can be asked for again, and the second one is live', async () => {
    const s = await setup();
    await online(s);
    s.rt.fake.register(s.today.id).failNext = new OrganiserError('The register did not answer. Check the connection panel, then try again.', 0);
    expect((await s.svc.pairOpen()).ok).toBe(false);
    expect(s.svc.view().pairing.phase).toBe('error');
    expect((await s.svc.pairNew()).ok).toBe(true);
    await s.svc.refresh();
    const st = s.svc.view().pairing;
    expect(st.phase === 'open' && st.info?.state).toBe('waiting');
  });
  test('a sheet closed while its code is shown does not block the next one: Pair an iPad shows a new live code', async () => {
    const s = await setup();
    await online(s);
    await s.svc.pairOpen();
    const first = s.svc.view().pairing;
    await s.svc.closePairing();
    expect((await s.svc.pairOpen()).ok).toBe(true);
    await s.svc.refresh();
    const next = s.svc.view().pairing;
    expect(next.phase === 'open' && first.phase === 'open' && next.offer.sessionId !== first.offer.sessionId).toBe(true);
    expect(next.phase === 'open' && next.info?.state).toBe('waiting');
    s.rt.fake.register(s.today.id).simulatePaired();
    await s.svc.refresh();
    expect(s.svc.view().pairing.phase).toBe('paired');
  });
  test('a sheet closed while its code is still being made: the late code is cancelled and the sheet stays closed', async () => {
    const s = await setup();
    const h = await held(s);
    h.hold.pairing = true;
    const asked = h.svc.pairOpen();
    await until(() => h.gates.pairing !== undefined);
    expect(h.svc.view().pairing.phase).toBe('issuing');
    await h.svc.closePairing();
    h.gates.pairing!();
    expect((await asked).ok).toBe(true);
    expect(h.svc.view().pairing.phase).toBe('idle');
    const reg = s.rt.fake.register(s.today.id);
    expect(reg.log.some((l) => l.startsWith('cancel-pairing'))).toBe(true);
    expect(() => reg.simulatePaired()).toThrow();
    // And the next attempt works.
    h.hold.pairing = false;
    expect((await h.svc.pairOpen()).ok).toBe(true);
    expect(h.svc.view().pairing.phase).toBe('open');
  });
  test('a device list read before the code was issued does not mark the new code as expired', async () => {
    const s = await setup();
    const h = await held(s);
    h.hold.devices = true;
    const poll = h.svc.refresh();
    await until(() => h.gates.devices !== undefined);
    h.hold.devices = false;
    expect((await h.svc.pairOpen()).ok).toBe(true);
    h.gates.devices!();
    await poll;
    const st = h.svc.view().pairing;
    expect(st.phase === 'open' && st.gone).toBe(false);
    await h.svc.refresh();
    const after = h.svc.view().pairing;
    expect(after.phase === 'open' && after.info?.state).toBe('waiting');
  });
  test('failed actions and pairing steps go to the log in plain words, never with the code', async () => {
    const s = await setup();
    const lines: string[] = [];
    const h = await held(s, lines);
    expect((await h.svc.pairOpen({ label: 'Door iPad' })).ok).toBe(true);
    const st = h.svc.view().pairing;
    const code = st.phase === 'open' ? st.offer.shortCode : '';
    s.rt.fake.register(s.today.id).simulatePaired();
    await h.svc.refresh();
    s.rt.fake.register(s.today.id).failNext = new OrganiserError('The register did not answer. Check the connection panel, then try again.', 0);
    expect((await h.svc.pairOpen()).ok).toBe(false);
    expect(await h.svc.start()).toEqual({ ok: false, error: 'Check-in is already open.' });
    expect(lines).toContain('Pair an iPad: Door iPad paired.');
    expect(lines.some((l) => l.startsWith('Pair an iPad: a code is shown, valid until '))).toBe(true);
    expect(lines).toContain('Pair an iPad failed: The register did not answer. Check the connection panel, then try again.');
    expect(code).not.toBe('');
    expect(lines.join('\n')).not.toContain(code);
    expect(lines.join('\n')).not.toContain(code.replace('-', ''));
  });
  test('a check-in that cannot start is logged with the reason the window shows', async () => {
    const s = await setup();
    const lines: string[] = [];
    s.svc.dispose();
    const svc = new SessionService({ port: s.rt, organiser: s.rt.fake.organiserFactory, hostName: 'Mac', changed: () => {}, now: () => s.clock.ms, pollMs: 0, log: (l) => lines.push(l) });
    await svc.show(s.today.id);
    const start = s.rt.startSession;
    s.rt.startSession = async () => { throw new Error('The register could not start. Try again.'); };
    expect(await svc.start()).toEqual({ ok: false, error: 'The register could not start. Try again.' });
    s.rt.startSession = start;
    expect(lines).toEqual(['Start check-in failed: The register could not start. Try again.']);
    expect((await svc.pairOpen()).ok).toBe(false);
    expect(lines[1]).toBe('Pair an iPad refused: Pairing needs the connection to be online.');
  });
});

describe('devices', () => {
  async function withDevice(s: Setup): Promise<string> {
    await online(s);
    const reg = s.rt.fake.register(s.today.id);
    await s.svc.pairOpen({ label: 'Door iPad' });
    const d = reg.simulatePaired();
    reg.simulateHeartbeat(d.id, { reportedPending: 3 });
    await s.svc.closePairing();
    await s.svc.refresh();
    return d.id;
  }
  test('rename, and revoke (the row stays, marked revoked)', async () => {
    const s = await setup();
    const id = await withDevice(s);
    expect((await s.svc.rename(id, 'Front desk')).ok).toBe(true);
    expect(s.svc.view().devices!.devices[0]!.label).toBe('Front desk');
    expect((await s.svc.rename(id, 'a@b')).ok).toBe(false);
    expect((await s.svc.revoke(id)).ok).toBe(true);
    expect(s.svc.view().devices!.devices[0]).toMatchObject({ status: 'revoked', reportedPending: 3 });
  });
  test('a check-in that matched nobody is listed and can be dismissed', async () => {
    const s = await setup();
    await withDevice(s);
    s.rt.fake.register(s.today.id).holds.push({ id: 7, opId: 'op-1', deviceId: null, deviceLabel: 'Door iPad', reason: 'unknown_person', recordedAt: null, receivedAt: null });
    await s.svc.refresh();
    expect(s.svc.view().devices!.unmatchedCheckIns).toHaveLength(1);
    expect((await s.svc.dismissHold(7)).ok).toBe(true);
    expect(s.svc.view().devices!.unmatchedCheckIns).toHaveLength(0);
    expect((await s.svc.dismissHold(7)).ok).toBe(false);
  });
  test('after the address changes, the iPad paired earlier needs pairing again; pairing it again clears that', async () => {
    const s = await setup();
    const id = await withDevice(s);
    expect(repairsIn(s.svc.view())).toEqual([]);
    s.clock.ms += 60_000;
    s.rt.fake.changeOrigin();
    await settle();
    await s.svc.refresh();
    const v = s.svc.view();
    expect(v.addressChangedAt).toBe(new Date(s.clock.ms).toISOString());
    expect(repairsIn(v).map((d) => d.id)).toEqual([id]);
    s.clock.ms += 5_000;
    await s.svc.pairOpen({ targetDeviceId: id });
    s.rt.fake.register(s.today.id).simulatePaired();
    await s.svc.refresh();
    expect(repairsIn(s.svc.view())).toEqual([]);
  });
});

describe('ending and reopening check-in', () => {
  test('End check-in closes the address, keeps the register, and shows the closed summary source', async () => {
    const s = await setup();
    await online(s);
    await s.svc.mark('p1', true);
    await s.svc.addPerson({ name: 'Walk In', email: '', markHere: true });
    await s.svc.pairOpen();
    s.clock.ms += 90_000;
    const r = await s.svc.end();
    expect(r).toEqual({ ok: true, value: { leftovers: [] } });
    await settle();
    const v = s.svc.view();
    expect(v).toMatchObject({ phase: 'closed', registerOpen: false, closedAt: new Date(s.clock.ms).toISOString(), pairing: { phase: 'idle' } });
    expect(v.runtime.session).toBe('idle');
    expect(v.roster!.participants.filter((p) => p.present).map((p) => p.name).sort()).toEqual(['Aisha Rahman', 'Walk In']);
    expect((await s.rt.workshops.list()).today[0]!.attended).toBe(2);
    expect((await s.svc.mark('p2', true)).ok).toBe(false);
    expect((await s.svc.end()).ok).toBe(false);
  });
  test('Reopen check-in starts again with a new address, and everything marked before is still there', async () => {
    const s = await setup();
    await online(s);
    await s.svc.mark('p1', true);
    const first = s.svc.view().lastAddress;
    await s.svc.end();
    await settle();
    s.clock.ms += 600_000;
    expect((await s.svc.start()).ok).toBe(true);
    await settle();
    await s.svc.refresh();
    const v = s.svc.view();
    expect(v).toMatchObject({ phase: 'online', closedAt: null });
    expect(v.lastAddress).not.toBe(first);
    expect(v.addressSince).toBe(new Date(s.clock.ms).toISOString());
    expect(v.roster!.participants.find((p) => p.id === 'p1')!.present).toBe(true);
  });
  test('a register ended by the runtime itself (not from here) is picked up as closed', async () => {
    const s = await setup();
    await online(s);
    await s.svc.mark('p2', true);
    await s.rt.endSession();
    await settle();
    expect(s.svc.view()).toMatchObject({ phase: 'closed', registerOpen: false });
    expect(s.svc.view().roster!.participants.find((p) => p.id === 'p2')!.present).toBe(true);
  });
  test('quit asks only while check-in is open', async () => {
    const s = await setup();
    expect(quitPlan(s.rt.status.get())).toBe('quit');
    await online(s);
    expect(quitPlan(s.rt.status.get())).toBe('confirm');
    await s.svc.end();
    expect(quitPlan(s.rt.status.get())).toBe('quit');
  });
});

describe('other workshops', () => {
  test('a past workshop is read-only from the library, with no connection to the register', async () => {
    const s = await setup();
    await s.svc.show(s.past.id);
    expect(s.svc.view()).toMatchObject({ phase: 'past', registerOpen: false, workshopId: s.past.id });
    expect(s.svc.view().roster!.participants).toHaveLength(4);
    expect(s.rt.fake.register(s.past.id).log).toEqual([]);
  });
  test('while one workshop is open for check-in another can be looked at but not started', async () => {
    const s = await setup();
    await online(s);
    await s.svc.show(s.past.id);
    expect(s.svc.view()).toMatchObject({ phase: 'past', otherLive: true, registerOpen: false });
    expect(await s.svc.start()).toEqual({ ok: false, error: "Another workshop's check-in is open. End it first." });
    await s.svc.show(s.today.id);
    expect(s.svc.view()).toMatchObject({ phase: 'online', registerOpen: true, otherLive: false });
  });
  test('leaving the screen keeps check-in running', async () => {
    const s = await setup();
    await online(s);
    await s.svc.leave();
    expect(s.rt.status.get().session).toBe('running');
    expect(s.svc.view().workshopId).toBeNull();
  });
  test('a workshop with no names yet has an empty register, not an error', async () => {
    const s = await setup({ seedNames: false });
    await s.svc.show(s.today.id);
    expect(s.svc.view().roster).toEqual({ participants: [], conflicts: [] });
    expect(s.svc.view().rosterError).toBeNull();
  });
});

describe('quit plan', () => {
  test('every runtime state', () => {
    const base = { workshopId: 'w', service: { state: 'off' as const }, tunnel: { state: 'off' as const } };
    expect(quitPlan({ ...base, session: 'idle' })).toBe('quit');
    for (const session of ['starting', 'running', 'ending'] as const) expect(quitPlan({ ...base, session })).toBe('confirm');
  });
});
