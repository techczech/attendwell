// "Tests every app carries" 5: every settings key appears in the window's schema, is found by search, resets to its default and writes a
// changelog entry. The Changes page's per-entry Reset is the store's resetEntry.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changeCounts, historyOf, searchSettings, valueOf, type SettingValue } from '@app-patterns/settings';
import { openSettings, windowsTolerantFolderSync } from '../main/settings.ts';
import { registry } from '../shared/commands.ts';
import { DEFAULT_REGISTERS_FOLDER, ROW_HINTS, SETTING_KEYS, schema } from '../shared/settings-schema.ts';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { settingsWriteTest } from './fakes.ts';

const dirs: string[] = [];
const open = async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aw-settings-'));
  dirs.push(dir);
  const s = openSettings({ dir, appVersion: '1.0.0', watch: false });
  await s.ready;
  return s;
};
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const OTHER: Record<string, SettingValue> = {
  [SETTING_KEYS.openLast]: true, [SETTING_KEYS.getStartedHidden]: true, [SETTING_KEYS.checkForUpdates]: false,
  [SETTING_KEYS.textSize]: 'large', [SETTING_KEYS.registersFolder]: '~/Documents/Elsewhere',
};

describe('every settings key', () => {
  test('is in a section the window shows, and has a value other than its default to test with', () => {
    const sections = new Set(schema.sections.filter((s) => !s.pinned).map((s) => s.id));
    for (const d of schema.settings) {
      expect(sections.has(d.section), d.key).toBe(true);
      expect(OTHER[d.key], d.key).toBeDefined();
      expect(OTHER[d.key]).not.toEqual(d.default);
    }
    expect(Object.keys(OTHER).sort()).toEqual(schema.settings.map((d) => d.key).sort());
  });
  test('is found by searching its label', () => {
    for (const d of schema.settings) {
      const hits = searchSettings(schema.settings, schema.sections, d.label);
      expect(hits.some((h) => h.key === d.key), d.key).toBe(true);
    }
  });
  test('has a row hint where the window reads one', () => {
    for (const k of Object.keys(ROW_HINTS)) expect(schema.def(k), k).toBeDefined();
  });
  settingsWriteTest('changes, logs one entry for You, and resets to its default with another entry', async () => {
    const s = await open();
    for (const d of schema.settings) {
      const before = s.state().changes.length;
      expect((await s.set(d.key, OTHER[d.key]!)).ok, d.key).toBe(true);
      expect(valueOf(s.state(), schema, d.key)).toEqual(OTHER[d.key]!);
      const entry = historyOf(s.state(), d.key)[0]!;
      expect(entry.who).toEqual({ kind: 'you' });
      expect(s.state().changes.length).toBe(before + 1);
      expect((await s.store.reset(d.key)).ok, d.key).toBe(true);
      expect(valueOf(s.state(), schema, d.key)).toEqual(d.default);
      expect(s.state().changes.length).toBe(before + 2);
    }
  });
  settingsWriteTest('setting the value it already has logs nothing', async () => {
    const s = await open();
    await s.set(SETTING_KEYS.textSize, 'normal');
    expect(s.state().changes).toHaveLength(0);
  });
  test('a value outside its choices is refused', async () => {
    const s = await open();
    expect((await s.set(SETTING_KEYS.textSize, 'huge')).ok).toBe(false);
  });
});

describe('changelog (Changes page)', () => {
  settingsWriteTest('newest first, counted by who, and Reset on an entry restores the value before it', async () => {
    const s = await open();
    await s.set(SETTING_KEYS.textSize, 'large');
    await s.set(SETTING_KEYS.textSize, 'extra-large');
    await s.set(SETTING_KEYS.openLast, true);
    const [newest, middle, oldest] = s.state().changes;
    expect([newest!.key, middle!.to, oldest!.to]).toEqual([SETTING_KEYS.openLast, 'extra-large', 'large']);
    expect(changeCounts(s.state())).toMatchObject({ all: 3, you: 3, agent: 0 });
    const r = await s.store.resetEntry(middle!.id);
    expect(r.ok).toBe(true);
    expect(valueOf(s.state(), schema, SETTING_KEYS.textSize)).toBe('large');
    const reset = s.state().changes[0]!;
    expect(reset.who).toMatchObject({ kind: 'reset', of: middle!.id });
    expect(reset.to).toBe('large');
  });
  settingsWriteTest('a shortcut change is an entry too, and Reset puts the default chord back', async () => {
    const s = await open();
    expect((await s.store.rebind('person.add', '⌘⇧M')).ok).toBe(true);
    expect(s.bindings()['person.add']).toBe('⌘⇧M');
    const entry = historyOf(s.state(), { commandId: 'person.add' })[0]!;
    expect([entry.from, entry.to]).toEqual(['⌘⌥N', '⌘⇧M']);
    expect((await s.store.resetEntry(entry.id)).ok).toBe(true);
    expect(s.bindings()['person.add']).toBe('⌘⌥N');
  });
  test('a fixed estate chord cannot be rebound, and a taken chord is refused', async () => {
    const s = await open();
    expect((await s.store.rebind('app.palette', '⌘⇧M')).ok).toBe(false);
    expect((await s.store.rebind('review.email', '⌘N')).ok).toBe(false);
  });
  settingsWriteTest('changes survive a restart (the file is the state)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aw-settings-'));
    dirs.push(dir);
    const a = openSettings({ dir, appVersion: '1.0.0', watch: false });
    await a.ready;
    await a.set(SETTING_KEYS.registersFolder, DEFAULT_REGISTERS_FOLDER + '2');
    const b = openSettings({ dir, appVersion: '1.0.0', watch: false });
    await b.ready;
    expect(b.get(SETTING_KEYS.registersFolder)).toBe(DEFAULT_REGISTERS_FOLDER + '2');
    expect(b.state().changes).toHaveLength(1);
  });
  test('the schema and the registry agree on the shortcut page: only registered commands are accepted', async () => {
    const s = await open();
    expect((await s.store.rebind('no.such-command', '⌘⇧M')).ok).toBe(false);
    expect(registry.byId('person.add')).toBeDefined();
  });
});

// The store as the app runs it: under Node (Electron's main process), on this computer's file system.
test('the settings store under Node: a change is saved, read back by a second store, and reset', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aw-settings-node-'));
  dirs.push(dir);
  const settings = pathToFileURL(join(import.meta.dir, '../main/settings.ts')).href;
  const script = `const m=await import(${JSON.stringify(settings)});const dir=${JSON.stringify(dir)};const k=m.SETTING_KEYS;
const a=m.openSettings({dir,appVersion:'1.0.0',watch:false});await a.ready;
const set=[await a.set(k.openLast,true),await a.set(k.textSize,'large'),await a.set(k.registersFolder,'~/Elsewhere')];
const b=m.openSettings({dir,appVersion:'1.0.0',watch:false});await b.ready;
const read=[b.get(k.openLast),b.get(k.textSize),b.get(k.registersFolder),b.state().changes.length];
const reset=await b.set(k.textSize,'normal');
console.log(JSON.stringify({set,read,reset}));`;
  const r = spawnSync('node', ['--no-warnings', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 30000 });
  expect(r.stderr).toBe('');
  expect(JSON.parse(r.stdout)).toEqual({ set: [{ ok: true }, { ok: true }, { ok: true }], read: [true, 'large', '~/Elsewhere', 3], reset: { ok: true } });
}, 40000);

// Windows refuses to flush a folder handle opened for reading (EPERM): that alone is not a failed save there. Any other
// error, and the same error on macOS, still fails the save.
test('the folder sync after a save: a refused flush on Windows is not an error; everything else still is', async () => {
  const failing = (code: string) => {
    let closed = 0;
    const fh = { sync: async () => { throw Object.assign(new Error(code), { code }); }, close: async () => { closed++; } };
    return { fh, closed: () => closed };
  };
  for (const code of ['EPERM', 'EACCES']) {
    const f = failing(code);
    const h = windowsTolerantFolderSync(f.fh, 'win32');
    await expect(h.sync()).resolves.toBeUndefined();
    await h.close();
    expect(f.closed()).toBe(1);
    await expect(windowsTolerantFolderSync(failing(code).fh, 'darwin').sync()).rejects.toThrow(code);
  }
  await expect(windowsTolerantFolderSync(failing('EIO').fh, 'win32').sync()).rejects.toThrow('EIO');
  const ok = failing('EPERM').fh;
  expect(windowsTolerantFolderSync(ok, 'darwin')).toBe(ok);
});
