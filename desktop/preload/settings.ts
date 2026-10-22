// Preload of the Settings window (sandboxed, so bundled into one file): the shared settings bridge (window.bridleSettings),
// the Connection page's calls and the update card's calls. Each goes one way only; every reply is a status.
import { contextBridge, ipcRenderer } from 'electron';
import { exposeSettingsBridge } from '@app-patterns/settings-electron/preload';
import type { UpdateSnapshot } from '@app-patterns/updates';
import type { CH, ConnectionApi, ConnectionView, UpdateAction, UpdatesApi } from '../shared/ipc.ts';

// Written here, not imported: see preload/index.ts.
const C = {
  connection: 'attendwell:connection', connectionChanged: 'attendwell:connection-changed', connectionTest: 'attendwell:connection-test',
  copyAddress: 'attendwell:copy-address', update: 'attendwell:update', updateChanged: 'attendwell:update-changed', updateAction: 'attendwell:update-action',
  updateNotes: 'attendwell:update-notes', showNotes: 'attendwell:show-notes',
} as const satisfies Partial<typeof CH>;

exposeSettingsBridge();

const listen = <T>(channel: string, cb: (v: T) => void): (() => void) => {
  const l = (_e: unknown, v: T): void => cb(v);
  ipcRenderer.on(channel, l);
  return () => { ipcRenderer.removeListener(channel, l); };
};

const connection: ConnectionApi = {
  view: () => ipcRenderer.invoke(C.connection),
  onChanged: (cb) => listen<ConnectionView>(C.connectionChanged, cb),
  test: () => ipcRenderer.invoke(C.connectionTest),
  copyAddress: () => ipcRenderer.invoke(C.copyAddress),
};

const updates: UpdatesApi = {
  snapshot: () => ipcRenderer.invoke(C.update),
  onChanged: (cb) => listen<UpdateSnapshot>(C.updateChanged, cb),
  action: (a: UpdateAction) => ipcRenderer.invoke(C.updateAction, a),
  loadNotes: (v) => ipcRenderer.invoke(C.updateNotes, v),
  showNotes: (v) => ipcRenderer.invoke(C.showNotes, v),
};

contextBridge.exposeInMainWorld('attendwellConnection', connection);
contextBridge.exposeInMainWorld('attendwellUpdates', updates);
