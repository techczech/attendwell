// Rules for anything the app hands to the operating system to open. A configured path is data, not a command: it is only ever
// opened when it is an existing folder (checked without following a link), and links go out only as https to a fixed allow-list.
import { lstatSync, mkdirSync } from 'node:fs';

/** True only for a real folder: a link, a file or a missing path is refused. */
export function isRealDirectory(path: string): boolean {
  try { return lstatSync(path).isDirectory(); } catch { return false; }
}

/**
 * The registers folder must be a real folder. A path that is missing is created (the first-run default does not exist yet); a path
 * that exists as a file, a link or anything but a folder is refused and left alone.
 */
export function ensureRealDirectory(path: string): boolean {
  try {
    lstatSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return false;
    try { mkdirSync(path, { recursive: true, mode: 0o700 }); } catch { return false; }
  }
  return isRealDirectory(path);
}

export interface RevealShell {
  openPath(path: string): Promise<string>;
  showItemInFolder(path: string): void;
}

/** Show a configured folder: open it when it is a real folder, otherwise only show it in Finder (nothing is ever run). */
export async function revealFolder(shell: RevealShell, path: string, isDirectory: (p: string) => boolean = isRealDirectory): Promise<'opened' | 'shown'> {
  if (isDirectory(path)) { await shell.openPath(path); return 'opened'; }
  shell.showItemInFolder(path);
  return 'shown';
}

/** Hosts the app may open in a browser (update notes and downloads, the product site). */
export const EXTERNAL_HOSTS: readonly string[] = ['attendwell.app', 'techczech.github.io', 'github.com'];

export function isAllowedExternal(url: string, hosts: readonly string[] = EXTERNAL_HOSTS): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !u.username && !u.password && hosts.includes(u.hostname);
  } catch { return false; }
}

/** A shell whose openExternal refuses everything but the allow-list. */
export function guardedExternal(shell: { openExternal(url: string): Promise<void> }, hosts: readonly string[] = EXTERNAL_HOSTS): { openExternal(url: string): Promise<void> } {
  return { openExternal: async (url) => { if (!isAllowedExternal(url, hosts)) throw new Error('Link not allowed'); await shell.openExternal(url); } };
}
