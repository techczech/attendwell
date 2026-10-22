// The right column: connection status, the paired iPads (Kiosk wording) and the Pair an iPad button.
import { useState } from 'react';
import { deviceRow, holdText, type DeviceHold, type DeviceList, type DeviceRow, type DeviceRecord } from '../../shared/devices-model.ts';
import type { Availability, ConnectionModel } from '../../shared/session-model.ts';
import { Icon } from './icons.tsx';
import { Keys } from './Keys.tsx';

export function ConnectionPanel({ model, host, compact, onCopy, onRetry, onChooseFolder, now }: {
  model: ConnectionModel; host: string; compact: boolean; onCopy(): void; onRetry(): void; onChooseFolder(): void; now?: number;
}): JSX.Element {
  void now;
  const icon = model.tone === 'good' ? 'wifi' : model.tone === 'bad' ? 'circle-x' : model.tone === 'off' ? 'lock' : 'wifi-off';
  if (compact && model.tone === 'good' && model.address) {
    return (
      <section className="panel rail-panel" aria-label="Connection">
        <div className="panel-head"><span>Connection</span><span className={`pill ${model.tone}`}>{model.chip}</span></div>
        <div className="conn-compact">
          <Icon name="wifi" size={18} /><span className="mono addr">{model.address}</span>
          <button type="button" className="btn icon small" aria-label="Copy address" title="Copy address" onClick={onCopy}><Icon name="copy" size={15} /></button>
        </div>
      </section>
    );
  }
  return (
    <section className="panel rail-panel" aria-label="Connection">
      <div className="panel-head"><span>Connection</span><span className={`pill ${model.tone}`}>{model.chip}</span></div>
      <div className="conn-body">
        <div className={`conn-state ${model.tone}`} role="status">
          <Icon name={icon} size={24} />
          <div><b>{model.headline}</b><span>{model.detail}</span></div>
        </div>
        {model.address ? <div className={`addr-box mono ${model.addressClosed ? 'closed' : ''}`}>{model.address}</div> : null}
        {model.advice ? <p className="conn-advice">{model.advice}</p> : null}
        {model.copy ? <button type="button" className="btn" onClick={onCopy}><Icon name="copy" />Copy address</button> : null}
        {model.retry ? <button type="button" className="btn primary wide" onClick={onRetry}><Icon name="refresh-cw" />Try again</button> : null}
        {model.chooseFolder ? <button type="button" className="btn" onClick={onChooseFolder}>Choose folder…</button> : null}
        <div className="conn-host"><Icon name="laptop" size={15} />{host}<span aria-hidden="true">·</span>Quick tunnel</div>
      </div>
    </section>
  );
}

function DeviceMenu({ row, canAct, onRename, onPairAgain, onRevoke, onClose }: {
  row: DeviceRow; canAct: boolean; onRename(): void; onPairAgain(): void; onRevoke(): void; onClose(): void;
}): JSX.Element {
  return (
    <div className="menu" role="menu" style={{ right: 0, top: 32 }} onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
      <button type="button" role="menuitem" className="menu-item" disabled={!canAct} onClick={() => { onClose(); onRename(); }}><Icon name="pencil" size={14} />Rename…</button>
      <button type="button" role="menuitem" className="menu-item" disabled={!canAct} onClick={() => { onClose(); onPairAgain(); }}><Icon name="rotate-ccw" size={14} />Pair again</button>
      <button type="button" role="menuitem" className="menu-item danger" disabled={!canAct || row.revoked} onClick={() => { onClose(); onRevoke(); }}><Icon name="ban" size={14} />Revoke…</button>
    </div>
  );
}

export function DevicesPanel(p: {
  list: DeviceList | null;
  live: boolean;
  closedAt: string | null;
  repair: ReadonlySet<string>;
  now: number;
  selectedId: string | null;
  /** Pairing and device changes work (check-in open, register answering). */
  canAct: boolean;
  onSelect(id: string): void;
  onRename(id: string): void;
  onPairAgain(id: string): void;
  onRevoke(id: string): void;
  onDismissHold(id: number): void;
  /** Import iPad recovery file works now (any phase but closing). */
  canImport: boolean;
  onImportRecovery(): void;
}): JSX.Element {
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const devices: DeviceRecord[] = p.list?.devices ?? [];
  const holds: DeviceHold[] = p.list?.unmatchedCheckIns ?? [];
  const rows = devices.map((d) => deviceRow(d, { now: p.now, live: p.live, closedAt: p.closedAt, repair: p.repair }));
  return (
    <section className="panel rail-panel devices" aria-label="Devices">
      <div className="panel-head"><span>Devices</span><span className="count-badge" aria-label={`${rows.length} iPads`}>{rows.length}</span></div>
      <div className="scroll dev-scroll">
        {rows.length === 0 ? (
          <div className="rail-empty dev-empty">
            <div><Icon name="tablet" size={30} /><b>No iPads paired yet.</b><p>An iPad lets people check themselves in at the door, even if the Wi-Fi drops.</p></div>
          </div>
        ) : rows.map((r) => (
          <div key={r.id} className={`dev ${r.tone} ${p.selectedId === r.id ? 'sel' : ''}`} role="button" tabIndex={0} aria-pressed={p.selectedId === r.id} data-device={r.id}
            onClick={() => p.onSelect(r.id)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); p.onSelect(r.id); } }}>
            <Icon name="tablet" size={22} />
            <div className="dev-main">
              <b>{r.label}</b>
              <span className={`dev-status ${r.tone}`}>
                {r.icon === 'dot' ? <i className="dot" aria-hidden="true" /> : <Icon name={r.icon === 'ban' ? 'ban' : r.icon === 'hourglass' ? 'hourglass' : 'download'} size={14} />}
                {r.statusText}
              </span>
              <span className="dev-fig">
                <span>Unsent <b>{r.unsent}</b>{r.unsentStale ? ' (last reported)' : ''}</span><span>Needs review <b>{r.needsReview}</b></span><span>App {r.appVersion}</span>
              </span>
              {r.pairAgainButton && p.canAct ? (
                <button type="button" className={`btn small ${r.revoked ? '' : 'primary'}`} onClick={(e) => { e.stopPropagation(); p.onPairAgain(r.id); }}><Icon name="rotate-ccw" size={14} />Pair again</button>
              ) : null}
            </div>
            <div style={{ position: 'relative' }}>
              <button type="button" className="btn icon small" aria-label={`Actions for ${r.label}`} aria-haspopup="menu" aria-expanded={menuFor === r.id}
                onClick={(e) => { e.stopPropagation(); setMenuFor(menuFor === r.id ? null : r.id); }}><Icon name="ellipsis" size={16} /></button>
              {menuFor === r.id ? (
                <DeviceMenu row={r} canAct={p.canAct} onClose={() => setMenuFor(null)} onRename={() => p.onRename(r.id)} onPairAgain={() => p.onPairAgain(r.id)} onRevoke={() => p.onRevoke(r.id)} />
              ) : null}
            </div>
          </div>
        ))}
        {holds.length > 0 ? (
          <div className="holds" aria-label="Held for review">
            <div className="sec-title">Held for review</div>
            {holds.map((h) => (
              <div key={h.id} className="hold">
                <span><b>{h.deviceLabel ?? 'An iPad'}</b> {holdText(h.reason)}</span>
                <button type="button" className="btn small" disabled={!p.canAct} onClick={() => p.onDismissHold(h.id)}>Dismiss</button>
              </div>
            ))}
          </div>
        ) : null}
      </div>
      <div className="dev-foot">
        <button type="button" className="link" disabled={!p.canImport} onClick={p.onImportRecovery}><Icon name="file-input" size={14} />Import iPad recovery file</button>
      </div>
    </section>
  );
}

export function PairButton({ avail, label, chord, platform, onClick }: { avail: Availability; label: string; chord: string; platform: 'mac' | 'win'; onClick(): void }): JSX.Element {
  return (
    <section className="panel rail-panel pair-box">
      <button type="button" className="btn primary big wide" disabled={!avail.ok} onClick={onClick} aria-label={label}><Icon name="qr-code" size={18} />{label}{avail.ok && chord ? <Keys chord={chord} platform={platform} /> : null}</button>
      {!avail.ok && avail.reason ? <p className="pair-why">{avail.reason}</p> : null}
    </section>
  );
}
