import { useEffect, useRef } from 'react';
import { cheatSheet } from '../../shared/commands.ts';
import { Icon } from './icons.tsx';
import { Keys } from './Keys.tsx';

/** ⌘/ : the registry's commands with their effective chords, in the locked groups. */
export function CheatSheet({ bindings, platform, onClose }: { bindings: Record<string, string>; platform: 'mac' | 'win'; onClose(): void }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const groups = cheatSheet(bindings);
  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sheet cheat" role="dialog" aria-label="Keyboard shortcuts" tabIndex={-1} ref={ref} onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } }}>
        <div className="sheet-head">
          <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}><Icon name="keyboard" size={20} />Keyboard shortcuts</span>
          <span className="hint">Change any of them in Settings › Shortcuts <Keys chord="⌘/" platform={platform} /></span>
        </div>
        <div className="sheet-body">
          <div className="cheat-cols">
            {groups.map((g) => (
              <section className="cheat-grp" key={g.group}>
                <h3>{g.group}</h3>
                {g.rows.map((r) => (
                  <div className="cheat-row" key={r.id}>
                    <span>{r.label}</span>
                    {r.id === 'register.next' ? <span className="keys"><Keys chord={r.chord} platform={platform} /><Keys chord={bindings['register.previous'] ?? ''} platform={platform} /></span> : <Keys chord={r.chord} platform={platform} />}
                  </div>
                ))}
              </section>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
