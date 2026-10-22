// The app's behaviour apart from Electron: what the window shows (the snapshot), and what its actions do. Electron-specific edges
// (dialogs, Finder, windows) are injected, so the first-run, example and library rules are tested with the fake runtime in a temp folder.
import { homedir } from 'node:os';
import { dayOf } from '../shared/workshops.ts';
import { expandHome, SETTING_KEYS } from '../shared/settings-schema.ts';
import { effectiveRegistersFolder, registersFolderProblem, windowsAppDataRoots } from '../shared/registers-folder.ts';
import type { AppSnapshot, Result } from '../shared/ipc.ts';
import type { NewWorkshop, WorkshopSummary } from '../shared/runtime-types.ts';
import type { UpdateSnapshot } from '@app-patterns/updates';
import type { AppStateFile } from './app-state.ts';
import type { RuntimePort } from './runtime-port.ts';
import { ensureRealDirectory } from './safe-paths.ts';
import type { Settings } from './settings.ts';

/** The example workshop is a past session: fictional names, nothing that reaches a real register. */
export const EXAMPLE_TITLE = 'Example workshop';
export const EXAMPLE_DATE = '2026-09-01';

export interface ControllerDeps {
  port: RuntimePort;
  settings: Settings;
  state: AppStateFile;
  platform: 'mac' | 'win';
  version: string;
  home?: string;
  /** Windows: the AppData and Local AppData folders; the registers folder has to be inside one (default: from the environment). */
  appDataRoots?: readonly string[];
  /** Makes sure the registers folder is a real folder, creating it when missing (default: on disk); false refuses it. */
  ensureFolder?: (path: string) => boolean;
  now?: () => Date;
  updateSnapshot(): UpdateSnapshot;
  /** The workshop is now on screen (the session screen loads its register). */
  onOpen?: (id: string) => Promise<void>;
  /** Tells every window that something changed. */
  changed(): void;
}

/** Windows: %APPDATA% and %LOCALAPPDATA%, or the standard places under the home folder when the variables are missing. The app passes Electron's AppData folder instead (main/index.ts). */
export const defaultAppDataRoots = (home: string): string[] => windowsAppDataRoots({ home, appData: process.env.APPDATA, localAppData: process.env.LOCALAPPDATA });

const fail = (e: unknown): { ok: false; error: string } => ({ ok: false, error: e instanceof Error ? e.message : String(e) });

export class Controller {
  private readonly home: string;
  constructor(private readonly d: ControllerDeps) {
    this.home = d.home ?? homedir();
  }

  /** The registers folder as an absolute path. */
  registersFolderPath(): string {
    return expandHome(this.registersFolderSetting(), this.home);
  }

  /** The setting as written. Windows: the default (or the Documents default, which is outside AppData) is derived from the same AppData roots that validate a choice. */
  private registersFolderSetting(): string {
    return effectiveRegistersFolder(this.d.platform, this.d.settings.get<string>(SETTING_KEYS.registersFolder), this.d.appDataRoots ?? defaultAppDataRoots(this.home), this.home);
  }

  async snapshot(): Promise<AppSnapshot> {
    const s = this.d.state.get();
    const listing = await this.d.port.workshops.list();
    return {
      platform: this.d.platform,
      home: this.home,
      version: this.d.version,
      registersFolder: this.registersFolderSetting(),
      registersFolderPath: this.registersFolderPath(),
      setupDone: s.setupDone,
      exampleId: s.exampleId,
      exampleOpened: s.exampleOpened,
      exampleRemoved: s.exampleRemoved,
      getStartedHidden: this.d.settings.get<boolean>(SETTING_KEYS.getStartedHidden),
      ran: [...s.ran],
      bindings: this.d.settings.bindings(),
      textSize: this.d.settings.get<string>(SETTING_KEYS.textSize),
      openLastWorkshop: this.d.settings.get<boolean>(SETTING_KEYS.openLast),
      lastWorkshopId: s.lastWorkshopId,
      listing,
      runtime: this.d.port.status.get(),
      update: this.d.updateSnapshot(),
      today: dayOf((this.d.now ?? (() => new Date()))()),
    };
  }

  async createWorkshop(input: NewWorkshop): Promise<Result<WorkshopSummary>> {
    try {
      const value = await this.d.port.workshops.create(input);
      this.d.changed();
      return { ok: true, value };
    } catch (e) { return fail(e); }
  }

  async openWorkshop(id: string): Promise<Result> {
    try {
      // While another workshop's check-in is open this one is shown read-only: the runtime keeps running the first.
      const live = this.d.port.status.get();
      if (live.session === 'idle' || live.workshopId === id) await this.d.port.openWorkshop(id);
      await this.d.onOpen?.(id);
      const s = this.d.state.get();
      this.d.state.update({ lastWorkshopId: id, ...(id === s.exampleId ? { exampleOpened: true } : {}) });
      if (id === s.exampleId) this.d.state.noteRan('workshop.open');
      this.d.changed();
      return { ok: true };
    } catch (e) { return fail(e); }
  }

  /** "Open the example workshop": creates it once (a past session with fictional names), or finds it again. */
  async createExample(): Promise<Result<WorkshopSummary>> {
    try {
      const s = this.d.state.get();
      if (s.exampleId && !s.exampleRemoved) {
        const all = await this.d.port.workshops.list();
        const found = [...all.today, ...all.upcoming, ...all.past].find((w) => w.id === s.exampleId);
        if (found) return { ok: true, value: found };
      }
      const value = await this.d.port.workshops.create({ title: EXAMPLE_TITLE, date: EXAMPLE_DATE });
      this.d.state.update({ exampleId: value.id, exampleRemoved: false, exampleOpened: false });
      this.d.changed();
      return { ok: true, value };
    } catch (e) { return fail(e); }
  }

  /** "Remove example": the example folder is archived (the runtime has no delete), and the button is retired. */
  async removeExample(): Promise<Result> {
    const s = this.d.state.get();
    if (!s.exampleId || s.exampleRemoved) return { ok: false, error: 'There is no example workshop to remove.' };
    try {
      await this.d.port.workshops.setArchived(s.exampleId, true);
      this.d.state.update({ exampleRemoved: true, lastWorkshopId: s.lastWorkshopId === s.exampleId ? null : s.lastWorkshopId });
      this.d.changed();
      return { ok: true };
    } catch (e) { return fail(e); }
  }

  /** Writes the folder the way it is shown: under the home folder as ~/…, so the setting is portable. */
  portablePath(path: string): string {
    const h = this.home.replace(/[\\/]+$/, '');
    const norm = path.replace(/\\/g, '/');
    const hn = h.replace(/\\/g, '/');
    return norm === hn ? '~' : norm.startsWith(`${hn}/`) ? `~/${norm.slice(hn.length + 1)}` : path;
  }

  async setRegistersFolder(path: string): Promise<Result> {
    if (!path.trim()) return { ok: false, error: 'Choose a folder.' };
    const problem = registersFolderProblem(this.d.platform, expandHome(path, this.home), this.d.appDataRoots ?? defaultAppDataRoots(this.home));
    if (problem) return { ok: false, error: problem };
    if (!(this.d.ensureFolder ?? ensureRealDirectory)(expandHome(path, this.home))) return { ok: false, error: 'That is not a folder on this computer.' };
    const r = await this.d.settings.set(SETTING_KEYS.registersFolder, this.portablePath(path));
    if (!r.ok) return { ok: false, error: r.error ?? 'That folder could not be used.' };
    try {
      await this.d.port.setDataRoot(this.registersFolderPath());
      this.d.changed();
      return { ok: true };
    } catch (e) { return fail(e); }
  }

  async setGetStartedHidden(hidden: boolean): Promise<Result> {
    const r = await this.d.settings.set(SETTING_KEYS.getStartedHidden, hidden);
    this.d.changed();
    return r.ok ? { ok: true } : { ok: false, error: r.error ?? 'That could not be saved.' };
  }

  finishSetup(): void {
    this.d.state.update({ setupDone: true });
    this.d.changed();
  }

  noteRan(id: string): void {
    this.d.state.noteRan(id);
    this.d.changed();
  }

  /** The folder a workshop lives in (for Show in Finder). */
  workshopFolder(id: string): string {
    return this.d.port.workshopFolder(id);
  }
}
