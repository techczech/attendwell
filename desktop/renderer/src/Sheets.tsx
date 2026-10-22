// Small modal sheets: New workshop (⌘N) and What's new.
import { useEffect, useRef } from 'react';
import { api } from './api.ts';
import { Icon } from './icons.tsx';
import { WorkshopFields, useWorkshopForm } from './WorkshopForm.tsx';
import { useState } from 'react';

export function NewWorkshopSheet({ today, folderPath, home, onCreated, onClose }: { today: string; folderPath: string; home: string; onCreated(id: string): void; onClose(): void }): JSX.Element {
  const form = useWorkshopForm(today);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (): Promise<void> => {
    if (!form.validate()) return;
    setBusy(true); setError(null);
    const r = await api.createWorkshop(form.form);
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    onCreated(r.value.id);
  };
  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sheet" role="dialog" aria-label="New workshop" onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } else if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') { e.preventDefault(); void submit(); } }}>
        <div className="sheet-head"><span>New workshop</span></div>
        <div className="sheet-body">
          <WorkshopFields state={form} folderPath={folderPath} home={home} />
          {error ? <p className="fr-error" role="alert">{error}</p> : null}
        </div>
        <div className="sheet-foot">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={busy} onClick={() => void submit()}>Create workshop</button>
        </div>
      </div>
    </div>
  );
}

export function NotesSheet({ version, items, onClose }: { version: string; items: Array<{ title: string | null; text: string }>; onClose(): void }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sheet" role="dialog" aria-label="What's new" tabIndex={-1} ref={ref} onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } }}>
        <div className="sheet-head"><span style={{ display: 'flex', gap: 8, alignItems: 'center' }}><Icon name="sparkles" size={20} />What's new in AttendWell {version}</span></div>
        <div className="sheet-body">
          <ul style={{ paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {items.map((it, i) => <li key={i}>{it.title ? <b>{it.title}. </b> : null}{it.text}</li>)}
          </ul>
        </div>
        <div className="sheet-foot"><button type="button" className="btn primary" onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}
