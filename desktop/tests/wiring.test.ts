// Guards for wiring that cannot be seen from one file: the preload channel names, the icon files, update notes loading, the fake runtime.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CH } from '../shared/ipc.ts';
import { icns, ico } from '../scripts/make-icons.ts';
import { AppStateFile } from '../main/app-state.ts';
import { createFakeRuntime } from '../main/fake-runtime.ts';
import { UPDATE_IDENTITY, createUpdateService } from '../main/updates.ts';

const root = resolve(import.meta.dir, '..');
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'aw-wire-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('preload channels', () => {
  const channels = new Set<string>(Object.values(CH));
  for (const file of ['preload/index.ts', 'preload/settings.ts']) {
    test(`${file} uses only channel names that exist in shared/ipc.ts, written inline and not imported`, () => {
      const text = readFileSync(join(root, file), 'utf8');
      const names = [...text.matchAll(/'(attendwell:[a-z-]+)'/g)].map((m) => m[1]!);
      expect(names.length).toBeGreaterThan(5);
      for (const n of names) expect(channels.has(n), n).toBe(true);
      expect(text).not.toMatch(/import \{[^}]*\bCH\b[^}]*\} from/);
    });
  }
  test('every channel is unique', () => expect(channels.size).toBe(Object.keys(CH).length));
});

describe('main process safety', () => {
  const main = readFileSync(join(root, 'main/index.ts'), 'utf8');
  test('windows are sandboxed and context isolated, with no Node in the page', () => {
    expect(main).toContain('sandbox: true');
    expect(main).toContain('contextIsolation: true');
    expect(main).toContain('nodeIntegration: false');
    expect(main).not.toContain('nodeIntegration: true');
  });
  test('single instance lock, mock keychain and hidden test mode are in place', () => {
    expect(main).toContain('requestSingleInstanceLock()');
    expect(main).toContain("appendSwitch('use-mock-keychain')");
    expect(main).toContain("ENV.ATTENDWELL_TEST === '1'");
    // Every test switch is read through the release-safe environment, never straight from process.env.
    expect(main).not.toMatch(/process\.env\.ATTENDWELL_/);
  });
  test('the app id and product name', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { productName: string };
    expect(pkg.productName).toBe('AttendWell');
    expect(readFileSync(join(root, 'electron-builder.yml'), 'utf8')).toContain('appId: net.dominiklukes.attendwell');
  });
});

describe('icon containers', () => {
  test('icns and ico headers and lengths are consistent', () => {
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const a = icns([{ type: 'ic07', png }, { type: 'ic08', png }]);
    expect(a.subarray(0, 4).toString('ascii')).toBe('icns');
    expect(a.readUInt32BE(4)).toBe(a.length);
    expect(a.subarray(8, 12).toString('ascii')).toBe('ic07');
    expect(a.readUInt32BE(12)).toBe(8 + png.length);
    const i = ico([{ size: 16, png }, { size: 256, png }]);
    expect(i.readUInt16LE(2)).toBe(1);
    expect(i.readUInt16LE(4)).toBe(2);
    expect(i.readUInt8(6)).toBe(16);
    expect(i.readUInt8(22)).toBe(0);
    expect(i.readUInt32LE(18)).toBe(6 + 32);
    expect(i.length).toBe(6 + 32 + 2 * png.length);
  });
  test('the generated set is in desktop/build', () => {
    for (const f of ['icon.icns', 'icon.ico', 'icon.png', 'icons/256x256.png']) expect(readFileSync(join(root, 'build', f)).length).toBeGreaterThan(500);
  });
});

describe('update service', () => {
  const make = (over: { packaged?: boolean; busy?: boolean; notes?: Record<string, string>; fetch?: () => Promise<{ ok: true; text: string } | { ok: false; reason: 'unreachable' }> } = {}) => {
    const dir = tmp();
    const notesDir = join(dir, 'notes');
    mkdirSync(notesDir);
    for (const [v, t] of Object.entries(over.notes ?? {})) writeFileSync(join(notesDir, `${v}.md`), t);
    let requests = 0;
    const state = new AppStateFile(dir);
    const service = createUpdateService({
      running: '1.0.0', platform: 'darwin', packaged: over.packaged ?? true, state, enabled: () => true, isBusy: () => over.busy ?? false, notesDir,
      fetchFeed: async () => { requests += 1; return (over.fetch ?? (async () => ({ ok: false as const, reason: 'unreachable' as const })))(); }, changed: () => undefined,
    });
    return { service, state, requests: () => requests };
  };
  const feed = JSON.stringify({ schema: 1, latest: { version: '1.1.0', released: '2026-10-30', summary: ['One change.'], notes: 'https://techczech.github.io/attendwell/whats-new#1.1.0', download: { mac: 'https://techczech.github.io/attendwell/download#mac', windows: 'https://techczech.github.io/attendwell/download#windows' } } });

  test('the feed address is the placeholder on techczech.github.io', () => expect(UPDATE_IDENTITY.feedUrl).toBe('https://techczech.github.io/attendwell/updates.json'));
  test('a development run never asks the network, not even for Check for Updates', async () => {
    const t = make({ packaged: false });
    t.service.checker.start();
    await t.service.checker.checkNow();
    expect(t.requests()).toBe(0);
    expect(t.service.checker.snapshot().source).toBe('development');
  });
  test('Check for Updates in a packaged copy makes one request and shows the mark for a newer version', async () => {
    const t = make({ fetch: async () => ({ ok: true, text: feed }) });
    const snap = await t.service.checker.checkNow();
    expect(t.requests()).toBe(1);
    expect(snap.mark?.version).toBe('1.1.0');
  });
  test('while a session is live the check waits, sends nothing and shows no mark', async () => {
    const t = make({ busy: true, fetch: async () => ({ ok: true, text: feed }) });
    const snap = await t.service.checker.checkNow();
    expect(t.requests()).toBe(0);
    expect(snap.busy).toBe(true);
    expect(snap.mark).toBeNull();
    t.service.checker.stop();
  });
  test('notes load from the shipped file, and a version that is not a version is never read as a path', () => {
    const t = make({ notes: { '1.0.0': '- **Library.** All workshops are folders.\n- Plain line.' } });
    expect(t.service.loadNotes('1.0.0')).toEqual([{ title: 'Library', text: 'All workshops are folders.' }, { title: null, text: 'Plain line.' }]);
    expect(t.service.loadNotes('../../etc/passwd')).toBeNull();
    expect(t.service.loadNotes('2.0.0')).toBeNull();
    expect(t.service.loadNotes('1.0.0-alpha.1')).toEqual(t.service.loadNotes('1.0.0'));
  });
  test('the notes file for 1.0.0 ships with the app', () => {
    const text = readFileSync(join(root, 'resources/whats-new/1.0.0.md'), 'utf8');
    expect(text).toContain('Workshops library');
  });
});

describe('fake runtime', () => {
  test('keeps workshops in folders, reloads them, and archives without deleting', async () => {
    const dir = tmp();
    const a = createFakeRuntime({ dataRoot: dir, now: () => new Date(2026, 9, 30) });
    const w = await a.workshops.create({ title: 'One', date: '2026-10-30' });
    await a.workshops.create({ title: 'One', date: '2026-10-30' });
    expect((await a.workshops.list()).today.map((x) => x.id)).toEqual(['2026-10-30-one', '2026-10-30-one-2']);
    await a.workshops.setArchived(w.id, true);
    const b = createFakeRuntime({ dataRoot: dir, now: () => new Date(2026, 9, 30) });
    expect((await b.workshops.list()).today.map((x) => x.id)).toEqual(['2026-10-30-one-2']);
    expect((await b.workshops.list({ includeArchived: true })).archived).toHaveLength(1);
    expect(b.status.get()).toMatchObject({ session: 'idle', tunnel: { state: 'off' } });
  });
  test('answers Test connection from what it is given', async () => {
    const r = createFakeRuntime({ dataRoot: tmp(), connectionTest: { ok: false, reason: 'blocked', advice: 'Try a hotspot.' } });
    expect(await r.testConnection!()).toEqual({ ok: false, reason: 'blocked', advice: 'Try a hotspot.' });
  });
  test('writes nothing until a workshop is created', () => {
    const dir = join(tmp(), 'never-made');
    createFakeRuntime({ dataRoot: dir });
    expect(() => readFileSync(dir)).toThrow();
  });
});
