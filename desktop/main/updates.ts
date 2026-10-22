// Update notices (App Patterns @app-patterns/updates): tell and link, never install. A daily check of techczech.github.io/attendwell/updates.json
// (placeholder address), no check while a check-in session is live, and the "Updated" mark with notes that ship inside the app.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  copySource, createUpdateChecker, parseWhatsNew, readUpdateState,
  type FeedAnswer, type UpdateChecker, type UpdateIdentity, type UpdateSnapshot, type WhatsNewItem,
} from '@app-patterns/updates';
import type { AppStateFile } from './app-state.ts';

export const UPDATE_IDENTITY: UpdateIdentity = { appName: 'AttendWell', feedUrl: 'https://techczech.github.io/attendwell/updates.json' };

export interface UpdateServiceDeps {
  running: string;
  platform: string;
  packaged: boolean;
  state: AppStateFile;
  /** The setting "Check for new versions". */
  enabled(): boolean;
  /** A check-in session is live. */
  isBusy(): boolean;
  /** Where the notes for each version ship: <dir>/<version>.md. */
  notesDir: string;
  fetchFeed(): Promise<FeedAnswer>;
  changed(snapshot: UpdateSnapshot): void;
  now?: () => number;
}

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export interface UpdateService {
  checker: UpdateChecker;
  loadNotes(version: string): WhatsNewItem[] | null;
}

export function createUpdateService(d: UpdateServiceDeps): UpdateService {
  // A pre-release (1.0.0-alpha.1) shows the notes of the release it leads to (1.0.0) unless it ships notes of its own.
  const notesPath = (version: string): string | null => {
    if (!VERSION.test(version)) return null;
    const own = join(d.notesDir, `${version}.md`);
    const base = join(d.notesDir, `${version.split('-')[0]}.md`);
    return !existsSync(own) && existsSync(base) ? base : own;
  };
  const checker = createUpdateChecker({
    identity: UPDATE_IDENTITY,
    running: d.running,
    platform: d.platform,
    // An unpackaged (development) run never asks the network; the packaged build downloaded from the website does.
    source: copySource({ packaged: d.packaged, store: false, running: d.running }),
    fetchFeed: d.fetchFeed,
    readState: () => readUpdateState(d.state.get().update, UPDATE_IDENTITY.feedUrl),
    writeState: (s) => { d.state.update({ update: s }); },
    enabled: d.enabled,
    isBusy: d.isBusy,
    hadConfiguration: () => d.state.existedAtStart,
    hasNotes: (v) => { const p = notesPath(v); return p !== null && existsSync(p); },
    now: d.now ?? Date.now,
    changed: d.changed,
  });
  return {
    checker,
    loadNotes(version) {
      const p = notesPath(version);
      if (!p || !existsSync(p)) return null;
      const items = parseWhatsNew(readFileSync(p, 'utf8'));
      return items.length ? items : null;
    },
  };
}
