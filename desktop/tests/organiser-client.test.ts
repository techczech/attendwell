// The organiser client against the real register service (its own handler, in memory, on a fake clock; no port is opened): the shapes the
// window depends on are the shapes the service really sends, and the client sends what the service accepts.
import { describe, expect, test } from 'bun:test';
import { createHttpOrganiser, loopbackOrigin, OrganiserError } from '../main/organiser-client.ts';
import { organiserOrigin, participantOrigin, setup } from '../../tests/device-helpers.ts';
import { buildRegister } from '../shared/register-model.ts';
import { IDLE, pairingView, reduce } from '../shared/pairing-model.ts';
import { deviceRow } from '../shared/devices-model.ts';

function rig(opts: Parameters<typeof setup>[0] = {}) {
  const s = setup(opts);
  const calls: Array<{ method: string; path: string; origin: string | null; marker: string | null }> = [];
  const viaHandler = (async (url: string, init?: RequestInit) => {
    const req = new Request(url, init);
    calls.push({ method: req.method, path: new URL(url).pathname, origin: req.headers.get('Origin'), marker: req.headers.get('X-Attendance-Request') });
    return s.organiser(req);
  }) as unknown as typeof fetch;
  return { s, calls, client: createHttpOrganiser(organiserOrigin, viaHandler) };
}

describe('the roster and the register', () => {
  test('reads names, versions and held check-ins as the window needs them', async () => {
    const { client } = rig();
    const r = await client.roster();
    expect(r.participants.map((p) => p.name)).toContain('Alex Example');
    expect(r.participants[0]).toMatchObject({ present: false, version: 0, booking: 'confirmed' });
    expect(buildRegister(r, { filter: 'all', sort: 'name', query: '', readOnly: false }).counts.here).toBe(0);
  });
  test('marks present with the version, undoes, and sends the headers the service demands', async () => {
    const { client, calls } = rig();
    const a = (await client.roster()).participants.find((p) => p.id === 'a')!;
    const after = await client.setAttendance('a', true, a.version);
    expect(after.participants.find((p) => p.id === 'a')).toMatchObject({ present: true, version: 1 });
    const undone = await client.setAttendance('a', false, 1);
    expect(undone.participants.find((p) => p.id === 'a')!.present).toBe(false);
    for (const c of calls.filter((x) => x.method !== 'GET')) expect(c).toMatchObject({ origin: organiserOrigin, marker: '1' });
  });
  test('a stale version is refused with the service\'s own words', async () => {
    const { client } = rig();
    await client.setAttendance('a', true, 0);
    const err = await client.setAttendance('a', false, 0).catch((e) => e as OrganiserError);
    expect(err).toBeInstanceOf(OrganiserError);
    expect((err as OrganiserError).status).toBe(409);
    expect((err as OrganiserError).message).toContain('Refresh and try again');
  });
  test('a walk-in is added without an email, shows as manual, and the same name twice is refused', async () => {
    const { client } = rig();
    const r = await client.addParticipant('Tomasz Kowalski', '');
    const t = r.participants.find((p) => p.name === 'Tomasz Kowalski')!;
    expect(t.id.startsWith('manual-')).toBe(true);
    expect(buildRegister(r, { filter: 'all', sort: 'name', query: 'tomasz', readOnly: false }).rows[0]).toMatchObject({ walkIn: true, email: null });
    await expect(client.addParticipant('tomasz kowalski', '')).rejects.toThrow('already in the register');
    await expect(client.addParticipant('Bad Email', 'nope')).rejects.toThrow('email');
  });
});

describe('pairing and devices', () => {
  test('a code comes with the QR address in the agreed shape, and the window state machine follows the service to paired', async () => {
    const { s, client } = rig();
    const offer = await client.createPairing({ label: 'Door iPad' });
    expect(offer.shortCode).toMatch(/^[A-HJKMNP-TV-Z2-9]{4}-[A-HJKMNP-TV-Z2-9]{4}$/);
    expect(offer.qrPayload).toBe(`${participantOrigin}/pair#v=1&code=${offer.shortCode}`);
    expect(offer).toMatchObject({ label: 'Door iPad', targetDeviceId: null, baseUrl: participantOrigin });
    let st = reduce(reduce(IDLE, { type: 'request', label: 'Door iPad', targetDeviceId: null }), { type: 'issued', offer, now: s.clock.t });
    expect(pairingView(st, s.clock.t)).toMatchObject({ kind: 'waiting', countdown: '5:00' });
    const list = await client.devices();
    expect(list.pairing).toMatchObject({ state: 'waiting', wrongAttempts: 0 });
    // The iPad pairs through the participant listener, exactly as the app does.
    const credential = 'dc_' + 'x'.repeat(43);
    const hash = (await import('node:crypto')).createHash('sha256').update(credential).digest('hex');
    s.clock.t += 15_000;
    expect((await s.dev('pair', { body: { code: offer.shortCode.replace('-', ''), credentialHash: hash } })).status).toBe(201);
    st = reduce(st, { type: 'poll', list: await client.devices(), now: s.clock.t });
    expect(pairingView(st, s.clock.t)).toMatchObject({ kind: 'paired', device: { label: 'Door iPad' } });
  });
  test('five wrong codes pause the pairing and the list says so; the countdown then ends in expiry', async () => {
    const { s, client } = rig();
    const offer = await client.createPairing({});
    expect(offer.label).toBe('iPad 1');
    for (let i = 0; i < 5; i += 1) expect((await s.dev('hello', { body: { code: 'ZZZZ2222' } })).status).toBe(401);
    const list = await client.devices();
    expect(list.pairing).toMatchObject({ state: 'paused', wrongAttempts: 5 });
    const st = reduce(reduce(reduce(IDLE, { type: 'request', label: '', targetDeviceId: null }), { type: 'issued', offer, now: s.clock.t }), { type: 'poll', list, now: s.clock.t });
    expect(pairingView(st, s.clock.t)).toMatchObject({ kind: 'paused', wrongAttempts: 5 });
    s.clock.t += 301_000;
    expect(pairingView(st, s.clock.t)!.kind).toBe('expired');
  });
  test('cancelling the open code, renaming, Pair again for one row, and revoking', async () => {
    const { s, client } = rig();
    const { deviceId } = await s.pairDevice({ label: 'Door iPad' });
    s.clock.t += 20_000;
    let list = await client.renameDevice(deviceId, 'Front desk');
    expect(list.devices[0]).toMatchObject({ id: deviceId, label: 'Front desk', status: 'active' });
    const again = await client.createPairing({ targetDeviceId: deviceId });
    expect(again).toMatchObject({ targetDeviceId: deviceId, label: 'Front desk' });
    await client.cancelPairing(again.sessionId);
    expect((await client.devices()).pairing).toBeNull();
    list = await client.revokeDevice(deviceId);
    expect(list.devices[0]).toMatchObject({ status: 'revoked' });
    expect(deviceRow(list.devices[0]!, { now: s.clock.t, live: true, closedAt: null, repair: new Set() })).toMatchObject({ tone: 'bad', revoked: true });
    await expect(client.renameDevice('dev_nope', 'X')).rejects.toBeInstanceOf(OrganiserError);
  });
  test('an unmatched check-in is listed and dismissed', async () => {
    const { s, client } = rig();
    const { credential } = await s.pairDevice({});
    await s.send(credential, s.op('pt_' + 'f'.repeat(24), 0));
    const list = await client.devices();
    expect(list.unmatchedCheckIns).toHaveLength(1);
    const after = await client.dismissHold(list.unmatchedCheckIns[0]!.id);
    expect(after.unmatchedCheckIns).toHaveLength(0);
    await expect(client.dismissHold(list.unmatchedCheckIns[0]!.id)).rejects.toThrow('already cleared');
  });
  test('pairing with the participant link off is a plain refusal', async () => {
    const { client } = rig({ participantLink: false });
    await expect(client.createPairing({})).rejects.toThrow('participant link');
  });
});

describe('name lists and recovery files', () => {
  test('a name list is previewed without writing, then added; the roster comes back in the window\'s shape', async () => {
    const { s, client, calls } = rig();
    const input = { source: { kind: 'paste' as const }, rows: [{ row: 1, name: 'Imogen Pryce', email: 'Imogen.Pryce@example.ac.uk' }, { row: 2, name: 'Bea Again', email: 'BEA@example.org' }] };
    const preview = await client.addNames(input, true);
    expect(preview).toMatchObject({ written: false, plan: { counts: { added: 1, known: 1 } } });
    expect(s.store.list().participants.some((p) => p.name === 'Imogen Pryce')).toBe(false);
    const done = await client.addNames(input, false);
    expect(done.written).toBe(true);
    expect(done.roster.participants.find((p) => p.name === 'Imogen Pryce')).toMatchObject({ email: 'imogen.pryce@example.ac.uk', present: false, version: 0 });
    await expect(client.addNames(input, false)).rejects.toThrow('already added');
    for (const c of calls.filter((x) => x.path === '/api/names')) expect(c).toMatchObject({ method: 'POST', origin: organiserOrigin, marker: '1' });
  });
  test('a recovery file is previewed and imported through the device path', async () => {
    const { s, client } = rig();
    const { credential, deviceId } = await s.pairDevice({ label: 'Door iPad' });
    const snap = await s.roster(credential);
    const bea = snap.people.find((p: { displayName: string }) => p.displayName === 'Bea Example');
    const file = { format: 'attendance-recovery', version: 1, eventId: snap.eventId, eventCode: snap.eventCode, deviceId, exportedAt: new Date(s.clock.t).toISOString(),
      operations: [{ opId: crypto.randomUUID(), personToken: bea.personToken, displayName: 'Bea Example', baseRevision: bea.revision, windowRevisionSeen: 1, recordedAt: new Date(s.clock.t).toISOString() }] };
    expect(await client.importRecovery(file, true)).toMatchObject({ written: false, deviceLabel: 'Door iPad', counts: { recorded: 1 } });
    expect(await client.importRecovery(file, false)).toMatchObject({ written: true, counts: { recorded: 1 } });
    expect((await client.roster()).participants.find((p) => p.name === 'Bea Example')!.present).toBe(true);
    await expect(client.importRecovery({ ...file, eventId: 'evt_elsewhere' }, true)).rejects.toThrow('another workshop');
  });
});

describe('only this computer is ever called', () => {
  test('addresses that are not plain loopback http are refused before any request', () => {
    expect(loopbackOrigin('http://127.0.0.1:5123')).toBe('http://127.0.0.1:5123');
    for (const bad of ['https://127.0.0.1:5123', 'http://example.com:80', 'http://192.168.1.4:5123', 'http://127.0.0.1', 'http://u:p@127.0.0.1:5123', 'http://127.0.0.1:5123/api', 'nonsense', '']) {
      expect(() => loopbackOrigin(bad), bad).toThrow(OrganiserError);
    }
  });
  test('a register that does not answer is a plain sentence, not a stack trace', async () => {
    const dead = (async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:1'); }) as unknown as typeof fetch;
    await expect(createHttpOrganiser('http://127.0.0.1:1', dead).roster()).rejects.toThrow('did not answer');
  });
});

describe('the organiser key', () => {
  test('sent as a bearer on every call, looked up each time; no key means no request; a wrong key is refused by the service', async () => {
    const { randomBytes } = await import('node:crypto');
    const { AttendanceStore } = await import('../../server/store-attendance.ts');
    const { createHandler } = await import('../../server/http-attendance.ts');
    const { fixture } = await import('../../tests/fixtures-attendance.ts');
    const store = new AttendanceStore(':memory:'); store.import(fixture, 'test');
    let key: string | null = randomBytes(32).toString('base64url');
    const real = key;
    const handler = createHandler(store, { origin: organiserOrigin, users: {}, localAdmin: true, organiserBearer: real }, '/tmp/missing-assets');
    const seen: Array<string | null> = [];
    const via = (async (url: string, init?: RequestInit) => { const r = new Request(url, init); seen.push(r.headers.get('Authorization')); return handler(r); }) as unknown as typeof fetch;
    const client = createHttpOrganiser(organiserOrigin, via, 8000, () => key);
    expect((await client.roster()).participants.length).toBeGreaterThan(0);
    expect(seen).toEqual([`Bearer ${real}`]);
    key = null;
    await expect(client.roster()).rejects.toThrow('not running');
    expect(seen).toHaveLength(1);
    key = randomBytes(32).toString('base64url');
    const refused = await client.roster().then(() => null, (e: OrganiserError) => e);
    expect(refused?.status).toBe(401);
    expect(String(refused?.message)).not.toContain(key);
    // Without the key the same service refuses the client that does not send one.
    await expect(createHttpOrganiser(organiserOrigin, via).roster()).rejects.toMatchObject({ status: 401 });
    store.close();
  });
});
