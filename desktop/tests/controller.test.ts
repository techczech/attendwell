// First run, the example workshop, the Get started lifecycle and the registers folder, over the fake runtime in a temporary folder.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getStartedButton } from '../shared/get-started.ts';
import { SETTING_KEYS } from '../shared/settings-schema.ts';
import { AppStateFile, readAppState } from '../main/app-state.ts';
import { Controller, EXAMPLE_DATE, EXAMPLE_TITLE } from '../main/controller.ts';
import { createFakeRuntime } from '../main/fake-runtime.ts';
import { openSettings } from '../main/settings.ts';
import type { UpdateSnapshot } from '@app-patterns/updates';
import { settingsWriteTest } from './fakes.ts';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

async function setup() {
  const base = mkdtempSync(join(tmpdir(), 'aw-ctl-'));
  dirs.push(base);
  const home = join(base, 'home');
  const settings = openSettings({ dir: join(base, 'userData'), appVersion: '1.0.0', watch: false });
  await settings.ready;
  await settings.set(SETTING_KEYS.registersFolder, '~/Documents/AttendWell');
  const state = new AppStateFile(join(base, 'userData'));
  const port = createFakeRuntime({ dataRoot: join(home, 'Documents/AttendWell'), now: () => new Date(2026, 9, 30, 12, 0) });
  let changes = 0;
  const ctl = new Controller({
    port, settings, state, platform: 'mac', version: '1.0.0', home, now: () => new Date(2026, 9, 30, 12, 0),
    updateSnapshot: () => ({ running: '1.0.0' } as UpdateSnapshot), changed: () => { changes += 1; },
  });
  return { base, home, settings, state, port, ctl, changes: () => changes };
}
const button = (s: Awaited<ReturnType<typeof setup>>, hidden = false) => {
  const a = s.state.get();
  return getStartedButton({ setupDone: a.setupDone, exampleOpened: a.exampleOpened, exampleRemoved: a.exampleRemoved, hiddenSetting: hidden });
};

describe('first run', () => {
  settingsWriteTest('a fresh copy is not set up, has no workshops and a registers folder under the home folder', async () => {
    const s = await setup();
    const snap = await s.ctl.snapshot();
    expect(snap.setupDone).toBe(false);
    expect(snap.registersFolder).toBe('~/Documents/AttendWell');
    expect(snap.registersFolderPath).toBe(join(s.home, 'Documents/AttendWell'));
    expect(snap.listing.today.length + snap.listing.upcoming.length + snap.listing.past.length).toBe(0);
    expect(snap.today).toBe('2026-10-30');
    expect(snap.bindings['app.palette']).toBe('⌘⇧P');
  });
  test('creating the first workshop makes its folder and lists it as Today', async () => {
    const s = await setup();
    const r = await s.ctl.createWorkshop({ title: 'Generative AI for Researchers', date: '2026-10-30', startTime: '14:00', endTime: '16:30' });
    expect(r.ok).toBe(true);
    s.ctl.finishSetup();
    const snap = await s.ctl.snapshot();
    expect(snap.setupDone).toBe(true);
    expect(snap.listing.today.map((w) => w.title)).toEqual(['Generative AI for Researchers']);
    if (r.ok) expect(existsSync(join(s.ctl.workshopFolder(r.value.id), 'workshop.json'))).toBe(true);
  });
  test('a workshop without a title is refused with a plain message', async () => {
    const s = await setup();
    const r = await s.ctl.createWorkshop({ title: ' ', date: '2026-10-30' });
    expect(r).toEqual({ ok: false, error: 'A workshop needs a title.' });
  });
  test('the first-run answer survives a restart', async () => {
    const s = await setup();
    s.ctl.finishSetup();
    expect(new AppStateFile(join(s.base, 'userData')).get().setupDone).toBe(true);
  });
});

describe('example workshop and the Get started button', () => {
  test('the example is created once, opened, then removed; the button follows the lifecycle', async () => {
    const s = await setup();
    s.ctl.finishSetup();
    expect(button(s)).toBe('get-started');
    const a = await s.ctl.createExample();
    const b = await s.ctl.createExample();
    expect(a.ok && b.ok && a.value.id === b.value.id).toBe(true);
    if (!a.ok) throw new Error('no example');
    expect(a.value.title).toBe(EXAMPLE_TITLE);
    expect(a.value.date).toBe(EXAMPLE_DATE);
    expect(button(s)).toBe('get-started');
    expect((await s.ctl.openWorkshop(a.value.id)).ok).toBe(true);
    expect(button(s)).toBe('remove-example');
    expect(s.state.get().ran).toContain('workshop.open');
    expect((await s.ctl.removeExample()).ok).toBe(true);
    expect(button(s)).toBe('hidden');
    const snap = await s.ctl.snapshot();
    expect(snap.listing.past).toEqual([]);
    expect(snap.exampleRemoved).toBe(true);
    expect((await s.ctl.removeExample()).ok).toBe(false);
  });
  test('opening a workshop that is not the example does not start the lifecycle', async () => {
    const s = await setup();
    s.ctl.finishSetup();
    const w = await s.ctl.createWorkshop({ title: 'Real', date: '2026-10-30' });
    if (!w.ok) throw new Error('no workshop');
    await s.ctl.openWorkshop(w.value.id);
    expect(button(s)).toBe('get-started');
    expect(s.state.get().lastWorkshopId).toBe(w.value.id);
  });
  test('opening an unknown workshop is refused', async () => {
    const s = await setup();
    expect((await s.ctl.openWorkshop('nope')).ok).toBe(false);
  });
  settingsWriteTest('the Settings switch hides the button; turning it off shows it again', async () => {
    const s = await setup();
    s.ctl.finishSetup();
    await s.ctl.setGetStartedHidden(true);
    expect(button(s, s.settings.get<boolean>(SETTING_KEYS.getStartedHidden))).toBe('hidden');
    await s.ctl.setGetStartedHidden(false);
    expect(button(s, s.settings.get<boolean>(SETTING_KEYS.getStartedHidden))).toBe('get-started');
    expect(s.settings.state().changes).toHaveLength(2);
  });
});

describe('registers folder', () => {
  settingsWriteTest('choosing another folder is saved as a change under the home folder, and the library moves with it', async () => {
    const s = await setup();
    await s.ctl.createWorkshop({ title: 'In the first folder', date: '2026-11-01' });
    const other = join(s.home, 'Dropbox', 'Registers');
    mkdirSync(other, { recursive: true });
    expect((await s.ctl.setRegistersFolder(other)).ok).toBe(true);
    expect(s.settings.get<string>(SETTING_KEYS.registersFolder)).toBe('~/Dropbox/Registers');
    expect(s.port.dataRoot()).toBe(other);
    expect(s.settings.state().changes[0]!.key).toBe(SETTING_KEYS.registersFolder);
    const snap = await s.ctl.snapshot();
    expect(snap.listing.upcoming).toEqual([]);
    await s.ctl.createWorkshop({ title: 'In the second', date: '2026-11-02' });
    expect(existsSync(join(other, '2026-11-02-in-the-second', 'workshop.json'))).toBe(true);
  });
  settingsWriteTest('a folder outside the home folder is kept as written; an empty one is refused', async () => {
    const s = await setup();
    const outside = join(s.home, '..', 'Volumes-Registers');
    mkdirSync(outside, { recursive: true });
    expect((await s.ctl.setRegistersFolder(outside)).ok).toBe(true);
    expect(s.settings.get<string>(SETTING_KEYS.registersFolder)).toBe(outside);
    expect((await s.ctl.setRegistersFolder('  ')).ok).toBe(false);
  });
  settingsWriteTest('a file or a link is refused and the setting stays as it was; a missing folder is created', async () => {
    const s = await setup();
    mkdirSync(s.home, { recursive: true });
    const file = join(s.home, 'run-me.sh');
    writeFileSync(file, '#!/bin/sh\n');
    const link = join(s.home, 'linked');
    mkdirSync(join(s.home, 'real'));
    symlinkSync(join(s.home, 'real'), link);
    for (const bad of [file, link]) expect((await s.ctl.setRegistersFolder(bad)).ok).toBe(false);
    expect(s.settings.get<string>(SETTING_KEYS.registersFolder)).toBe('~/Documents/AttendWell');
    expect((await s.ctl.setRegistersFolder(join(s.home, 'fresh', 'Registers'))).ok).toBe(true);
    expect(existsSync(join(s.home, 'fresh', 'Registers'))).toBe(true);
  });
  test('portablePath writes the home folder as ~ on either path style', async () => {
    const s = await setup();
    expect(s.ctl.portablePath(s.home)).toBe('~');
    expect(s.ctl.portablePath(s.home + '/a/b')).toBe('~/a/b');
    expect(s.ctl.portablePath(s.home + 'x/a')).toBe(s.home + 'x/a');
  });
});

describe('app state file', () => {
  test('a damaged or foreign file is a first run, not an error', () => {
    expect(readAppState('nonsense').setupDone).toBe(false);
    expect(readAppState({ version: 2, setupDone: true }).setupDone).toBe(false);
    expect(readAppState({ version: 1, setupDone: true, ran: ['a', 3, 'b'], exampleId: 5 })).toMatchObject({ setupDone: true, ran: ['a', 'b'], exampleId: null });
  });
  test('written by rename with private permissions, no temp file left, and noteRan records once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aw-state-'));
    dirs.push(dir);
    const f = new AppStateFile(dir);
    expect(f.existedAtStart).toBe(false);
    f.noteRan('x');
    f.noteRan('x');
    expect(JSON.parse(readFileSync(f.path, 'utf8')).ran).toEqual(['x']);
    expect(new AppStateFile(dir).existedAtStart).toBe(true);
    expect(require('node:fs').readdirSync(dir)).toEqual(['app-state.json']);
  });
});
