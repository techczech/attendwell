// The name-list sheets (Paste names, Import names from a file) and Import iPad recovery file, as locked in names-paste,
// names-preview and recovery-import. The window shows what main previews; it never reads a file or writes the register itself.
import { useEffect, useRef, useState } from 'react';
import type { Result, SheetAnswer } from '../../shared/ipc.ts';
import {
  addBlocked, addLabel, importTally, pasteTally, previewRows, recoveryLine, recoveryReason, resultText, sameNameText,
  type NamesMapping, type NamesSheetView, type RecoverySheetView, type TallyLine,
} from '../../shared/names-model.ts';
import { Icon } from './icons.tsx';
import { Sheet } from './SessionSheets.tsx';

type Answer = Promise<Result<SheetAnswer>>;
const asNames = (r: Result<SheetAnswer>): NamesSheetView | null => (r.ok && r.value && 'source' in r.value ? r.value : null);
const asRecovery = (r: Result<SheetAnswer>): RecoverySheetView | null => (r.ok && r.value && 'report' in r.value ? r.value : null);

const EMPTY_PASTE: NamesSheetView = { source: 'paste', filename: null, columns: null, mapping: null, plan: null, token: null, written: false, error: null };
const TALLY_ICON: Record<TallyLine['tone'], string> = { good: 'user-check', info: 'users', warn: 'circle-alert', neutral: 'x' };

function Tally({ lines, variant }: { lines: TallyLine[]; variant: 'stack' | 'cards' }): JSX.Element {
  return (
    <div className={`tally ${variant}`}>
      {lines.map((t, i) => (
        <div key={i} className={`tally-line ${t.tone}`}><Icon name={TALLY_ICON[t.tone]} size={18} /><b>{t.figure}</b><span>{t.text}</span></div>
      ))}
    </div>
  );
}

function Notes({ view }: { view: NamesSheetView | null }): JSX.Element | null {
  const plan = view?.plan;
  const items: string[] = [];
  if (view?.error) items.push(view.error);
  if (plan?.alreadyAdded) items.push(`This list was already added${plan.alreadyAdded.filename ? ` from ${plan.alreadyAdded.filename}` : ''}. Adding it again changes nothing.`);
  if (plan?.full) items.push(`The register holds up to 500 people; with this list it would hold ${plan.total}.`);
  return (
    <>
      {plan?.sameName.map((n) => <div key={n} className="warn-card" role="note"><Icon name="circle-alert" size={16} /><span><b>{n}</b>{sameNameText(n).slice(n.length)}</span></div>)}
      {items.map((t) => <div key={t} className="warn-card" role="alert"><Icon name="circle-alert" size={16} /><span>{t}</span></div>)}
    </>
  );
}

function Foot({ note, view, busy, onClose, onAdd }: { note: string; view: NamesSheetView | null; busy: boolean; onClose(): void; onAdd(): void }): JSX.Element {
  const blocked = addBlocked(view?.plan ?? null) ?? (view?.token ? null : 'Wait for the preview.');
  return (
    <>
      <span className="foot-note"><Icon name="lock" size={14} />{note}</span>
      <button type="button" className="btn" onClick={onClose}>Cancel</button>
      <button type="button" className="btn primary" disabled={busy || blocked !== null || !!view?.error} title={blocked ?? undefined} onClick={onAdd}>{addLabel(view?.plan ?? null)}</button>
    </>
  );
}

/** Paste names: one person per line, a live tally on the right, nothing written until Add. */
export function PasteNamesSheet({ onPreview, onAdd, onClose }: { onPreview(text: string): Answer; onAdd(token: string): Answer; onClose(): void }): JSX.Element {
  const [text, setText] = useState('');
  const [view, setView] = useState<NamesSheetView | null>(null);
  // The text the shown preview was made from: once the text differs, Add is off until the new preview answers.
  const [previewed, setPreviewed] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  useEffect(() => {
    const n = (seq.current += 1);
    const t = setTimeout(() => {
      void onPreview(text).then((r) => {
        if (n !== seq.current) return;
        if (!r.ok) { setError(r.error); return; }
        setError(null); setView(asNames(r)); setPreviewed(text);
      });
    }, text ? 200 : 0);
    return () => clearTimeout(t);
  }, [text]);
  const fresh = previewed === text;
  const add = async (): Promise<void> => {
    if (!fresh || !view?.token) return;
    setBusy(true);
    const r = await onAdd(view.token);
    setBusy(false);
    if (!r.ok) setError(r.error);
  };
  const plan = view?.plan ?? null;
  const shown: NamesSheetView | null = view && !fresh ? { ...view, token: null } : view;
  const withError: NamesSheetView | null = error ? { ...(shown ?? EMPTY_PASTE), error } : shown;
  return (
    <Sheet label="Paste names" title="Paste names" icon="clipboard-paste" onClose={onClose} width={960}
      foot={<Foot note="Kept only on this laptop." view={withError} busy={busy} onClose={onClose} onAdd={() => void add()} />}>
      <div className="names-grid">
        <div className="field">
          <label htmlFor="names-text">One person per line. An email address after a comma is optional.</label>
          <textarea id="names-text" className="paste mono" value={text} spellCheck={false} onChange={(e) => setText(e.target.value)} placeholder={'Aisha Rahman, aisha.rahman@example.ac.uk\nHenrik Olsen'} />
        </div>
        <div className="names-side" aria-live="polite">
          <div className="lab">What will be added</div>
          {plan ? <Tally variant="stack" lines={pasteTally(plan)} /> : <p className="none">Paste a list to see who will be added.</p>}
          <Notes view={withError} />
        </div>
      </div>
    </Sheet>
  );
}

function ColumnSelect({ id, label, columns, value, none, onChange }: { id: string; label: string; columns: string[]; value: number | null; none: string; onChange(v: number | null): void }): JSX.Element {
  return (
    <label className="map-field" htmlFor={id}>
      <span>{label}</span>
      <select id={id} value={value === null ? '' : String(value)} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}>
        <option value="">{none}</option>
        {columns.map((c, i) => <option key={i} value={i}>{c}</option>)}
      </select>
    </label>
  );
}

/** Import names from a file: column matching, the three figures, the rows that matter, nothing written until Add. */
export function ImportNamesSheet({ initial, onMap, onAdd, onClose }: { initial: NamesSheetView; onMap(m: NamesMapping): Answer; onAdd(token: string): Answer; onClose(): void }): JSX.Element {
  const [view, setView] = useState<NamesSheetView>(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const columns = view.columns ?? [];
  const m = view.mapping;
  const split = m !== null && m.name === null && (m.first !== null || m.last !== null);
  const remap = async (patch: Partial<NamesMapping>): Promise<void> => {
    if (!m) return;
    setBusy(true);
    const r = await onMap({ ...m, ...patch });
    setBusy(false);
    if (!r.ok) { setError(r.error); setView((v) => ({ ...v, token: null })); return; }
    setError(null);
    const v = asNames(r);
    if (v) setView(v);
  };
  const add = async (): Promise<void> => {
    if (!view.token) return;
    setBusy(true);
    const r = await onAdd(view.token);
    setBusy(false);
    if (!r.ok) setError(r.error);
  };
  const plan = view.plan;
  const shown = plan ? previewRows(plan) : null;
  const withError = error ? { ...view, error } : view;
  return (
    <Sheet label="Import names" title={`Import names from ${view.filename ?? 'a file'}`} icon="file-up" onClose={onClose} width={1000}
      foot={<Foot note="Kept only on this laptop. AttendWell records the file name and its checksum, not a copy of the file." view={withError} busy={busy} onClose={onClose} onAdd={() => void add()} />}>
      {m ? (
        <div className="map-row" role="group" aria-label="Columns">
          <b>Columns</b>
          <label className="map-field" htmlFor="map-name">
            <span>Name from</span>
            <select id="map-name" value={split ? 'split' : m.name === null ? '' : String(m.name)}
              onChange={(e) => void remap(e.target.value === 'split' ? { name: null, first: m.first ?? 0, last: m.last ?? Math.min(1, columns.length - 1) } : { name: e.target.value === '' ? null : Number(e.target.value), first: null, last: null })}>
              <option value="">Choose a column</option>
              {columns.map((c, i) => <option key={i} value={i}>{c}</option>)}
              {columns.length > 1 ? <option value="split">First name and last name columns</option> : null}
            </select>
          </label>
          {split ? <ColumnSelect id="map-first" label="First name from" columns={columns} value={m.first} none="None" onChange={(v) => void remap({ first: v })} /> : null}
          {split ? <ColumnSelect id="map-last" label="Last name from" columns={columns} value={m.last} none="None" onChange={(v) => void remap({ last: v })} /> : null}
          <ColumnSelect id="map-email" label="Email from" columns={columns} value={m.email} none="No email column" onChange={(v) => void remap({ email: v })} />
          <ColumnSelect id="map-status" label="Booking status from" columns={columns} value={m.status} none="No status column" onChange={(v) => void remap({ status: v })} />
          <ColumnSelect id="map-date" label="Date from" columns={columns} value={m.date} none="No date column" onChange={(v) => void remap({ date: v })} />
          <label className="check"><input type="checkbox" checked={m.header} onChange={(e) => void remap({ header: e.target.checked })} />First row is a header</label>
        </div>
      ) : null}
      {plan ? <Tally variant="cards" lines={importTally(plan)} /> : null}
      <Notes view={withError} />
      {shown ? (
        <div className="preview-table" role="table" aria-label="Rows">
          <div className="pt-row head" role="row"><span>Row</span><span>Name</span><span>Email</span><span>Result</span></div>
          {shown.rows.map((r) => (
            <div key={r.row} role="row" className={`pt-row ${r.result}`}>
              <span>{r.row}</span><span className={r.name ? '' : 'none'}>{r.name || '(empty)'}</span><span className="mono">{r.email}</span>
              <span><span className={`res ${r.result}`}><Icon name={r.result === 'added' ? 'check' : r.result === 'skipped' ? 'x' : 'users'} size={13} />{resultText(r)}</span></span>
            </div>
          ))}
          {shown.moreAdded > 0 ? <div className="pt-row more" role="row"><span /><span>and {shown.moreAdded} more {shown.moreAdded === 1 ? 'row' : 'rows'} added</span></div> : null}
        </div>
      ) : null}
    </Sheet>
  );
}

/** Import iPad recovery file: drop or choose the file, see what it would record, record it; the same file twice records nothing new. */
export function RecoverySheet({ onChoose, onDropPath, onImport, onClose, pathForFile }: { onChoose(): Answer; onDropPath(path: string): Answer; onImport(): Answer; onClose(): void; pathForFile(f: File): string }): JSX.Element {
  const [view, setView] = useState<RecoverySheetView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const take = async (p: Answer): Promise<void> => {
    setBusy(true);
    const r = await p;
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    const v = asRecovery(r);
    if (v) { setView(v); setError(null); }
  };
  const report = view?.report ?? null;
  const done = report?.written === true;
  const notable = report?.rows.filter((r) => r.outcome === 'review' || r.outcome === 'refused') ?? [];
  return (
    <Sheet label="Import iPad recovery file" title="Import iPad recovery file" icon="file-input" onClose={onClose} wide
      foot={done ? <button type="button" className="btn primary" onClick={onClose}>Done</button> : (
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={busy || !report || report.counts.recorded + report.counts.review === 0} onClick={() => void take(onImport())}>Import check-ins</button>
        </>
      )}>
      <div className={`dropzone ${over ? 'over' : ''}`} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files[0]; if (f) { const p = pathForFile(f); if (p) void take(onDropPath(p)); } }}>
        <Icon name="file-input" size={30} />
        <span>Drop the file here, or <button type="button" className="btn small" disabled={busy} onClick={() => void take(onChoose())}>Choose file</button></span>
      </div>
      {error ? <div className="warn-card" role="alert"><Icon name="circle-alert" size={16} /><span>{error}</span></div> : null}
      {report && view ? (
        <div className={`result-card ${done ? 'done' : ''}`} role="status">
          <Icon name={done ? 'circle-check' : 'info'} size={20} />
          <div><b>{view.filename}</b><span>{recoveryLine(report)}</span>
            {report.deviceLabel ? <span className="none">From {report.deviceLabel}.</span> : null}
          </div>
        </div>
      ) : null}
      {notable.length ? (
        <ul className="recips">{notable.slice(0, 8).map((r, i) => <li key={`${r.opId}-${i}`}><b>{r.name}</b> <span className="none">{recoveryReason(r)}</span></li>)}</ul>
      ) : null}
      <p className="none">Importing the same file twice records nothing new.</p>
    </Sheet>
  );
}
