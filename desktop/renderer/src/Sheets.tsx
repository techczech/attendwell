// Small modal sheets: New workshop (⌘N) and What's new.
import { useEffect, useRef } from 'react';
import { api } from './api.ts';
import { Icon } from './icons.tsx';
import { WorkshopFields, useWorkshopForm } from './WorkshopForm.tsx';
import { useState } from 'react';
import type { NearbyView } from '../../shared/ipc.ts';
import { QrCode } from './PairSheet.tsx';

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

/** Nearby link test…: the QR and key the iPad's Nearby link test takes, the link's state, and the check-ins received. */
export function NearbySheet({ onClose }: { onClose(): void }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const [v, setV] = useState<NearbyView | null>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  useEffect(() => {
    let live = true;
    const tick = (): void => { void api.nearbyView().then((n) => { if (live) setV(n); }); };
    tick();
    const t = setInterval(tick, 1000);
    return () => { live = false; clearInterval(t); };
  }, []);
  const status = !v ? '' : !v.available ? 'Not available' : v.state === 'connected' ? `Connected to ${v.peerName ?? 'the iPad'}` : 'Waiting for the iPad';
  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sheet" role="dialog" aria-label="Nearby link test" tabIndex={-1} ref={ref} onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } }}>
        <div className="sheet-head"><span style={{ display: 'flex', gap: 8, alignItems: 'center' }}><Icon name="plug-zap" size={20} />Nearby link test</span></div>
        <div className="sheet-body">
          {v && !v.available ? (
            <p>The nearby link is not available in this copy of AttendWell. It needs the Mac helper that comes with the installed app.</p>
          ) : v ? (
            <div style={{ display: 'flex', gap: 18, alignItems: 'flex-start' }}>
              <div className="qr-col"><div className="qr-frame"><QrCode text={v.payload!} /></div></div>
              <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <p>On the iPad, open Nearby link test and scan this code, or paste the key below. This only tests the link: the iPad sees 500 made-up names, and nothing is saved in a register.</p>
                <p><b>{status}</b></p>
                <p>Check-ins received: <b>{v.checkins}</b></p>
                <input readOnly value={v.key!} aria-label="Key" style={{ width: '100%', fontFamily: 'ui-monospace, monospace' }} onFocus={(e) => e.currentTarget.select()} />
              </div>
            </div>
          ) : null}
        </div>
        <div className="sheet-foot">
          <button type="button" className="btn" onClick={() => void api.nearbyShowLog()}>Show log</button>
          <button type="button" className="btn primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
