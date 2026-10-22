// The name-list sheets and the recovery-file sheet, apart from Electron: read what the organiser pasted or chose (files are read here,
// in the main process, never in the window), preview it against the register, and write it only when confirmed. Every preview and
// every write goes to the register service through the organiser client, the same path a live session uses, so there is one write
// path. With check-in open that is the live service; otherwise the runtime opens the workshop's register on loopback for as long as
// a sheet needs it (RuntimePort.openRegister), with no check-in address.
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { MAX_LIST_ROWS } from '../../server/names-list.ts';
import type { Result } from '../shared/ipc.ts';
import type { NameRow, NamesMapping, NamesPlan, NamesSheetView, RecoveryReport, RecoverySheetView } from '../shared/names-model.ts';
import type { RegisterLease } from '../shared/runtime-types.ts';
import { columnLabels, decodeText, detectMapping, parseDelimited, parsePaste, rowsFromTable } from './names-parse.ts';
import { OrganiserError, type OrganiserClient, type OrganiserFactory } from './organiser-client.ts';
import type { RuntimePort } from './runtime-port.ts';
import { readXlsx, SpreadsheetError } from './xlsx-read.ts';

/** A name list file larger than this is not a name list. */
export const MAX_LIST_FILE = 5 * 1024 * 1024;
/** An iPad recovery file holds at most 1000 check-ins of a few hundred bytes each. */
export const MAX_RECOVERY_FILE = 1024 * 1024;

export interface NamesServiceDeps {
  port: RuntimePort;
  organiser: OrganiserFactory;
  /** Names were added or check-ins recorded: the session screen reads the register again and the library its counts. */
  written(workshopId: string): Promise<void>;
  /** Reads a regular file of at most `max` bytes (default: from disk). */
  readFile?: (path: string, max: number) => Promise<Uint8Array>;
  now?: () => Date;
}

export class FileError extends Error {}

/** Reads a chosen file: a regular file, no larger than `max`. Nothing else is opened. */
export async function readRegularFile(path: string, max: number): Promise<Uint8Array> {
  let fh;
  try { fh = await open(path, 'r'); } catch { throw new FileError('That file could not be opened.'); }
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new FileError('That is not a file.');
    if (st.size > max) throw new FileError(`That file is too large (over ${Math.round(max / 1024 / 1024)} MB).`);
    const buf = new Uint8Array(st.size);
    const { bytesRead } = await fh.read(buf, 0, st.size, 0);
    return buf.subarray(0, bytesRead);
  } finally { await fh.close(); }
}

const say = (e: unknown, fallback: string): string => (e instanceof OrganiserError || e instanceof FileError || e instanceof SpreadsheetError ? e.message : e instanceof Error && e.message ? e.message : fallback);
const fail = (e: unknown, fallback = 'That did not work. Try again.'): { ok: false; error: string } => ({ ok: false, error: say(e, fallback) });

interface NamesState {
  kind: 'names';
  workshopId: string;
  source: 'paste' | 'file';
  filename: string | null;
  sha256: string | null;
  table: string[][] | null;
  date1904: boolean;
  mapping: NamesMapping | null;
  rows: NameRow[];
  plan: NamesPlan | null;
  /** Names the exact rows `plan` was made from; Add must bring it back. Null until this state's own preview has answered. */
  token: string | null;
  written: boolean;
}
interface RecoveryState { kind: 'recovery'; workshopId: string; filename: string; file: unknown; report: RecoveryReport | null }

const trimRows = (rows: string[][]): string[][] => {
  const out = rows.slice();
  while (out.length && out[out.length - 1]!.every((c) => !c.trim())) out.pop();
  return out;
};
/** Cells long enough to be refused for their length, short enough to keep the request small. */
const bound = (r: NameRow): NameRow => ({ ...r, name: r.name.slice(0, 201), email: r.email.slice(0, 255), ...(r.status !== undefined ? { status: r.status.slice(0, 100) } : {}) });
const hasName = (m: NamesMapping | null): boolean => !m || m.name !== null || m.first !== null || m.last !== null;
/** The token of a preview: a hash of everything Add would send. */
const tokenOf = (s: NamesState): string => createHash('sha256').update(JSON.stringify([s.workshopId, s.source, s.filename, s.sha256, s.rows.map(bound)])).digest('hex');
const CHANGED = 'The list changed after the preview. Check the new preview, then add.';

export class NamesService {
  private state: NamesState | RecoveryState | null = null;
  private lease: { id: string; lease: RegisterLease } | null = null;
  /** Bumped when the sheet closes or moves to another workshop: a register still being opened for the old one is stopped as it arrives. */
  private gen = 0;
  private opening: { id: string; gen: number; p: Promise<RegisterLease>; dropped: boolean } | null = null;
  private readonly read: (path: string, max: number) => Promise<Uint8Array>;
  private readonly now: () => Date;

  constructor(private readonly d: NamesServiceDeps) {
    this.read = d.readFile ?? readRegularFile;
    this.now = d.now ?? (() => new Date());
  }

  // ---- the register ---------------------------------------------------------------------------------------------------------------

  private async client(id: string): Promise<OrganiserClient> {
    const s = this.d.port.status.get();
    if (s.workshopId === id && s.session !== 'idle') {
      if (s.session === 'running' && s.service.state === 'running') { await this.releaseLease(); return this.d.organiser(s.service.organiserUrl); }
      throw new OrganiserError('Check-in is starting or closing. Try again in a moment.', 0);
    }
    return this.d.organiser((await this.leaseFor(id)).organiserUrl);
  }

  /**
   * The register opened for this sheet's workshop, opened once however many previews ask at the same time. A register that arrives
   * after the sheet closed or moved on (or after another one was taken) is stopped at once, so every open has exactly one release.
   */
  private async leaseFor(id: string): Promise<RegisterLease> {
    if (this.lease?.id === id) return this.lease.lease;
    if (this.lease || (this.opening && this.opening.id !== id)) { this.gen += 1; await this.releaseLease(); }
    const g = this.gen;
    if (!this.opening || this.opening.id !== id || this.opening.gen !== g) this.opening = { id, gen: g, p: this.d.port.openRegister(id), dropped: false };
    const o = this.opening;
    let lease: RegisterLease;
    try { lease = await o.p; } finally { if (this.opening === o) this.opening = null; }
    if (g === this.gen && !o.dropped && (!this.lease || this.lease.lease === lease)) {
      this.lease = { id, lease };
      return lease;
    }
    if (this.lease?.lease !== lease && !o.dropped) {
      o.dropped = true;
      try { await lease.release(); } catch { /* the runtime stops it at quit */ }
    }
    throw new OrganiserError('The sheet was closed or changed. Try again.', 0);
  }

  private async releaseLease(): Promise<void> {
    const l = this.lease;
    this.lease = null;
    if (l) { try { await l.lease.release(); } catch { /* the runtime stops it at quit */ } }
  }

  // ---- name lists -----------------------------------------------------------------------------------------------------------------

  private view(s: NamesState, error: string | null = null): NamesSheetView {
    return {
      source: s.source, filename: s.filename, columns: s.table && s.mapping ? columnLabels(s.table, s.mapping) : null, mapping: s.mapping,
      plan: s.plan, token: s.token, written: s.written, error,
    };
  }

  private async preview(s: NamesState): Promise<Result<NamesSheetView>> {
    s.plan = null;
    s.token = null;
    this.state = s;
    if (!s.rows.some((r) => r.name.trim() || r.email.trim())) { s.plan = null; return { ok: true, value: this.view(s) }; }
    if (!hasName(s.mapping)) { s.plan = null; return { ok: true, value: this.view(s, 'Choose the column that holds the names.') }; }
    if (s.rows.length > MAX_LIST_ROWS) { s.plan = null; return { ok: true, value: this.view(s, `This list has more than ${MAX_LIST_ROWS} rows. A register holds up to 500 people.`) }; }
    try {
      const c = await this.client(s.workshopId);
      const r = await c.addNames({ source: { kind: s.source, filename: s.filename, sha256: s.sha256 }, rows: s.rows.map(bound) }, true);
      s.plan = r.plan;
      s.token = tokenOf(s);
      return { ok: true, value: this.view(s) };
    } catch (e) { return fail(e, 'The register could not be read.'); }
  }

  /** The paste sheet's live preview. Empty text previews nothing. */
  async pastePreview(workshopId: string, text: string): Promise<Result<NamesSheetView>> {
    const p = parsePaste(text);
    return this.preview({ kind: 'names', workshopId, source: 'paste', filename: null, sha256: null, table: p.table, date1904: false, mapping: p.mapping, rows: p.rows, plan: null, token: null, written: false });
  }

  /** Import a file: CSV, TSV, text or XLSX, read here. Columns are guessed; `remap` changes them. */
  async openFile(workshopId: string, path: string): Promise<Result<NamesSheetView>> {
    try {
      const ext = extname(path).toLowerCase();
      if (ext === '.xls') throw new FileError('This is an older Excel file (.xls). Save it as .xlsx or CSV, then try again.');
      if (ext === '.numbers' || ext === '.ods') throw new FileError('Export it as CSV or Excel (.xlsx) first, then import that file.');
      const bytes = await this.read(path, MAX_LIST_FILE);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const zip = bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
      let table: string[][];
      let date1904 = false;
      if (zip || ext === '.xlsx' || ext === '.xlsm') ({ rows: table, date1904 } = readXlsx(bytes));
      else {
        const text = decodeText(bytes);
        if (/\u0000/.test(text)) throw new FileError('This file is not a text or spreadsheet file AttendWell can read.');
        table = parseDelimited(text);
      }
      table = trimRows(table);
      const mapping = detectMapping(table);
      return this.preview({ kind: 'names', workshopId, source: 'file', filename: basename(path).slice(0, 250), sha256, table, date1904, mapping, rows: rowsFromTable(table, mapping, { date1904 }), plan: null, token: null, written: false });
    } catch (e) { return fail(e, 'That file could not be read.'); }
  }

  /** The organiser chose other columns. */
  async remap(mapping: NamesMapping): Promise<Result<NamesSheetView>> {
    const s = this.state;
    if (s?.kind !== 'names' || !s.table) return { ok: false, error: 'There is no list to change.' };
    const width = Math.max(0, ...s.table.map((r) => r.length));
    const col = (v: number | null): number | null => (v !== null && Number.isInteger(v) && v >= 0 && v < width ? v : null);
    const m: NamesMapping = { header: mapping.header, name: col(mapping.name), first: col(mapping.first), last: col(mapping.last), email: col(mapping.email), status: col(mapping.status), date: col(mapping.date) };
    if (m.name !== null) { m.first = null; m.last = null; }
    return this.preview({ ...s, mapping: m, rows: rowsFromTable(s.table, m, { date1904: s.date1904 }), plan: null });
  }

  /**
   * Add the people the preview showed: only when `token` is the token of the latest preview, and that preview has answered, so
   * what is written is exactly what the window showed. The register plans again inside its write.
   */
  async add(token: string): Promise<Result<NamesSheetView>> {
    const s = this.state;
    if (s?.kind !== 'names') return { ok: false, error: 'Paste or choose a list first.' };
    if (!s.plan || !s.token || s.token !== token || tokenOf(s) !== token) return { ok: false, error: CHANGED };
    try {
      const c = await this.client(s.workshopId);
      const r = await c.addNames({ source: { kind: s.source, filename: s.filename, sha256: s.sha256 }, rows: s.rows.map(bound) }, false);
      s.plan = r.plan; s.written = r.written;
      if (r.written) {
        try {
          await this.d.port.recordRosterProvenance(s.workshopId, { kind: s.source === 'paste' ? 'paste' : 'spreadsheet', filename: s.filename, sha256: s.sha256, importedAt: this.now().toISOString(), count: r.plan.total });
        } catch { /* the names are in the register; only the library's count waits for the next list */ }
        await this.releaseLease();
        await this.d.written(s.workshopId);
      }
      return { ok: true, value: this.view(s) };
    } catch (e) { return fail(e, 'The names could not be added.'); }
  }

  // ---- recovery files -------------------------------------------------------------------------------------------------------------

  /** Read an iPad's recovery file and preview what importing it would record. */
  async openRecovery(workshopId: string, path: string): Promise<Result<RecoverySheetView>> {
    const filename = basename(path).slice(0, 250);
    try {
      if (extname(path).toLowerCase() !== '.json') throw new FileError('Choose the .attendance-recovery.json file the iPad saved.');
      const bytes = await this.read(path, MAX_RECOVERY_FILE);
      let file: unknown;
      try { file = JSON.parse(decodeText(bytes)); } catch { throw new FileError('This is not an iPad recovery file.'); }
      if ((file as { format?: unknown } | null)?.format !== 'attendance-recovery') throw new FileError('This is not an iPad recovery file.');
      const s: RecoveryState = { kind: 'recovery', workshopId, filename, file, report: null };
      this.state = s;
      const c = await this.client(workshopId);
      s.report = await c.importRecovery(file, true);
      return { ok: true, value: { filename, report: s.report, error: null } };
    } catch (e) { return fail(e, 'That file could not be read.'); }
  }

  /** Record the check-ins. Importing the same file again records nothing new. */
  async importRecovery(): Promise<Result<RecoverySheetView>> {
    const s = this.state;
    if (s?.kind !== 'recovery') return { ok: false, error: 'Choose a recovery file first.' };
    try {
      const c = await this.client(s.workshopId);
      s.report = await c.importRecovery(s.file, false);
      await this.releaseLease();
      await this.d.written(s.workshopId);
      return { ok: true, value: { filename: s.filename, report: s.report, error: null } };
    } catch (e) { return fail(e, 'The check-ins could not be imported.'); }
  }

  /** The sheet closed: nothing is kept, and a register opened for it is stopped. */
  async close(): Promise<void> {
    this.state = null;
    this.gen += 1;
    await this.releaseLease();
  }
}
