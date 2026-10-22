// The app's settings: the shared store (one file in the user-data folder) over the schema and the command registry.
import { open } from 'node:fs/promises';
import { commandsAdapter, valueOf, type SettingValue, type SettingsState } from '@app-patterns/settings';
import { SettingsStore } from '@app-patterns/settings/node';
import { registry } from '../shared/commands.ts';
import { APP_ID, schema, SETTING_KEYS } from '../shared/settings-schema.ts';

export const commands = commandsAdapter(registry);

export interface Settings {
  store: SettingsStore;
  ready: Promise<void>;
  get<T extends SettingValue>(key: string): T;
  /** A change made by the person in the app (logged as You). */
  set(key: string, value: SettingValue): Promise<{ ok: boolean; error?: string }>;
  /** Effective chord of every command. */
  bindings(): Record<string, string>;
  state(): SettingsState;
}

type FolderHandle = { sync(): Promise<void>; close(): Promise<void> };
/**
 * The folder sync after each save, as Windows allows it. Node opens a folder there only for reading, and Windows refuses
 * to flush a handle opened that way (EPERM), so @app-patterns/settings 0.4.1 reported every save on Windows as "could not
 * be written" although the file had been written and renamed into place. NTFS journals the rename itself; on Windows a
 * refused folder flush is therefore not an error. Every other error, and every error on other systems, still is.
 * Passed to the store as its folder opener on Windows only (the package's file-layer seam), until the package itself
 * tolerates this.
 */
export function windowsTolerantFolderSync(fh: FolderHandle, platform: NodeJS.Platform = process.platform): FolderHandle {
  if (platform !== 'win32') return fh;
  return {
    async sync() {
      try { await fh.sync(); } catch (e) {
        if (!['EPERM', 'EACCES'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e;
      }
    },
    close: () => fh.close(),
  };
}

export function openSettings(opts: { dir: string; appVersion: string; onChange?: (state: SettingsState) => void; watch?: boolean }): Settings {
  const store = new SettingsStore({
    dir: opts.dir, app: APP_ID, schema, registry: commands, appVersion: opts.appVersion,
    ...(opts.onChange ? { onChange: opts.onChange } : {}),
    ...(opts.watch === false ? { watch: false } : {}),
    log: () => { /* damaged-file notes stay out of the console; the Changes page shows what was repaired */ },
    ...(process.platform === 'win32' ? { testHooks: { openDir: async (dir: string) => windowsTolerantFolderSync(await open(dir, 'r')) } } : {}),
  });
  return {
    store,
    ready: store.ready,
    get: <T extends SettingValue>(key: string): T => valueOf(store.view(), schema, key) as T,
    async set(key, value) {
      const r = await store.set(key, value);
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    },
    bindings: () => ({ ...registry.bindingsOf(store.view().keys) }),
    state: () => store.view(),
  };
}

export { SETTING_KEYS };
