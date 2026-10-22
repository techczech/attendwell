// What the main window and the Settings window's Connection page exchange with the main process (through the two preloads).
import type { UpdateSnapshot } from '@app-patterns/updates';
import type { SessionSelection, SessionView } from './session-model.ts';
import type { ConnectionTest, NewWorkshop, RuntimeSnapshot, WorkshopListing, WorkshopSummary } from './runtime-types.ts';
import type { NamesMapping, NamesSheetView, RecoverySheetView } from './names-model.ts';

export const CH = {
  state: 'attendwell:state',
  changed: 'attendwell:changed',
  command: 'attendwell:command',
  runCommand: 'attendwell:run-command',
  createWorkshop: 'attendwell:create-workshop',
  openWorkshop: 'attendwell:open-workshop',
  closeWorkshop: 'attendwell:close-workshop',
  createExample: 'attendwell:create-example',
  removeExample: 'attendwell:remove-example',
  chooseFolder: 'attendwell:choose-folder',
  setRegistersFolder: 'attendwell:set-registers-folder',
  finishSetup: 'attendwell:finish-setup',
  reveal: 'attendwell:reveal',
  setGetStartedHidden: 'attendwell:set-get-started-hidden',
  noteRan: 'attendwell:note-ran',
  rebind: 'attendwell:rebind',
  // updates
  update: 'attendwell:update',
  updateChanged: 'attendwell:update-changed',
  showNotes: 'attendwell:show-notes',
  view: 'attendwell:view',
  updateAction: 'attendwell:update-action',
  updateNotes: 'attendwell:update-notes',
  // Settings window, Connection page
  connection: 'attendwell:connection',
  connectionChanged: 'attendwell:connection-changed',
  connectionTest: 'attendwell:connection-test',
  copyAddress: 'attendwell:copy-address',
  // the session screen
  sessionView: 'attendwell:session-view',
  sessionChanged: 'attendwell:session-changed',
  sessionAction: 'attendwell:session-action',
  quitRequested: 'attendwell:quit-requested',
} as const;

/** Everything the session screen asks the main process to do. Arguments are checked by `parseSessionAction` before anything runs. */
export type SessionAction =
  | { kind: 'show'; workshopId: string }
  | { kind: 'leave' }
  | { kind: 'start' }
  | { kind: 'retry' }
  | { kind: 'end' }
  | { kind: 'mark'; id: string; present: boolean }
  | { kind: 'undo' }
  | { kind: 'resolve'; id: string; action: 'check-in' | 'dismiss' }
  | { kind: 'add'; name: string; email: string; markHere: boolean }
  | { kind: 'pair-open'; targetDeviceId?: string; label?: string }
  | { kind: 'pair-new' }
  | { kind: 'pair-label'; label: string }
  | { kind: 'pair-close' }
  | { kind: 'rename'; id: string; label: string }
  | { kind: 'revoke'; id: string }
  | { kind: 'dismiss-hold'; id: number }
  | { kind: 'copy'; what: 'address' | 'pair-code' | 'pair-address' | 'review-bcc' }
  | { kind: 'export-csv' }
  | { kind: 'quit'; endFirst: boolean }
  // Name lists and iPad recovery files, for the workshop on screen (main/names-service.ts). Files are chosen in main, or dropped.
  | { kind: 'names-paste'; text: string }
  | { kind: 'names-choose-file' }
  | { kind: 'names-map'; mapping: NamesMapping }
  | { kind: 'names-add'; token: string }
  | { kind: 'names-close' }
  | { kind: 'recovery-choose-file' }
  | { kind: 'recovery-file'; path: string }
  | { kind: 'recovery-import' }
  | { kind: 'recovery-close' };

/** What the names and recovery actions answer: the sheet to show, or null when the file chooser was cancelled. */
export type SheetAnswer = NamesSheetView | RecoverySheetView | null;

/** Pasted text longer than this is not a name list. */
export const MAX_PASTE = 300_000;
const column = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 99) throw new Error('Bad argument');
  return v;
};

const text = (v: unknown, max: number, min = 0): string => {
  if (typeof v !== 'string' || v.length > max || v.length < min) throw new Error('Bad argument');
  return v;
};
const optional = (v: unknown, max: number): string | undefined => (v === undefined || v === null ? undefined : text(v, max));
const ID = /^[A-Za-z0-9_.:-]{1,120}$/;
const id = (v: unknown): string => { const t = text(v, 120, 1); if (!ID.test(t)) throw new Error('Bad argument'); return t; };

/** Validates an action that came from the window; throws 'Bad argument' for anything unexpected, and drops unknown fields. */
export function parseSessionAction(v: unknown): SessionAction {
  const o = (v ?? {}) as Record<string, unknown>;
  switch (o.kind) {
    case 'show': return { kind: 'show', workshopId: id(o.workshopId) };
    case 'leave': case 'start': case 'retry': case 'end': case 'undo': case 'pair-new': case 'pair-close': case 'export-csv': return { kind: o.kind };
    case 'mark': if (typeof o.present !== 'boolean') throw new Error('Bad argument'); return { kind: 'mark', id: id(o.id), present: o.present };
    case 'resolve': if (o.action !== 'check-in' && o.action !== 'dismiss') throw new Error('Bad argument'); return { kind: 'resolve', id: id(o.id), action: o.action };
    case 'add': return { kind: 'add', name: text(o.name, 200, 1), email: text(o.email ?? '', 254), markHere: o.markHere === true };
    case 'pair-open': {
      const target = optional(o.targetDeviceId, 120);
      const label = optional(o.label, 40);
      if (target !== undefined && !ID.test(target)) throw new Error('Bad argument');
      return { kind: 'pair-open', ...(target ? { targetDeviceId: target } : {}), ...(label ? { label } : {}) };
    }
    case 'pair-label': return { kind: 'pair-label', label: text(o.label, 40) };
    case 'rename': return { kind: 'rename', id: id(o.id), label: text(o.label, 40, 1) };
    case 'revoke': return { kind: 'revoke', id: id(o.id) };
    case 'dismiss-hold': if (typeof o.id !== 'number' || !Number.isInteger(o.id) || o.id < 0) throw new Error('Bad argument'); return { kind: 'dismiss-hold', id: o.id };
    case 'copy': if (o.what !== 'address' && o.what !== 'pair-code' && o.what !== 'pair-address' && o.what !== 'review-bcc') throw new Error('Bad argument'); return { kind: 'copy', what: o.what };
    case 'quit': return { kind: 'quit', endFirst: o.endFirst === true };
    case 'names-paste': return { kind: 'names-paste', text: text(o.text, MAX_PASTE) };
    case 'names-map': {
      const m = (o.mapping ?? {}) as Record<string, unknown>;
      return { kind: 'names-map', mapping: { header: m.header === true, name: column(m.name), first: column(m.first), last: column(m.last), email: column(m.email), status: column(m.status), date: column(m.date) } };
    }
    case 'recovery-file': return { kind: 'recovery-file', path: text(o.path, 4096, 1) };
    case 'names-add': if (typeof o.token !== 'string' || !/^[0-9a-f]{64}$/.test(o.token)) throw new Error('Bad argument'); return { kind: 'names-add', token: o.token };
    case 'names-choose-file': case 'names-close': case 'recovery-choose-file': case 'recovery-import': case 'recovery-close': return { kind: o.kind };
    default: throw new Error('Bad argument');
  }
}

export type UpdateAction =
  | { kind: 'check' }
  | { kind: 'set-enabled'; on: boolean }
  | { kind: 'download' }
  | { kind: 'not-now' }
  | { kind: 'skip'; version: string }
  | { kind: 'stop-skipping' }
  | { kind: 'open-notes'; version: string }
  | { kind: 'open-store' }
  | { kind: 'dismiss-whats-new' };

/** The commands the main process runs (everything else the window runs itself). */
export const MAIN_COMMANDS: ReadonlySet<string> = new Set([
  'settings', 'export-settings', 'import-settings', 'app.quit', 'app.about', 'app.check-for-updates', 'window.close',
  'workshop.reveal-folder', 'workshop.reveal', 'connection.test',
]);

export interface AppSnapshot {
  platform: 'mac' | 'win';
  home: string;
  version: string;
  /** Registers folder as written in settings and as an absolute path. */
  registersFolder: string;
  registersFolderPath: string;
  setupDone: boolean;
  exampleId: string | null;
  exampleOpened: boolean;
  exampleRemoved: boolean;
  getStartedHidden: boolean;
  ran: string[];
  /** The effective chord of every command ("" = none). */
  bindings: Record<string, string>;
  /** Text size choice: normal, large, extra-large. */
  textSize: string;
  openLastWorkshop: boolean;
  lastWorkshopId: string | null;
  listing: WorkshopListing;
  runtime: RuntimeSnapshot;
  update: UpdateSnapshot;
  /** Today as YYYY-MM-DD in the local zone. */
  today: string;
}

export type Result<T = void> = ({ ok: true } & (T extends void ? unknown : { value: T })) | { ok: false; error: string };

export interface AttendWellApi {
  state(): Promise<AppSnapshot>;
  onChanged(cb: (s: AppSnapshot) => void): () => void;
  /** A command chosen in the menu: the window runs it. */
  onCommand(cb: (id: string) => void): () => void;
  runCommand(id: string, arg?: string): Promise<void>;
  /** The window tells main which view it shows and whether a workshop is selected, so the menu can enable what applies. */
  reportView(v: { view: string; selectedWorkshop: boolean; selection?: SessionSelection }): Promise<void>;
  createWorkshop(input: NewWorkshop): Promise<Result<WorkshopSummary>>;
  openWorkshop(id: string): Promise<Result>;
  createExample(): Promise<Result<WorkshopSummary>>;
  removeExample(): Promise<Result>;
  chooseFolder(): Promise<string | null>;
  setRegistersFolder(path: string): Promise<Result>;
  finishSetup(): Promise<void>;
  setGetStartedHidden(hidden: boolean): Promise<Result>;
  noteRan(id: string): Promise<void>;
  /** Rebinds a command's shortcut in place (palette ⌘⇧,); "" removes it. Logged in Changes as You. */
  rebind(id: string, chord: string): Promise<Result>;
  update(action: UpdateAction): Promise<unknown>;
  loadNotes(version: string): Promise<Array<{ title: string | null; text: string }> | null>;
  /** The session screen: its current state, a push when it changes, what the organiser does, and the quit confirmation request. */
  sessionView(): Promise<SessionView>;
  onSession(cb: (v: SessionView) => void): () => void;
  sessionAct(a: SessionAction): Promise<Result<{ leftovers?: string[]; path?: string | null }>>;
  /** The names and recovery sheets' actions (the same channel as sessionAct). */
  sheetAct(a: SessionAction): Promise<Result<SheetAnswer>>;
  /** The path of a file dropped on the window (Electron webUtils), for the recovery sheet's drop zone. */
  pathForFile(file: File): string;
  onQuitRequested(cb: () => void): () => void;
}

/** What the Settings window's About card needs for update notices (it has no other access to the app). */
export interface UpdatesApi {
  snapshot(): Promise<UpdateSnapshot>;
  onChanged(cb: (s: UpdateSnapshot) => void): () => void;
  action(a: UpdateAction): Promise<unknown>;
  loadNotes(version: string): Promise<Array<{ title: string | null; text: string }> | null>;
  showNotes(version: string): Promise<void>;
}

export interface ConnectionView {
  tunnel: RuntimeSnapshot['tunnel'];
  workshopTitle: string | null;
  testAvailable: boolean;
}

export interface ConnectionApi {
  view(): Promise<ConnectionView>;
  onChanged(cb: (v: ConnectionView) => void): () => void;
  test(): Promise<ConnectionTest>;
  copyAddress(): Promise<boolean>;
}
