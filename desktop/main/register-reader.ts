// Reads a workshop's register (db/attendance.sqlite) without the register service: closed and past sessions, and the list before
// check-in starts. Read-only in every sense: the file is never created, migrated or written, and no SQLite side file is left
// behind when there was none. When the register has no -wal or -shm file (the service is stopped and closed cleanly) it is opened
// immutable, so SQLite creates neither; when they exist (a service is running on it, or one stopped without tidying up) it is opened
// read-only through them, so recent changes in the write-ahead log are seen. Node's built-in SQLite (Electron's Node 24).
import { lstatSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { Roster, RosterConflict, RosterPerson } from '../shared/register-model.ts';

export interface ReadOnlyDb { all(sql: string): Array<Record<string, unknown>>; close(): void }
/** Opens a register read-only; `immutable` when no -wal/-shm file exists (then SQLite creates neither). Test seam. */
export type ReadOnlyOpener = (file: string, opts: { immutable: boolean }) => ReadOnlyDb;

export const nodeSqliteOpener: ReadOnlyOpener = (file, { immutable }) => {
  const sqlite = process.getBuiltinModule?.('node:sqlite') as typeof import('node:sqlite') | undefined;
  if (!sqlite) throw new Error('This copy of AttendWell cannot read registers (no SQLite).');
  const url = pathToFileURL(file);
  url.searchParams.set('mode', 'ro');
  if (immutable) url.searchParams.set('immutable', '1');
  const db = new sqlite.DatabaseSync(url, { readOnly: true });
  return { all: (sql) => db.prepare(sql).all() as Array<Record<string, unknown>>, close: () => db.close() };
};

const kind = (p: string): 'file' | 'missing' | 'other' => {
  try { const st = lstatSync(p); return st.isFile() && !st.isSymbolicLink() ? 'file' : 'other'; } catch { return 'missing'; }
};

const PEOPLE_BASE = 'id,name,email,booking,present,version,updatedAt';
// The same open held check-ins the service lists (server/store-attendance.ts conflicts()).
const CONFLICTS = "SELECT o.participantId,p.name,o.reason,MIN(o.queuedAt) AS queuedAt,MAX(o.receivedAt) AS receivedAt,COUNT(*) AS count FROM operations o JOIN people p ON p.id=o.participantId WHERE o.outcome='conflict' AND o.resolvedAt IS NULL AND (p.active=1 OR o.reason='not-in-roster') GROUP BY o.participantId ORDER BY receivedAt";

const str = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/**
 * The register at `file` as the window's Roster (people on the active list, and open held check-ins); null when the workshop has
 * no register yet. The caller has already checked the workshop folder (links, containment, privacy: workshops.get).
 */
export function readRegisterFile(file: string, open: ReadOnlyOpener = nodeSqliteOpener): Roster | null {
  const k = kind(file);
  if (k === 'missing') return null;
  if (k === 'other') throw new Error('The register is not a plain file.');
  const sides = [`${file}-wal`, `${file}-shm`].map(kind);
  if (sides.includes('other')) throw new Error('The register is not a plain file.');
  const db = open(file, { immutable: sides.every((s) => s === 'missing') });
  try {
    const tables = new Set(db.all("SELECT name FROM sqlite_master WHERE type='table'").map((r) => str(r.name)));
    if (!tables.has('people')) return { participants: [], conflicts: [] };
    const hasAdmitted = db.all('PRAGMA table_info(people)').some((c) => c.name === 'admitted');
    const rows = db.all(`SELECT ${PEOPLE_BASE}${hasAdmitted ? ',admitted' : ''} FROM people WHERE active=1 ORDER BY name COLLATE NOCASE,id`);
    const participants: RosterPerson[] = rows.map((r) => ({
      id: str(r.id), name: str(r.name), email: str(r.email), booking: str(r.booking) || 'confirmed', present: Number(r.present) === 1,
      admitted: Number(r.admitted ?? 0) === 1, version: Number(r.version ?? 0), updatedAt: strOrNull(r.updatedAt),
    }));
    const conflicts: RosterConflict[] = tables.has('operations') ? db.all(CONFLICTS).map((r) => ({
      participantId: str(r.participantId), name: str(r.name), reason: str(r.reason), queuedAt: strOrNull(r.queuedAt), receivedAt: strOrNull(r.receivedAt), count: Number(r.count ?? 1),
    })) : [];
    return { participants, conflicts };
  } finally { db.close(); }
}
