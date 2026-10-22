// The window a workshop opens into (direction A, Register first): the register fills the window; the right column holds the connection,
// the paired iPads and the Pair an iPad button. What it shows is decided by the view models in shared/ (register, devices, session).
import { useEffect, useMemo, useRef } from 'react';
import { repairBanner, repairTargets } from '../../shared/devices-model.ts';
import { clockOf, summaryOf, type RegisterView } from '../../shared/register-model.ts';
import { connectionModel, pairAvailability, pastBanner, toolbarModel, type SessionView } from '../../shared/session-model.ts';
import type { WorkshopSummary } from '../../shared/runtime-types.ts';
import { longDate, shortPath, timeRange } from '../../shared/workshops.ts';
import { Icon } from './icons.tsx';
import { Keys } from './Keys.tsx';
import { ConnectionPanel, DevicesPanel, PairButton } from './Rail.tsx';
import { RegisterPanel, type RegisterUi } from './RegisterPanel.tsx';

export interface SessionActions {
  onUi(patch: Partial<RegisterUi>): void;
  onShowAll(): void;
  onStart(): void;
  onEnd(): void;
  onReopen(): void;
  onAdd(): void;
  onPair(targetId?: string): void;
  onCopyAddress(): void;
  onRetry(): void;
  onMark(id: string, present: boolean): void;
  onResolve(id: string, action: 'check-in' | 'dismiss'): void;
  onExport(): void;
  onReview(): void;
  onSelectDevice(id: string): void;
  onRenameDevice(id: string): void;
  onRevokeDevice(id: string): void;
  onDismissHold(id: number): void;
  onChooseFolder(): void;
  onPasteNames(): void;
  onImportNames(): void;
  onImportRecovery(): void;
}

export interface SessionScreenProps {
  sv: SessionView;
  workshop: WorkshopSummary | null;
  register: RegisterView;
  ui: RegisterUi;
  selectedDeviceId: string | null;
  searchTick: number;
  bindings: Record<string, string>;
  platform: 'mac' | 'win';
  now: number;
  actions: SessionActions;
}

export function SessionScreen(p: SessionScreenProps): JSX.Element {
  const { sv, workshop: w, actions: a } = p;
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => { if (p.searchTick > 0) search.current?.focus(); }, [p.searchTick]);
  const tb = toolbarModel(sv.phase);
  const live = sv.phase === 'connecting' || sv.phase === 'online' || sv.phase === 'trouble' || sv.phase === 'ending';
  const conn = connectionModel({ phase: sv.phase, runtime: sv.runtime, lastOnlineAt: sv.lastOnlineAt, closedAt: sv.closedAt, failedAt: sv.failedAt, lastAddress: sv.lastAddress, addressChangedAt: sv.addressChangedAt });
  const avail = pairAvailability(sv.phase, sv.runtime, sv.otherLive);
  const devices = sv.devices?.devices ?? [];
  const targets = useMemo(() => (live ? repairTargets(devices, sv.addressSince) : []), [live, devices, sv.addressSince]);
  const banner = sv.phase === 'online' ? repairBanner(targets, sv.addressSince) : null;
  const repairIds = useMemo(() => new Set(targets.map((d) => d.id)), [targets]);
  const roster = sv.roster ?? { participants: [], conflicts: [] };
  const sum = summaryOf(roster);
  const editable = sv.registerOpen && live && sv.phase !== 'ending';
  const readOnlyBanner = sv.phase === 'past' && w ? pastBanner(w) : sv.phase === 'ready' ? (sv.otherLive ? "Check-in is open for another workshop. End it there before starting this one." : 'Check-in has not started. Start check-in to open the check-in address.') : null;
  const pairLabel = banner?.targetId && targets.length === 1 ? `Pair ${targets[0]!.label} again` : 'Pair an iPad';
  const pairChord = p.bindings['ipad.pair'] ?? '';
  const sub = w ? [longDate(w.date), timeRange(w.startTime, w.endTime)].filter(Boolean).join(' · ') : '';
  const showSummary = sv.phase === 'closed';

  return (
    <>
      <div className="toolbar">
        <button type="button" className="btn icon" onClick={a.onShowAll} aria-label="Show all workshops" title="Show all workshops"><Icon name="library" size={18} /></button>
        <div className="wt"><b>{w?.title ?? 'Workshop'}</b><small>{sub}</small></div>
        <label className="search">
          <Icon name="search" size={16} />
          <input ref={search} value={p.ui.query} placeholder="Search people" aria-label="Search people" onChange={(e) => a.onUi({ query: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Escape') { a.onUi({ query: '' }); (e.target as HTMLInputElement).blur(); } }} />
          <Keys chord={p.bindings['register.find'] ?? ''} platform={p.platform} />
        </label>
        <button type="button" className="btn" disabled={tb.addPerson === 'disabled' || !sv.registerOpen} onClick={a.onAdd}><Icon name="user-plus" />Add person</button>
        {tb.end ? <button type="button" className="btn danger" onClick={a.onEnd} disabled={sv.busy}><Icon name="power" />End check-in</button> : null}
        {tb.closedMarker ? <span className="btn marker" aria-label="Check-in closed"><Icon name="circle-check" />Check-in closed</span> : null}
        {tb.readOnlyMarker ? <span className="btn marker" aria-label="Read only"><Icon name="lock" />Read only</span> : null}
        {tb.readOnlyMarker && roster.participants.length > 0 ? <button type="button" className="btn" onClick={a.onExport}><Icon name="file-down" />Export CSV</button> : null}
        {tb.start ? <button type="button" className="btn primary" onClick={a.onStart} disabled={sv.busy || sv.otherLive} title={sv.otherLive ? "Another workshop's check-in is open. End it first." : undefined}><Icon name="play" />Start check-in</button> : null}
        {tb.reopen ? <button type="button" className="btn" onClick={a.onReopen} disabled={sv.busy || sv.otherLive} title={sv.otherLive ? "Another workshop's check-in is open. End it first." : undefined}><Icon name="rotate-ccw" />Reopen check-in</button> : null}
      </div>
      <div className="main">
        <RegisterPanel view={p.register} ui={p.ui} phase={sv.phase} editable={editable} readOnlyBanner={readOnlyBanner}
          summary={showSummary ? { closedAt: clockOf(sv.closedAt), arrived: sum.here, total: sum.total, walkIns: sum.walkIns, held: sum.held } : null}
          repair={banner} repairChord={pairChord} platform={p.platform} rosterError={sv.rosterError} busy={sv.busy}
          onUi={a.onUi} onMark={a.onMark} onResolve={a.onResolve} onRepair={() => a.onPair(banner?.targetId ?? undefined)} onExport={a.onExport} onReview={a.onReview}
          canAddNames={sv.phase !== 'ending'} onPasteNames={a.onPasteNames} onImportNames={a.onImportNames} />
        <aside className="rail" aria-label="Connection and iPads">
          <ConnectionPanel model={conn} host={sv.hostName} compact={devices.length >= 4} onCopy={a.onCopyAddress} onRetry={a.onRetry} onChooseFolder={a.onChooseFolder} />
          <DevicesPanel list={sv.devices} live={live && sv.phase !== 'ending'} closedAt={sv.closedAt} repair={repairIds} now={p.now} selectedId={p.selectedDeviceId}
            canAct={editable} onSelect={a.onSelectDevice} onRename={a.onRenameDevice} onPairAgain={(id) => a.onPair(id)} onRevoke={a.onRevokeDevice} onDismissHold={a.onDismissHold}
            canImport={sv.phase !== 'ending'} onImportRecovery={a.onImportRecovery} />
          <PairButton avail={avail} label={pairLabel} chord={pairChord} platform={p.platform} onClick={() => a.onPair(banner?.targetId ?? undefined)} />
        </aside>
      </div>
    </>
  );
}

export const sessionStatusText = (folderPath: string, home: string, id: string): string => `Saved on this laptop · ${shortPath(folderPath, home)}/${id}`;
