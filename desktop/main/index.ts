// AttendWell main process: the windows, the menu, the Settings host, update notices, and the IPC the renderer uses.
// Test mode (ATTENDWELL_TEST=1): windows are created hidden, the Dock icon is hidden, the Keychain is mocked, and nothing
// opens Finder, a browser or a dialog, so a headless run never shows anything on the screen. The runtime (register, gateway, quick
// tunnel; desktop/runtime) runs here in the main process; test mode uses the fake unless ATTENDWELL_RUNTIME=real.
import { writeFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, net, session, shell, type IpcMainInvokeEvent, type MenuItemConstructorOptions } from 'electron';
import { installSettingsWith, type SettingsHost, type BrowserWindowCtor, type DialogLike, type ElectronDeps, type IpcMainLike, type MenuLike } from '@app-patterns/settings-electron';
import { createElectronFeedFetcher, createUpdateLinkOpener } from '@app-patterns/updates/electron';
import type { UpdateSnapshot } from '@app-patterns/updates';
import { registry, MENU_DECLS, type CommandCtx, type ViewName } from '../shared/commands.ts';
import { buildAppMenu } from '../shared/menu.ts';
import { APP_NAME, SETTING_KEYS, schema } from '../shared/settings-schema.ts';
import { CH, MAIN_COMMANDS, parseSessionAction, type AppSnapshot, type ConnectionView, type UpdateAction } from '../shared/ipc.ts';
import { reviewRecipients, registerCsv } from '../shared/register-model.ts';
import { NO_SELECTION, sessionCtxOf, type SessionSelection } from '../shared/session-model.ts';
import type { ConnectionTest } from '../shared/runtime-types.ts';
import { AppStateFile } from './app-state.ts';
import { openAppLog, runtimeChangeLogger } from './app-log.ts';
import { Controller } from './controller.ts';
import { effectiveRegistersFolder, windowsAppDataRoots } from '../shared/registers-folder.ts';
import { createRuntimeBundle } from './runtime-factory.ts';
import { SessionService, quitPlan } from './session-service.ts';
import { NamesService } from './names-service.ts';
import { openSettings } from './settings.ts';
import { guardedExternal, isRealDirectory, revealFolder } from './safe-paths.ts';
import { effectiveEnv, readTestBuildMarker } from './test-mode.ts';
import { UPDATE_IDENTITY, createUpdateService } from './updates.ts';

// Test switches are read through this environment only (main/test-mode.ts): a release build sees none of them.
const ENV = effectiveEnv({ isPackaged: app.isPackaged, testBuild: readTestBuildMarker(app.getAppPath()) });
const TEST = ENV.ATTENDWELL_TEST === '1';

if (ENV.ATTENDWELL_USER_DATA) app.setPath('userData', ENV.ATTENDWELL_USER_DATA);
app.setName(APP_NAME);
// Chromium's Keychain use is mocked in test mode (a real Keychain call can raise a dialog); the app itself stores no secrets in release 1.
if (TEST) app.commandLine.appendSwitch('use-mock-keychain');
if (TEST) app.dock?.hide();

const platform: 'mac' | 'win' = process.platform === 'darwin' ? 'mac' : 'win';
let mainWindow: BrowserWindow | null = null;
let host: SettingsHost | null = null;
let view: { view: ViewName; selectedWorkshop: boolean } = { view: 'library', selectedWorkshop: false };
let selection: SessionSelection = NO_SELECTION;
let shuttingDown = false;
/** The runtime has finished shutting down (session ended, register and tunnel stopped): only then may the app exit. */
let shutdownDone = false;
/** The person confirmed Quit while check-in was open (or nothing was open): the next quit goes straight through. */
let quitConfirmed = false;

const rendererUrl = (page: string): string => {
  const dev = process.env.ELECTRON_RENDERER_URL;
  if (dev && !app.isPackaged) return `${dev.replace(/\/+$/, '')}/${page}`;
  return pathToFileURL(join(__dirname, '../renderer', page)).href;
};

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showMain());
  void app.whenReady().then(start);
}

function showMain(): void {
  if (TEST) return;
  if (!mainWindow || mainWindow.isDestroyed()) { createMainWindow(); return; }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1360, height: 792, minWidth: 1000, minHeight: 620, title: APP_NAME, backgroundColor: '#e6ebf0', show: false,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false },
  });
  win.once('ready-to-show', () => { if (!TEST) win.show(); });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => { if (url !== win.webContents.getURL()) e.preventDefault(); });
  win.on('closed', () => { if (mainWindow === win) mainWindow = null; });
  void win.loadURL(rendererUrl('index.html'));
  mainWindow = win;
  return win;
}

const isMainSender = (e: IpcMainInvokeEvent): boolean =>
  mainWindow !== null && !mainWindow.isDestroyed() && e.sender === mainWindow.webContents && e.senderFrame === mainWindow.webContents.mainFrame;

async function start(): Promise<void> {
  const userData = app.getPath('userData');
  const version = app.getVersion();
  const state = new AppStateFile(userData);
  let controller: Controller | null = null;
  let checkerRef: ReturnType<typeof createUpdateService> | null = null;
  // Changes made while the app is still starting up (the test-mode folder) have nobody to tell yet.
  let wired = false;

  const settings = openSettings({
    dir: userData, appVersion: version,
    onChange: (s) => { if (!wired) return; host?.storeChanged(s); rebuildMenu(); checkerRef?.checker.settingChanged(); pushState(); },
  });
  await settings.ready;
  // Test mode only: a run is pointed at a temporary registers folder, so nothing is ever written into the real Documents folder.
  if (TEST && ENV.ATTENDWELL_REGISTERS) await settings.set(SETTING_KEYS.registersFolder, ENV.ATTENDWELL_REGISTERS);

  // Windows: the AppData roots that bound the registers folder and give its default (Electron's AppData folder, %LOCALAPPDATA%).
  const appDataRoots = platform === 'win' ? windowsAppDataRoots({ home: homedir(), appData: app.getPath('appData'), localAppData: process.env.LOCALAPPDATA }) : [];
  const folder = effectiveRegistersFolder(platform, settings.get<string>(SETTING_KEYS.registersFolder), appDataRoots, homedir());
  // The compiled register and cloudflared: beside the app when packaged (extraResources), desktop/resources in development.
  const resourcesRoot = app.isPackaged ? process.resourcesPath : join(__dirname, '../../resources');
  // The diagnostic log (main/app-log.ts): the register's and cloudflared's output, the check-in's states and failed actions.
  const appLog = openAppLog(userData);
  appLog.write(`AttendWell ${version} started (${app.isPackaged ? 'packaged' : 'development'}, ${process.platform} ${process.arch}); registers folder ${folder}; programs in ${resourcesRoot}.`);
  const bundle = createRuntimeBundle({ dataRoot: expandForPort(folder), resourcesRoot, env: ENV, log: (line) => appLog.write(line) });
  const port = bundle.port;
  port.status.onChange(runtimeChangeLogger((line) => appLog.write(line)));
  // Test mode only: the screenshot script drives the fake runtime from here (a global is not reachable from the window).
  if (TEST && bundle.fake) (globalThis as { __attendwellFake?: unknown }).__attendwellFake = bundle.fake;
  // Test mode only: the live smoke check reads the runtime's state and its own children's process IDs (never the organiser key).
  if (TEST && bundle.real) {
    const real = bundle.real;
    (globalThis as { __attendwellDiag?: unknown }).__attendwellDiag = { status: () => port.status.get(), childPids: () => real.childPids(), lastShutdown: () => real.lastShutdown() };
  }
  const busy = (): boolean => port.status.get().session !== 'idle';

  const feed = createElectronFeedFetcher(UPDATE_IDENTITY, { net: net as never, session: session as never });
  const updates = createUpdateService({
    running: version, platform: process.platform, packaged: app.isPackaged, state,
    enabled: () => settings.get<boolean>(SETTING_KEYS.checkForUpdates),
    isBusy: busy,
    notesDir: app.isPackaged ? join(process.resourcesPath, 'whats-new') : join(__dirname, '../../resources/whats-new'),
    fetchFeed: feed,
    changed: (snap) => pushUpdate(snap),
  });
  checkerRef = updates;
  const openLink = createUpdateLinkOpener(TEST ? { openExternal: async () => undefined } : guardedExternal(shell), UPDATE_IDENTITY, () => updates.checker.snapshot().state.latest);

  const sess = new SessionService({
    port, organiser: bundle.organiser, hostName: hostname().replace(/\.local$/, ''), log: (line) => appLog.write(line),
    changed: () => { send(CH.sessionChanged, sess.view()); pushState(); rebuildMenu(); },
  });

  // Name lists and iPad recovery files for the workshop on screen. Files are read here; the window only ever sees the preview.
  const names = new NamesService({
    port, organiser: bundle.organiser,
    written: async (id) => { await sess.reloadRegister(id); pushState(); rebuildMenu(); },
  });
  /** The file chooser for a names or recovery sheet. Test mode shows no dialog: it answers the file named in ATTENDWELL_TEST_NAMES_FILE or ATTENDWELL_TEST_RECOVERY_FILE, or nothing. */
  async function chooseFile(title: string, filters: Array<{ name: string; extensions: string[] }>, testFile?: string): Promise<string | null> {
    if (TEST) return testFile || null;
    const options = { title, filters, properties: ['openFile' as const] };
    const r = await (mainWindow ? dialog.showOpenDialog(mainWindow, options) : dialog.showOpenDialog(options));
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
  }

  controller = new Controller({
    port, settings, state, platform, version, appDataRoots, onOpen: async (id) => { await sess.show(id); },
    updateSnapshot: () => updates.checker.snapshot(),
    changed: () => { pushState(); rebuildMenu(); },
  });
  const ctl = controller;

  // ---- windows ----------------------------------------------------------------------------------------------------------------
  const send = (channel: string, payload: unknown): void => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed() && !w.webContents.isDestroyed()) w.webContents.send(channel, payload);
  };
  function pushState(): void {
    void ctl.snapshot().then((s: AppSnapshot) => send(CH.changed, s));
    void connectionView().then((v) => send(CH.connectionChanged, v));
  }
  function pushUpdate(snap: UpdateSnapshot): void {
    send(CH.updateChanged, snap);
    pushState();
  }
  async function connectionView(): Promise<ConnectionView> {
    const snap = port.status.get();
    const all = await port.workshops.list();
    const w = [...all.today, ...all.upcoming, ...all.past].find((x) => x.id === snap.workshopId);
    return { tunnel: snap.tunnel, workshopTitle: w?.title ?? null, testAvailable: typeof port.testConnection === 'function' };
  }
  port.status.onChange(() => { updates.checker.busyChanged(); pushState(); });

  // ---- Settings host ----------------------------------------------------------------------------------------------------------
  // The host's own menu is not used: the shim swallows it, and the menu below (shared/menu.ts) is installed instead, so the order and
  // wording follow the locked design.
  const deps: ElectronDeps = {
    ipcMain: ipcMain as unknown as IpcMainLike,
    BrowserWindow: BrowserWindow as unknown as BrowserWindowCtor,
    dialog: (TEST ? { showSaveDialog: async () => ({ canceled: true }), showOpenDialog: async () => ({ canceled: true, filePaths: [] }) } : {
      showSaveDialog: (win, o) => (win ? dialog.showSaveDialog(win as unknown as BrowserWindow, o) : dialog.showSaveDialog(o)),
      showOpenDialog: (win, o) => (win ? dialog.showOpenDialog(win as unknown as BrowserWindow, o) : dialog.showOpenDialog(o)),
    }) as DialogLike,
    Menu: { buildFromTemplate: (t) => t, setApplicationMenu: () => undefined } as MenuLike,
  };
  host = installSettingsWith(deps, {
    app, store: settings.store, schema, registry, menus: MENU_DECLS, appName: APP_NAME,
    openMain: showMain, sendCommand: (id) => send(CH.command, id),
    extraSections: ['connection'],
    applyEnv: { pathExists: isRealDirectory, isDirectory: isRealDirectory, home: homedir(), platform, appDataRoots },
    appInfo: { icon: 'scan-line', cli: 'attendwell' },
    checkForUpdates: async () => { await updates.checker.checkNow(); },
    window: { preload: join(__dirname, '../preload/settings.js'), url: rendererUrl('settings.html'), showOnReady: !TEST },
  });

  // ---- commands ---------------------------------------------------------------------------------------------------------------
  function menuCtx(): CommandCtx {
    const s = state.get();
    return {
      view: view.view, workshopCount: lastCount, selectedWorkshop: view.selectedWorkshop, liveSession: busy(),
      exampleOffered: s.exampleId !== null && !s.exampleRemoved, whatsNewAvailable: updates.checker.snapshot().whatsNew !== null,
      session: view.view === 'session' ? sessionCtxOf(sess.view(), selection) : null,
    };
  }
  let lastCount = 0;
  const bindings = (): Record<string, string> => settings.bindings();
  function rebuildMenu(): void {
    void port.workshops.list().then((l) => {
      lastCount = l.today.length + l.upcoming.length + l.past.length;
      const template = buildAppMenu({ platform, bindings: bindings(), ctx: menuCtx(), run: runFromMenu, appName: APP_NAME });
      Menu.setApplicationMenu(Menu.buildFromTemplate(template as MenuItemConstructorOptions[]));
    });
  }
  function runFromMenu(id: string): void {
    if (MAIN_COMMANDS.has(id)) void runMain(id);
    else { showMain(); send(CH.command, id); }
  }
  async function runMain(id: string, arg?: string): Promise<void> {
    switch (id) {
      case 'settings': host?.openSettingsWindow(); break;
      case 'export-settings': await host?.exportSettings(); break;
      case 'import-settings': host?.startImport(); break;
      case 'app.about': host?.openSettingsWindow('about'); break;
      case 'app.check-for-updates': host?.openSettingsWindow('about'); await updates.checker.checkNow(); break;
      case 'connection.test': host?.openSettingsWindow('connection'); break;
      case 'app.quit': app.quit(); break;
      case 'window.close': BrowserWindow.getFocusedWindow()?.close(); break;
      case 'workshop.reveal-folder': if (!TEST) await revealFolder(shell, ctl.registersFolderPath()); break;
      case 'workshop.reveal': if (!TEST && arg) shell.showItemInFolder(ctl.workshopFolder(arg)); break;
      default: break;
    }
  }

  // ---- IPC: main window -------------------------------------------------------------------------------------------------------
  const handle = (channel: string, fn: (e: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void => {
    ipcMain.handle(channel, (e, ...args) => {
      if (!isMainSender(e)) throw new Error('Not allowed');
      return fn(e, ...args);
    });
  };
  const str = (v: unknown, max = 500): string => { if (typeof v !== 'string' || v.length > max) throw new Error('Bad argument'); return v; };

  handle(CH.state, () => ctl.snapshot());
  handle(CH.runCommand, (_e, id, arg) => { const c = str(id, 80); if (!registry.byId(c)) throw new Error('Unknown command'); return runMain(c, arg === undefined ? undefined : str(arg, 120)); });
  handle(CH.view, (_e, v) => {
    const o = v as { view?: unknown; selectedWorkshop?: unknown; selection?: unknown };
    const name = str(o?.view, 20) as ViewName;
    if (!['first-run', 'library', 'get-started', 'session'].includes(name)) throw new Error('Bad argument');
    view = { view: name, selectedWorkshop: o.selectedWorkshop === true };
    const sel = o.selection as { person?: { held?: unknown; present?: unknown; canCheckIn?: unknown } | null; device?: { revoked?: unknown } | null } | undefined;
    selection = {
      person: sel?.person ? { held: sel.person.held === true, present: sel.person.present === true, canCheckIn: sel.person.canCheckIn === true } : null,
      device: sel?.device ? { revoked: sel.device.revoked === true } : null,
    };
    rebuildMenu();
  });
  handle(CH.createWorkshop, (_e, v) => {
    const o = v as { title?: unknown; date?: unknown; startTime?: unknown; endTime?: unknown };
    return ctl.createWorkshop({ title: str(o?.title, 200), date: str(o?.date, 10), startTime: str(o?.startTime ?? '', 5), endTime: str(o?.endTime ?? '', 5) });
  });
  handle(CH.openWorkshop, (_e, id) => ctl.openWorkshop(str(id, 120)));
  handle(CH.createExample, () => ctl.createExample());
  handle(CH.removeExample, () => ctl.removeExample());
  handle(CH.chooseFolder, async () => {
    if (TEST) return null;
    const win = mainWindow ?? undefined;
    const r = await (win
      ? dialog.showOpenDialog(win, { title: 'Choose the registers folder', defaultPath: ctl.registersFolderPath(), properties: ['openDirectory', 'createDirectory'] })
      : dialog.showOpenDialog({ title: 'Choose the registers folder', defaultPath: ctl.registersFolderPath(), properties: ['openDirectory', 'createDirectory'] }));
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
  });
  handle(CH.setRegistersFolder, (_e, p) => ctl.setRegistersFolder(str(p, 1000)));
  handle(CH.finishSetup, () => ctl.finishSetup());
  handle(CH.setGetStartedHidden, (_e, h) => ctl.setGetStartedHidden(h === true));
  handle(CH.rebind, async (_e, id, chord) => {
    const c = str(id, 80);
    if (!registry.byId(c)) throw new Error('Unknown command');
    const r = await settings.store.rebind(c, str(chord, 12));
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  });
  handle(CH.noteRan, (_e, id) => { const c = str(id, 80); if (registry.byId(c)) ctl.noteRan(c); });

  // The session screen: what it shows, and what the organiser does there.
  handle(CH.sessionView, () => sess.view());
  const copy = (text: string | null): { ok: boolean } => {
    if (!text) return { ok: false };
    if (!TEST) clipboard.writeText(text);
    return { ok: true };
  };
  handle(CH.sessionAction, async (_e, raw): Promise<unknown> => {
    const a = parseSessionAction(raw);
    switch (a.kind) {
      case 'show': return sess.show(a.workshopId);
      case 'leave': await sess.leave(); return { ok: true };
      case 'start': return sess.start();
      case 'retry': return sess.retry();
      case 'end': return sess.end();
      case 'mark': return sess.mark(a.id, a.present);
      case 'undo': return sess.undoLast();
      case 'resolve': return sess.resolve(a.id, a.action);
      case 'add': return sess.addPerson({ name: a.name, email: a.email, markHere: a.markHere });
      case 'pair-open': return sess.pairOpen({ ...(a.label ? { label: a.label } : {}), ...(a.targetDeviceId ? { targetDeviceId: a.targetDeviceId } : {}) });
      case 'pair-new': return sess.pairNew();
      case 'pair-label': return sess.setPairLabel(a.label);
      case 'pair-close': await sess.closePairing(); return { ok: true };
      case 'rename': return sess.rename(a.id, a.label);
      case 'revoke': return sess.revoke(a.id);
      case 'dismiss-hold': return sess.dismissHold(a.id);
      case 'copy': {
        const v = sess.view();
        const t = v.runtime.tunnel;
        const open = v.pairing.phase === 'open' ? v.pairing.offer : null;
        const text = a.what === 'address' ? (t.state === 'online' ? t.url : null) : a.what === 'pair-code' ? open?.shortCode ?? null
          : a.what === 'pair-address' ? open?.baseUrl ?? null : v.roster ? reviewRecipients(v.roster).bcc || null : null;
        return copy(text).ok ? { ok: true } : { ok: false, error: 'There is nothing to copy yet.' };
      }
      case 'export-csv': {
        const v = sess.view();
        if (!v.roster || !v.workshopId) return { ok: false, error: 'There is no register to export.' };
        if (TEST) return { ok: true, value: { path: null } };
        const options = { title: 'Export CSV', defaultPath: join(app.getPath('documents'), `${v.workshopId}-register.csv`), filters: [{ name: 'CSV', extensions: ['csv'] }] };
        const target = await (mainWindow ? dialog.showSaveDialog(mainWindow, options) : dialog.showSaveDialog(options));
        if (target.canceled || !target.filePath) return { ok: true, value: { path: null } };
        try { await writeFile(target.filePath, registerCsv(v.roster), 'utf8'); } catch { return { ok: false, error: 'The file could not be saved there.' }; }
        return { ok: true, value: { path: target.filePath } };
      }
      case 'names-paste': case 'names-choose-file': case 'recovery-choose-file': case 'recovery-file': {
        const id = sess.view().workshopId;
        if (!id) return { ok: false, error: 'Open a workshop first.' };
        if (a.kind === 'names-paste') return names.pastePreview(id, a.text);
        if (a.kind === 'names-choose-file') {
          const path = await chooseFile('Import names from a file', [{ name: 'Name lists (CSV, Excel, text)', extensions: ['csv', 'tsv', 'txt', 'xlsx', 'xlsm'] }], ENV.ATTENDWELL_TEST_NAMES_FILE);
          return path ? names.openFile(id, path) : { ok: true, value: null };
        }
        const path = a.kind === 'recovery-file' ? a.path : await chooseFile('Import iPad recovery file', [{ name: 'iPad recovery file', extensions: ['json'] }], ENV.ATTENDWELL_TEST_RECOVERY_FILE);
        return path ? names.openRecovery(id, path) : { ok: true, value: null };
      }
      case 'names-map': return names.remap(a.mapping);
      case 'names-add': return names.add(a.token);
      case 'recovery-import': return names.importRecovery();
      case 'names-close': case 'recovery-close': await names.close(); return { ok: true, value: null };
      case 'quit': {
        if (a.endFirst) { const r = await sess.end(); if (!r.ok) return r; }
        quitConfirmed = true;
        app.quit();
        return { ok: true };
      }
    }
  });

  // Update notices: both windows may ask (the status bar in the main window, the About card in Settings).
  const either = (e: IpcMainInvokeEvent): boolean => isMainSender(e) || host?.isSettingsWindowSender(e as never) === true;
  const guarded = (channel: string, fn: (...args: unknown[]) => unknown): void => {
    ipcMain.handle(channel, (e, ...args) => { if (!either(e)) throw new Error('Not allowed'); return fn(...args); });
  };
  guarded(CH.update, () => updates.checker.snapshot());
  guarded(CH.updateNotes, (v) => updates.loadNotes(str(v, 40)));
  guarded(CH.showNotes, () => { showMain(); send(CH.command, 'app.whats-new'); });
  guarded(CH.updateAction, async (a) => {
    const act = a as UpdateAction;
    const c = updates.checker;
    switch (act.kind) {
      case 'check': return c.checkNow();
      case 'set-enabled': { await settings.set(SETTING_KEYS.checkForUpdates, act.on === true); return c.settingChanged(); }
      case 'download': return openLink('download');
      case 'not-now': return c.notNow();
      case 'skip': return c.skip(str(act.version, 40));
      case 'stop-skipping': return c.stopSkipping();
      case 'open-notes': return openLink('notes', str(act.version, 40));
      case 'open-store': return openLink('store');
      case 'dismiss-whats-new': return c.dismissWhatsNew();
      default: throw new Error('Bad argument');
    }
  });

  // ---- IPC: Settings window, Connection page ----------------------------------------------------------------------------------
  const settingsOnly = (channel: string, fn: () => unknown): void => {
    ipcMain.handle(channel, (e) => { if (host?.isSettingsWindowSender(e as never) !== true) throw new Error('Not allowed'); return fn(); });
  };
  settingsOnly(CH.connection, () => connectionView());
  settingsOnly(CH.connectionTest, async (): Promise<ConnectionTest> => {
    if (!port.testConnection) return { ok: false, reason: 'not-available', advice: 'Test connection is not available in this version yet.' };
    try { return await port.testConnection(); } catch { return { ok: false, reason: 'failed', advice: 'The test could not run. Try again.' }; }
  });
  settingsOnly(CH.copyAddress, () => {
    const t = port.status.get().tunnel;
    if (t.state !== 'online') return false;
    if (!TEST) clipboard.writeText(t.url);
    return true;
  });

  // ---- lifecycle --------------------------------------------------------------------------------------------------------------
  wired = true;
  updates.checker.start();
  rebuildMenu();
  if (!app.isPackaged && !TEST && platform === 'mac') app.dock?.setIcon(join(__dirname, '../../build/icon.png'));
  createMainWindow();

  app.on('activate', () => { if (!TEST && BrowserWindow.getAllWindows().length === 0) createMainWindow(); });
  app.on('window-all-closed', () => { if (platform !== 'mac' || TEST) app.quit(); });
  app.on('before-quit', (e) => {
    // A second Quit while the runtime is still stopping waits for it: the register and cloudflared are never left running.
    if (shuttingDown) { if (!shutdownDone) e.preventDefault(); return; }
    // Quitting while check-in is open closes the address: the window asks first (Cancel, End check-in and quit, Quit).
    if (!TEST && !quitConfirmed && quitPlan(port.status.get()) === 'confirm') {
      e.preventDefault();
      showMain();
      send(CH.quitRequested, null);
      return;
    }
    updates.checker.stop();
    shuttingDown = true;
    sess.dispose();
    e.preventDefault();
    // A register a names sheet opened is stopped first, then the runtime.
    appLog.write('Quitting.');
    void names.close().catch(() => undefined).then(() => port.shutdown()).catch(() => undefined).finally(() => {
      const left = bundle.real?.lastShutdown() ?? [];
      appLog.write(left.length ? `Quit left something running: ${left.join(' ')}` : 'Stopped cleanly.');
      appLog.close();
      shutdownDone = true; host?.dispose(); app.quit();
    });
  });
}

function expandForPort(folder: string): string {
  return folder.startsWith('~/') ? join(app.getPath('home'), folder.slice(2)) : folder === '~' ? app.getPath('home') : folder;
}
