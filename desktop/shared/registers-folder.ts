// Where workshops live. macOS: ~/Documents/AttendWell. Windows: the register runtime only accepts a data folder inside the
// user's AppData folder (server/private-path.ts; desktop/README-runtime.md), so the default there is AppData\Local\AttendWell\Workshops
// and a folder outside AppData is refused with a plain message. Pure functions: the platform and the folders are passed in.

export type FolderPlatform = 'mac' | 'win';

export const MAC_DEFAULT_FOLDER = '~/Documents/AttendWell';
export const WIN_DEFAULT_FOLDER = '~/AppData/Local/AttendWell/Workshops';

/**
 * Windows: [AppData (Roaming), Local AppData], the folders the registers folder may sit in. The same roots give the default
 * and validate a choice. Roaming: Electron's app.getPath('appData') when given, else %APPDATA%. Local: %LOCALAPPDATA%, else
 * the Local folder beside roaming AppData, else under the home folder.
 */
export function windowsAppDataRoots(o: { home: string; appData?: string | null; localAppData?: string | null }): [string, string] {
  const home = o.home.replace(/[\\/]+$/, '');
  const roaming = o.appData || `${home}/AppData/Roaming`;
  const local = o.localAppData || (o.appData ? o.appData.replace(/[\\/]+$/, '').replace(/[^\\/]+$/, 'Local') : `${home}/AppData/Local`);
  return [roaming, local];
}

/** Windows: AttendWell\Workshops inside Local AppData, written as ~/… when that lies under the home folder (as the setting is stored). */
export function windowsDefaultFolder(localAppData: string, home: string): string {
  const local = localAppData.replace(/[\\/]+$/, '');
  const h = home.replace(/[\\/]+$/, '');
  if (h && isInsideWindows(h, local)) {
    const rel = local.slice(h.length).replace(/^[\\/]+/, '').replace(/\\/g, '/');
    return `~/${rel ? `${rel}/` : ''}AttendWell/Workshops`;
  }
  return `${local}\\AttendWell\\Workshops`;
}

/** The default folder. Windows: from the Local AppData root when it is known (see windowsAppDataRoots), else the standard place. */
export const defaultRegistersFolder = (platform: FolderPlatform, win?: { localAppData: string; home: string }): string =>
  platform === 'win' ? (win ? windowsDefaultFolder(win.localAppData, win.home) : WIN_DEFAULT_FOLDER) : MAC_DEFAULT_FOLDER;

/**
 * The folder to use for a stored setting. Windows: an empty setting, the macOS default or the standard Windows default is
 * the default derived from `appDataRoots` (the same roots that validate a choice), so a Local AppData folder in another
 * place is followed. Anything else is kept as written.
 */
export function effectiveRegistersFolder(platform: FolderPlatform, value: string | undefined | null, appDataRoots: readonly string[], home: string): string {
  if (platform !== 'win') return value || MAC_DEFAULT_FOLDER;
  if (value && value !== MAC_DEFAULT_FOLDER && value !== WIN_DEFAULT_FOLDER) return value;
  const local = appDataRoots[1] || windowsAppDataRoots({ home })[1];
  return windowsDefaultFolder(local, home);
}

export const WINDOWS_APPDATA_MESSAGE = 'On Windows the workshops folder has to be inside your AppData folder, which keeps it private to you. Choose a folder there.';

const clean = (p: string): string[] => p.replace(/\\/g, '/').split('/').filter((s, i) => s !== '' || i === 0).filter((s) => s !== '.').map((s) => s.toLowerCase());

/** True when `child` is `parent` or lies beneath it, comparing Windows paths case-insensitively with either slash. `..` is refused. */
export function isInsideWindows(parent: string, child: string): boolean {
  const a = clean(parent.replace(/[\\/]+$/, ''));
  const b = clean(child);
  if (!a.length || b.includes('..') || a.includes('..') || b.length < a.length) return false;
  return a.every((seg, i) => seg === b[i]);
}

/** Null when the folder may be used on this platform, otherwise the words to show. `appDataRoots` are the real AppData and Local AppData folders. */
export function registersFolderProblem(platform: FolderPlatform, absolutePath: string, appDataRoots: readonly string[]): string | null {
  if (platform !== 'win') return null;
  return appDataRoots.some((root) => root && isInsideWindows(root, absolutePath)) ? null : WINDOWS_APPDATA_MESSAGE;
}
