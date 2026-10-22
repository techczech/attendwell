// The command palette (⌘⇧P), the actions list for the selection (⌘K) and the Go to workshop switcher (⌘⇧K). The palette lists
// every registry command with its effective chord, the reason an unavailable one cannot run, and rebinds the highlighted one in place (⌘⇧,).
import { chordFromEvent } from '@app-patterns/commands';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CHEAT_ORDER, cheatGroupOf, registry, selectionCommands, type CommandCtx } from '../../shared/commands.ts';
import { switcherRows } from '../../shared/workshops.ts';
import type { WorkshopListing } from '../../shared/runtime-types.ts';
import { Icon } from './icons.tsx';
import { Keys } from './Keys.tsx';

type Platform = 'mac' | 'win';
const GROUP_TITLES: Record<string, string> = { App: 'App', Workshops: 'Workshops', Register: 'Register', Session: 'Session', Devices: 'Devices' };

export interface PaletteProps {
  scope: 'all' | 'selection';
  ctx: CommandCtx;
  bindings: Record<string, string>;
  platform: Platform;
  recent: string[];
  onRun(id: string): void;
  onRebind(id: string, chord: string): Promise<string | null>;
  onClose(): void;
}

interface Item { id: string; label: string; icon: string; chord: string; reason: string | null }

/** Rows of the palette for a query, in groups; recently used commands first when nothing is typed. Pure, so a test reads it. */
export function paletteGroups(ctx: CommandCtx, bindings: Record<string, string>, query: string, recent: string[], scope: 'all' | 'selection'): Array<{ title: string; items: Item[] }> {
  const rows = registry.paletteList(ctx, query).filter((r) => scope === 'all' || selectionCommands(ctx).includes(r.def.id));
  const toItem = (r: (typeof rows)[number]): Item => ({ id: r.def.id, label: r.def.label, icon: r.def.icon, chord: bindings[r.def.id] ?? '', reason: r.reason });
  const groups: Array<{ title: string; items: Item[] }> = [];
  if (!query.trim() && scope === 'all') {
    const recents = recent.map((id) => rows.find((r) => r.def.id === id)).filter((r): r is (typeof rows)[number] => r !== undefined && r.reason === null).slice(0, 3);
    if (recents.length) groups.push({ title: 'Recently used', items: recents.map(toItem) });
  }
  if (scope === 'selection') return [{ title: ctx.view === 'session' ? 'Selection' : 'Selected workshop', items: rows.map(toItem) }].filter((g) => g.items.length > 0);
  for (const g of CHEAT_ORDER) {
    const items = rows.filter((r) => cheatGroupOf(r.def.id) === g).sort((a, b) => Number(a.reason !== null) - Number(b.reason !== null)).map(toItem);
    if (items.length) groups.push({ title: GROUP_TITLES[g] ?? g, items });
  }
  return groups;
}

export function CommandPalette(p: PaletteProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const [capturing, setCapturing] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const groups = useMemo(() => paletteGroups(p.ctx, p.bindings, query, p.recent, p.scope), [p.ctx, p.bindings, query, p.recent, p.scope]);
  const flat = groups.flatMap((g) => g.items);
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => { setIndex(0); }, [query]);
  const current = flat[index];

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (capturing) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') { setCapturing(null); setMessage(null); return; }
      const mac = p.platform === 'mac';
      const chord = e.key === 'Backspace' || e.key === 'Delete' ? '' : chordFromEvent({ code: e.code, metaKey: mac ? e.metaKey : e.ctrlKey, ctrlKey: mac ? e.ctrlKey : false, altKey: e.altKey, shiftKey: e.shiftKey });
      if (chord === null) return;
      const check = chord === '' ? { kind: 'ok' as const } : registry.checkRebind(p.bindings, capturing, chord);
      if (check.kind !== 'ok' && check.kind !== 'same') { setMessage(registry.rebindMessage(check, chord)); return; }
      void p.onRebind(capturing, chord).then((err) => { setMessage(err); if (!err) setCapturing(null); });
      return;
    }
    const meta = p.platform === 'mac' ? e.metaKey : e.ctrlKey;
    if (meta && e.shiftKey && e.code === 'Comma') {
      e.preventDefault();
      if (current) {
        const def = registry.byId(current.id);
        if (def?.fixed) setMessage(registry.rebindMessage({ kind: 'fixed' }, ''));
        else { setCapturing(current.id); setMessage(null); }
      }
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => Math.min(flat.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (current && current.reason === null) p.onRun(current.id); }
    else if (e.key === 'Escape') { e.preventDefault(); p.onClose(); }
  };

  let n = -1;
  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) p.onClose(); }}>
      <div className="palette" role="dialog" aria-label={p.scope === 'all' ? 'Command palette' : 'Actions for the selection'} onKeyDown={onKeyDown}>
        <div className="q">
          <Icon name="command" size={20} />
          <input ref={input} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={p.scope === 'all' ? 'Type a command' : 'Type an action'} aria-label="Search commands" />
          <Keys chord={p.scope === 'all' ? '⌘⇧P' : '⌘K'} platform={p.platform} />
        </div>
        <div className="list" role="listbox">
          {flat.length === 0 ? <div className="noresult">{p.scope === 'selection' ? 'Select a workshop first.' : 'No command matches.'}</div> : null}
          {groups.map((g) => (
            <div key={g.title}>
              <div className="grp">{g.title}</div>
              {g.items.map((it) => {
                n += 1;
                const my = n;
                return (
                  <button
                    key={`${g.title}-${it.id}`} type="button" role="option" className="item" aria-selected={my === index} aria-disabled={it.reason !== null}
                    onMouseMove={() => setIndex(my)} onClick={() => { if (it.reason === null) p.onRun(it.id); }}
                  >
                    <Icon name={it.icon} />
                    <span className="lbl">{it.label}</span>
                    {capturing === it.id ? <span>Press the new shortcut · Delete removes · Esc cancels</span>
                      : it.reason ? <span className="why">{it.reason}</span> : <Keys chord={it.chord} platform={p.platform} />}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <div className="foot">
          <span>↵ run</span>
          <span className="keys"><Keys chord="⌘⇧," platform={p.platform} /> change the shortcut of the highlighted command</span>
          <span>Esc close</span>
          {message ? <span className="msg" role="alert">{message}</span> : null}
        </div>
      </div>
    </div>
  );
}

export interface SwitcherProps {
  listing: WorkshopListing;
  live: { id: string; here: number | null; names: number | null } | null;
  today: string;
  bindings: Record<string, string>;
  platform: Platform;
  onOpen(id: string): void;
  onShowAll(): void;
  onNew(): void;
  onClose(): void;
}

export function WorkshopSwitcher(p: SwitcherProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => { setIndex(0); }, [query]);
  const rows = switcherRows(p.listing, query, p.live, p.today).slice(0, 8);
  const goto = [
    { id: 'workshop.show-all', label: 'Show all workshops', icon: 'library', run: p.onShowAll },
    { id: 'workshop.new', label: 'New workshop', icon: 'plus', run: p.onNew },
  ];
  const total = rows.length + goto.length;
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => Math.min(total - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (index < rows.length) p.onOpen(rows[index]!.id); else goto[index - rows.length]?.run(); }
    else if (e.key === 'Escape') { e.preventDefault(); p.onClose(); }
  };
  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) p.onClose(); }}>
      <div className="palette" role="dialog" aria-label="Go to workshop" onKeyDown={onKeyDown}>
        <div className="q">
          <Icon name="calendar-days" size={20} />
          <input ref={input} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Go to workshop" aria-label="Search workshops" />
          <Keys chord="⌘⇧K" platform={p.platform} />
        </div>
        <div className="list" role="listbox">
          {rows.length > 0 ? <div className="grp">Workshops</div> : null}
          {rows.map((r, i) => (
            <button key={r.id} type="button" role="option" className="item" aria-selected={i === index} onMouseMove={() => setIndex(i)} onClick={() => p.onOpen(r.id)}>
              <Icon name="calendar-days" /><span className="lbl">{r.title}</span><span className="why">{r.state}</span>
            </button>
          ))}
          <div className="grp">Go to</div>
          {goto.map((g, i) => (
            <button key={g.id} type="button" role="option" className="item" aria-selected={rows.length + i === index} onMouseMove={() => setIndex(rows.length + i)} onClick={g.run}>
              <Icon name={g.icon} /><span className="lbl">{g.label}</span><Keys chord={p.bindings[g.id] ?? ''} platform={p.platform} />
            </button>
          ))}
        </div>
        <div className="foot"><span>↵ open</span><span>↑↓ move</span><span>Esc close</span><span>Check-in stays open while you look at another workshop.</span></div>
      </div>
    </div>
  );
}
