// Preload of the main window (sandboxed, context-isolated, no Node): the app's actions as one small API, nothing else.
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { AppSnapshot, AttendWellApi, CH, SessionAction, UpdateAction } from '../shared/ipc.ts';
import type { SessionView } from '../shared/session-model.ts';

// Channel names are written here, not imported: a sandboxed preload must be one file, and a shared module would become a second one.
// `satisfies` keeps each string equal to the one in shared/ipc.ts.
const C = {
  state: 'attendwell:state', changed: 'attendwell:changed', command: 'attendwell:command', runCommand: 'attendwell:run-command',
  createWorkshop: 'attendwell:create-workshop', openWorkshop: 'attendwell:open-workshop', createExample: 'attendwell:create-example',
  removeExample: 'attendwell:remove-example', chooseFolder: 'attendwell:choose-folder', setRegistersFolder: 'attendwell:set-registers-folder',
  finishSetup: 'attendwell:finish-setup', setGetStartedHidden: 'attendwell:set-get-started-hidden', noteRan: 'attendwell:note-ran',
  rebind: 'attendwell:rebind', sessionView: 'attendwell:session-view', sessionChanged: 'attendwell:session-changed', sessionAction: 'attendwell:session-action',
  quitRequested: 'attendwell:quit-requested', updateAction: 'attendwell:update-action', updateNotes: 'attendwell:update-notes', view: 'attendwell:view',
} as const satisfies Partial<typeof CH>;

const listen = <T>(channel: string, cb: (v: T) => void): (() => void) => {
  const l = (_e: unknown, v: T): void => cb(v);
  ipcRenderer.on(channel, l);
  return () => { ipcRenderer.removeListener(channel, l); };
};

const api: AttendWellApi = {
  state: () => ipcRenderer.invoke(C.state),
  onChanged: (cb) => listen<AppSnapshot>(C.changed, cb),
  onCommand: (cb) => listen<string>(C.command, cb),
  runCommand: (id, arg) => ipcRenderer.invoke(C.runCommand, id, arg),
  reportView: (v) => ipcRenderer.invoke(C.view, v),
  createWorkshop: (input) => ipcRenderer.invoke(C.createWorkshop, input),
  openWorkshop: (id) => ipcRenderer.invoke(C.openWorkshop, id),
  createExample: () => ipcRenderer.invoke(C.createExample),
  removeExample: () => ipcRenderer.invoke(C.removeExample),
  chooseFolder: () => ipcRenderer.invoke(C.chooseFolder),
  setRegistersFolder: (p) => ipcRenderer.invoke(C.setRegistersFolder, p),
  finishSetup: () => ipcRenderer.invoke(C.finishSetup),
  setGetStartedHidden: (h) => ipcRenderer.invoke(C.setGetStartedHidden, h),
  noteRan: (id) => ipcRenderer.invoke(C.noteRan, id),
  rebind: (id, chord) => ipcRenderer.invoke(C.rebind, id, chord),
  update: (a: UpdateAction) => ipcRenderer.invoke(C.updateAction, a),
  loadNotes: (v) => ipcRenderer.invoke(C.updateNotes, v),
  sessionView: () => ipcRenderer.invoke(C.sessionView),
  onSession: (cb) => listen<SessionView>(C.sessionChanged, cb),
  sessionAct: (a: SessionAction) => ipcRenderer.invoke(C.sessionAction, a),
  sheetAct: (a: SessionAction) => ipcRenderer.invoke(C.sessionAction, a),
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  onQuitRequested: (cb) => listen<null>(C.quitRequested, () => cb()),
};

contextBridge.exposeInMainWorld('attendwell', api);
