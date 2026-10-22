// The registers folder per platform: the default, and the Windows rule that it has to sit inside AppData.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Controller } from '../main/controller.ts';
import { AppStateFile } from '../main/app-state.ts';
import { createFakeRuntime } from '../main/fake-runtime.ts';
import { openSettings } from '../main/settings.ts';
import { SETTING_KEYS, schema } from '../shared/settings-schema.ts';
import { defaultRegistersFolder, effectiveRegistersFolder, isInsideWindows, registersFolderProblem, windowsAppDataRoots, windowsDefaultFolder, WINDOWS_APPDATA_MESSAGE } from '../shared/registers-folder.ts';
import type { UpdateSnapshot } from '@app-patterns/updates';
import { settingsWriteTest } from './fakes.ts';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const roots = ['C:\\Users\\Ann\\AppData\\Roaming', 'C:\\Users\\Ann\\AppData\\Local'];

describe('defaults and the AppData rule', () => {
  test('macOS keeps Documents; Windows defaults inside AppData\\Local', () => {
    expect(defaultRegistersFolder('mac')).toBe('~/Documents/AttendWell');
    expect(defaultRegistersFolder('win')).toBe('~/AppData/Local/AttendWell/Workshops');
    expect(registersFolderProblem('win', 'C:\\Users\\Ann\\AppData\\Local\\AttendWell\\Workshops', roots)).toBeNull();
  });
  test('Windows refuses Documents, other drives, look-alike names and .. escapes, whatever the case or slash', () => {
    for (const bad of ['C:\\Users\\Ann\\Documents\\AttendWell', 'D:\\AppData\\Local\\x', 'C:\\Users\\Ann\\AppData\\LocalBackup\\x', 'C:/Users/Ann/AppData/Local/../../Documents', 'C:\\Users\\Ann\\AppData']) {
      expect(registersFolderProblem('win', bad, roots)).toBe(WINDOWS_APPDATA_MESSAGE);
    }
    expect(registersFolderProblem('win', 'c:/users/ann/appdata/roaming/AttendWell', roots)).toBeNull();
    expect(isInsideWindows('C:\\A\\', 'c:\\a')).toBe(true);
  });
  test('macOS never applies the rule', () => expect(registersFolderProblem('mac', '/Users/ann/Documents/x', roots)).toBeNull());
  test('the Settings row refuses a non-AppData folder on Windows and accepts one inside', () => {
    const row = schema.settings.find((s) => s.key === SETTING_KEYS.registersFolder)!;
    const env = { isDirectory: () => true, home: 'C:\\Users\\Ann', platform: 'win', appDataRoots: roots };
    expect(row.canApply?.('C:\\Users\\Ann\\Documents\\AttendWell', env)).toBe(WINDOWS_APPDATA_MESSAGE);
    expect(row.canApply?.('~/AppData/Local/AttendWell/Workshops', env)).toBeNull();
    expect(row.canApply?.('C:\\Users\\Ann\\Documents\\AttendWell', { ...env, platform: 'mac' })).toBeNull();
  });
});

describe('the controller on Windows', () => {
  const winController = async (roots?: (base: string) => string[]) => {
    const base = mkdtempSync(join(tmpdir(), 'aw-win-'));
    dirs.push(base);
    const home = join(base, 'home');
    const appData = roots ? roots(base) : [join(home, 'AppData', 'Roaming'), join(home, 'AppData', 'Local')];
    const settings = openSettings({ dir: join(base, 'userData'), appVersion: '1.0.0', watch: false });
    await settings.ready;
    const ctl = new Controller({
      port: createFakeRuntime({ dataRoot: join(base, 'root'), now: () => new Date(2026, 9, 30) }), settings, state: new AppStateFile(join(base, 'userData')),
      platform: 'win', version: '1.0.0', home, appDataRoots: appData, ensureFolder: () => true,
      updateSnapshot: () => ({ running: '1.0.0' } as UpdateSnapshot), changed: () => undefined,
    });
    return { base, home, ctl, settings };
  };
  test('defaults to AppData\\Local and refuses a folder outside AppData with the plain message, leaving the setting alone', async () => {
    const { home, ctl, settings } = await winController();
    expect(ctl.registersFolderPath()).toBe(`${home}/AppData/Local/AttendWell/Workshops`);
    const before = settings.get<string>(SETTING_KEYS.registersFolder);
    expect(await ctl.setRegistersFolder(join(home, 'Documents', 'AttendWell'))).toEqual({ ok: false, error: WINDOWS_APPDATA_MESSAGE });
    expect(settings.get<string>(SETTING_KEYS.registersFolder)).toBe(before);
  });
  settingsWriteTest('a folder inside AppData is accepted and saved', async () => {
    const { home, ctl } = await winController();
    expect((await ctl.setRegistersFolder(join(home, 'AppData', 'Local', 'Elsewhere'))).ok).toBe(true);
  });
  test('a Local AppData folder in another place (not under the home folder) gives the default, and the same roots validate a choice', async () => {
    const { base, ctl } = await winController((b) => [join(b, 'Profiles', 'Ann', 'Roaming'), join(b, 'Profiles', 'Ann', 'Local')]);
    const local = join(base, 'Profiles', 'Ann', 'Local');
    expect(ctl.registersFolderPath()).toBe(`${local}\\AttendWell\\Workshops`);
    expect(registersFolderProblem('win', ctl.registersFolderPath(), [join(base, 'Profiles', 'Ann', 'Roaming'), local])).toBeNull();
    expect(await ctl.setRegistersFolder(join(base, 'home', 'AppData', 'Local', 'AttendWell'))).toEqual({ ok: false, error: WINDOWS_APPDATA_MESSAGE });
  });
});

describe('the Windows roots and the default derived from them', () => {
  test('Electron\'s AppData folder and %LOCALAPPDATA% give the roots; Local is found beside AppData when the variable is missing', () => {
    expect(windowsAppDataRoots({ home: 'C:\\Users\\Ann', appData: 'C:\\Users\\Ann\\AppData\\Roaming', localAppData: 'D:\\Local' })).toEqual(['C:\\Users\\Ann\\AppData\\Roaming', 'D:\\Local']);
    expect(windowsAppDataRoots({ home: 'C:\\Users\\Ann', appData: 'C:\\Users\\Ann\\AppData\\Roaming' })).toEqual(['C:\\Users\\Ann\\AppData\\Roaming', 'C:\\Users\\Ann\\AppData\\Local']);
    expect(windowsAppDataRoots({ home: 'C:\\Users\\Ann' })).toEqual(['C:\\Users\\Ann/AppData/Roaming', 'C:\\Users\\Ann/AppData/Local']);
  });
  test('the default is under the home folder as ~/…, elsewhere as written; stored defaults follow the roots, chosen folders are kept', () => {
    expect(windowsDefaultFolder('C:\\Users\\Ann\\AppData\\Local', 'C:\\Users\\Ann')).toBe('~/AppData/Local/AttendWell/Workshops');
    expect(windowsDefaultFolder('D:\\Profiles\\Ann\\Local\\', 'C:\\Users\\Ann')).toBe('D:\\Profiles\\Ann\\Local\\AttendWell\\Workshops');
    const roots = ['D:\\Profiles\\Ann\\Roaming', 'D:\\Profiles\\Ann\\Local'];
    for (const stored of [undefined, '', '~/Documents/AttendWell', '~/AppData/Local/AttendWell/Workshops']) {
      expect(effectiveRegistersFolder('win', stored, roots, 'C:\\Users\\Ann')).toBe('D:\\Profiles\\Ann\\Local\\AttendWell\\Workshops');
    }
    expect(effectiveRegistersFolder('win', 'D:\\Profiles\\Ann\\Local\\Mine', roots, 'C:\\Users\\Ann')).toBe('D:\\Profiles\\Ann\\Local\\Mine');
    expect(effectiveRegistersFolder('mac', undefined, [], '/Users/ann')).toBe(defaultRegistersFolder('mac'));
    expect(effectiveRegistersFolder('mac', '~/Elsewhere', [], '/Users/ann')).toBe('~/Elsewhere');
  });
});
