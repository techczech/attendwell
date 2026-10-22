// The main window: first run, the workshops library, the Get started page, and the frame a workshop opens into. Every key and every
// menu choice goes through one function, `run`, which reads the command registry; nothing here listens for a key on its own.
import { dispatchKey } from '@app-patterns/commands';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { IDLE_CTX, registry, type CommandCtx, type ViewName } from '../../shared/commands.ts';
import { buildRegister, stepSelection, SORT_ORDER, type Roster } from '../../shared/register-model.ts';
import { repairsIn, sessionCtxOf, statusChip, type SessionSelection, type SessionView } from '../../shared/session-model.ts';
import { getStartedButton } from '../../shared/get-started.ts';
import type { AppSnapshot, SessionAction } from '../../shared/ipc.ts';
import type { NamesSheetView } from '../../shared/names-model.ts';
import { allWorkshops, countWorkshops, longDate, shortPath } from '../../shared/workshops.ts';
import { TEXT_SIZE_PX } from '../../shared/settings-schema.ts';
import { api } from './api.ts';
import { CheatSheet } from './CheatSheet.tsx';
import { CommandPalette, WorkshopSwitcher } from './CommandPalette.tsx';
import { FirstRun } from './FirstRun.tsx';
import { GetStarted } from './GetStarted.tsx';
import { Library } from './Library.tsx';
import { NewWorkshopSheet, NotesSheet } from './Sheets.tsx';
import { SessionScreen, sessionStatusText } from './SessionScreen.tsx';
import { PairSheet } from './PairSheet.tsx';
import { AddPersonSheet, EndConfirmSheet, QuitConfirmSheet, RenameSheet, ReviewSheet, RevokeSheet } from './SessionSheets.tsx';
import type { RegisterUi } from './RegisterPanel.tsx';
import { ImportNamesSheet, PasteNamesSheet, RecoverySheet } from './NamesSheets.tsx';
import { StatusBar } from './StatusBar.tsx';
import { updateActionsFor } from './updateActions.ts';

type Overlay = null | { kind: 'palette'; scope: 'all' | 'selection' } | { kind: 'switcher' } | { kind: 'cheat' } | { kind: 'new' } | { kind: 'add-person' } | { kind: 'pair' } | { kind: 'end' } | { kind: 'quit' } | { kind: 'revoke'; id: string } | { kind: 'rename'; id: string } | { kind: 'review' } | { kind: 'notes'; version: string; items: Array<{ title: string | null; text: string }> }
  | { kind: 'names-paste' } | { kind: 'names-import'; view: NamesSheetView } | { kind: 'recovery' };

/** Who the quit sheet names: the one paired iPad by its name, otherwise "the iPad". */
function quitDeviceLabel(sv: SessionView | null): string {
  const active = sv?.devices?.devices.filter((d) => d.status === 'active') ?? [];
  return active.length === 1 ? active[0]!.label : active.length > 1 ? 'your iPads' : 'the iPad';
}

const isField = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
};

export function App(): JSX.Element | null {
  const [snap, setSnap] = useState<AppSnapshot | null>(null);
  const [view, setView] = useState<ViewName | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [searchTick, setSearchTick] = useState(0);
  const [sv, setSv] = useState<SessionView | null>(null);
  const [ui, setUiState] = useState<RegisterUi>({ filter: 'all', sort: 'newest', query: '', selectedId: null });
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [regSearchTick, setRegSearchTick] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const setUi = useCallback((patch: Partial<RegisterUi>) => setUiState((u) => ({ ...u, ...patch })), []);
  const [notice, setNotice] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem('aw.recent') ?? '[]') as string[]; } catch { return []; } });
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const started = useRef(false);

  useEffect(() => {
    void api.state().then((s) => setSnap(s));
    return api.onChanged(setSnap);
  }, []);

  useEffect(() => {
    void api.sessionView().then(setSv);
    const off = api.onSession(setSv);
    const offQuit = api.onQuitRequested(() => setOverlay({ kind: 'quit' }));
    return () => { off(); offQuit(); };
  }, []);
  // The clock of the session screen (countdown of the pairing code, "last seen" ages).
  useEffect(() => {
    if (view !== 'session') return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [view]);
  useEffect(() => { setUiState({ filter: 'all', sort: 'newest', query: '', selectedId: null }); setDeviceId(null); }, [sv?.workshopId]);

  // The first view: first run until set up; the library, or the last workshop when Settings says so.
  useEffect(() => {
    if (!snap || started.current) return;
    started.current = true;
    if (!snap.setupDone) { setView('first-run'); return; }
    const last = snap.openLastWorkshop && snap.lastWorkshopId && allWorkshops(snap.listing).some((w) => w.id === snap.lastWorkshopId) ? snap.lastWorkshopId : null;
    if (last) { setSessionId(last); setView('session'); void api.openWorkshop(last); } else setView('library');
  }, [snap]);

  const readOnly = sv?.phase === 'closed' || sv?.phase === 'past';
  const register = useMemo(
    () => buildRegister(sv?.roster ?? { participants: [], conflicts: [] }, { filter: ui.filter, sort: ui.sort, query: ui.query, readOnly }),
    [sv?.roster, ui.filter, ui.sort, ui.query, readOnly],
  );
  const selection: SessionSelection = useMemo(() => {
    const row = register.rows.find((r) => r.id === ui.selectedId);
    const dev = sv?.devices?.devices.find((d) => d.id === deviceId);
    return { person: row ? { held: row.status === 'held', present: row.present, canCheckIn: row.canCheckIn } : null, device: dev ? { revoked: dev.status === 'revoked' } : null };
  }, [register.rows, ui.selectedId, sv?.devices, deviceId]);
  const selectionKey = JSON.stringify(selection);

  const ctx: CommandCtx = useMemo(() => !snap || !view ? IDLE_CTX : ({
    view, workshopCount: countWorkshops(snap.listing), selectedWorkshop: view === 'library' && selectedId !== null,
    liveSession: snap.runtime.session !== 'idle', exampleOffered: snap.exampleId !== null && !snap.exampleRemoved,
    whatsNewAvailable: snap.update.whatsNew !== null,
    session: view === 'session' && sv ? sessionCtxOf(sv, selection) : null,
  }), [snap, view, selectedId, sv, selection]);

  useEffect(() => { if (view) void api.reportView({ view, selectedWorkshop: ctx.selectedWorkshop, selection }); }, [view, ctx.selectedWorkshop, selectionKey]);
  useEffect(() => { if (snap) document.documentElement.style.setProperty('--base', `${TEXT_SIZE_PX[snap.textSize] ?? 13}px`); }, [snap?.textSize]);

  const flash = useCallback((text: string) => {
    setNotice(text);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 3500);
  }, []);

  const act = useCallback(async (a: SessionAction, okMessage?: string): Promise<string | null> => {
    const r = await api.sessionAct(a);
    if (!r.ok) { flash(r.error); return r.error; }
    if (okMessage) flash(okMessage);
    return null;
  }, [flash]);
  /** Like `act`, for sheets that show the reason themselves. */
  const actQuiet = useCallback(async (a: SessionAction): Promise<string | null> => {
    const r = await api.sessionAct(a);
    return r.ok ? null : r.error;
  }, []);
  const showAll = useCallback(() => {
    setOverlay(null);
    if (view === 'session') void api.sessionAct({ kind: 'leave' });
    setView('library');
  }, [view]);
  const open = useCallback(async (id: string) => {
    setOverlay(null);
    const r = await api.openWorkshop(id);
    if (!r.ok) { flash(r.error); return; }
    setSessionId(id);
    setView('session');
  }, [flash]);

  // The sheet shows a refusal from the register itself (its error state, with Try again). A refusal before any code was asked for
  // (the connection is not online) leaves nothing on the sheet to show, so the sheet closes and the reason appears in the status bar.
  const pairPhase = useRef<string>('idle');
  pairPhase.current = sv?.pairing.phase ?? 'idle';
  const startPair = (target?: string): void => {
    setOverlay({ kind: 'pair' });
    void actQuiet({ kind: 'pair-open', ...(target ? { targetDeviceId: target } : {}) }).then((error) => {
      if (!error || pairPhase.current === 'error') return;
      setOverlay((o) => (o?.kind === 'pair' ? null : o));
      flash(error);
    });
  };
  const exportCsv = async (): Promise<void> => {
    const r = await api.sessionAct({ kind: 'export-csv' });
    if (!r.ok) flash(r.error);
    else if (r.value.path) flash('Saved the register as a CSV file');
  };

  // Name lists and recovery files: main reads the files and previews; these open the sheets and close them again.
  const chooseNamesFile = useCallback(async (): Promise<void> => {
    const r = await api.sheetAct({ kind: 'names-choose-file' });
    if (!r.ok) { flash(r.error); return; }
    if (r.value && 'source' in r.value) setOverlay({ kind: 'names-import', view: r.value });
  }, [flash]);
  const closeSheet = useCallback((kind: 'names-close' | 'recovery-close') => { setOverlay(null); void api.sheetAct({ kind }); }, []);
  const addNames = useCallback(async (token: string) => {
    const r = await api.sheetAct({ kind: 'names-add', token });
    if (r.ok && r.value && 'source' in r.value && r.value.written) {
      const n = r.value.plan?.counts.added ?? 0;
      closeSheet('names-close');
      flash(`Added ${n} ${n === 1 ? 'person' : 'people'} to the register`);
    }
    return r;
  }, [closeSheet, flash]);
  /** From the library, the selected workshop opens first, so the list goes to the workshop on screen. */
  const withWorkshop = useCallback(async (then: () => void): Promise<void> => {
    if (view === 'library' && selectedId) { await open(selectedId); }
    then();
  }, [view, selectedId, open]);

  const run = useCallback((id: string, arg?: string) => {
    if (!snap || !view) return;
    const def = registry.byId(id);
    if (!def) return;
    const why = def.available ? def.available(ctx) : null;
    if (why) { flash(`${def.label}: ${why}`); return; }
    setRecent((r) => { const n = [id, ...r.filter((x) => x !== id)].slice(0, 6); try { localStorage.setItem('aw.recent', JSON.stringify(n)); } catch { /* storage off */ } return n; });
    switch (id) {
      case 'app.palette': setOverlay({ kind: 'palette', scope: 'all' }); return;
      case 'app.contextual': setOverlay({ kind: 'palette', scope: 'selection' }); return;
      case 'app.switcher': setOverlay({ kind: 'switcher' }); return;
      case 'cheat': setOverlay({ kind: 'cheat' }); return;
      case 'workshop.new': setOverlay({ kind: 'new' }); return;
      case 'workshop.show-all': showAll(); return;
      case 'workshop.search-all': setOverlay(null); setView('library'); setSearchTick((t) => t + 1); return;
      case 'app.get-started': case 'app.how-it-works': setOverlay(null); setView('get-started'); return;
      case 'app.remove-example': setOverlay(null); void api.removeExample().then((r) => { if (!r.ok) flash(r.error); }); return;
      case 'app.whats-new':
        void api.loadNotes(snap.update.running).then((items) => { if (items) setOverlay({ kind: 'notes', version: snap.update.running, items }); });
        return;
      case 'register.find': setOverlay(null); setRegSearchTick((t) => t + 1); return;
      case 'register.show-all': setUi({ filter: 'all' }); return;
      case 'register.show-here': setUi({ filter: 'here' }); return;
      case 'register.show-not-yet': setUi({ filter: 'not-yet' }); return;
      case 'register.show-held': setUi({ filter: 'held' }); return;
      case 'register.sort': setOverlay(null); setUi({ sort: SORT_ORDER[(SORT_ORDER.indexOf(ui.sort) + 1) % SORT_ORDER.length]! }); return;
      case 'register.next': setUi({ selectedId: stepSelection(register.rows, ui.selectedId, 1) }); return;
      case 'register.previous': setUi({ selectedId: stepSelection(register.rows, ui.selectedId, -1) }); return;
      case 'register.check-in': setOverlay(null); if (ui.selectedId) void act({ kind: 'mark', id: ui.selectedId, present: true }); return;
      case 'register.undo': setOverlay(null); void act({ kind: 'undo' }); return;
      case 'held.check-in': setOverlay(null); if (ui.selectedId) void act({ kind: 'resolve', id: ui.selectedId, action: 'check-in' }); return;
      case 'held.keep-not-checked-in': setOverlay(null); if (ui.selectedId) void act({ kind: 'resolve', id: ui.selectedId, action: 'dismiss' }); return;
      case 'person.add': setOverlay({ kind: 'add-person' }); return;
      case 'ipad.pair': {
        // Exactly one iPad needs pairing again: the same key pairs that one (ADR-0003 targetDeviceId).
        const repairs = sv ? repairsIn(sv) : [];
        startPair(repairs.length === 1 ? repairs[0]!.id : undefined);
        return;
      }
      case 'ipad.pair-again': if (deviceId) startPair(deviceId); return;
      case 'ipad.rename': if (deviceId) setOverlay({ kind: 'rename', id: deviceId }); return;
      case 'ipad.revoke': if (deviceId) setOverlay({ kind: 'revoke', id: deviceId }); return;
      case 'connection.copy-address': setOverlay(null); void act({ kind: 'copy', what: 'address' }, 'Check-in address copied'); return;
      case 'connection.retry': setOverlay(null); void act({ kind: 'retry' }); return;
      case 'checkin.end': setOverlay({ kind: 'end' }); return;
      case 'checkin.reopen': setOverlay(null); void act({ kind: 'start' }); return;
      case 'export.csv': setOverlay(null); void exportCsv(); return;
      case 'review.email': setOverlay({ kind: 'review' }); return;
      case 'names.paste': setOverlay(null); void withWorkshop(() => setOverlay({ kind: 'names-paste' })); return;
      case 'names.import': setOverlay(null); void withWorkshop(() => void chooseNamesFile()); return;
      case 'ipad.import-recovery': setOverlay({ kind: 'recovery' }); return;
      case 'workshop.open': setOverlay(null); if (selectedId) void open(selectedId); return;
      case 'workshop.reveal': setOverlay(null); if (selectedId) void api.runCommand(id, selectedId); return;
      default: setOverlay(null); void api.runCommand(id, arg); void api.noteRan(id);
    }
  }, [snap, view, ctx, selectedId, flash, showAll, open, ui, register.rows, sv, deviceId, act, setUi, withWorkshop, chooseNamesFile]);

  // The one key handler: the registry decides what a key does.
  const runRef = useRef(run);
  runRef.current = run;
  useEffect(() => {
    if (!snap) return;
    const mac = snap.platform === 'mac';
    const onKey = (e: KeyboardEvent): void => {
      const id = dispatchKey(registry, { code: e.code, metaKey: mac ? e.metaKey : e.ctrlKey, ctrlKey: mac ? e.ctrlKey : false, altKey: e.altKey, shiftKey: e.shiftKey }, snap.bindings, {
        inField: isField(e.target), onControl: (e.target as HTMLElement | null)?.tagName === 'BUTTON', overlay: overlay !== null,
        ...(view === 'session' ? { scope: 'register' } : {}),
      });
      if (!id) return;
      e.preventDefault();
      runRef.current(id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [snap, overlay, view]);
  useEffect(() => api.onCommand((id) => runRef.current(id)), []);

  useEffect(() => {
    if (overlay?.kind === 'pair' && sv && sv.phase !== 'online') { setOverlay(null); void api.sessionAct({ kind: 'pair-close' }); }
  }, [overlay, sv?.phase]);

  const actions = useMemo(() => updateActionsFor((a) => api.update(a), (v) => api.loadNotes(v), (version, items) => setOverlay({ kind: 'notes', version, items })), []);

  if (!snap || !view) return null;
  const folderPath = snap.registersFolderPath;
  const live = allWorkshops(snap.listing);
  const sessionWorkshop = live.find((w) => w.id === sessionId) ?? null;
  const gs = getStartedButton({ setupDone: snap.setupDone, exampleOpened: snap.exampleOpened, exampleRemoved: snap.exampleRemoved, hiddenSetting: snap.getStartedHidden });
  const statusLeft = view === 'session' && sessionId ? sessionStatusText(folderPath, snap.home, sessionId) : view === 'first-run' ? 'Not set up yet'
    : `${shortPath(folderPath, snap.home)} · ${countWorkshops(snap.listing) === 0 ? 'empty' : `${countWorkshops(snap.listing)} workshops`}`;

  return (
    <div className="app">
      {view === 'first-run' ? (
        <FirstRun registersFolder={snap.registersFolder} home={snap.home} today={snap.today} platform={snap.platform}
          onDone={(id) => { setSessionId(id); setView('session'); }} />
      ) : view === 'library' ? (
        <Library listing={snap.listing} today={snap.today} exampleId={snap.exampleRemoved ? null : snap.exampleId} folderPath={folderPath} home={snap.home} platform={snap.platform}
          getStarted={gs} bindings={snap.bindings} selectedId={selectedId} searchFocusTick={searchTick}
          onSelect={setSelectedId} onOpen={(id) => void open(id)} onReveal={(id) => void api.runCommand('workshop.reveal', id)}
          onNew={() => run('workshop.new')} onChooseFolder={() => void api.chooseFolder().then((p) => { if (p) void api.setRegistersFolder(p); })}
          onGetStarted={() => run('app.get-started')} onRemoveExample={() => run('app.remove-example')} />
      ) : view === 'get-started' ? (
        <GetStarted ran={snap.ran} bindings={snap.bindings} platform={snap.platform} exampleOffered={snap.exampleId !== null && !snap.exampleRemoved} hidden={snap.getStartedHidden}
          onOpenExample={() => void (async () => { const e = await api.createExample(); if (e.ok) await open(e.value.id); else flash(e.error); })()}
          onHide={() => void api.setGetStartedHidden(true)} onLibrary={showAll} />
      ) : (
        sv ? (
          <SessionScreen sv={sv} workshop={sessionWorkshop} register={register} ui={ui} selectedDeviceId={deviceId} searchTick={regSearchTick} bindings={snap.bindings} platform={snap.platform} now={now}
            actions={{
              onUi: setUi, onShowAll: showAll, onStart: () => void act({ kind: 'start' }), onEnd: () => setOverlay({ kind: 'end' }), onReopen: () => void act({ kind: 'start' }),
              onAdd: () => setOverlay({ kind: 'add-person' }), onPair: startPair, onCopyAddress: () => void act({ kind: 'copy', what: 'address' }, 'Check-in address copied'),
              onRetry: () => void act({ kind: 'retry' }), onMark: (id, present) => void act({ kind: 'mark', id, present }),
              onResolve: (id, action) => void act({ kind: 'resolve', id, action }), onExport: () => void exportCsv(), onReview: () => setOverlay({ kind: 'review' }),
              onSelectDevice: setDeviceId, onRenameDevice: (id) => setOverlay({ kind: 'rename', id }), onRevokeDevice: (id) => setOverlay({ kind: 'revoke', id }),
              onDismissHold: (id) => void act({ kind: 'dismiss-hold', id }), onChooseFolder: () => void api.chooseFolder().then((p) => { if (p) void api.setRegistersFolder(p); }),
              onPasteNames: () => run('names.paste'), onImportNames: () => run('names.import'), onImportRecovery: () => run('ipad.import-recovery'),
            }} />
        ) : null
      )}
      {view === 'first-run' ? null : <StatusBar left={statusLeft} version={snap.version} update={snap.update} actions={actions} notice={notice} chip={view === 'session' && sv ? statusChip(sv.phase) : null} />}

      {overlay?.kind === 'palette' ? (
        <CommandPalette scope={overlay.scope} ctx={ctx} bindings={snap.bindings} platform={snap.platform} recent={recent} onRun={(id) => run(id)} onClose={() => setOverlay(null)}
          onRebind={async (id, chord) => { const r = await api.rebind(id, chord); return r.ok ? null : r.error; }} />
      ) : null}
      {overlay?.kind === 'switcher' ? (
        <WorkshopSwitcher listing={snap.listing} live={snap.runtime.session !== 'idle' && snap.runtime.workshopId ? { id: snap.runtime.workshopId, here: sv?.workshopId === snap.runtime.workshopId && sv.roster ? sv.roster.participants.filter((x) => x.present).length : null, names: sv?.workshopId === snap.runtime.workshopId && sv.roster ? sv.roster.participants.length : null } : null} today={snap.today} bindings={snap.bindings} platform={snap.platform}
          onOpen={(id) => void open(id)} onShowAll={showAll} onNew={() => setOverlay({ kind: 'new' })} onClose={() => setOverlay(null)} />
      ) : null}
      {overlay?.kind === 'cheat' ? <CheatSheet bindings={snap.bindings} platform={snap.platform} onClose={() => setOverlay(null)} /> : null}
      {overlay?.kind === 'new' ? (
        <NewWorkshopSheet today={snap.today} folderPath={folderPath} home={snap.home} onClose={() => setOverlay(null)}
          onCreated={(id) => { setOverlay(null); setSelectedId(id); setView('library'); }} />
      ) : null}
      {overlay?.kind === 'add-person' ? <AddPersonSheet onClose={() => setOverlay(null)} onAdd={(p) => actQuiet({ kind: 'add', ...p })} /> : null}
      {overlay?.kind === 'pair' && sv ? (
        <PairSheet state={sv.pairing} now={now} label={sv.pairLabel} workshopLine={[sessionWorkshop?.title, sessionWorkshop ? longDate(sessionWorkshop.date) : ''].filter(Boolean).join(' · ')}
          onLabel={(label) => void actQuiet({ kind: 'pair-label', label })} onNew={() => void actQuiet({ kind: 'pair-new' })} onAnother={() => void actQuiet({ kind: 'pair-open' })}
          onCopy={(what) => void act({ kind: 'copy', what }, what === 'pair-code' ? 'Code copied' : 'Address copied')}
          onClose={() => { setOverlay(null); void api.sessionAct({ kind: 'pair-close' }); }} />
      ) : null}
      {overlay?.kind === 'end' ? (
        <EndConfirmSheet held={register.counts.held} onClose={() => setOverlay(null)}
          onEnd={() => { setOverlay(null); void api.sessionAct({ kind: 'end' }).then((r) => { if (!r.ok) flash(r.error); else if (r.value.leftovers?.length) flash('Check-in closed, but something may still be running. Quit AttendWell to be sure.'); }); }} />
      ) : null}
      {overlay?.kind === 'quit' ? (
        <QuitConfirmSheet deviceLabel={quitDeviceLabel(sv)} onCancel={() => setOverlay(null)}
          onEndAndQuit={() => { setOverlay(null); void act({ kind: 'quit', endFirst: true }); }} onQuit={() => { setOverlay(null); void act({ kind: 'quit', endFirst: false }); }} />
      ) : null}
      {overlay?.kind === 'revoke' && sv?.devices?.devices.find((d) => d.id === overlay.id) ? (
        <RevokeSheet device={sv.devices.devices.find((d) => d.id === overlay.id)!} onClose={() => setOverlay(null)} onRevoke={() => { const id = overlay.id; setOverlay(null); void act({ kind: 'revoke', id }); }} />
      ) : null}
      {overlay?.kind === 'rename' && sv?.devices?.devices.find((d) => d.id === overlay.id) ? (
        <RenameSheet device={sv.devices.devices.find((d) => d.id === overlay.id)!} onClose={() => setOverlay(null)} onRename={(label) => actQuiet({ kind: 'rename', id: overlay.id, label })} />
      ) : null}
      {overlay?.kind === 'review' && sv?.roster ? <ReviewSheet roster={sv.roster as Roster} onClose={() => setOverlay(null)} onCopy={() => void act({ kind: 'copy', what: 'review-bcc' }, 'Bcc list copied')} /> : null}
      {overlay?.kind === 'names-paste' ? (
        <PasteNamesSheet onPreview={(text) => api.sheetAct({ kind: 'names-paste', text })} onAdd={addNames} onClose={() => closeSheet('names-close')} />
      ) : null}
      {overlay?.kind === 'names-import' ? (
        <ImportNamesSheet initial={overlay.view} onMap={(mapping) => api.sheetAct({ kind: 'names-map', mapping })} onAdd={addNames} onClose={() => closeSheet('names-close')} />
      ) : null}
      {overlay?.kind === 'recovery' ? (
        <RecoverySheet onChoose={() => api.sheetAct({ kind: 'recovery-choose-file' })} onDropPath={(path) => api.sheetAct({ kind: 'recovery-file', path })}
          onImport={() => api.sheetAct({ kind: 'recovery-import' })} onClose={() => closeSheet('recovery-close')} pathForFile={(f) => api.pathForFile(f)} />
      ) : null}
      {overlay?.kind === 'notes' ? <NotesSheet version={overlay.version} items={overlay.items} onClose={() => { setOverlay(null); void api.update({ kind: 'dismiss-whats-new' }); }} /> : null}
    </div>
  );
}
