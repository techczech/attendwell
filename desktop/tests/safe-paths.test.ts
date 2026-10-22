// What the app may hand to the operating system: real folders only, https links on an allow-list only; the schema refuses non-folders.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureRealDirectory, guardedExternal, isAllowedExternal, isRealDirectory, revealFolder } from '../main/safe-paths.ts';
import { schema, SETTING_KEYS } from '../shared/settings-schema.ts';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const temp = (): string => { const d = mkdtempSync(join(tmpdir(), 'aw-safe-')); dirs.push(d); return d; };

describe('revealing a folder', () => {
  test('a real folder is opened; a file, a link or a missing path is only shown, never opened', async () => {
    const d = temp();
    mkdirSync(join(d, 'dir'));
    writeFileSync(join(d, 'script.command'), 'x');
    symlinkSync(join(d, 'dir'), join(d, 'link'));
    const calls: string[] = [];
    const shell = { openPath: async (p: string) => { calls.push(`open ${p}`); return ''; }, showItemInFolder: (p: string) => { calls.push(`show ${p}`); } };
    expect(await revealFolder(shell, join(d, 'dir'))).toBe('opened');
    for (const p of ['script.command', 'link', 'gone']) expect(await revealFolder(shell, join(d, p))).toBe('shown');
    expect(calls.filter((c) => c.startsWith('open '))).toEqual([`open ${join(d, 'dir')}`]);
    expect(isRealDirectory(join(d, 'link'))).toBe(false);
  });
});

describe('the registers folder', () => {
  test('a missing folder is created private; a file, a link and a missing parent chain are handled; nothing existing is touched', () => {
    const d = temp();
    expect(ensureRealDirectory(join(d, 'new', 'Registers'))).toBe(true);
    expect(isRealDirectory(join(d, 'new', 'Registers'))).toBe(true);
    writeFileSync(join(d, 'file'), 'x');
    mkdirSync(join(d, 'dir'));
    symlinkSync(join(d, 'dir'), join(d, 'link'));
    expect(ensureRealDirectory(join(d, 'file'))).toBe(false);
    expect(ensureRealDirectory(join(d, 'link'))).toBe(false);
    expect(ensureRealDirectory(join(d, 'file', 'inside'))).toBe(false);
    expect(ensureRealDirectory(join(d, 'dir'))).toBe(true);
  });
});

describe('links', () => {
  test('only https on the allow-list', async () => {
    expect(isAllowedExternal('https://attendwell.app/notes')).toBe(true);
    expect(isAllowedExternal('https://techczech.github.io/attendwell/updates.json')).toBe(true);
    for (const u of ['http://attendwell.app/', 'file:///etc/passwd', 'https://evil.example/', 'https://user:pw@attendwell.app/', 'javascript:1', 'nonsense']) expect(isAllowedExternal(u)).toBe(false);
    const opened: string[] = [];
    const g = guardedExternal({ openExternal: async (u) => { opened.push(u); } });
    await g.openExternal('https://github.com/x/y');
    await expect(g.openExternal('file:///Applications')).rejects.toThrow();
    expect(opened).toEqual(['https://github.com/x/y']);
  });
});

describe('the registers folder setting', () => {
  test('canApply accepts a folder and refuses a file, a missing path, and an unchecked environment', () => {
    const d = temp();
    writeFileSync(join(d, 'f'), 'x');
    const def = schema.settings.find((s) => s.key === SETTING_KEYS.registersFolder)!;
    const env = { isDirectory: isRealDirectory, home: d };
    expect(def.canApply!(d, env)).toBeNull();
    expect(def.canApply!(join(d, 'f'), env)).not.toBeNull();
    expect(def.canApply!(join(d, 'gone'), env)).not.toBeNull();
    expect(def.canApply!(d, {})).not.toBeNull();
  });
});
