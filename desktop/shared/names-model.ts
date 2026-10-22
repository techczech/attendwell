// The name-list and recovery sheets: the shapes main sends the window, and the locked wording (lock-notes "Names", Kiosk
// recovery line). Pure. The decisions themselves are the register's (server/names-list.ts, DeviceRegistry.importRecovery); this
// only says them.
import type { NameListRecord, NameRow, NamesPlan, RowResult } from '../../server/names-list.ts';
import type { RecoveryReport, RecoveryRow } from '../../server/device-attendance.ts';
import type { Roster } from './register-model.ts';

export type { NameListRecord, NameRow, NamesPlan, RecoveryReport, RecoveryRow, RowResult };

export interface AddNamesRequest {
  source: { kind: 'paste' | 'file'; filename?: string | null; sha256?: string | null };
  rows: NameRow[];
}
export interface AddNamesResult { plan: NamesPlan; written: boolean; roster: Roster }

/** Which column holds what (0-based; null = none). A name comes from `name`, or from `first` and `last` together. */
export interface NamesMapping {
  header: boolean;
  name: number | null;
  first: number | null;
  last: number | null;
  email: number | null;
  status: number | null;
  date: number | null;
}

export interface NamesSheetView {
  source: 'paste' | 'file';
  filename: string | null;
  /** A file or a pasted table: the columns to choose from (header text, or "Column B"). Null for a plain pasted list. */
  columns: string[] | null;
  mapping: NamesMapping | null;
  /** What adding would do (or, once written, what it did). Null while there is nothing to preview. */
  plan: NamesPlan | null;
  /** The preview's token: Add sends it back, and main adds only if it is still the latest preview's. Null with no plan. */
  token: string | null;
  written: boolean;
  error: string | null;
}

export interface RecoverySheetView {
  filename: string;
  report: RecoveryReport | null;
  error: string | null;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "Thu 6 Nov" from YYYY-MM-DD. */
export function shortDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(Date.UTC(y!, m! - 1, d!));
  return Number.isNaN(t.getTime()) ? day : `${DAYS[t.getUTCDay()]} ${t.getUTCDate()} ${MONTHS[t.getUTCMonth()]}`;
}

export function addLabel(plan: NamesPlan | null): string {
  const n = plan?.counts.added ?? 0;
  return n === 0 ? 'Add people' : `Add ${plural(n, 'person', 'people')}`;
}

/** Why the Add button is off, or null when it is on. */
export function addBlocked(plan: NamesPlan | null): string | null {
  if (!plan) return 'Paste or choose a list first.';
  if (plan.alreadyAdded) return 'This list was already added. Adding it again changes nothing.';
  if (plan.full) return `The register holds up to 500 people; with this list it would hold ${plan.total}.`;
  if (plan.counts.added === 0) return 'There is nobody new on this list.';
  return null;
}

const REASONS: Record<string, string> = {
  'no-name': 'no name',
  'name-too-long': 'name longer than 200 characters',
  'bad-email': 'email address not valid',
  cancelled: 'booking cancelled',
  'no-status-label': 'this workshop has no booking status for it',
};

export function resultText(r: RowResult): string {
  switch (r.result) {
    case 'added': return 'Added';
    case 'merged': return `Merged with row ${r.mergedWith} (same email)`;
    case 'known': return 'Already in the register (same email)';
    default: return r.reason === 'other-date' && r.date ? `Skipped: date is ${shortDay(r.date)}, not this workshop` : `Skipped: ${REASONS[r.reason ?? ''] ?? 'not readable'}`;
  }
}

export type Tone = 'good' | 'info' | 'warn' | 'neutral';
export interface TallyLine { tone: Tone; figure: number; text: string }

/** The paste sheet's "What will be added": people, merges (named), already in the register, blank lines, rows skipped. */
export function pasteTally(plan: NamesPlan): TallyLine[] {
  const out: TallyLine[] = [{ tone: 'good', figure: plan.counts.added, text: plan.counts.added === 1 ? 'person' : 'people' }];
  const merged = plan.rows.filter((r) => r.result === 'merged');
  if (merged.length) {
    const names = [...new Set(merged.map((r) => r.name))];
    out.push({ tone: 'info', figure: merged.length, text: `${merged.length === 1 ? 'duplicate' : 'duplicates'} merged: ${names.slice(0, 3).join(', ')}${names.length > 3 ? ' and others' : ''} (same email)` });
  }
  if (plan.counts.known) out.push({ tone: 'info', figure: plan.counts.known, text: 'already in the register (same email)' });
  if (plan.counts.blank) out.push({ tone: 'neutral', figure: plan.counts.blank, text: plan.counts.blank === 1 ? 'blank line skipped' : 'blank lines skipped' });
  const skipped = plan.rows.filter((r) => r.result === 'skipped');
  if (skipped.length) out.push({ tone: 'warn', figure: skipped.length, text: `${skipped.length === 1 ? 'line' : 'lines'} skipped: ${[...new Set(skipped.map((r) => resultText(r).replace(/^Skipped: /, '')))].join('; ')}` });
  return out;
}

/** The import sheet's three cards. */
export function importTally(plan: NamesPlan): TallyLine[] {
  const merged = plan.counts.merged + plan.counts.known;
  return [
    { tone: 'good', figure: plan.counts.added, text: plan.counts.added === 1 ? 'person will be on the list' : 'people will be on the list' },
    { tone: 'info', figure: merged, text: merged === 1 ? 'duplicate merged by email address' : 'duplicates merged by email address' },
    { tone: 'warn', figure: plan.counts.skipped, text: plan.counts.skipped === 1 ? 'row skipped, reason below' : 'rows skipped, reasons below' },
  ];
}

/** Lines held for confirmation: one per name that would be on the register more than once. */
export function sameNameText(name: string): string {
  return `${name} appears more than once. Both are kept; a check-in for this name is held for you to confirm.`;
}

/** Rows the import table shows: the first two added, then every row that was not simply added, then "and N more rows added". */
export function previewRows(plan: NamesPlan, firstAdded = 2, max = 60): { rows: RowResult[]; moreAdded: number } {
  const added = plan.rows.filter((r) => r.result === 'added');
  const notable = plan.rows.filter((r) => r.result !== 'added');
  const rows = [...added.slice(0, firstAdded), ...notable].slice(0, max);
  return { rows, moreAdded: added.length - Math.min(firstAdded, added.length) };
}

/** The recovery result line, in the Kiosk wording: before importing (preview) and after. */
export function recoveryLine(report: RecoveryReport): string {
  const c = report.counts;
  const refused = c.refused ? ` · ${plural(c.refused, 'could not be read', 'could not be read')}` : '';
  if (report.written) {
    return `${plural(c.recorded, 'check-in', 'check-ins')} recorded · ${c.already} ${c.already === 1 ? 'was' : 'were'} already recorded · ${c.review} ${c.review === 1 ? 'needs' : 'need'} review${refused}.`;
  }
  return `${plural(c.recorded, 'check-in', 'check-ins')} to record · ${c.already} already recorded · ${c.review} will need review${refused}.`;
}

const RECOVERY_REASONS: Record<string, string> = {
  stale: 'Changed by an organiser after the iPad saved this check-in.',
  duplicate_name: 'More than one person on the list has this name.',
  not_on_form: 'Not on the name list any more.',
  unknown_person: 'Not on this register.',
  invalid: 'Not a check-in AttendWell can read.',
};
/** Why a recovered check-in needs review or could not be read. */
export function recoveryReason(row: RecoveryRow): string {
  return RECOVERY_REASONS[row.reason ?? ''] ?? (row.outcome === 'refused' ? RECOVERY_REASONS.invalid! : 'Held for you to check.');
}
