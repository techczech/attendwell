// The estate's "tests every app carries" 1-4 for the command registry, palette, menu bar and cheat sheet (app-design-elements SKILL.md),
// plus the locked command list (lock-notes-attendwell.md) checked row by row.
import { describe, expect, test } from 'bun:test';
import { RESERVED_ESTATE, toAccelerator } from '@app-patterns/commands';
import {
  COMMAND_ROWS, IDLE_CTX, MENU_ORDER, PLACED_IDS, UNBOUND_RESERVED, cheatSheet, displayChord, registry, type CommandCtx,
} from '../shared/commands.ts';
import { buildAppMenu, menuLabels } from '../shared/menu.ts';
import { ICON_NAMES } from '../renderer/src/icons.tsx';

const defaults = registry.bindingsOf({});
const lib: CommandCtx = { ...IDLE_CTX, view: 'library', workshopCount: 3, selectedWorkshop: true };

type Item = { label?: string; accelerator?: string; enabled?: boolean; submenu?: Item[]; type?: string; role?: string };
const walk = (items: Item[]): Item[] => items.flatMap((i) => [i, ...(i.submenu ? walk(i.submenu) : [])]);
const menuOf = (platform: 'mac' | 'win', bindings: Record<string, string>, ctx: CommandCtx = lib): Item[] =>
  buildAppMenu({ platform, bindings, ctx, run: () => undefined }) as Item[];

// The lock notes' table: id (lock spelling) | name | default chord | menu. Camel-case ids are written with hyphens here, and four ids are the package's frame ids.
const LOCK: Array<[string, string, string, string]> = [
  ['app.palette', 'Command palette', '⌘⇧P', 'View'], ['app.contextual', 'Actions for the selection', '⌘K', 'View'], ['app.switcher', 'Go to workshop…', '⌘⇧K', 'File'],
  ['settings', 'Settings…', '⌘,', 'AttendWell'], ['cheat', 'Keyboard shortcuts', '⌘/', 'Help'], ['app.about', 'About AttendWell', '', 'AttendWell'],
  ['app.check-for-updates', 'Check for Updates…', '', 'AttendWell'], ['app.whats-new', "What's new in AttendWell", '', 'Help'], ['app.get-started', 'Get started', '', 'Help'],
  ['app.how-it-works', 'How AttendWell works', '', 'Help'], ['app.remove-example', 'Remove example', '', 'Help'], ['export-settings', 'Export Settings…', '', 'AttendWell'],
  ['import-settings', 'Import Settings…', '', 'AttendWell'], ['app.quit', 'Quit AttendWell', '⌘Q', 'AttendWell'], ['window.close', 'Close window', '⌘W', 'Window'],
  ['workshop.new', 'New workshop', '⌘N', 'File'], ['workshop.show-all', 'Show all workshops', '⌘⇧L', 'File'], ['workshop.search-all', 'Search all workshops', '⌘⇧F', 'File'],
  ['workshop.reveal-folder', 'Show the registers folder in Finder', '', 'File'], ['names.paste', 'Paste a name list…', '', 'File'], ['names.import', 'Import names from a file…', '⌘⇧I', 'File'],
  ['register.find', 'Find a person', '⌘F', 'Edit'], ['register.check-in', 'Check in the selected person', '⌘↵', 'Session'], ['register.undo', 'Undo the last attendance change', '⌘Z', 'Session'],
  ['register.show-all', 'Show everyone', '⌘1', 'View'], ['register.show-here', 'Show who is here', '⌘2', 'View'], ['register.show-not-yet', 'Show who is not here yet', '⌘3', 'View'],
  ['register.show-held', 'Show held for review', '⌘4', 'View'], ['register.sort', 'Change sort order', '', 'View'], ['register.next', 'Next person', '↓', ''], ['register.previous', 'Previous person', '↑', ''],
  ['register.print', 'Print the register…', '', 'Session'], ['held.check-in', 'Check in (held for review)', '', ''], ['held.keep-not-checked-in', 'Keep not checked in', '', ''],
  ['person.add', 'Add person', '⌘⌥N', 'Session'], ['ipad.pair', 'Pair an iPad', '⌘⇧N', 'Session'], ['ipad.pair-again', 'Pair again', '', 'Session'], ['ipad.rename', 'Rename iPad…', '', ''],
  ['ipad.revoke', 'Revoke iPad…', '', ''], ['ipad.import-recovery', 'Import iPad recovery file…', '', 'Session'], ['connection.copy-address', 'Copy check-in address', '⌘⌥C', 'Session'],
  ['connection.retry', 'Retry connection', '⌘⇧R', 'Session'], ['connection.test', 'Test connection', '', ''], ['review.email', 'Email review…', '⌘E', 'Session'], ['export.csv', 'Export CSV…', '⌘⇧E', 'Session'],
  ['checkin.end', 'End check-in', '', 'Session'], ['checkin.reopen', 'Reopen check-in', '', 'Session'],
];

describe('the locked command list', () => {
  test('every locked command is registered with its name and default chord, and nothing else is (except the two library actions)', () => {
    for (const [id, name, chord] of LOCK) {
      const def = registry.byId(id);
      expect(def, id).toBeDefined();
      expect(def!.label, id).toBe(name);
      expect(def!.key, id).toBe(chord);
    }
    const extra = registry.defs.map((d) => d.id).filter((id) => !LOCK.some((l) => l[0] === id));
    expect(extra.sort()).toEqual(['workshop.open', 'workshop.reveal']);
  });
  test('menu placement follows the lock (File, Edit, View, Session, Help; the AttendWell menu and Window are placed by the builder)', () => {
    for (const [id, , , menu] of LOCK) {
      const row = COMMAND_ROWS.find((r) => r.id === id)!;
      if (menu === '') expect(registry.byId(id)!.noMenu, id).toBe(true);
      else if (menu === 'AttendWell') expect(['App'].includes(row.menu), id).toBe(true);
      else if (menu === 'Window') expect(id).toBe('window.close');
      else expect(row.menu as string, id).toBe(menu);
    }
  });
  test('outside a session, the register and iPad commands are disabled, each with a reason', () => {
    for (const id of ['register.check-in', 'ipad.pair', 'person.add', 'export.csv', 'checkin.end', 'ipad.import-recovery', 'connection.copy-address']) {
      expect(registry.byId(id)!.available!(lib), id).toBeTruthy();
    }
  });
  test('a name list can go to the workshop selected in the library (its ⌘K list), and needs a selection', () => {
    for (const id of ['names.paste', 'names.import']) {
      expect(registry.byId(id)!.available!(lib), id).toBeNull();
      expect(registry.byId(id)!.available!({ ...lib, selectedWorkshop: false }), id).toBe('Select a workshop first.');
    }
  });
});

describe('1. reserved chords resolve to their surface or are unbound', () => {
  const surface: Record<string, string | null> = {
    '⌘⇧P': 'app.palette', '⌘⇧K': 'app.switcher', '⌘K': 'app.contextual', '⌘P': null, '⌘F': 'register.find', '⌘⇧F': 'workshop.search-all', '⌘,': 'settings', '⌘/': 'cheat',
  };
  test('every estate chord is accounted for', () => {
    expect(Object.keys(surface).sort()).toEqual(Object.keys(RESERVED_ESTATE).sort());
    for (const [chord, id] of Object.entries(surface)) expect(registry.commandForChord(defaults, chord), chord).toBe(id);
    expect(UNBOUND_RESERVED).toEqual(['⌘P']);
  });
  test('the reserved chords cannot be taken by another command', () => {
    for (const chord of Object.keys(RESERVED_ESTATE)) expect(registry.checkRebind(defaults, 'person.add', chord).kind, chord).not.toBe('ok');
  });
});

describe('2. every cheat-sheet row and menu item shows its command effective chord', () => {
  const overrides = { 'person.add': '⌘⇧M', 'review.email': '' };
  const bindings = registry.bindingsOf(overrides);
  test('override is applied by the registry', () => {
    expect(bindings['person.add']).toBe('⌘⇧M');
    expect(bindings['review.email']).toBe('');
  });
  test('cheat sheet rows carry the effective chord', () => {
    const rows = cheatSheet(bindings).flatMap((g) => g.rows);
    for (const r of rows) expect(r.chord, r.id).toBe(bindings[r.id] ?? '');
    expect(rows.find((r) => r.id === 'person.add')!.chord).toBe('⌘⇧M');
  });
  for (const platform of ['mac', 'win'] as const) {
    test(`menu items show the effective chord (${platform})`, () => {
      const items = walk(menuOf(platform, bindings));
      for (const d of registry.defs) {
        const label = platform === 'win' && d.id === 'app.quit' ? 'Exit' : d.label;
        const item = items.find((i) => i.label === label);
        if (!item) { expect(d.noMenu, `${d.id} is missing from the menu`).toBe(true); continue; }
        const want = platform === 'win' && d.id === 'app.quit' ? 'Alt+F4' : toAccelerator(bindings[d.id] ?? '')?.replace(/\bCmd\b/g, platform === 'win' ? 'Ctrl' : 'Cmd');
        expect(item.accelerator, d.id).toBe(want ?? undefined);
      }
    });
  }
  test('Windows writes chords with Ctrl, Alt and Shift', () => {
    expect(displayChord('⌘⇧P', 'win')).toBe('Ctrl+Shift+P');
    expect(displayChord('⌘⌥N', 'win')).toBe('Ctrl+Alt+N');
    expect(displayChord('⌘⇧P', 'mac')).toBe('⌘⇧P');
  });
});

describe('3. every command is in the palette, in the bindable set, and in the menu bar or noMenu with a reason', () => {
  test('the palette lists every command (none is hidden)', () => {
    const rows = registry.paletteList(lib, '');
    expect(rows.map((r) => r.def.id).sort()).toEqual(registry.defs.map((d) => d.id).sort());
    expect(registry.defs.filter((d) => d.hidden)).toEqual([]);
  });
  test('every command is bindable or holds a fixed estate or system chord', () => {
    for (const d of registry.defs) {
      if (d.fixed) { expect(d.key, d.id).not.toBe(''); continue; }
      expect(['ok', 'same'], d.id).toContain(registry.checkRebind(defaults, d.id, d.key || '⌘⌥⇧9').kind);
    }
  });
  test('every command is in the menu bar (mac and Windows) or is noMenu with a reason', () => {
    for (const platform of ['mac', 'win'] as const) {
      const labels = new Set(menuLabels(menuOf(platform, defaults) as never));
      for (const d of registry.defs) {
        const label = platform === 'win' && d.id === 'app.quit' ? 'Exit' : d.label;
        if (d.noMenu) { expect(d.noMenuReason, d.id).toBeTruthy(); if (!PLACED_IDS.includes(d.id)) expect(labels.has(label), `${d.id} should be left out`).toBe(false); }
        else expect(labels.has(label), `${d.id} (${platform})`).toBe(true);
      }
    }
  });
  test('the commands the builder places are really in the menu', () => {
    const mac = new Set(menuLabels(menuOf('mac', defaults) as never));
    for (const id of PLACED_IDS) expect(mac.has(registry.byId(id)!.label), id).toBe(true);
  });
  test('menu bar order: AttendWell, File, Edit, View, Session, Window, Help; Windows has no AttendWell menu', () => {
    expect(menuOf('mac', defaults).map((m) => m.label)).toEqual([...MENU_ORDER]);
    expect(menuOf('win', defaults).map((m) => m.label)).toEqual(['File', 'Edit', 'View', 'Session', 'Window', 'Help']);
  });
  test('the AttendWell menu has About, Check for Updates, Settings…, Export/Import Settings… and Quit; on Windows they move to File and Help', () => {
    const app = menuOf('mac', defaults)[0]!.submenu!.map((i) => i.label).filter(Boolean);
    for (const l of ['About AttendWell', 'Check for Updates…', 'Settings…', 'Export Settings…', 'Import Settings…', 'Quit AttendWell']) expect(app).toContain(l);
    const win = menuOf('win', defaults);
    const file = win.find((m) => m.label === 'File')!.submenu!.map((i) => i.label);
    const help = win.find((m) => m.label === 'Help')!.submenu!.map((i) => i.label);
    expect(file).toContain('Settings…');
    expect(file).toContain('Exit');
    expect(help).toContain('Check for Updates…');
    expect(help).toContain('About AttendWell');
  });
  test('every icon the registry names exists in the interface icon set', () => {
    for (const d of registry.defs) expect(ICON_NAMES, `${d.id}: ${d.icon}`).toContain(d.icon);
  });
});

describe('4. zero chord collisions', () => {
  test('no two commands share an effective chord in one scope', () => {
    const seen = new Map<string, string>();
    for (const d of registry.defs) {
      const chord = defaults[d.id];
      if (!chord) continue;
      const slot = `${d.scope ?? 'global'}|${chord}`;
      expect(seen.get(slot), `${d.id} and ${seen.get(slot)} share ${chord}`).toBeUndefined();
      seen.set(slot, d.id);
    }
  });
  test('a rebind onto a taken chord is refused, and a swap is possible', () => {
    expect(registry.checkRebind(defaults, 'review.email', '⌘⌥N').kind).toBe('taken');
    expect(registry.checkRebind(defaults, 'review.email', '⌘⇧M').kind).toBe('ok');
  });
  test('arrow keys are scoped to the register', () => {
    expect(registry.commandForChord(defaults, '↓')).toBeNull();
    expect(registry.commandForChord(defaults, '↓', 'register')).toBe('register.next');
  });
});

describe('availability', () => {
  test('during first run only the app-level commands run', () => {
    const first = { ...IDLE_CTX, view: 'first-run' as const };
    expect(registry.byId('workshop.new')!.available!(first)).toBeTruthy();
    expect(registry.byId('app.palette')!.available!(first)).toBeNull();
    expect(registry.byId('app.quit')!.available!(first)).toBeNull();
  });
  test('Open workshop needs a selection in the library', () => {
    expect(registry.byId('workshop.open')!.available!({ ...lib, selectedWorkshop: false })).toBeTruthy();
    expect(registry.byId('workshop.open')!.available!(lib)).toBeNull();
  });
  test('Check for Updates is refused while check-in is live', () => {
    expect(registry.byId('app.check-for-updates')!.available!({ ...lib, liveSession: true })).toBe('Not while check-in is open.');
  });
  test('Remove example only when an example is offered', () => {
    expect(registry.byId('app.remove-example')!.available!(lib)).toBeTruthy();
    expect(registry.byId('app.remove-example')!.available!({ ...lib, exampleOffered: true })).toBeNull();
  });
});
