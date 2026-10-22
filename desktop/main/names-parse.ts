// Reading a name list the organiser pastes or imports: text in any encoding a spreadsheet saves, CSV/TSV with quotes, a pasted
// list ("Name, email", "Name <email>", one per line, with or without a header), a pasted spreadsheet range (tab-separated), and the
// columns of a table. Pure; nothing here is evaluated or fetched: a cell is text, whatever it looks like. The register decides
// what each row does (server/names-list.ts); this only turns cells into rows.
import type { NamesMapping, NameRow } from '../shared/names-model.ts';

/** More text than this is not a name list. */
export const MAX_TEXT = 2_000_000;
export const MAX_ROWS = 5000;
export const MAX_COLUMNS = 100;

/**
 * Bytes to text: UTF-8 with or without its BOM, UTF-16 little- or big-endian with a BOM (Excel "Unicode text") or without one
 * (detected from the zero bytes of ASCII text), and Windows-1252 for an older export that is not valid UTF-8.
 */
export function decodeText(bytes: Uint8Array): string {
  const b = bytes;
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return new TextDecoder('utf-8').decode(b.subarray(3));
  if (b[0] === 0xff && b[1] === 0xfe) return utf16(b.subarray(2), true);
  if (b[0] === 0xfe && b[1] === 0xff) return utf16(b.subarray(2), false);
  if (b.length >= 4) {
    let evenZero = 0;
    let oddZero = 0;
    const n = Math.min(b.length, 4096);
    for (let i = 0; i < n; i += 1) if (b[i] === 0) { if (i % 2) oddZero += 1; else evenZero += 1; }
    if (oddZero > n / 4 && evenZero === 0) return utf16(b, true);
    if (evenZero > n / 4 && oddZero === 0) return utf16(b, false);
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(b); } catch { return windows1252(b); }
}

function utf16(b: Uint8Array, little: boolean): string {
  const even = b.length - (b.length % 2);
  const copy = new Uint8Array(even);
  if (little) copy.set(b.subarray(0, even));
  else for (let i = 0; i < even; i += 2) { copy[i] = b[i + 1]!; copy[i + 1] = b[i]!; }
  return new TextDecoder('utf-16le').decode(copy);
}

// The bytes 0x80–0x9F of Windows-1252 that differ from Latin-1; the rest map to the same code point.
const CP1252: Record<number, number> = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160,
  0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
  0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178,
};
function windows1252(b: Uint8Array): string {
  let out = '';
  for (const x of b) out += String.fromCharCode(CP1252[x] ?? x);
  return out;
}

/** The delimiter of a table: a tab when any line has one, otherwise whichever of comma or semicolon splits the first lines evenly. */
export function detectDelimiter(text: string): '\t' | ',' | ';' {
  const lines = text.split(/\r\n|\n|\r/).filter((l) => l.trim()).slice(0, 20);
  if (lines.some((l) => l.includes('\t'))) return '\t';
  const score = (d: string): number => {
    const counts = lines.map((l) => splitLine(l, d).length - 1);
    const nonzero = counts.filter((c) => c > 0).length;
    return nonzero === 0 ? 0 : nonzero * 10 - new Set(counts).size;
  };
  return score(';') > score(',') ? ';' : ',';
}
const splitLine = (line: string, d: string): string[] => parseDelimited(line, d)[0] ?? [];

/** RFC 4180 with any delimiter: quoted cells may hold the delimiter, quotes ("") and line breaks. Blank lines are kept as empty rows. */
export function parseDelimited(text: string, delimiter: string = detectDelimiter(text)): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let atStart = true;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 1; } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && atStart) { quoted = true; atStart = false; continue; }
    if (ch === delimiter) { row.push(cell); cell = ''; atStart = true; continue; }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell); rows.push(row.slice(0, MAX_COLUMNS)); row = []; cell = ''; atStart = true;
      if (rows.length >= MAX_ROWS) return rows;
      continue;
    }
    cell += ch;
    if (ch !== ' ') atStart = false;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row.slice(0, MAX_COLUMNS)); }
  return rows;
}

// ---- columns --------------------------------------------------------------------------------------------------------------------

// Email detection is linear in the input: no regular expression is run over a whole line or an unbounded cell. A cell is tested
// with an anchored pattern only when it is short enough to be an address and holds an '@'; a pasted line is scanned by hand.
const EMAIL_CELL_RE = /^\s*(?:mailto:)?<?[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>?\s*$/i;
/** Longest cell or token that can be an email address (RFC 5321 path limit, with room for "mailto:" and brackets). */
const MAX_EMAIL_CELL = 300;
/** A pasted line longer than this cannot be a valid row (name at most 200 characters plus an address): it is kept as a name, unscanned, and refused as too long. */
export const MAX_LINE = 1024;
const EMAIL_CELL = { test: (c: string): boolean => c.length <= MAX_EMAIL_CELL && c.includes('@') && EMAIL_CELL_RE.test(c) };
const DELIMS = new Set(['<', '>', ',', ';', ':', '"', "'", '(', ')', '[', ']']);
const isDelim = (ch: string): boolean => DELIMS.has(ch) || /\s/.test(ch);
/**
 * The first token (a run between delimiters) that reads as an address: an '@' after its first character, and a '.' at least two
 * characters after that '@' with something after it. One pass over the line.
 */
function findEmail(line: string): { start: number; end: number } | null {
  let i = 0;
  const n = line.length;
  while (i < n) {
    while (i < n && isDelim(line[i]!)) i += 1;
    const start = i;
    let at = -1;
    let dot = -1;
    while (i < n && !isDelim(line[i]!)) {
      const ch = line[i]!;
      if (ch === '@' && at < 0 && i > start) at = i;
      else if (ch === '.') dot = i;
      i += 1;
    }
    if (at >= 0 && dot >= at + 2 && dot <= i - 2) return { start, end: i };
  }
  return null;
}
const squash = (s: string): string => s.toLowerCase().replace(/[^a-z]/g, '');

type Role = 'name' | 'first' | 'last' | 'email' | 'status' | 'date';
function headerRole(cell: string): Role | null {
  const h = squash(cell);
  if (!h) return null;
  if (/^(firstname|forename|forenames|givenname|first)$/.test(h)) return 'first';
  if (/^(lastname|surname|familyname|last)$/.test(h)) return 'last';
  if (/(email|mail)/.test(h)) return 'email';
  if (/(status|booking)/.test(h)) return 'status';
  if (/(date|startdate|day|when)$/.test(h) || h === 'start') return 'date';
  if (/(name|participant|attendee|delegate|person|learner|student)/.test(h)) return 'name';
  return null;
}

/** Column letters as a spreadsheet shows them: 0 → A, 26 → AA. */
export function columnLetter(i: number): string {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** The choices a column picker offers: the header's text, or "Column B" when there is no header. */
export function columnLabels(rows: string[][], mapping: NamesMapping): string[] {
  const width = Math.max(0, ...rows.slice(0, 50).map((r) => r.length));
  const head = mapping.header ? firstNonEmpty(rows) : null;
  return Array.from({ length: width }, (_, i) => (head && head.cells[i]?.trim() ? head.cells[i]!.trim() : `Column ${columnLetter(i)}`));
}

function firstNonEmpty(rows: string[][]): { index: number; cells: string[] } | null {
  const index = rows.findIndex((r) => r.some((c) => c.trim()));
  return index < 0 ? null : { index, cells: rows[index]! };
}

/** Guesses which column holds what: from a header row when there is one, otherwise from what the cells look like. */
export function detectMapping(rows: string[][]): NamesMapping {
  const m: NamesMapping = { header: false, name: null, first: null, last: null, email: null, status: null, date: null };
  const head = firstNonEmpty(rows);
  if (!head) return m;
  const roles = head.cells.map(headerRole);
  const looksLikeData = head.cells.some((c) => EMAIL_CELL.test(c));
  if (!looksLikeData && roles.some((r) => r !== null)) {
    m.header = true;
    roles.forEach((r, i) => { if (r && m[r] === null) m[r] = i; });
    if (m.name !== null && (m.first !== null || m.last !== null)) { m.first = null; m.last = null; }
    if (m.name === null && m.first === null && m.last === null) m.name = guessNameColumn(rows.slice(head.index + 1), m.email);
    return m;
  }
  const body = rows.slice(head.index);
  m.email = guessEmailColumn(body);
  m.name = guessNameColumn(body, m.email);
  return m;
}

function guessEmailColumn(rows: string[][]): number | null {
  const width = Math.max(0, ...rows.map((r) => r.length));
  let best: number | null = null;
  let bestHits = 0;
  for (let c = 0; c < width; c += 1) {
    const hits = rows.filter((r) => EMAIL_CELL.test(r[c] ?? '')).length;
    if (hits > bestHits) { best = c; bestHits = hits; }
  }
  return best;
}
function guessNameColumn(rows: string[][], email: number | null): number | null {
  const width = Math.max(0, ...rows.map((r) => r.length));
  for (let c = 0; c < width; c += 1) {
    if (c === email) continue;
    const filled = rows.filter((r) => (r[c] ?? '').trim());
    if (filled.length && filled.filter((r) => /\p{L}/u.test(r[c]!) && !EMAIL_CELL.test(r[c]!)).length >= filled.length / 2) return c;
  }
  return null;
}

/** Rows of a table under a mapping. `row` is the number the organiser sees in the spreadsheet (1 = the first line). */
export function rowsFromTable(rows: string[][], m: NamesMapping, opts: { date1904?: boolean } = {}): NameRow[] {
  const head = m.header ? firstNonEmpty(rows)?.index ?? -1 : -1;
  const out: NameRow[] = [];
  const cell = (r: string[], i: number | null): string => (i === null ? '' : r[i] ?? '');
  rows.forEach((r, i) => {
    if (i <= head) return;
    const name = m.name !== null ? cell(r, m.name) : [cell(r, m.first), cell(r, m.last)].map((x) => x.trim()).filter(Boolean).join(' ');
    const status = m.status !== null ? cell(r, m.status) : undefined;
    const date = m.date !== null ? normaliseDate(cell(r, m.date), opts.date1904 ?? false) : undefined;
    out.push({ row: i + 1, name, email: cell(r, m.email), ...(status !== undefined ? { status } : {}), ...(date !== undefined ? { date } : {}) });
  });
  return out;
}

// ---- pasted text ----------------------------------------------------------------------------------------------------------------

export interface PastedList {
  rows: NameRow[];
  /** Set when the paste is a table (a spreadsheet range, or comma-separated lines under a header): its cells and columns. */
  table: string[][] | null;
  mapping: NamesMapping | null;
}

const isHeaderLine = (line: string): boolean => {
  if (line.includes('@')) return false;
  const parts = line.split(/[,;<>]/).map((p) => p.trim()).filter(Boolean);
  return parts.length > 0 && parts.every((p) => headerRole(p) !== null);
};

/**
 * A pasted list. Tab-separated text (a range copied from a spreadsheet) and comma-separated lines under a header row are tables;
 * anything else is one person per line: a name, and an email address after a comma, in angle brackets, or anywhere on the line.
 * A comma that is not followed by an address belongs to the name ("Rahman, Aisha").
 */
export function parsePaste(text: string): PastedList {
  const t = text.slice(0, MAX_TEXT);
  const lines = t.split(/\r\n|\n|\r/);
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
  const firstFilled = lines.find((l) => l.trim()) ?? '';
  const commaHeader = isHeaderLine(firstFilled) && /[,;]/.test(firstFilled);
  if (t.includes('\t') || commaHeader) {
    const table = parseDelimited(lines.join('\n'), t.includes('\t') ? '\t' : detectDelimiter(t));
    const mapping = detectMapping(table);
    return { rows: rowsFromTable(table, mapping), table, mapping };
  }
  const rows: NameRow[] = [];
  let headerSeen = false;
  lines.slice(0, MAX_ROWS).forEach((raw, i) => {
    const line = raw.trim();
    if (!headerSeen && line) { headerSeen = true; if (isHeaderLine(line)) return; }
    rows.push({ row: i + 1, ...splitPerson(line) });
  });
  return { rows, table: null, mapping: null };
}

const EDGE = new Set([',', ';', ':', '|', '-']);
const isEdge = (ch: string): boolean => EDGE.has(ch) || /\s/.test(ch);
/** Brackets and quotes become spaces, separators at either end go, runs of whitespace become one space. Linear: the ends are trimmed by hand. */
function strip(s: string): string {
  const t = s.replace(/[<>()[\]"']/g, ' ');
  let a = 0;
  let b = t.length;
  while (a < b && isEdge(t[a]!)) a += 1;
  while (b > a && isEdge(t[b - 1]!)) b -= 1;
  return t.slice(a, b).replace(/\s+/g, ' ').trim();
}

/** One pasted line: the address (or the token that tried to be one) and the name around it. */
export function splitPerson(line: string): { name: string; email: string } {
  if (!line.includes('@') || line.length > MAX_LINE) return { name: strip(line), email: '' };
  const m = findEmail(line);
  if (m) return { name: strip(line.slice(0, m.start).replace(/mailto:\s*$/i, '') + ' ' + line.slice(m.end)), email: line.slice(m.start, m.end) };
  // An address with a typo: kept as the email so the preview says it is not valid, rather than turning it into part of a name.
  const token = line.split(/[\s,;<>]+/).find((x) => x.includes('@')) ?? '';
  return { name: strip(line.replace(token, ' ')), email: token };
}

// ---- dates ----------------------------------------------------------------------------------------------------------------------

const MONTH: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n: number): string => String(n).padStart(2, '0');
function day(y: number, m: number, d: number): string | null {
  if (y < 100) y += 2000;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : null;
}

/**
 * A date cell as YYYY-MM-DD, or null when it is not one. ISO dates, British day-first dates (06/11/2026, 6.11.26), "6 Nov 2026"
 * with or without a weekday, and spreadsheet serial numbers (1900 or 1904 date system). A time after the date is ignored.
 */
export function normaliseDate(cell: string, date1904 = false): string | null {
  const s = cell.trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:$|[T\s])/.exec(s);
  if (m) return day(+m[1]!, +m[2]!, +m[3]!);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})(?:$|\s)/.exec(s);
  if (m) return day(+m[3]!, +m[2]!, +m[1]!);
  m = /^(?:[A-Za-z]{3,9},?\s+)?(\d{1,2})(?:st|nd|rd|th)?[\s-]+([A-Za-z]{3,9})[\s-]+(\d{2}|\d{4})(?:$|[\s,])/.exec(s);
  if (m && MONTH[m[2]!.toLowerCase().slice(0, m[2]!.toLowerCase() === 'sept' ? 4 : 3)]) return day(+m[3]!, MONTH[m[2]!.toLowerCase().slice(0, 3)]!, +m[1]!);
  if (/^\d{4,6}(\.\d+)?$/.test(s)) {
    const serial = Math.floor(Number(s));
    if (serial < 20000 || serial > 80000) return null;
    // 1900 system: day 1 is 1900-01-01 and Excel counts a 29 Feb 1900 that never was, so day 25569 is 1970-01-01.
    const t = new Date(Date.UTC(1970, 0, 1) + (serial - (date1904 ? 24107 : 25569)) * 86_400_000);
    return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
  }
  return null;
}
