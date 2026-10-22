// The pairing sheet (Kiosk laptop states): the QR is drawn here from the code, never fetched; the countdown follows the register's clock.
import QRCode from 'qrcode';
import { useEffect, useMemo, useRef } from 'react';
import { PAIR_STEPS, pairingMessage, pairingView, type PairingState } from '../../shared/pairing-model.ts';
import { Icon } from './icons.tsx';

export function QrCode({ text, blurred }: { text: string; blurred?: boolean }): JSX.Element {
  const { size, path } = useMemo(() => {
    const q = QRCode.create(text, { errorCorrectionLevel: 'M' });
    const n = q.modules.size;
    const parts: string[] = [];
    for (let y = 0; y < n; y += 1) for (let x = 0; x < n; x += 1) if (q.modules.data[y * n + x]) parts.push(`M${x + 4} ${y + 4}h1v1h-1z`);
    return { size: n + 8, path: parts.join('') };
  }, [text]);
  return (
    <svg className={`qr ${blurred ? 'blurred' : ''}`} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Pairing code as a QR code" shapeRendering="crispEdges">
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#111" />
    </svg>
  );
}

function Stepper({ step, done }: { step: 2 | 3; done: boolean }): JSX.Element {
  const Item = ({ n, label, state, note }: { n: number; label: string; state: 'done' | 'on' | 'todo'; note?: string }): JSX.Element => (
    <li className={`st ${state}`} aria-current={state === 'on' ? 'step' : undefined}>
      <span className="n">{state === 'done' ? <Icon name="check" size={14} /> : n}</span><b>{label}</b>{note ? <small>{note}</small> : null}
    </li>
  );
  return (
    <ol className="stepper" aria-label="Steps">
      <Item n={1} label="Name this iPad" state="done" note="(done)" />
      <span className="arrow" aria-hidden="true"><Icon name="arrow-right" size={14} /></span>
      <Item n={2} label="Scan the code" state={step === 2 ? 'on' : 'done'} />
      <span className="arrow" aria-hidden="true"><Icon name="arrow-right" size={14} /></span>
      <Item n={3} label="Paired" state={done ? 'on' : 'todo'} />
    </ol>
  );
}

export interface PairSheetProps {
  state: PairingState;
  now: number;
  /** The name typed so far (null: nothing typed yet). */
  label: string | null;
  workshopLine: string;
  onLabel(label: string): void;
  onNew(): void;
  onAnother(): void;
  onCopy(what: 'pair-code' | 'pair-address'): void;
  onClose(): void;
}

export function PairSheet(p: PairSheetProps): JSX.Element {
  // Before the first answer from the main process the sheet already shows "Creating a pairing code…".
  const v = pairingView(p.state, p.now) ?? pairingView({ phase: 'issuing', label: p.label ?? '', targetDeviceId: null }, p.now)!;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const dead = v.kind === 'expired' || v.kind === 'paused';
  const title = v.repair && v.kind !== 'paired' ? `Re-pairing ${v.label}` : 'Pair an iPad';
  const shown = p.label ?? (p.state.phase === 'open' ? p.state.offer.label : v.label);
  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) p.onClose(); }}>
      <div className="sheet pair" role="dialog" aria-label="Pair an iPad" tabIndex={-1} ref={ref} onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); p.onClose(); } }}>
        <div className="sheet-head"><span>{title}</span><button type="button" className="btn icon" aria-label="Close" onClick={p.onClose}><Icon name="x" size={18} /></button></div>
        <Stepper step={v.step} done={v.kind === 'paired'} />
        {v.kind === 'issuing' ? (
          <div className="pair-body center" role="status"><Icon name="refresh-cw" size={30} /><b>{pairingMessage(v)}</b></div>
        ) : v.kind === 'error' ? (
          <div className="pair-body center" role="alert">
            <Icon name="circle-x" size={30} /><b>Couldn't create a pairing code.</b><p>{v.message}</p>
            <button type="button" className="btn primary" onClick={p.onNew}><Icon name="refresh-cw" />Try again</button>
          </div>
        ) : v.kind === 'paired' ? (
          <div className="pair-body center" role="status">
            <Icon name="circle-check" size={34} /><b>{pairingMessage(v)}</b>
            {v.repair ? <p>The check-ins it saved while it could not reach this laptop arrive now.</p> : null}
          </div>
        ) : (
          <div className="pair-body">
            <div className="qr-col">
              <div className="qr-frame"><QrCode text={v.qrPayload ?? ''} blurred={dead} /></div>
              <small><Icon name="qr-code" size={14} /> One use: this code pairs one iPad.</small>
            </div>
            <div className="pair-info">
              <p className="event-line">{p.workshopLine}{v.eventCode ? ` · Event code ${v.eventCode}` : ''}</p>
              <ol className="pair-steps">
                {PAIR_STEPS(v.repair).map((t, i) => <li key={i}><span className="n">{i + 1}</span>{t}</li>)}
              </ol>
              <div className={`countdown ${dead ? 'dead' : ''}`} role="timer" aria-live="off">
                <Icon name="timer" size={22} />
                {dead ? <b className="big">{v.kind === 'paused' ? '⏸' : '0:00'}</b> : <b className="big">{v.countdown}</b>}
                <span>{pairingMessage(v)}</span>
              </div>
              <button type="button" className="btn" onClick={p.onNew}><Icon name="refresh-cw" />Show a new code</button>
              <div className="cant-scan">
                <b><Icon name="keyboard" size={15} /> Can't scan? Enter on the iPad:</b>
                <div className="kv"><span>Address</span><code className="mono">{v.baseUrl}</code><button type="button" className="btn icon small" aria-label="Copy address" onClick={() => p.onCopy('pair-address')}><Icon name="copy" size={15} /></button></div>
                <div className="kv"><span>Code</span><code className="mono code">{v.shortCode}</code><button type="button" className="btn icon small" aria-label="Copy code" onClick={() => p.onCopy('pair-code')}><Icon name="copy" size={15} /></button></div>
              </div>
              <label className="called"><span>This iPad will be called</span>
                <input value={shown} disabled={v.repair} maxLength={40} onChange={(e) => p.onLabel(e.target.value)} aria-label="This iPad will be called" />
              </label>
            </div>
          </div>
        )}
        <div className="sheet-foot">
          {v.kind === 'paired' ? <button type="button" className="btn" onClick={p.onAnother}><Icon name="qr-code" />Pair another iPad</button> : null}
          <button type="button" className={`btn ${v.kind === 'paired' ? 'primary' : ''}`} onClick={p.onClose}>{v.kind === 'paired' ? 'Done' : <><Icon name="x" size={15} />Close</>}</button>
        </div>
      </div>
    </div>
  );
}
