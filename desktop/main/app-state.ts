// What the app remembers beside its settings: whether first run is done, the example workshop, which Get started chapters
// have been tried, the last workshop, and the update checker's state. One small JSON file in the user-data folder, written
// by rename so a crash never leaves half a file. Tolerant on read: a damaged file is treated as a first run, never an error.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface AppState {
  version: 1;
  setupDone: boolean;
  exampleId: string | null;
  exampleOpened: boolean;
  exampleRemoved: boolean;
  /** Command ids that have run at least once (Get started chapters read this). */
  ran: string[];
  lastWorkshopId: string | null;
  /** The update checker's stored state (see @app-patterns/updates `readUpdateState`). */
  update: unknown;
  /** When Changes was last opened in Settings (ms), for the "new" highlight. */
  changesSeenAt: number;
}

export const EMPTY_STATE: AppState = {
  version: 1, setupDone: false, exampleId: null, exampleOpened: false, exampleRemoved: false, ran: [], lastWorkshopId: null, update: {}, changesSeenAt: 0,
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function readAppState(raw: unknown): AppState {
  if (!isObject(raw) || raw.version !== 1) return { ...EMPTY_STATE, ran: [] };
  return {
    version: 1,
    setupDone: raw.setupDone === true,
    exampleId: typeof raw.exampleId === 'string' ? raw.exampleId : null,
    exampleOpened: raw.exampleOpened === true,
    exampleRemoved: raw.exampleRemoved === true,
    ran: Array.isArray(raw.ran) ? raw.ran.filter((x): x is string => typeof x === 'string').slice(0, 200) : [],
    lastWorkshopId: typeof raw.lastWorkshopId === 'string' ? raw.lastWorkshopId : null,
    update: isObject(raw.update) ? raw.update : {},
    changesSeenAt: typeof raw.changesSeenAt === 'number' && Number.isFinite(raw.changesSeenAt) ? raw.changesSeenAt : 0,
  };
}

export class AppStateFile {
  private state: AppState;
  /** True when no file was there at start: the first launch of this copy. */
  readonly existedAtStart: boolean;

  constructor(private readonly dir: string, private readonly fileName = 'app-state.json') {
    let raw: unknown;
    let existed = false;
    try { raw = JSON.parse(readFileSync(this.path, 'utf8')); existed = true; } catch { raw = undefined; }
    this.existedAtStart = existed;
    this.state = readAppState(raw);
  }

  get path(): string { return join(this.dir, this.fileName); }
  get(): Readonly<AppState> { return this.state; }

  update(patch: Partial<AppState>): AppState {
    this.state = { ...this.state, ...patch, version: 1 };
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, this.path);
    return this.state;
  }

  /** Records that a command ran (Get started chapters). */
  noteRan(id: string): void {
    if (this.state.ran.includes(id)) return;
    this.update({ ran: [...this.state.ran, id] });
  }
}
