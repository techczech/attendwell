// The real runtime behind the app's RuntimePort (main/real-runtime.ts), on the runtime's fake process host: no process, port to the
// outside or window. The shapes the app depends on, leases, the organiser key handed to the client, and the read-only register.
import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRuntime } from '../runtime/index.ts';
import { resourcePaths } from '../runtime/platform.ts';
import { createRealRuntime, toAppSnapshot } from '../main/real-runtime.ts';
import { readRegisterFile, type ReadOnlyOpener } from '../main/register-reader.ts';
import { createRuntimeBundle, usesRealRuntime } from '../main/runtime-factory.ts';
import { fakeHost, until, secretsOf, simulatedAcl, SIM_KEY, SIM_WINDOWS } from './fakes.ts';
import { pathToFileURL } from 'node:url';
import { AttendanceStore } from '../../server/store-attendance.ts';
import { fixture } from '../../tests/fixtures-attendance.ts';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const URL_A = 'https://gentle-example-river-test.trycloudflare.com';

// bun:sqlite stands in for node:sqlite under the test runner (Bun has no node:sqlite); the real opener is checked under Node below.
const bunOpener: ReadOnlyOpener = (file) => {
  const db = new Database(file, { readonly: true });
  return { all: (sql) => db.query(sql).all() as Array<Record<string, unknown>>, close: () => db.close() };
};

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'aw-real-')); dirs.push(root);
  const resourcesRoot = path.join(root, 'resources');
  const res = resourcePaths(resourcesRoot, SIM_KEY);
  for (const f of [res.sidecar, res.cloudflared]) { mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, ''); }
  const host = fakeHost((c) => {
    if (c.req.command === res.cloudflared) setImmediate(() => { c.err(`INF |  ${URL_A}   |`); c.err('INF Registered tunnel connection connIndex=0 event=0 ip=198.41.200.33 location=lhr01 protocol=quic'); });
  });
  const sidecars = () => host.children.filter((c) => c.req.command === res.sidecar);
  const seen: Array<{ url: string; auth: string | null }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    seen.push({ url, auth: new Headers(init?.headers).get('Authorization') });
    return Response.json({ participants: [], conflicts: [] });
  }) as unknown as typeof fetch;
  const rt = createRealRuntime({
    dataRoot: path.join(root, 'data'), resourcesRoot, openDb: bunOpener, fetchImpl,
    create: (o) => createRuntime({ ...o, host, sidecar: res.sidecar, cloudflared: res.cloudflared, assets: res.assets, ...simulatedAcl(), countAttended: () => 0, serviceProbe: async () => { const c = sidecars().at(-1); return !!c && !c.done; }, serviceBackoffMs: [5], tunnelBackoffMs: [5] }),
  });
  return { root, rt, sidecars, seen, host };
}

test('workshops: create, list with the name count from provenance, archive; the folder is <dataRoot>/workshops/<id>', async () => {
  const { rt, root } = setup();
  const w = await rt.workshops.create({ title: '  Fictional Lab ', date: '2031-03-04', startTime: '14:00', endTime: '' });
  expect(w).toMatchObject({ title: 'Fictional Lab', date: '2031-03-04', startTime: '14:00', when: 'upcoming', archived: false, names: null });
  await expect(rt.workshops.create({ title: '  ', date: '2031-03-04' })).rejects.toThrow('title');
  await rt.recordRosterProvenance(w.id, { kind: 'paste', filename: null, sha256: null, importedAt: '2031-03-01T10:00:00Z', count: 3 });
  expect((await rt.workshops.list()).upcoming.map((x) => [x.id, x.names])).toEqual([[w.id, 3]]);
  expect(rt.workshopFolder(w.id)).toBe(path.join(root, 'data', 'workshops', w.id));
  expect(readdirSync(rt.workshopFolder(w.id))).toContain('roster-provenance.json');
  await rt.workshops.setArchived(w.id, true);
  expect((await rt.workshops.list()).upcoming).toHaveLength(0);
  expect((await rt.workshops.list()).archived).toHaveLength(0);
  expect((await rt.workshops.list({ includeArchived: true })).archived.map((x) => x.id)).toEqual([w.id]);
  await rt.shutdown();
});

test('a session in the app\'s shapes; the organiser client carries the running register\'s key, and nothing else ever sees it', async () => {
  const { rt, sidecars, seen } = setup();
  const w = await rt.workshops.create({ title: 'Fictional Lab', date: '2031-03-04' });
  const changes: unknown[] = [];
  rt.status.onChange((s) => changes.push(s));
  await rt.openWorkshop(w.id);
  const snap = await rt.startSession();
  expect(snap).toMatchObject({ workshopId: w.id, session: 'running', tunnel: { state: 'online', url: URL_A }, service: { state: 'running', participantPort: SIM_WINDOWS ? expect.any(Number) : 0, participantOrigin: URL_A } }); // macOS: a socket, no port
  expect(Object.keys(snap)).toEqual(['workshopId', 'session', 'service', 'tunnel']);
  const key = secretsOf(sidecars()[0]!).organiserToken;
  expect(JSON.stringify(sidecars()[0]!.req.env)).not.toContain(key);
  expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const url = (snap.service as { organiserUrl: string }).organiserUrl;
  await rt.organiserFactory(url).roster();
  expect(seen).toEqual([{ url: `${url}/api/roster`, auth: `Bearer ${key}` }]);
  expect(JSON.stringify([snap, changes, rt.status.get()])).not.toContain(key);
  // Another address gets no key, so no request is made.
  await expect(rt.organiserFactory('http://127.0.0.1:1').roster()).rejects.toThrow('not running');
  expect(seen).toHaveLength(1);
  await expect(rt.setDataRoot(path.join(path.dirname(rt.dataRoot()), 'elsewhere'))).rejects.toThrow('End check-in');
  expect(await rt.endSession()).toEqual({ clean: true, leftovers: [] });
  await expect(rt.organiserFactory(url).roster()).rejects.toThrow('not running');
  expect(rt.childPids()).toEqual({ service: null, tunnel: null, lease: null });
  await rt.shutdown();
  expect(rt.lastShutdown()).toEqual([]);
});

test('leases: loopback only, released once, replaced by the live register while check-in runs, stopped before check-in on the same workshop', async () => {
  const { rt, sidecars } = setup();
  const w = await rt.workshops.create({ title: 'Fictional Lab', date: '2031-03-04' });
  const lease = await rt.openRegister(w.id);
  expect(lease.organiserUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  expect(sidecars()[0]!.req.env.ATTENDANCE_PARTICIPANT_ORIGIN).toBeUndefined();
  expect(rt.status.get().session).toBe('idle');
  await rt.openWorkshop(w.id);
  await rt.startSession();
  expect(sidecars()[0]!.done).toBe(true);
  await lease.release(); // already stopped by the start: nothing happens
  const live = await rt.openRegister(w.id);
  expect(live.organiserUrl).toBe((rt.status.get().service as { organiserUrl: string }).organiserUrl);
  await live.release();
  expect(rt.status.get().service.state).toBe('running');
  await rt.endSession();
  const again = await rt.openRegister(w.id);
  const leased = sidecars().at(-1)!;
  await again.release();
  await again.release();
  expect(leased.done).toBe(true);
  expect(rt.childPids().lease).toBeNull();
  await rt.shutdown();
});

test('moving the library shuts the old runtime down and keeps the window\'s listeners', async () => {
  const { rt, root } = setup();
  const seen: string[] = [];
  rt.status.onChange((s) => seen.push(s.session));
  await rt.workshops.create({ title: 'Fictional Lab', date: '2031-03-04' });
  await rt.setDataRoot(path.join(root, 'moved'));
  expect(rt.dataRoot()).toBe(path.join(root, 'moved'));
  expect((await rt.workshops.list()).upcoming).toHaveLength(0);
  const w = await rt.workshops.create({ title: 'Second Lab', date: '2031-03-05' });
  await rt.openWorkshop(w.id);
  await rt.startSession();
  await until(() => seen.includes('running'));
  await rt.shutdown();
});

test('snapshot mapping: failure details stay in the main process; the Windows participant port is reported', () => {
  const s = toAppSnapshot({ workshopId: 'w', session: 'running', orphans: ['x'], tunnel: { state: 'reconnecting', attempt: 2, url: null },
    service: { state: 'failed', reason: 'will-not-start', message: 'The register would not start for this workshop.', detail: 'stack line /private/path' } });
  expect(s).toEqual({ workshopId: 'w', session: 'running', tunnel: { state: 'reconnecting', attempt: 2, url: null }, service: { state: 'failed', reason: 'will-not-start', message: 'The register would not start for this workshop.' } });
  expect(toAppSnapshot({ workshopId: null, session: 'running', orphans: [], tunnel: { state: 'off' }, service: { state: 'running', organiserUrl: 'http://127.0.0.1:5', participant: { port: 7, fingerprint: 'ab' }, participantOrigin: null } }).service)
    .toEqual({ state: 'running', organiserUrl: 'http://127.0.0.1:5', participantPort: 7, participantOrigin: null });
});

test('the factory: the real runtime outside test mode; the fake in test mode unless ATTENDWELL_RUNTIME=real', async () => {
  expect(usesRealRuntime({})).toBe(true);
  expect(usesRealRuntime({ ATTENDWELL_TEST: '1' })).toBe(false);
  expect(usesRealRuntime({ ATTENDWELL_TEST: '1', ATTENDWELL_RUNTIME: 'real' })).toBe(true);
  const root = mkdtempSync(path.join(tmpdir(), 'aw-factory-')); dirs.push(root);
  const fake = createRuntimeBundle({ dataRoot: root, env: { ATTENDWELL_TEST: '1' } });
  expect(fake.fake).toBeDefined();
  expect(() => createRuntimeBundle({ dataRoot: root, env: {} })).toThrow('resources');
  const real = createRuntimeBundle({ dataRoot: path.join(root, 'data'), resourcesRoot: path.join(root, 'resources'), env: {} });
  expect(real.fake).toBeUndefined();
  expect(real.real?.childPids()).toEqual({ service: null, tunnel: null, lease: null });
  await real.port.shutdown();
});

// ---- the register, read with the service stopped -------------------------------------------------------------------------------

function register(dir: string): string {
  const file = path.join(dir, 'attendance.sqlite');
  const store = new AttendanceStore(file);
  store.import(fixture, 'test');
  store.setAttendance('a', true, 0, 'test');
  store.db.query("INSERT INTO operations(opId,kind,participantId,actor,outcome,reason,queuedAt,receivedAt) VALUES('op-1','check-in','b','device','conflict','changed','2030-01-15T12:00:00Z','2030-01-15T12:00:05Z')").run();
  store.close();
  return file;
}

test('readRegister: people on the active list and open held check-ins, as the window needs them; null with no register', async () => {
  const { rt } = setup();
  const w = await rt.workshops.create({ title: 'Fictional Lab', date: '2031-03-04' });
  expect(await rt.readRegister(w.id)).toBeNull();
  const dir = mkdtempSync(path.join(tmpdir(), 'aw-reg-')); dirs.push(dir);
  const r = readRegisterFile(register(dir), bunOpener)!;
  expect(r.participants.find((p) => p.id === 'a')).toMatchObject({ name: 'Alex Example', present: true, version: 1, booking: 'confirmed', admitted: false });
  expect(r.conflicts).toEqual([{ participantId: 'b', name: 'Bea Example', reason: 'changed', queuedAt: '2030-01-15T12:00:00Z', receivedAt: '2030-01-15T12:00:05Z', count: 1 }]);
  await expect(rt.readRegister('no-such-workshop')).rejects.toThrow();
  await rt.shutdown();
});

// node:sqlite is what Electron uses; Bun has none, so this part runs under Node. It checks that a read creates no file at all when
// the register has no side files (immutable open), and that with side files present recent changes in the write-ahead log are seen.
test('readRegister under Node: never creates the register or a side file; sees what is still in the write-ahead log', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'aw-reg-node-')); dirs.push(dir);
  const file = register(dir);
  for (const f of [`${file}-wal`, `${file}-shm`]) rmSync(f, { force: true });
  const reader = path.resolve(import.meta.dir, '../main/register-reader.ts');
  const run = (target: string) => spawnSync('node', ['--no-warnings', '--input-type=module', '-e',
    `const m=await import(${JSON.stringify(pathToFileURL(reader).href)});const r=m.readRegisterFile(${JSON.stringify(target)});console.log(JSON.stringify(r===null?null:{n:r.participants.length,here:r.participants.filter(p=>p.present).map(p=>p.id),held:r.conflicts.length}))`], { encoding: 'utf8' });
  const before = readdirSync(dir).sort();
  const a = run(file);
  expect(a.stderr).toBe('');
  expect(JSON.parse(a.stdout)).toEqual({ n: 6, here: ['a'], held: 1 });
  expect(readdirSync(dir).sort()).toEqual(before);
  // No register: null, and nothing is created.
  const b = run(path.join(dir, 'missing.sqlite'));
  expect(JSON.parse(b.stdout)).toBeNull();
  expect(readdirSync(dir).sort()).toEqual(before);
  // A service still running on it: the change sits in the write-ahead log, and the read sees it.
  const live = new Database(file);
  live.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
  live.query("UPDATE people SET present=1 WHERE id='b'").run();
  const c = run(file);
  live.close();
  expect(JSON.parse(c.stdout)).toEqual({ n: 6, here: ['a', 'b'], held: 1 });
}, 20000);
