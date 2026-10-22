// The register: who is here, who is not yet, who is held for review. The list fills the window; the view model is shared/register-model.ts.
import { useState } from 'react';
import {
  FILTER_LABELS, FILTER_ORDER, SORT_LABELS, SORT_ORDER, STATUS_LABELS,
  type RegisterFilter, type RegisterRow, type RegisterSort, type RegisterView,
} from '../../shared/register-model.ts';
import type { RepairBanner } from '../../shared/devices-model.ts';
import type { SessionPhase } from '../../shared/session-model.ts';
import { Icon } from './icons.tsx';
import { Keys } from './Keys.tsx';

export interface RegisterUi { filter: RegisterFilter; sort: RegisterSort; query: string; selectedId: string | null }

export interface RegisterPanelProps {
  view: RegisterView;
  ui: RegisterUi;
  phase: SessionPhase;
  /** People can be marked and resolved (check-in open and the register answering). */
  editable: boolean;
  readOnlyBanner: string | null;
  summary: { closedAt: string | null; arrived: number; total: number; walkIns: number; held: number } | null;
  repair: RepairBanner | null;
  repairChord: string;
  platform: 'mac' | 'win';
  rosterError: string | null;
  busy: boolean;
  onUi(patch: Partial<RegisterUi>): void;
  onMark(id: string, present: boolean): void;
  onResolve(id: string, action: 'check-in' | 'dismiss'): void;
  onRepair(): void;
  onExport(): void;
  onReview(): void;
  /** Name lists can be added now (any phase but closing). */
  canAddNames: boolean;
  onPasteNames(): void;
  onImportNames(): void;
}

const CHIP: Record<string, string> = { here: 'here', 'walk-in': 'walkin', 'not-yet': 'notyet', held: 'held', waiting: 'notyet' };

function StatusChip({ row }: { row: RegisterRow }): JSX.Element {
  const icon = row.status === 'here' ? 'check' : row.status === 'walk-in' ? 'user-plus' : row.status === 'held' ? 'circle-alert' : null;
  return <span className={`rchip ${CHIP[row.status]}`}>{icon ? <Icon name={icon} size={13} /> : null}{STATUS_LABELS[row.status]}</span>;
}

export function RegisterPanel(p: RegisterPanelProps): JSX.Element {
  const [sortOpen, setSortOpen] = useState(false);
  const { view, ui } = p;
  return (
    <section className="panel register" aria-label="Register">
      <div className="reg-head">
        <div className="reg-count">
          <b>{view.headline}</b>
          <div className="progress" aria-hidden="true"><i style={{ width: `${Math.round(view.progress * 100)}%` }} /></div>
        </div>
        <div className="seg" role="group" aria-label="Show">
          {FILTER_ORDER.map((f) => (
            <button key={f} type="button" aria-pressed={ui.filter === f} onClick={() => p.onUi({ filter: f })}>{FILTER_LABELS[f]}</button>
          ))}
        </div>
        <div style={{ position: 'relative' }}>
          <button type="button" className="btn" aria-haspopup="menu" aria-expanded={sortOpen} onClick={() => setSortOpen((o) => !o)}>
            <Icon name="arrow-down-up" />{SORT_LABELS[ui.sort]}<Icon name="chevron-down" size={14} />
          </button>
          {sortOpen ? (
            <div className="menu" role="menu" style={{ right: 0, top: 40 }} onKeyDown={(e) => { if (e.key === 'Escape') setSortOpen(false); }}>
              {SORT_ORDER.map((s) => (
                <button key={s} type="button" role="menuitemradio" aria-checked={s === ui.sort} className="menu-item" onClick={() => { p.onUi({ sort: s }); setSortOpen(false); }}>
                  <span className="tick">{s === ui.sort ? <Icon name="check" size={14} /> : null}</span>{SORT_LABELS[s]}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      {p.readOnlyBanner ? <div className="reg-banner info" role="note"><Icon name="info" size={18} /><span>{p.readOnlyBanner}</span></div> : null}
      {p.summary ? (
        <div className="reg-banner summary" role="status">
          <Icon name="circle-check" size={20} />
          <b className="s-title">{p.summary.closedAt ? `Check-in closed at ${p.summary.closedAt}` : 'Check-in closed'}</b>
          <span className="s-fig"><b>{p.summary.arrived}</b> of {p.summary.total} arrived</span>
          <span className="s-fig"><b>{p.summary.walkIns}</b> {p.summary.walkIns === 1 ? 'walk-in' : 'walk-ins'}</span>
          <span className="s-fig"><b>{p.summary.held}</b> held for review</span>
          <span className="grow" />
          <button type="button" className="btn primary" onClick={p.onExport}><Icon name="file-down" />Export CSV</button>
          <button type="button" className="btn" onClick={p.onReview}><Icon name="mail" />Email review</button>
        </div>
      ) : null}
      {p.repair ? (
        <div className="reg-banner repair" role="alert">
          <Icon name="rotate-ccw" size={20} />
          <span className="r-text"><b>{p.repair.title}</b> {p.repair.body}</span>
          <button type="button" className="btn primary" onClick={p.onRepair}><Icon name="qr-code" />{p.repair.button}</button>
          {p.repair.targetId && p.repairChord ? <Keys chord={p.repairChord} platform={p.platform} /> : null}
        </div>
      ) : null}
      {p.rosterError ? <div className="banner-err" role="alert">The register could not be read: {p.rosterError}</div> : null}

      <div className="reg-cols" aria-hidden="true"><span>Name</span><span>Email</span><span>Arrived</span><span>Status</span></div>
      <div className="scroll" role="listbox" aria-label="People" aria-multiselectable="false">
        {view.empty ? (
          <div className="empty">
            <Icon name="users" size={40} />
            <h2>Add the name list for this workshop</h2>
            <p>Paste a list of names, or import a CSV or Excel file from your booking system. Names and email addresses are kept only on this laptop.</p>
            {p.canAddNames ? (
              <div className="actions">
                <button type="button" className="btn primary" onClick={p.onPasteNames}><Icon name="clipboard-paste" />Paste names…</button>
                <button type="button" className="btn" onClick={p.onImportNames}><Icon name="file-up" />Import a file…</button>
              </div>
            ) : null}
            {p.editable ? <p>Walk-ins can still be added with Add person.</p> : null}
          </div>
        ) : view.noMatch ? (
          <div className="empty"><h2>No one matches</h2><p>Change the search or the filter.</p></div>
        ) : view.rows.map((r) => (
          <div key={r.id} role="option" aria-selected={ui.selectedId === r.id} tabIndex={-1} className={`rrow ${r.status === 'held' ? 'held' : ''}`}
            data-person={r.id} onClick={() => p.onUi({ selectedId: r.id })} onDoubleClick={() => { if (p.editable && r.canCheckIn) p.onMark(r.id, true); }}>
            <div className="rname"><span className="avatar" aria-hidden="true">{r.initials}</span><b>{r.name}</b></div>
            <div className={`remail ${r.email ? '' : 'none'}`}>{r.email ?? (r.walkIn ? 'No email' : '')}</div>
            <div className="rtime">{r.arrived ?? '—'}</div>
            <div className="rstatus">
              <StatusChip row={r} />
              {p.editable && ui.selectedId === r.id && r.status !== 'held' && r.present ? (
                <button type="button" className="btn small" disabled={p.busy} onClick={(e) => { e.stopPropagation(); p.onMark(r.id, false); }}><Icon name="undo-2" size={14} />Undo</button>
              ) : null}
              {p.editable && ui.selectedId === r.id && r.canCheckIn && r.status !== 'held' ? (
                <button type="button" className="btn small" disabled={p.busy} onClick={(e) => { e.stopPropagation(); p.onMark(r.id, true); }}><Icon name="check" size={14} />Check in</button>
              ) : null}
            </div>
            {r.status === 'held' ? (
              <div className="rheld">
                <span>{r.heldReason}</span>
                <span className="grow" />
                <button type="button" className="btn small" disabled={!p.editable || p.busy || !r.inRoster} onClick={(e) => { e.stopPropagation(); p.onResolve(r.id, 'check-in'); }}><Icon name="check" size={14} />Check in</button>
                <button type="button" className="btn small" disabled={!p.editable || p.busy} onClick={(e) => { e.stopPropagation(); p.onResolve(r.id, 'dismiss'); }}>Keep not checked in</button>
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}
