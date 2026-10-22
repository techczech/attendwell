// Settings > Connection: how iPads reach this laptop (quick tunnel, no account), the check-in address now, and Test connection.
import { useEffect, useState } from 'react';
import type { ConnectionApi, ConnectionView } from '../../shared/ipc.ts';
import type { ConnectionTest } from '../../shared/runtime-types.ts';
import { Icon } from './icons.tsx';

declare global { interface Window { attendwellConnection: ConnectionApi } }

type TestState = { kind: 'idle' } | { kind: 'testing' } | { kind: 'done'; result: ConnectionTest };

export function connectionStatus(t: ConnectionView['tunnel']): { chip: string; tone: 'good' | 'warn' | 'bad' | 'off'; detail: string } {
  switch (t.state) {
    case 'online': return { chip: 'Online', tone: 'good', detail: 'Check-in address ready' };
    case 'starting': return { chip: 'Connecting…', tone: 'warn', detail: 'Opening the check-in address. This can take up to a minute.' };
    case 'reconnecting': return { chip: `Reconnecting… attempt ${t.attempt}`, tone: 'warn', detail: 'The iPad keeps saving check-ins while the address is down.' };
    case 'failed': return { chip: 'Not connected', tone: 'bad', detail: t.message };
    default: return { chip: 'Off', tone: 'off', detail: 'No check-in address is open. It opens when you open a workshop.' };
  }
}

export function ConnectionPage(): JSX.Element {
  const api = window.attendwellConnection;
  const [view, setView] = useState<ConnectionView | null>(null);
  const [test, setTest] = useState<TestState>({ kind: 'idle' });
  const [copied, setCopied] = useState(false);
  useEffect(() => { void api.view().then(setView); return api.onChanged(setView); }, []);
  if (!view) return <div className="aw-conn" />;
  const st = connectionStatus(view.tunnel);
  const url = view.tunnel.state === 'online' ? view.tunnel.url : view.tunnel.state === 'reconnecting' ? view.tunnel.url : null;
  const host = url ? url.replace(/^https?:\/\//, '') : null;
  const runTest = async (): Promise<void> => { setTest({ kind: 'testing' }); setTest({ kind: 'done', result: await api.test() }); };

  return (
    <div className="aw-conn">
      <section className="aw-card">
        <h3>How iPads reach this laptop</h3>
        <div className="aw-row">
          <Icon name="globe" size={20} />
          <div>
            <b>Temporary address, no account needed</b>
            <p>When a workshop is open, AttendWell opens a public check-in address through Cloudflare that only paired iPads can use. The address changes each time AttendWell starts, so after a restart you pair each iPad again with a new code. Check-ins saved on the iPad are kept and sent once it is paired again.</p>
          </div>
        </div>
      </section>
      <section className="aw-card">
        <h3>Now</h3>
        <div className="aw-row between">
          <div>
            <b>Check-in address</b>
            <p>{st.detail}{view.workshopTitle && view.tunnel.state === 'online' ? ` · ${view.workshopTitle}` : ''}</p>
          </div>
          <div className="aw-addr">
            {host ? <span className="mono">{host}</span> : null}
            {host ? <button type="button" className="aw-btn icon" aria-label="Copy address" onClick={() => void api.copyAddress().then((ok) => { setCopied(ok); setTimeout(() => setCopied(false), 1500); })}><Icon name="copy" /></button> : null}
            <span className={`aw-chip ${st.tone}`} role="status">{copied ? 'Copied' : st.chip}</span>
          </div>
        </div>
        <div className="aw-row between top">
          <div>
            <b>Test connection</b>
            <p>Opens a test address for a few seconds and checks that it reaches this laptop. Safe to run during a session.</p>
            {test.kind === 'done' && test.result.ok ? <p className="aw-ok" role="status"><Icon name="circle-check" /> Cloudflare answered and the check-in address reached this laptop.</p> : null}
            {test.kind === 'done' && !test.result.ok ? <p className="aw-bad" role="alert"><Icon name="circle-alert" /> {test.result.advice}</p> : null}
            {test.kind === 'testing' ? <p role="status">Testing…</p> : null}
          </div>
          <button type="button" className="aw-btn" disabled={test.kind === 'testing' || !view.testAvailable} onClick={() => void runTest()}>
            <Icon name="plug-zap" />{test.kind === 'done' ? 'Test again' : 'Test connection'}
          </button>
        </div>
        {!view.testAvailable ? <p className="aw-note">Test connection is not available in this version yet.</p> : null}
      </section>
    </div>
  );
}
