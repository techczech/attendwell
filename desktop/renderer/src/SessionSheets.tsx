// The small sheets of the session screen: Add person, End check-in, Quit while check-in is open, Revoke, Rename, Email review.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { reviewRecipients, type Roster } from '../../shared/register-model.ts';
import { revokeText, type DeviceRecord } from '../../shared/devices-model.ts';
import { Icon } from './icons.tsx';

export function Sheet({ label, title, icon, onClose, children, foot, wide, width }: { label: string; title: ReactNode; icon?: string; onClose(): void; children: ReactNode; foot: ReactNode; wide?: boolean; width?: number }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { (ref.current?.querySelector('input,textarea') as HTMLElement | null)?.focus() ?? ref.current?.focus(); }, []);
  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sheet" style={{ width: width ?? (wide ? 720 : 520) }} role="dialog" aria-label={label} tabIndex={-1} ref={ref} onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } }}>
        <div className="sheet-head"><span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>{icon ? <Icon name={icon} size={20} /> : null}{title}</span></div>
        <div className="sheet-body">{children}</div>
        <div className="sheet-foot">{foot}</div>
      </div>
    </div>
  );
}

export function AddPersonSheet({ onAdd, onClose }: { onAdd(p: { name: string; email: string; markHere: boolean }): Promise<string | null>; onClose(): void }): JSX.Element {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [here, setHere] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (): Promise<void> => {
    if (!name.trim()) { setError('Enter a name.'); return; }
    setBusy(true); setError(null);
    const err = await onAdd({ name, email, markHere: here });
    setBusy(false);
    if (err) setError(err); else onClose();
  };
  return (
    <Sheet label="Add person" title="Add person" icon="user-plus" onClose={onClose}
      foot={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" disabled={busy} onClick={() => void submit()}>Add person</button></>}>
      <div onKeyDown={(e) => { if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') { e.preventDefault(); void submit(); } }}>
        <div className="field"><label htmlFor="ap-name">Name</label><input id="ap-name" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} autoComplete="off" /></div>
        <div className="field"><label htmlFor="ap-email">Email (optional)</label><input id="ap-email" value={email} maxLength={254} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
          <span className="help">Kept only on this laptop.</span></div>
        <label className="check"><input type="checkbox" checked={here} onChange={(e) => setHere(e.target.checked)} />Mark as here now</label>
        {error ? <p className="fr-error" role="alert">{error}</p> : null}
      </div>
    </Sheet>
  );
}

export function EndConfirmSheet({ held, onEnd, onClose }: { held: number; onEnd(): void; onClose(): void }): JSX.Element {
  return (
    <Sheet label="End check-in" title="End check-in?" icon="power" onClose={onClose}
      foot={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn danger-solid" onClick={onEnd}><Icon name="power" size={15} />End check-in</button></>}>
      <p>The iPad will stop accepting check-ins and the check-in address will close. The register stays on this laptop.</p>
      {held > 0 ? <p className="warn-line"><Icon name="circle-alert" size={16} />{held === 1 ? '1 check-in is still held for review.' : `${held} check-ins are still held for review.`} They stay held in the register.</p> : null}
    </Sheet>
  );
}

export function QuitConfirmSheet({ deviceLabel, onCancel, onEndAndQuit, onQuit }: { deviceLabel: string; onCancel(): void; onEndAndQuit(): void; onQuit(): void }): JSX.Element {
  return (
    <Sheet label="Quit AttendWell" title="Quit AttendWell while check-in is open?" icon="log-out" onClose={onCancel}
      foot={<><button type="button" className="btn" onClick={onCancel}>Cancel</button><button type="button" className="btn" onClick={onEndAndQuit}>End check-in and quit</button><button type="button" className="btn danger-solid" onClick={onQuit}>Quit</button></>}>
      <p>Quitting closes the check-in address, so {deviceLabel} will save check-ins without sending them. The register stays on this laptop.</p>
      <p>When you open AttendWell again it gets a new address, and you pair {deviceLabel} again to receive what it saved.</p>
    </Sheet>
  );
}

export function RevokeSheet({ device, onRevoke, onClose }: { device: DeviceRecord; onRevoke(): void; onClose(): void }): JSX.Element {
  const t = revokeText(device);
  return (
    <Sheet label="Revoke iPad" title={t.title} icon="ban" onClose={onClose}
      foot={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn danger-solid" onClick={onRevoke}><Icon name="ban" size={15} />Revoke</button></>}>
      <p>{t.body}</p>
    </Sheet>
  );
}

export function RenameSheet({ device, onRename, onClose }: { device: DeviceRecord; onRename(label: string): Promise<string | null>; onClose(): void }): JSX.Element {
  const [label, setLabel] = useState(device.label);
  const [error, setError] = useState<string | null>(null);
  const submit = async (): Promise<void> => {
    if (!label.trim()) { setError('Enter a name.'); return; }
    const err = await onRename(label.trim());
    if (err) setError(err); else onClose();
  };
  return (
    <Sheet label="Rename iPad" title="Rename iPad" icon="pencil" onClose={onClose}
      foot={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" onClick={() => void submit()}>Rename</button></>}>
      <div className="field" onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void submit(); } }}>
        <label htmlFor="rn">Name</label><input id="rn" value={label} maxLength={40} onChange={(e) => setLabel(e.target.value)} />
        {error ? <span className="err" role="alert">{error}</span> : null}
      </div>
    </Sheet>
  );
}

export function ReviewSheet({ roster, onCopy, onClose }: { roster: Roster; onCopy(): void; onClose(): void }): JSX.Element {
  const r = reviewRecipients(roster);
  return (
    <Sheet label="Email review" title="Email review" icon="mail" onClose={onClose}
      foot={<><button type="button" className="btn" onClick={onClose}>Close</button><button type="button" className="btn primary" disabled={r.recipients.length === 0} onClick={onCopy}><Icon name="copy" size={15} />Copy Bcc list</button></>}>
      <p><b>{r.recipients.length}</b> {r.recipients.length === 1 ? 'person who was here has' : 'people who were here have'} an email address{r.skipped > 0 ? `; ${r.skipped} left out (no address, or a repeated one)` : ''}. Paste the list into the Bcc line of a new message.</p>
      <ul className="recips">{r.recipients.slice(0, 12).map((x) => <li key={x.email}>{x.name} <span className="none">{x.email}</span></li>)}</ul>
      {r.recipients.length > 12 ? <p className="none">and {r.recipients.length - 12} more</p> : null}
    </Sheet>
  );
}
