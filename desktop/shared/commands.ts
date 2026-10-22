// The one command registry of AttendWell (App Patterns @app-patterns/commands), seeded from the locked command list.
// The palette, the cheat sheet, the menu bar, the Shortcuts page and the key handler all read it.
//
// Commands whose surfaces arrive in a later version are registered now and disabled, each with its reason (avail 'later').
// Ids: the package accepts lower case, digits, dots and hyphens only, so the lock notes' camel-case ids are written with hyphens
// (app.checkForUpdates -> app.check-for-updates), and the package's own frame ids stand for Settings (`settings`), Keyboard shortcuts
// (`cheat`), Export Settings (`export-settings`) and Import Settings (`import-settings`).
import { defineRegistry, type CommandDef, type Registry } from '@app-patterns/commands';
import type { Availability, SessionPhase } from './session-model.ts';

/** Registry groups are the menus: where the command sits in the menu bar. ("App" is the AttendWell menu.) */
export type MenuGroup = 'App' | 'File' | 'Edit' | 'View' | 'Session' | 'Help';
/** The cheat sheet's own grouping (the locked mockup's), separate from the menu a command sits in. */
export type CheatGroup = 'App' | 'Workshops' | 'Register' | 'Session' | 'Devices';

export type ViewName = 'first-run' | 'library' | 'get-started' | 'session';

/** What the session screen knows that decides its commands: where check-in stands, and what is selected. */
export interface SessionCtx {
  phase: SessionPhase;
  /** The register is answering (check-in is open and the connection to the register works): people can be marked and added. */
  registerOpen: boolean;
  pair: Availability;
  canUndo: boolean;
  hasAddress: boolean;
  canRetry: boolean;
  hasPeople: boolean;
  hasPresent: boolean;
  /** Another workshop's check-in is open, so this one cannot be started. */
  otherLive: boolean;
  /** The selected person: held for review, already here, or can be checked in. */
  person: { held: boolean; present: boolean; canCheckIn: boolean } | null;
  /** The selected iPad. */
  device: { revoked: boolean } | null;
  /** Exactly one iPad needs pairing again (⇧⌘N targets it); its name. */
  repairName: string | null;
}

export interface CommandCtx {
  view: ViewName;
  workshopCount: number;
  /** A workshop row is selected in the library. */
  selectedWorkshop: boolean;
  /** A check-in session is running (none can start in this version, the field is for the register release). */
  liveSession: boolean;
  /** The example workshop exists and has not been removed. */
  exampleOffered: boolean;
  /** The "Updated to … · What's new" mark is showing. */
  whatsNewAvailable: boolean;
  /** The session screen's state (only while a workshop is open on screen). */
  session: SessionCtx | null;
}

export const IDLE_CTX: CommandCtx = {
  view: 'library', workshopCount: 0, selectedWorkshop: false, liveSession: false, exampleOffered: false, whatsNewAvailable: false, session: null,
};

type Avail = 'always' | 'setup' | 'selection' | 'later' | 'idle' | 'example' | 'whats-new' | 'workshops'
  | 'register' | 'check-in' | 'undo' | 'held' | 'add' | 'pair' | 'pair-again' | 'device' | 'address' | 'retry' | 'end' | 'reopen' | 'export' | 'review'
  | 'names' | 'recovery';

const REASONS = {
  setup: 'Finish setting up first.',
  selection: 'Select a workshop first.',
  openFirst: 'Open a workshop first.',
  later: 'Not available yet in this version.',
  live: 'Not while check-in is open.',
  noExample: 'There is no example workshop to remove.',
  noNotes: 'There are no new version notes to show.',
  noWorkshops: 'There are no workshops yet.',
} as const;

const SESSION_KINDS: ReadonlySet<Avail> = new Set(['register', 'check-in', 'undo', 'held', 'add', 'pair', 'pair-again', 'device', 'address', 'retry', 'end', 'reopen', 'export', 'review']);

function notOpen(s: SessionCtx): string {
  return s.phase === 'ready' ? 'Start check-in first.' : s.phase === 'closed' || s.phase === 'past' ? 'Check-in is closed. Reopen check-in first.' : 'The register is not answering yet.';
}

/** Why a command that works on the open workshop cannot run now, or null. */
function sessionReason(kind: Avail, c: CommandCtx): string | null {
  if (c.view !== 'session' || !c.session) return REASONS.openFirst;
  const s = c.session;
  switch (kind) {
    case 'register': return null;
    case 'check-in':
      if (!s.registerOpen) return notOpen(s);
      if (!s.person) return 'Select a person first.';
      if (s.person.held) return 'This check-in is held. Use Check in (held for review).';
      if (s.person.present) return 'This person is already checked in.';
      return s.person.canCheckIn ? null : 'This person is on the waiting list. Admit them first.';
    case 'undo': return !s.registerOpen ? notOpen(s) : s.canUndo ? null : 'There is nothing to undo.';
    case 'held': return !s.registerOpen ? notOpen(s) : s.person?.held ? null : 'Select a person held for review first.';
    case 'add': return s.registerOpen ? null : notOpen(s);
    case 'pair': return s.pair.ok ? null : s.pair.reason;
    case 'pair-again': return !s.pair.ok ? s.pair.reason : s.device ? null : 'Select an iPad first.';
    case 'device': return !s.registerOpen ? notOpen(s) : s.device ? null : 'Select an iPad first.';
    case 'address': return s.hasAddress ? null : 'There is no check-in address to copy.';
    case 'retry': return s.canRetry ? null : 'The connection does not need a retry.';
    case 'end': return s.phase === 'connecting' || s.phase === 'online' || s.phase === 'trouble' ? null : 'Check-in is not open.';
    case 'reopen':
      if (s.phase !== 'closed' && s.phase !== 'past' && s.phase !== 'ready') return 'Check-in is already open.';
      return s.otherLive ? "Another workshop's check-in is open. End it first." : null;
    case 'export': return s.hasPeople ? null : 'The register has no people yet.';
    case 'review': return s.hasPresent ? null : 'Nobody is checked in yet.';
    default: return null;
  }
}

function reasonFor(kind: Avail, c: CommandCtx): string | null {
  if (kind === 'always') return null;
  if (c.view === 'first-run') return REASONS.setup;
  if (kind === 'later') return REASONS.later;
  if (SESSION_KINDS.has(kind)) return sessionReason(kind, c);
  switch (kind) {
    case 'setup': return null;
    // A name list goes to the workshop on screen, or to the one selected in the library; a recovery file to the workshop on screen.
    // Either works before Start check-in and after End (the runtime opens the register without the check-in address).
    case 'names':
      if (c.view === 'session' && c.session) return c.session.phase === 'ending' ? 'Wait until check-in has closed.' : null;
      return c.view === 'library' ? (c.selectedWorkshop ? null : REASONS.selection) : REASONS.openFirst;
    case 'recovery':
      if (c.view === 'session' && c.session) return c.session.phase === 'ending' ? 'Wait until check-in has closed.' : null;
      return REASONS.openFirst;
    case 'workshops': return c.workshopCount > 0 ? null : REASONS.noWorkshops;
    case 'selection': return c.view === 'library' && c.selectedWorkshop ? null : c.view === 'library' ? REASONS.selection : REASONS.later;
    case 'idle': return c.liveSession ? REASONS.live : null;
    case 'example': return c.exampleOffered ? null : REASONS.noExample;
    case 'whats-new': return c.whatsNewAvailable ? null : REASONS.noNotes;
    default: return null;
  }
}

interface Row {
  id: string;
  menu: MenuGroup;
  cheat: CheatGroup;
  label: string;
  key: string;
  icon: string;
  avail: Avail;
  fixed?: true;
  typing?: true;
  scope?: string;
  /** Left out of the generated menu on purpose. */
  noMenu?: string;
  /** Placed in the menu by buildAppMenu (a system role or an App-menu item), not by the group. */
  placed?: true;
}

// prettier-ignore
export const COMMAND_ROWS: readonly Row[] = [
  // AttendWell menu and app
  { id: 'app.palette', menu: 'View', cheat: 'App', label: 'Command palette', key: '⌘⇧P', icon: 'command', avail: 'always', fixed: true, typing: true },
  { id: 'app.contextual', menu: 'View', cheat: 'App', label: 'Actions for the selection', key: '⌘K', icon: 'zap', avail: 'always', fixed: true, typing: true },
  { id: 'app.switcher', menu: 'File', cheat: 'App', label: 'Go to workshop…', key: '⌘⇧K', icon: 'calendar-days', avail: 'workshops', fixed: true, typing: true },
  { id: 'app.about', menu: 'App', cheat: 'App', label: 'About AttendWell', key: '', icon: 'info', avail: 'always', placed: true, noMenu: 'Placed in the AttendWell menu (Help on Windows)' },
  { id: 'app.check-for-updates', menu: 'App', cheat: 'App', label: 'Check for Updates…', key: '', icon: 'refresh-cw', avail: 'idle', placed: true, noMenu: 'Placed in the AttendWell menu (Help on Windows)' },
  { id: 'app.whats-new', menu: 'Help', cheat: 'App', label: "What's new in AttendWell", key: '', icon: 'sparkles', avail: 'whats-new' },
  { id: 'app.get-started', menu: 'Help', cheat: 'App', label: 'Get started', key: '', icon: 'play', avail: 'setup' },
  { id: 'app.how-it-works', menu: 'Help', cheat: 'App', label: 'How AttendWell works', key: '', icon: 'book-open', avail: 'setup' },
  { id: 'app.remove-example', menu: 'Help', cheat: 'App', label: 'Remove example', key: '', icon: 'x', avail: 'example' },
  { id: 'app.quit', menu: 'App', cheat: 'App', label: 'Quit AttendWell', key: '⌘Q', icon: 'log-out', avail: 'always', fixed: true, placed: true, noMenu: 'Placed in the AttendWell menu (File as Exit on Windows)' },
  { id: 'window.close', menu: 'File', cheat: 'Workshops', label: 'Close window', key: '⌘W', icon: 'x', avail: 'always', fixed: true, placed: true, noMenu: 'Placed in the Window menu' },
  // Workshops
  { id: 'workshop.new', menu: 'File', cheat: 'Workshops', label: 'New workshop', key: '⌘N', icon: 'plus', avail: 'setup' },
  { id: 'workshop.open', menu: 'File', cheat: 'Workshops', label: 'Open workshop', key: '', icon: 'folder-open', avail: 'selection' },
  { id: 'workshop.show-all', menu: 'File', cheat: 'Workshops', label: 'Show all workshops', key: '⌘⇧L', icon: 'library', avail: 'setup' },
  { id: 'workshop.search-all', menu: 'File', cheat: 'Workshops', label: 'Search all workshops', key: '⌘⇧F', icon: 'search', avail: 'setup', fixed: true, typing: true },
  { id: 'workshop.reveal-folder', menu: 'File', cheat: 'Workshops', label: 'Show the registers folder in Finder', key: '', icon: 'folder', avail: 'setup' },
  { id: 'workshop.reveal', menu: 'File', cheat: 'Workshops', label: 'Show the selected workshop in Finder', key: '', icon: 'folder', avail: 'selection' },
  { id: 'names.paste', menu: 'File', cheat: 'Workshops', label: 'Paste a name list…', key: '', icon: 'clipboard-paste', avail: 'names' },
  { id: 'names.import', menu: 'File', cheat: 'Workshops', label: 'Import names from a file…', key: '⌘⇧I', icon: 'file-up', avail: 'names' },
  // Register
  { id: 'register.find', menu: 'Edit', cheat: 'Register', label: 'Find a person', key: '⌘F', icon: 'search', avail: 'register', fixed: true, typing: true },
  { id: 'register.check-in', menu: 'Session', cheat: 'Register', label: 'Check in the selected person', key: '⌘↵', icon: 'check', avail: 'check-in' },
  { id: 'register.undo', menu: 'Session', cheat: 'Register', label: 'Undo the last attendance change', key: '⌘Z', icon: 'undo-2', avail: 'undo', fixed: true },
  { id: 'register.show-all', menu: 'View', cheat: 'Register', label: 'Show everyone', key: '⌘1', icon: 'users', avail: 'register' },
  { id: 'register.show-here', menu: 'View', cheat: 'Register', label: 'Show who is here', key: '⌘2', icon: 'user-check', avail: 'register' },
  { id: 'register.show-not-yet', menu: 'View', cheat: 'Register', label: 'Show who is not here yet', key: '⌘3', icon: 'user-round', avail: 'register' },
  { id: 'register.show-held', menu: 'View', cheat: 'Register', label: 'Show held for review', key: '⌘4', icon: 'circle-alert', avail: 'register' },
  { id: 'register.sort', menu: 'View', cheat: 'Register', label: 'Change sort order', key: '', icon: 'arrow-down-up', avail: 'register' },
  { id: 'register.next', menu: 'View', cheat: 'Register', label: 'Next person', key: '↓', icon: 'chevron-down', avail: 'register', scope: 'register', noMenu: 'Repeat movement key' },
  { id: 'register.previous', menu: 'View', cheat: 'Register', label: 'Previous person', key: '↑', icon: 'chevron-up', avail: 'register', scope: 'register', noMenu: 'Repeat movement key' },
  { id: 'register.print', menu: 'Session', cheat: 'Register', label: 'Print the register…', key: '', icon: 'printer', avail: 'later' },
  { id: 'held.check-in', menu: 'Session', cheat: 'Register', label: 'Check in (held for review)', key: '', icon: 'check', avail: 'held', noMenu: 'Needs a selected held row: Actions for the selection (⌘K) only' },
  { id: 'held.keep-not-checked-in', menu: 'Session', cheat: 'Register', label: 'Keep not checked in', key: '', icon: 'user-x', avail: 'held', noMenu: 'Needs a selected held row: Actions for the selection (⌘K) only' },
  // Session
  { id: 'person.add', menu: 'Session', cheat: 'Session', label: 'Add person', key: '⌘⌥N', icon: 'user-plus', avail: 'add' },
  { id: 'ipad.pair', menu: 'Session', cheat: 'Session', label: 'Pair an iPad', key: '⌘⇧N', icon: 'qr-code', avail: 'pair' },
  { id: 'connection.copy-address', menu: 'Session', cheat: 'Session', label: 'Copy check-in address', key: '⌘⌥C', icon: 'copy', avail: 'address' },
  { id: 'connection.retry', menu: 'Session', cheat: 'Session', label: 'Retry connection', key: '⌘⇧R', icon: 'rotate-cw', avail: 'retry' },
  { id: 'review.email', menu: 'Session', cheat: 'Session', label: 'Email review…', key: '⌘E', icon: 'mail', avail: 'review' },
  { id: 'export.csv', menu: 'Session', cheat: 'Session', label: 'Export CSV…', key: '⌘⇧E', icon: 'file-down', avail: 'export' },
  { id: 'checkin.end', menu: 'Session', cheat: 'Session', label: 'End check-in', key: '', icon: 'power', avail: 'end' },
  { id: 'checkin.reopen', menu: 'Session', cheat: 'Session', label: 'Reopen check-in', key: '', icon: 'rotate-ccw', avail: 'reopen' },
  // Devices
  { id: 'ipad.pair-again', menu: 'Session', cheat: 'Devices', label: 'Pair again', key: '', icon: 'rotate-ccw', avail: 'pair-again' },
  { id: 'ipad.rename', menu: 'Session', cheat: 'Devices', label: 'Rename iPad…', key: '', icon: 'pencil', avail: 'device', noMenu: 'Needs a selected iPad: Actions for the selection (⌘K) and the row menu' },
  { id: 'ipad.revoke', menu: 'Session', cheat: 'Devices', label: 'Revoke iPad…', key: '', icon: 'ban', avail: 'device', noMenu: 'Needs a selected iPad: Actions for the selection (⌘K) and the row menu' },
  { id: 'ipad.import-recovery', menu: 'Session', cheat: 'Devices', label: 'Import iPad recovery file…', key: '', icon: 'file-input', avail: 'recovery' },
  { id: 'connection.test', menu: 'Session', cheat: 'Session', label: 'Test connection', key: '', icon: 'plug-zap', avail: 'idle', noMenu: 'Settings and the palette only' },
  // Frame commands (ids fixed by the package); relabelled to the locked wording
  { id: 'settings', menu: 'App', cheat: 'App', label: 'Settings…', key: '⌘,', icon: 'settings', avail: 'always', fixed: true, typing: true },
  { id: 'cheat', menu: 'Help', cheat: 'App', label: 'Keyboard shortcuts', key: '⌘/', icon: 'keyboard', avail: 'always', fixed: true, typing: true },
  { id: 'export-settings', menu: 'App', cheat: 'App', label: 'Export Settings…', key: '', icon: 'download', avail: 'always' },
  { id: 'import-settings', menu: 'App', cheat: 'App', label: 'Import Settings…', key: '', icon: 'upload', avail: 'always' },
];

/** ⌘P (inspector) is reserved by the estate and unbound here: no journey needs an inspector. */
export const UNBOUND_RESERVED = ['⌘P'] as const;

/** The frame commands the package supplies; they are merged with the rows above and may only change label and icon. */
const FRAME = new Set(['settings', 'cheat', 'export-settings', 'import-settings']);

function toDef(r: Row): CommandDef<MenuGroup, CommandCtx> {
  const noMenu = r.noMenu !== undefined && !FRAME.has(r.id);
  return {
    id: r.id, group: r.menu, label: r.label, key: r.key, icon: r.icon,
    ...(r.fixed ? { fixed: true as const } : {}),
    ...(r.typing ? { typing: true as const } : {}),
    ...(r.scope ? { scope: r.scope } : {}),
    ...(noMenu ? { noMenu: true as const, noMenuReason: r.noMenu! } : {}),
    available: (ctx: CommandCtx) => reasonFor(r.avail, ctx),
  };
}

export const registry: Registry<MenuGroup, CommandCtx> = defineRegistry<MenuGroup, CommandCtx>(COMMAND_ROWS.map(toDef));

export const MENU_DECLS = [
  { label: 'File', groups: ['File'] as MenuGroup[] },
  { label: 'Edit', groups: ['Edit'] as MenuGroup[] },
  { label: 'View', groups: ['View'] as MenuGroup[] },
  { label: 'Session', groups: ['Session'] as MenuGroup[] },
  { label: 'Help', groups: ['Help'] as MenuGroup[] },
];

/** Menu bar order of the locked design (the package's own order puts Edit before File). */
export const MENU_ORDER = ['AttendWell', 'File', 'Edit', 'View', 'Session', 'Window', 'Help'] as const;

/** Commands the menu builder places itself (system roles and the AttendWell menu's own items). */
export const PLACED_IDS: readonly string[] = COMMAND_ROWS.filter((r) => r.placed).map((r) => r.id);

export const cheatGroupOf = (id: string): CheatGroup => COMMAND_ROWS.find((r) => r.id === id)?.cheat ?? 'App';
export const CHEAT_ORDER: readonly CheatGroup[] = ['App', 'Workshops', 'Register', 'Session', 'Devices'];

/** Commands in the palette's "selection" list (⌘K): what can be done to the library's selected workshop. */
export const SELECTION_COMMANDS: readonly string[] = ['workshop.open', 'workshop.reveal', 'names.paste', 'names.import'];

/** In the session screen the ⌘K list is about the selected person or iPad. */
export const SESSION_SELECTION_COMMANDS: readonly string[] = ['register.check-in', 'held.check-in', 'held.keep-not-checked-in', 'ipad.rename', 'ipad.pair-again', 'ipad.revoke'];

export const selectionCommands = (ctx: CommandCtx): readonly string[] => (ctx.view === 'session' ? SESSION_SELECTION_COMMANDS : SELECTION_COMMANDS);

export interface CheatRow { id: string; label: string; chord: string }
export interface CheatSheetView { group: CheatGroup; rows: CheatRow[] }

/** The cheat sheet: every shown command with its effective chord ("" is none), in the locked groups. */
export function cheatSheet(bindings: Record<string, string>): CheatSheetView[] {
  return CHEAT_ORDER.map((group) => ({
    group,
    rows: registry.defs
      .filter((d) => !d.hidden && cheatGroupOf(d.id) === group && !(d.id === 'register.previous'))
      .map((d) => ({
        id: d.id,
        label: d.id === 'register.next' ? 'Next / previous person' : d.label,
        chord: Object.hasOwn(bindings, d.id) ? bindings[d.id] ?? '' : '',
      })),
  })).filter((g) => g.rows.length > 0);
}

/** A chord written for the platform: ⌘ is Ctrl and ⌥ is Alt on Windows. */
export function displayChord(chord: string, platform: 'mac' | 'win'): string {
  if (!chord) return '';
  if (platform === 'mac') return chord;
  const mods: string[] = [];
  if (chord.includes('⌘') || chord.includes('⌃')) mods.push('Ctrl');
  if (chord.includes('⌥')) mods.push('Alt');
  if (chord.includes('⇧')) mods.push('Shift');
  return [...mods, chord.replace(/[⌘⌃⌥⇧]/g, '')].join('+');
}
