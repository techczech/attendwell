// The update card's and the status bar's actions, bound to the main process (which holds the checker and opens links; the window never supplies an address).
import type { UpdateSnapshot } from '@app-patterns/updates';
import type { UpdateActions } from '@app-patterns/updates-react';
import type { UpdateAction, UpdatesApi } from '../../shared/ipc.ts';

export function updateActionsFor(send: (a: UpdateAction) => Promise<unknown>, loadNotes: UpdatesApi['loadNotes'], showNotes: (version: string, items: Array<{ title: string | null; text: string }>) => void): UpdateActions {
  return {
    check: () => send({ kind: 'check' }) as Promise<UpdateSnapshot>,
    setEnabled: (on) => send({ kind: 'set-enabled', on }),
    download: () => send({ kind: 'download' }),
    notNow: () => send({ kind: 'not-now' }),
    skip: (version) => send({ kind: 'skip', version }),
    stopSkipping: () => send({ kind: 'stop-skipping' }),
    openNotes: (version) => send({ kind: 'open-notes', version }),
    openStore: () => send({ kind: 'open-store' }),
    dismissWhatsNew: () => send({ kind: 'dismiss-whats-new' }),
    loadNotes,
    showNotes,
  };
}
