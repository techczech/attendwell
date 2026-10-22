// The register as the window shows it: who is here, who is not yet, who is held for review; search, sort, counts and the closed summary.
// Pure (no Electron, no React). The input is the organiser API's roster (docs/reference-device-api.md and server/store-attendance.ts `list()`).

export interface RosterPerson {
  id: string;
  name: string;
  email: string;
  /** confirmed, waiting or cancelled (cancelled people are not in the active roster). */
  booking: string;
  present: boolean;
  admitted: boolean;
  /** The version a change must quote (the register refuses a stale one). */
  version: number;
  /** When the record last changed; for a present person, when they were checked in. */
  updatedAt: string | null;
}

export interface RosterConflict {
  participantId: string;
  name: string;
  reason: string;
  queuedAt: string | null;
  receivedAt: string | null;
  count: number;
}

export interface Roster {
  participants: RosterPerson[];
  conflicts: RosterConflict[];
}

export type RegisterFilter = 'all' | 'here' | 'not-yet' | 'held';
export type RegisterSort = 'newest' | 'name' | 'arrival';
export type RowStatus = 'here' | 'walk-in' | 'not-yet' | 'held' | 'waiting';

export const FILTER_LABELS: Record<RegisterFilter, string> = { all: 'All', here: 'Here', 'not-yet': 'Not yet', held: 'Held' };
export const FILTER_ORDER: readonly RegisterFilter[] = ['all', 'here', 'not-yet', 'held'];
export const SORT_LABELS: Record<RegisterSort, string> = { newest: 'Newest arrivals first', name: 'Name A–Z', arrival: 'Arrival order' };
export const SORT_ORDER: readonly RegisterSort[] = ['newest', 'name', 'arrival'];
export const STATUS_LABELS: Record<RowStatus, string> = { here: 'Here', 'walk-in': 'Walk-in', 'not-yet': 'Not yet', held: 'Held for review', waiting: 'Waiting list' };

const HELD_TEXT: Record<string, string> = {
  changed: 'Changed by an organiser after the iPad saved this check-in.',
  'duplicate-name': 'There is more than one booking with this name.',
  'not-eligible': 'This booking needs an organiser check.',
  'not-in-roster': 'This booking is no longer in the name list.',
};
export const heldText = (reason: string): string => HELD_TEXT[reason] ?? 'This check-in needs an organiser check.';

export interface RegisterRow {
  id: string;
  name: string;
  initials: string;
  /** null shows as "No email" for a walk-in and as a dash otherwise (the window decides). */
  email: string | null;
  walkIn: boolean;
  status: RowStatus;
  present: boolean;
  /** Local HH:MM of the check-in, or null. */
  arrived: string | null;
  arrivedAt: string | null;
  heldReason: string | null;
  version: number;
  /** Check in is offered for this row (not for a waiting-list person who has not been admitted, nor a booking missing from the list). */
  canCheckIn: boolean;
  inRoster: boolean;
}

export interface RegisterCounts { total: number; here: number; notYet: number; held: number; walkIns: number }

export interface RegisterView {
  rows: RegisterRow[];
  counts: RegisterCounts;
  /** "12 of 28 here" (live) or "26 of 28 attended" (read only). */
  headline: string;
  /** 0..1 */
  progress: number;
  /** Nothing matches the search or the filter, but the register has people. */
  noMatch: boolean;
  empty: boolean;
}

export const isWalkIn = (id: string): boolean => id.startsWith('manual-');

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = [...parts[0]!][0] ?? '';
  const last = parts.length > 1 ? [...parts[parts.length - 1]!][0] ?? '' : '';
  return (first + last).toUpperCase();
}

const pad = (n: number): string => String(n).padStart(2, '0');
/** Local HH:MM of an ISO time; null when it is not a time. */
export function clockOf(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const fold = (s: string): string => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function rowsOf(roster: Roster): RegisterRow[] {
  const held = new Map(roster.conflicts.map((c) => [c.participantId, c]));
  const known = new Set(roster.participants.map((p) => p.id));
  const rows: RegisterRow[] = roster.participants.map((p) => {
    const c = held.get(p.id);
    const walkIn = isWalkIn(p.id);
    const waiting = p.booking === 'waiting' && !p.admitted;
    const status: RowStatus = c ? 'held' : p.present ? (walkIn ? 'walk-in' : 'here') : waiting ? 'waiting' : 'not-yet';
    return {
      id: p.id, name: p.name, initials: initialsOf(p.name), email: p.email || null, walkIn, status, present: p.present,
      arrived: p.present ? clockOf(p.updatedAt) : null, arrivedAt: p.present ? p.updatedAt : null,
      heldReason: c ? heldText(c.reason) : null, version: p.version, canCheckIn: !p.present && !waiting, inRoster: true,
    };
  });
  // A held check-in for a booking a re-import removed is still listed, so the organiser can keep it as not checked in.
  for (const c of roster.conflicts) {
    if (known.has(c.participantId)) continue;
    rows.push({
      id: c.participantId, name: c.name, initials: initialsOf(c.name), email: null, walkIn: false, status: 'held', present: false, arrived: null, arrivedAt: null,
      heldReason: heldText(c.reason), version: 0, canCheckIn: false, inRoster: false,
    });
  }
  return rows;
}

export function countsOf(rows: RegisterRow[]): RegisterCounts {
  return {
    total: rows.filter((r) => r.inRoster).length,
    here: rows.filter((r) => r.present).length,
    notYet: rows.filter((r) => !r.present && r.status !== 'held').length,
    held: rows.filter((r) => r.status === 'held').length,
    walkIns: rows.filter((r) => r.walkIn && r.present).length,
  };
}

const byName = (a: RegisterRow, b: RegisterRow): number => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.id.localeCompare(b.id);
const time = (r: RegisterRow): number => (r.arrivedAt ? new Date(r.arrivedAt).getTime() : 0);

export function sortRows(rows: RegisterRow[], sort: RegisterSort, pinHeld: boolean): RegisterRow[] {
  const group = (r: RegisterRow): number => (r.status === 'held' ? (pinHeld ? 0 : 2) : r.present ? 1 : 3);
  const copy = [...rows];
  const pin = (r: RegisterRow): number => (pinHeld && r.status === 'held' ? 0 : 1);
  if (sort === 'name') return copy.sort((a, b) => pin(a) - pin(b) || byName(a, b));
  const dir = sort === 'newest' ? -1 : 1;
  return copy.sort((a, b) => group(a) - group(b) || (group(a) === 1 ? dir * (time(a) - time(b)) : 0) || byName(a, b));
}

export interface RegisterQuery { filter: RegisterFilter; sort: RegisterSort; query: string; readOnly: boolean }

export function buildRegister(roster: Roster, q: RegisterQuery): RegisterView {
  const all = rowsOf(roster);
  const counts = countsOf(all);
  const needle = fold(q.query.trim());
  const kept = all.filter((r) => {
    if (q.filter === 'here' && !r.present) return false;
    if (q.filter === 'not-yet' && (r.present || r.status === 'held')) return false;
    if (q.filter === 'held' && r.status !== 'held') return false;
    return !needle || fold(r.name).includes(needle) || fold(r.email ?? '').includes(needle);
  });
  return {
    rows: sortRows(kept, q.sort, q.readOnly), counts,
    headline: `${counts.here} of ${counts.total} ${q.readOnly ? 'attended' : 'here'}`,
    progress: counts.total === 0 ? 0 : Math.min(1, counts.here / counts.total),
    noMatch: kept.length === 0 && all.length > 0, empty: all.length === 0,
  };
}

/** The next or previous row's id for the movement keys; the first row when nothing is selected. */
export function stepSelection(rows: RegisterRow[], selectedId: string | null, delta: 1 | -1): string | null {
  if (rows.length === 0) return null;
  const i = rows.findIndex((r) => r.id === selectedId);
  if (i < 0) return rows[delta === 1 ? 0 : rows.length - 1]!.id;
  return rows[Math.min(rows.length - 1, Math.max(0, i + delta))]!.id;
}

/** The closed-session summary: "26 of 28 arrived · 2 walk-ins · 1 held for review". */
export function summaryOf(roster: Roster): RegisterCounts {
  return countsOf(rowsOf(roster));
}

// ---- Export and email review (the closed summary's two buttons) --------------------------------------------------------------

const csvCell = (v: string): string => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v);
const quote = (v: string): string => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** CSV of the register: Name, Email, Status, Arrived. Cells that would run as a formula in a spreadsheet are defused. */
export function registerCsv(roster: Roster): string {
  const lines = ['Name,Email,Status,Arrived'];
  for (const r of sortRows(rowsOf(roster), 'name', false)) lines.push([r.name, r.email ?? '', STATUS_LABELS[r.status], r.arrived ?? ''].map((c) => quote(csvCell(c))).join(','));
  return lines.join('\r\n') + '\r\n';
}

const EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

/** Who an email review goes to: people who are here with a valid address, once each. */
export function reviewRecipients(roster: Roster): { recipients: Array<{ name: string; email: string }>; skipped: number; bcc: string } {
  const seen = new Set<string>();
  const recipients: Array<{ name: string; email: string }> = [];
  let skipped = 0;
  const held = new Set(roster.conflicts.map((c) => c.participantId));
  for (const p of roster.participants) {
    if (!p.present || held.has(p.id)) continue;
    const email = p.email.trim().toLowerCase();
    if (!EMAIL.test(email) || seen.has(email)) { skipped += 1; continue; }
    seen.add(email);
    recipients.push({ name: p.name, email });
  }
  recipients.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
  return { recipients, skipped, bcc: recipients.map((r) => r.email).join('; ') };
}
