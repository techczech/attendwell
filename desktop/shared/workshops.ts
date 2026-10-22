// The workshops library as the window shows it: grouping, search, sort, row wording and the new-workshop form rules.
// Pure (no Electron, no React), so the tests read it directly.
import type { WorkshopListing, WorkshopSummary, WorkshopWhen } from './runtime-types.ts';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

export type LibraryFilter = 'all' | 'upcoming' | 'past';
export type LibrarySort = 'date-nearest' | 'date-newest' | 'title' | 'attendance';

export const SORT_LABELS: Record<LibrarySort, string> = {
  'date-nearest': 'Date, nearest first',
  'date-newest': 'Date, newest first',
  title: 'Title A–Z',
  attendance: 'Attendance, highest first',
};
export const SORT_ORDER: readonly LibrarySort[] = ['date-nearest', 'date-newest', 'title', 'attendance'];
export const FILTER_LABELS: Record<LibraryFilter, string> = { all: 'All', upcoming: 'Upcoming', past: 'Past' };

/** The date as a local calendar day; null when it is not a real YYYY-MM-DD day. */
export function parseDay(day: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getFullYear() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]) ? d : null;
}

export function dayOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** "Thu 30 Oct 2026" */
export function longDate(day: string): string {
  const d = parseDay(day);
  return d ? `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}` : day;
}
/** "Thu 9 Oct" */
export function shortDate(day: string): string {
  const d = parseDay(day);
  return d ? `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}` : day;
}
export function dateBadge(day: string): { month: string; day: string } {
  const d = parseDay(day);
  return d ? { month: MONTHS[d.getMonth()]!.toUpperCase(), day: String(d.getDate()) } : { month: '', day: '' };
}
/** "14:00–16:30", "14:00" or "". */
export function timeRange(start: string, end: string): string {
  if (start && end) return `${start}–${end}`;
  return start || '';
}
/** "Thu · 14:00–16:30" */
export function weekdayAndTimes(w: Pick<WorkshopSummary, 'date' | 'startTime' | 'endTime'>): string {
  const d = parseDay(w.date);
  const wd = d ? WEEKDAYS[d.getDay()]! : '';
  const t = timeRange(w.startTime, w.endTime);
  return [wd, t].filter(Boolean).join(' · ');
}

const slug = (s: string): string => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
/** The folder a new workshop gets (the runtime's id convention: date then title, lower case, hyphens). */
export function folderName(date: string, title: string): string {
  return `${date}-${slug(title) || 'workshop'}`;
}

export interface NewWorkshopForm { title: string; date: string; startTime: string; endTime: string }
/** What is wrong with the form, field by field, in plain words; an empty object when it can be created. */
export function checkNewWorkshop(f: NewWorkshopForm): Partial<Record<keyof NewWorkshopForm, string>> {
  const out: Partial<Record<keyof NewWorkshopForm, string>> = {};
  if (!f.title.trim()) out.title = 'Give the workshop a title.';
  if (!parseDay(f.date)) out.date = 'Choose the date of the workshop.';
  const time = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (f.startTime && !time.test(f.startTime)) out.startTime = 'Write the time as 14:00.';
  if (f.endTime && !time.test(f.endTime)) out.endTime = 'Write the time as 16:30.';
  if (!out.startTime && !out.endTime && f.startTime && f.endTime && f.endTime <= f.startTime) out.endTime = 'The end must be after the start.';
  return out;
}

export type RowChip = 'Today' | 'Upcoming' | 'Finished' | 'Example';

export interface LibraryRow {
  id: string;
  title: string;
  date: string;
  badge: { month: string; day: string };
  whenLine: string;
  stat: string;
  statNote: string;
  chip: RowChip;
  when: WorkshopWhen;
  attended: number | null;
  names: number | null;
}

export interface LibrarySection { key: WorkshopWhen; title: 'Today' | 'Upcoming' | 'Past'; rows: LibraryRow[] }

export function statText(w: Pick<WorkshopSummary, 'when' | 'attended' | 'names'>): string {
  const { when, attended, names } = w;
  if (when === 'past') {
    if (attended !== null && names) return `${attended} of ${names} attended`;
    if (attended !== null) return `${attended} attended`;
  }
  if (!names) return 'No names yet';
  return `${names} names`;
}

export function statNote(w: Pick<WorkshopSummary, 'when' | 'attended' | 'names'>, isExample: boolean): string {
  if (isExample) return 'From Get started';
  if (w.when === 'today') return w.attended ? `${w.attended} here` : 'No one here yet';
  if (w.when === 'upcoming') return w.names ? 'Name list added' : 'Add a name list';
  return '';
}

export function rowOf(w: WorkshopSummary, exampleId: string | null): LibraryRow {
  const isExample = w.id === exampleId;
  return {
    id: w.id, title: w.title, date: w.date, badge: dateBadge(w.date), whenLine: weekdayAndTimes(w),
    stat: statText(w), statNote: statNote(w, isExample),
    chip: isExample ? 'Example' : w.when === 'today' ? 'Today' : w.when === 'upcoming' ? 'Upcoming' : 'Finished',
    when: w.when, attended: w.attended, names: w.names,
  };
}

export function matches(w: WorkshopSummary, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = `${w.title} ${longDate(w.date)} ${w.date}`.toLowerCase();
  return words.every((x) => hay.includes(x));
}

const dayNumber = (day: string): number => { const d = parseDay(day); return d ? Math.round(d.getTime() / 86_400_000) : 0; };

function comparator(sort: LibrarySort, today: string): (a: WorkshopSummary, b: WorkshopSummary) => number {
  const dist = (w: WorkshopSummary): number => Math.abs(dayNumber(w.date) - dayNumber(today));
  const byTime = (a: WorkshopSummary, b: WorkshopSummary): number => a.startTime.localeCompare(b.startTime);
  switch (sort) {
    case 'date-newest': return (a, b) => b.date.localeCompare(a.date) || byTime(a, b);
    case 'title': return (a, b) => a.title.localeCompare(b.title, 'en-GB', { sensitivity: 'base' }) || a.date.localeCompare(b.date);
    case 'attendance': return (a, b) => (b.attended ?? -1) - (a.attended ?? -1) || a.title.localeCompare(b.title, 'en-GB');
    default: return (a, b) => dist(a) - dist(b) || byTime(a, b) || a.title.localeCompare(b.title, 'en-GB');
  }
}

export interface LibraryQuery { filter: LibraryFilter; query: string; sort: LibrarySort; today: string; exampleId: string | null }

/** Today, Upcoming and Past sections for the library list; a section with no match is left out. */
export function librarySections(listing: WorkshopListing, q: LibraryQuery): LibrarySection[] {
  const cmp = comparator(q.sort, q.today);
  const make = (key: WorkshopWhen, title: LibrarySection['title'], from: WorkshopSummary[]): LibrarySection => ({
    key, title, rows: from.filter((w) => matches(w, q.query)).sort(cmp).map((w) => rowOf(w, q.exampleId)),
  });
  const all: LibrarySection[] = [];
  if (q.filter === 'all') all.push(make('today', 'Today', listing.today));
  if (q.filter !== 'past') all.push(make('upcoming', 'Upcoming', listing.upcoming));
  if (q.filter !== 'upcoming') all.push(make('past', 'Past', listing.past));
  return all.filter((s) => s.rows.length > 0);
}

export function allWorkshops(listing: WorkshopListing): WorkshopSummary[] {
  return [...listing.today, ...listing.upcoming, ...listing.past];
}

export function countWorkshops(listing: WorkshopListing): number {
  return listing.today.length + listing.upcoming.length + listing.past.length;
}

/** The row order the arrow keys walk: sections as shown, rows as sorted. */
export function visibleIds(sections: LibrarySection[]): string[] {
  return sections.flatMap((s) => s.rows.map((r) => r.id));
}

/** "Documents/AttendWell": a path shown without the home folder, with forward slashes as the mockup shows it. */
export function shortPath(path: string, home: string): string {
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const p = norm(path);
  const h = norm(home);
  return h && (p === h ? true : p.startsWith(`${h}/`)) ? p.slice(h.length).replace(/^\//, '') || '~' : p;
}

export function librarySubtitle(count: number, folder: string): string {
  return count === 0 ? `No workshops in ${folder}` : `${count} in ${folder}`;
}

export interface SwitcherRow { id: string; title: string; state: string; live: boolean }
/** Go to workshop (⌘⇧K): matching workshops with their state; a live one says its check-in is open. */
export function switcherRows(listing: WorkshopListing, query: string, live: { id: string; here: number | null; names: number | null } | null, today: string): SwitcherRow[] {
  return allWorkshops(listing)
    .filter((w) => matches(w, query))
    .sort(comparator('date-nearest', today))
    .map((w) => {
      const isLive = live?.id === w.id;
      const state = isLive
        ? `Today · check-in open${live!.here !== null && live!.names ? ` · ${live!.here} of ${live!.names} here` : ''}`
        : w.when === 'today' ? `Today · ${statText(w)}` : `${shortDate(w.date)} · ${statText(w)}`;
      return { id: w.id, title: w.title, state, live: isLive };
    });
}
