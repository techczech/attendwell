// The workshops library: the main window's home view (lib-home, lib-search, lib-empty). Today, Upcoming and Past sections,
// a 70/30 details rail, search, sort and the All / Upcoming / Past filter. The view model is shared/workshops.ts.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { GetStartedButton } from '../../shared/get-started.ts';
import type { WorkshopListing } from '../../shared/runtime-types.ts';
import {
  FILTER_LABELS, SORT_LABELS, SORT_ORDER, countWorkshops, librarySections, librarySubtitle, longDate, shortPath, timeRange, visibleIds,
  type LibraryFilter, type LibraryRow, type LibrarySort,
} from '../../shared/workshops.ts';
import { Icon } from './icons.tsx';
import { Keys } from './Keys.tsx';

export interface LibraryProps {
  listing: WorkshopListing;
  today: string;
  exampleId: string | null;
  folderPath: string;
  home: string;
  platform: 'mac' | 'win';
  getStarted: GetStartedButton;
  bindings: Record<string, string>;
  selectedId: string | null;
  searchFocusTick: number;
  onSelect(id: string | null): void;
  onOpen(id: string): void;
  onReveal(id: string): void;
  onNew(): void;
  onChooseFolder(): void;
  onGetStarted(): void;
  onRemoveExample(): void;
}

export function Library(p: LibraryProps): JSX.Element {
  const [filter, setFilter] = useState<LibraryFilter>('all');
  const [sort, setSort] = useState<LibrarySort>('date-nearest');
  const [query, setQuery] = useState('');
  const [sortOpen, setSortOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const total = countWorkshops(p.listing);
  const sections = useMemo(
    () => librarySections(p.listing, { filter, query, sort, today: p.today, exampleId: p.exampleId }),
    [p.listing, filter, query, sort, p.today, p.exampleId],
  );
  const ids = visibleIds(sections);
  const selected = ids.includes(p.selectedId ?? '') ? p.selectedId : null;
  const row = sections.flatMap((s) => s.rows).find((r) => r.id === selected) ?? null;
  const folder = shortPath(p.folderPath, p.home);

  useEffect(() => { if (p.searchFocusTick > 0) searchRef.current?.focus(); }, [p.searchFocusTick]);
  // The first row is selected when nothing is, so the details rail always has something to show.
  useEffect(() => { if (selected === null && ids.length > 0) p.onSelect(ids[0]!); }, [selected, ids.join('|')]);

  const move = (delta: number): void => {
    if (ids.length === 0) return;
    const at = selected === null ? -1 : ids.indexOf(selected);
    p.onSelect(ids[Math.max(0, Math.min(ids.length - 1, at + delta))]!);
  };

  return (
    <>
      <div className="toolbar">
        <div className="wt"><b>Workshops</b><small>{librarySubtitle(total, folder)}</small></div>
        {p.getStarted === 'get-started' ? <button type="button" className="btn gs" onClick={p.onGetStarted}><Icon name="play" />Get started</button> : null}
        {p.getStarted === 'remove-example' ? <button type="button" className="btn gs" onClick={p.onRemoveExample}><Icon name="x" />Remove example</button> : null}
        <label className="search">
          <Icon name="search" />
          <input ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search workshops" aria-label="Search workshops"
            onKeyDown={(e) => { if (e.key === 'ArrowDown') { e.preventDefault(); move(1); } else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); } else if (e.key === 'Enter' && selected) p.onOpen(selected); }} />
          <Keys chord={p.bindings['workshop.search-all'] ?? ''} platform={p.platform} />
        </label>
        <div style={{ position: 'relative' }}>
          <button type="button" className="btn" aria-haspopup="menu" aria-expanded={sortOpen} onClick={() => setSortOpen((o) => !o)}>
            <Icon name="arrow-down-up" />{SORT_LABELS[sort]}<Icon name="chevron-down" />
          </button>
          {sortOpen ? (
            <div className="menu" role="menu" style={{ right: 0, top: 40 }} onKeyDown={(e) => { if (e.key === 'Escape') setSortOpen(false); }}>
              {SORT_ORDER.map((s) => (
                <button key={s} type="button" role="menuitemradio" aria-checked={s === sort} className="menu-item" onClick={() => { setSort(s); setSortOpen(false); }}>
                  <span className="tick">{s === sort ? <Icon name="check" size={14} /> : null}</span>{SORT_LABELS[s]}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <button type="button" className="btn primary" onClick={p.onNew}><Icon name="plus" />New workshop</button>
      </div>
      <div className="main">
        <section className="panel" aria-label="Workshops">
          <div className="panel-head big">
            <span>Workshops</span>
            <div className="seg" role="group" aria-label="Show">
              {(Object.keys(FILTER_LABELS) as LibraryFilter[]).map((f) => (
                <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}>{FILTER_LABELS[f]}</button>
              ))}
            </div>
          </div>
          {total === 0 ? (
            <div className="empty">
              <Icon name="calendar-days" size={44} />
              <h2>No workshops yet</h2>
              <p>Create a workshop, then paste its name list or import it from your booking system.</p>
              <div className="actions">
                <button type="button" className="btn primary" onClick={p.onNew}><Icon name="plus" />New workshop</button>
                <button type="button" className="btn" onClick={p.onChooseFolder}><Icon name="folder-open" />Choose another registers folder…</button>
              </div>
            </div>
          ) : sections.length === 0 ? (
            <div className="empty"><h2>No workshop matches</h2><p>Nothing in the list matches “{query}”.</p></div>
          ) : (
            <div className="scroll" role="listbox" aria-label="Workshops list"
              onKeyDown={(e) => { if (e.key === 'ArrowDown') { e.preventDefault(); move(1); } else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); } }}>
              {sections.map((s) => (
                <div key={s.key} role="group" aria-label={s.title}>
                  <div className="sec-title">{s.title}</div>
                  {s.rows.map((r) => <WorkshopRow key={r.id} row={r} selected={r.id === selected} onSelect={() => p.onSelect(r.id)} onOpen={() => p.onOpen(r.id)} />)}
                </div>
              ))}
            </div>
          )}
        </section>
        <aside className="panel details" aria-label="Details">
          {row ? <Details row={row} listing={p.listing} folder={`${p.folderPath}`} onOpen={() => p.onOpen(row.id)} onReveal={() => p.onReveal(row.id)} platform={p.platform} /> : (
            <>
              <div className="panel-head">Details</div>
              <div className="rail-empty">Select a workshop to see its details.</div>
            </>
          )}
        </aside>
      </div>
    </>
  );
}

function WorkshopRow({ row, selected, onSelect, onOpen }: { row: LibraryRow; selected: boolean; onSelect(): void; onOpen(): void }): JSX.Element {
  return (
    <button type="button" role="option" aria-selected={selected} className="row" onClick={onSelect} onDoubleClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onOpen(); } }}>
      <span className="badge-date"><i>{row.badge.month}</i><b>{row.badge.day}</b></span>
      <span className="row-title"><b>{row.title}</b><small>{row.whenLine || 'No time set'}</small></span>
      <span className="row-stat"><b>{row.stat}</b>{row.statNote ? <small>{row.statNote}</small> : null}</span>
      <span className={`chip ${row.chip.toLowerCase()}`}>{row.chip}</span>
    </button>
  );
}

function Details({ row, listing, folder, onOpen, onReveal, platform }: { row: LibraryRow; listing: WorkshopListing; folder: string; onOpen(): void; onReveal(): void; platform: 'mac' | 'win' }): JSX.Element {
  const all = [...listing.today, ...listing.upcoming, ...listing.past].find((w) => w.id === row.id);
  const times = all ? timeRange(all.startTime, all.endTime) : '';
  const finder = platform === 'mac' ? 'Show in Finder' : 'Show in Explorer';
  return (
    <>
      <div className="panel-head"><span>{row.title}</span><span className={`chip ${row.chip.toLowerCase()}`}>{row.chip}</span></div>
      <div className="scroll">
        <dl>
          <dt>Date</dt><dd>{longDate(row.date)}{times ? `, ${times}` : ''}</dd>
          <dt>Names</dt><dd>{row.names ? `${row.names}` : 'No names yet'}</dd>
          <dt>Attended</dt><dd>{row.when === 'past' ? (row.attended !== null ? `${row.attended}${row.names ? ` of ${row.names}` : ''}` : 'Not recorded') : 'Not started'}</dd>
          <dt>Folder</dt><dd className="mono">{`${folder.replace(/\\/g, '/')}/${row.id}`}</dd>
        </dl>
        <p className="note">{row.when === 'past' ? 'Opening a past session shows its register as it was saved.' : 'Opening this workshop opens its check-in address.'}</p>
        <div className="actions">
          <button type="button" className="btn primary" onClick={onOpen}><Icon name="folder-open" />Open</button>
          <button type="button" className="btn" onClick={onReveal}><Icon name="folder" />{finder}</button>
        </div>
      </div>
    </>
  );
}
