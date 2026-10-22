// The one settings schema (App Patterns @app-patterns/settings): the Settings window's sections, rows, search, reset and the changelog all come from it.
// Sections: General, Appearance and Shortcuts (shared); Workshops (this app; Connection is a custom page); Changes and About (pinned).
import { defineSchema, type SettingValue } from '@app-patterns/settings';
import { defaultRegistersFolder, registersFolderProblem, windowsAppDataRoots } from './registers-folder.ts';

export const APP_ID = 'attendwell';
export const APP_NAME = 'AttendWell';
export const CLI_NAME = 'attendwell';

/** Written portably; `expandHome` makes it a real path. The default depends on the platform (registers-folder.ts). */
// Windows: from the same Local AppData root that validates a choice (%LOCALAPPDATA%), when the environment is readable.
const windowsEnv = typeof process !== 'undefined' && process.platform === 'win32' ? process.env : null;
export const DEFAULT_REGISTERS_FOLDER = windowsEnv
  ? defaultRegistersFolder('win', windowsEnv.USERPROFILE ? { home: windowsEnv.USERPROFILE, localAppData: windowsAppDataRoots({ home: windowsEnv.USERPROFILE, appData: windowsEnv.APPDATA, localAppData: windowsEnv.LOCALAPPDATA })[1] } : undefined)
  : defaultRegistersFolder('mac');

export const SETTING_KEYS = {
  openLast: 'general.openLastWorkshop',
  getStartedHidden: 'general.getStartedHidden',
  checkForUpdates: 'updates.checkForNewVersions',
  textSize: 'appearance.textSize',
  registersFolder: 'workshops.registersFolder',
} as const;

const choice = (pairs: Array<[string, string]>): Array<{ value: string; label: string }> => pairs.map(([value, label]) => ({ value, label }));

export function expandHome(path: string, home: string): string {
  if (path === '~') return home;
  if (path.startsWith('~/')) return `${home.replace(/[\\/]+$/, '')}/${path.slice(2)}`;
  return path;
}

/** The registers folder must be an existing folder (not a file or a link). With no way to check, it is refused rather than trusted. */
const folderHere = (v: SettingValue, env: { isDirectory?(p: string): boolean; home?: unknown; platform?: unknown; appDataRoots?: unknown }): string | null => {
  if (typeof v !== 'string') return 'Choose a folder';
  if (!env.isDirectory) return 'That folder could not be checked';
  const home = typeof env.home === 'string' ? env.home : '';
  if (env.platform === 'win') {
    const roots = Array.isArray(env.appDataRoots) ? env.appDataRoots.filter((r): r is string => typeof r === 'string') : [];
    const problem = registersFolderProblem('win', expandHome(v, home), roots);
    if (problem) return problem;
  }
  return env.isDirectory(expandHome(v, home)) ? null : 'That folder is not on this computer';
};

export const schema = defineSchema({
  app: APP_ID,
  sections: [{ id: 'workshops', label: 'Workshops', icon: 'folder' }],
  settings: [
    {
      key: SETTING_KEYS.openLast, label: 'Open the last workshop at launch', section: 'general', group: 'Opening', type: 'toggle', default: false,
      help: 'When off, AttendWell opens on the list of workshops.',
    },
    {
      key: SETTING_KEYS.getStartedHidden, label: 'Hide the Get started button', section: 'general', group: 'Getting started', type: 'toggle', default: false,
      help: 'The Get started button in the title bar goes once you have removed the example or hidden it. Turn this off to show the button again.',
    },
    {
      key: SETTING_KEYS.checkForUpdates, label: 'Check for new versions', section: 'general', group: 'Updates', type: 'toggle', default: true,
      help: 'Once a day AttendWell reads techczech.github.io/attendwell/updates.json. It sends nothing but the request; the site sees this computer’s internet address. No check runs while check-in is open.',
    },
    {
      key: SETTING_KEYS.textSize, label: 'Text size', section: 'appearance', type: 'choice', default: 'normal',
      options: choice([['normal', 'Normal'], ['large', 'Large'], ['extra-large', 'Extra large']]),
      help: 'The size of the text in the AttendWell window.',
    },
    {
      key: SETTING_KEYS.registersFolder, label: 'Registers folder', section: 'workshops', group: 'Registers', type: 'path', default: DEFAULT_REGISTERS_FOLDER,
      help: 'The folder that holds one folder per workshop: its details, its register and a note of where its name list came from. Past sessions stay here. Names and email addresses never leave this computer.',
      canApply: folderHere,
    },
  ],
});

/** Row hints for the Settings window (short line under the label, control style). */
export const ROW_HINTS: Record<string, { control?: 'segmented'; summary?: string; example?: string }> = {
  [SETTING_KEYS.openLast]: { summary: 'When off, AttendWell opens on the list of workshops', example: 'on' },
  [SETTING_KEYS.getStartedHidden]: { summary: 'The Get started button in the title bar', example: 'on' },
  [SETTING_KEYS.checkForUpdates]: { summary: 'Once a day; no check while check-in is open', example: 'off' },
  [SETTING_KEYS.textSize]: { control: 'segmented', summary: 'Text in the AttendWell window', example: 'large' },
  [SETTING_KEYS.registersFolder]: { summary: 'One folder per workshop', example: '~/Documents/AttendWell' },
};

/** The text size choice as a root font-size in pixels. */
export const TEXT_SIZE_PX: Record<string, number> = { normal: 13, large: 15, 'extra-large': 17 };
