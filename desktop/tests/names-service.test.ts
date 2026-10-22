// The name-list and recovery sheets' behaviour in main: the paste preview writes nothing, Add writes once and records provenance,
// files are read here (CSV, UTF-16 text, XLSX) with their columns guessed and changeable, the register is opened without check-in
// (and closed again) when check-in is not running, and the live service is used when it is. Recovery files are previewed and
// imported idempotently. Against the fake runtime, and against the real register handler. Fictional names only.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeRuntime } from '../main/fake-runtime.ts';
import { fakeToken } from '../main/fake-organiser.ts';
import { NamesService, readRegularFile, MAX_LIST_FILE } from '../main/names-service.ts';
import { createHttpOrganiser } from '../main/organiser-client.ts';
import { SessionService } from '../main/session-service.ts';
import { organiserOrigin, setup as registerSetup } from '../../tests/device-helpers.ts';
import type { Result } from '../shared/ipc.ts';
import type { NamesSheetView } from '../shared/names-model.ts';
import { addLabel, importTally, pasteTally, previewRows, recoveryLine, resultText, sameNameText } from '../shared/names-model.ts';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tok = (x: Result<NamesSheetView>): string => (x.ok ? x.value.token ?? '' : '');
const temp = (): string => { const d = mkdtempSync(join(tmpdir(), 'aw-names-')); dirs.push(d); return d; };

const PASTE = [
  'Aisha Rahman, aisha.rahman@example.ac.uk', 'Henrik Olsen', 'Sofia Marchetti, sofia.marchetti@example.ac.uk', 'Tom Whitfield',
  'Ngozi Adeyemi, ngozi.adeyemi@example.ac.uk', 'Callum MacLeod', 'Yuki Tanaka', 'Rebecca Hartley, rebecca.hartley@example.ac.uk',
  'Sofia Marchetti, Sofia.Marchetti@example.ac.uk', 'Mateusz Nowak', '', 'Imogen Pryce', 'Lars Eriksson', 'Sam Patel', 'Sam Patel',
].join('\n');

async function fakeRig() {
  const dir = temp();
  const rt = createFakeRuntime({ dataRoot: dir, now: () => new Date(2026, 9, 21, 9, 0) });
  const w = await rt.workshops.create({ title: 'Generative AI for Researchers', date: '2026-10-30', startTime: '14:00', endTime: '16:30' });
  const sess = new SessionService({ port: rt, organiser: rt.fake.organiserFactory, hostName: 'Mac', changed: () => undefined, pollMs: 0 });
  const written: string[] = [];
  const names = new NamesService({ port: rt, organiser: rt.fake.organiserFactory, written: async (id) => { written.push(id); await sess.reloadRegister(id); }, now: () => new Date('2026-10-21T09:00:00Z') });
  await sess.show(w.id);
  return { dir, rt, w, sess, names, written };
}

describe('pasting names (fake runtime, check-in not started)', () => {
  test('the preview matches the locked example and writes nothing; Add writes once, records provenance and refreshes the register', async () => {
    const r = await fakeRig();
    const p = await r.names.pastePreview(r.w.id, PASTE);
    if (!p.ok) throw new Error(p.error);
    const plan = p.value.plan!;
    expect(plan.counts).toMatchObject({ added: 13, merged: 1, blank: 1 });
    expect(addLabel(plan)).toBe('Add 13 people');
    expect(pasteTally(plan).map((t) => `${t.figure} ${t.text}`)).toEqual(['13 people', '1 duplicate merged: Sofia Marchetti (same email)', '1 blank line skipped']);
    expect(plan.sameName.map(sameNameText)).toEqual(['Sam Patel appears more than once. Both are kept; a check-in for this name is held for you to confirm.']);
    expect(r.rt.fake.leases()).toEqual([r.w.id]);
    expect(r.sess.view().roster!.participants).toHaveLength(0);
    const added = await r.names.add(p.value.token!);
    if (!added.ok) throw new Error(added.error);
    expect(added.value.written).toBe(true);
    expect(r.written).toEqual([r.w.id]);
    expect(r.sess.view().roster!.participants.map((x) => x.name)).toContain('Lars Eriksson');
    expect(r.sess.view().roster!.participants).toHaveLength(13);
    expect(r.rt.fake.provenance(r.w.id)).toEqual({ kind: 'paste', filename: null, sha256: null, importedAt: '2026-10-21T09:00:00.000Z', count: 13 });
    expect((await r.rt.workshops.list()).upcoming[0]!.names).toBe(13);
    expect(r.rt.fake.leases()).toEqual([]);
    expect(JSON.parse(readFileSync(join(r.rt.workshopFolder(r.w.id), 'roster-provenance.json'), 'utf8'))).toMatchObject({ kind: 'paste', count: 13 });
  });
  test('the same paste again is recognised and Add changes nothing; closing the sheet stops the register it opened', async () => {
    const r = await fakeRig();
    await r.names.add(tok(await r.names.pastePreview(r.w.id, PASTE)));
    const again = await r.names.pastePreview(r.w.id, PASTE);
    expect(again.ok && again.value.plan!.alreadyAdded).toBeTruthy();
    const second = await r.names.add(tok(again));
    expect(second.ok).toBe(false);
    expect(r.sess.view().roster!.participants).toHaveLength(13);
    await r.names.close();
    expect(r.rt.fake.leases()).toEqual([]);
  });
  test('empty text previews nothing and opens no register', async () => {
    const r = await fakeRig();
    const p = await r.names.pastePreview(r.w.id, '\n  \n');
    expect(p.ok && p.value.plan).toBeNull();
    expect(r.rt.fake.leases()).toEqual([]);
  });
  test('with check-in open, the live service is used and no second register is opened', async () => {
    const r = await fakeRig();
    await r.sess.start();
    await r.sess.refresh();
    const one = await r.names.pastePreview(r.w.id, 'Aisha Rahman, aisha.rahman@example.ac.uk');
    expect(r.rt.fake.leases()).toEqual([]);
    await r.names.add(tok(one));
    expect(r.sess.view().roster!.participants.map((x) => x.name)).toEqual(['Aisha Rahman']);
    expect(r.sess.view().registerOpen).toBe(true);
  });
});

describe('importing a file', () => {
  test('a CSV with a header: columns guessed, rows previewed with reasons, and the columns can be changed', async () => {
    const r = await fakeRig();
    const file = join(r.dir, 'booking-export.csv');
    writeFileSync(file, 'User Fullname,User Email,Start Date,Status\r\nAisha Rahman,aisha@example.ac.uk,30/10/2026,Booked\r\n,rowan@example.ac.uk,30/10/2026,Booked\r\nPriya V,priya@example.ac.uk,30/10/2026,Cancelled\r\nFelix Grant,felix@example.ac.uk,06/11/2026,Booked\r\nAisha R,AISHA@example.ac.uk,30/10/2026,Booked\r\n');
    const p = await r.names.openFile(r.w.id, file);
    if (!p.ok) throw new Error(p.error);
    expect(p.value).toMatchObject({ source: 'file', filename: 'booking-export.csv', columns: ['User Fullname', 'User Email', 'Start Date', 'Status'], mapping: { name: 0, email: 1, date: 2, status: 3 } });
    const plan = p.value.plan!;
    expect(previewRows(plan).rows.map((x) => [x.row, resultText(x)])).toEqual([[2, 'Added'], [3, 'Skipped: no name'], [4, 'Skipped: booking cancelled'], [5, 'Skipped: date is Fri 6 Nov, not this workshop'], [6, 'Merged with row 2 (same email)']]);
    expect(importTally(plan).map((t) => t.figure)).toEqual([1, 1, 3]);
    // Without the date column, Felix is added.
    const m = await r.names.remap({ ...p.value.mapping!, date: null });
    expect(m.ok && m.value.plan!.counts.added).toBe(2);
    await r.names.add(tok(m));
    expect(r.rt.fake.provenance(r.w.id)).toMatchObject({ kind: 'spreadsheet', filename: 'booking-export.csv', sha256: expect.stringMatching(/^[a-f0-9]{64}$/), count: 2 });
  });
  test('Excel "Unicode text" (UTF-16, tab-separated) and the XLSX fixture are read', async () => {
    const r = await fakeRig();
    const txt = join(r.dir, 'list.txt');
    writeFileSync(txt, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Name\tEmail\r\nZoë Ångström\tzoe@example.ac.uk\r\n', 'utf16le')]));
    const t = await r.names.openFile(r.w.id, txt);
    expect(t.ok && t.value.plan!.rows[0]).toMatchObject({ name: 'Zoë Ångström', email: 'zoe@example.ac.uk', result: 'added' });
    const x = await r.names.openFile(r.w.id, join(import.meta.dir, 'fixtures/names-booking-export.xlsx'));
    if (!x.ok) throw new Error(x.error);
    // The fake's workshop labels are the example's (Confirmed, Cancelled, Waiting list): "Booked" is a confirmed place by its words.
    expect(x.value.plan!.counts).toMatchObject({ added: 6, merged: 1, skipped: 4 });
  });
  test('no name column means a plain request to choose one; unreadable and unsupported files are refused in plain words', async () => {
    const r = await fakeRig();
    const f = join(r.dir, 'emails.csv');
    writeFileSync(f, 'Email\na@example.ac.uk\n');
    const p = await r.names.openFile(r.w.id, f);
    expect(p.ok && p.value.error).toBe('Choose the column that holds the names.');
    expect(await r.names.openFile(r.w.id, join(r.dir, 'old.xls'))).toMatchObject({ ok: false, error: expect.stringContaining('.xlsx or CSV') });
    expect(await r.names.openFile(r.w.id, join(r.dir, 'missing.csv'))).toMatchObject({ ok: false, error: 'That file could not be opened.' });
    expect(await r.names.openFile(r.w.id, r.dir)).toMatchObject({ ok: false, error: 'That is not a file.' });
    const big = join(r.dir, 'big.csv');
    writeFileSync(big, Buffer.alloc(MAX_LIST_FILE + 1, 0x41));
    expect(await r.names.openFile(r.w.id, big)).toMatchObject({ ok: false, error: expect.stringContaining('too large') });
    const fake = join(r.dir, 'fake.xlsx');
    writeFileSync(fake, 'Name\n');
    expect(await r.names.openFile(r.w.id, fake)).toMatchObject({ ok: false, error: expect.stringContaining('not an Excel workbook') });
  });
  test('the file reader only reads regular files, up to the cap', async () => {
    const d = temp();
    writeFileSync(join(d, 'a.csv'), 'x');
    expect(Buffer.from(await readRegularFile(join(d, 'a.csv'), 10)).toString()).toBe('x');
    await expect(readRegularFile(join(d, 'a.csv'), 0)).rejects.toThrow('too large');
  });
});

describe('recovery files (fake runtime)', () => {
  test('preview, import, and the same file again records nothing new', async () => {
    const r = await fakeRig();
    await r.names.add(tok(await r.names.pastePreview(r.w.id, 'Aisha Rahman\nHenrik Olsen')));
    const people = r.sess.view().roster!.participants;
    const file = join(r.dir, 'Door iPad recovery.attendance-recovery.json');
    writeFileSync(file, JSON.stringify({ format: 'attendance-recovery', version: 1, eventId: 'evt_fake', eventCode: 'H4KD', deviceId: null, exportedAt: '2026-10-30T16:40:00Z',
      operations: people.map((p, i) => ({ opId: `00000000-0000-4000-8000-00000000000${i}`, personToken: fakeToken(p.id), displayName: p.name, baseRevision: 0, windowRevisionSeen: 1, recordedAt: '2026-10-30T14:05:00Z' })) }));
    const p = await r.names.openRecovery(r.w.id, file);
    if (!p.ok) throw new Error(p.error);
    expect(recoveryLine(p.value.report!)).toBe('2 check-ins to record · 0 already recorded · 0 will need review.');
    expect(r.sess.view().roster!.participants.every((x) => !x.present)).toBe(true);
    const done = await r.names.importRecovery();
    expect(done.ok && recoveryLine(done.value.report!)).toBe('2 check-ins recorded · 0 were already recorded · 0 need review.');
    expect(r.sess.view().roster!.participants.every((x) => x.present)).toBe(true);
    await r.names.openRecovery(r.w.id, file);
    const again = await r.names.importRecovery();
    expect(again.ok && again.value.report!.counts).toEqual({ recorded: 0, already: 2, review: 0, refused: 0 });
  });
  test('a file that is not a recovery file is refused before the register is asked', async () => {
    const r = await fakeRig();
    const f = join(r.dir, 'x.json');
    writeFileSync(f, '{"format":"roster"}');
    expect(await r.names.openRecovery(r.w.id, f)).toMatchObject({ ok: false, error: 'This is not an iPad recovery file.' });
    expect(await r.names.openRecovery(r.w.id, join(r.dir, 'x.csv'))).toMatchObject({ ok: false, error: expect.stringContaining('.attendance-recovery.json') });
    expect(r.rt.fake.leases()).toEqual([]);
  });
});

describe('against the real register handler', () => {
  async function realRig() {
    const s = registerSetup();
    const viaHandler = (async (url: string, init?: RequestInit) => s.organiser(new Request(url, init))) as unknown as typeof fetch;
    const dir = temp();
    const rt = createFakeRuntime({ dataRoot: dir });
    const w = await rt.workshops.create({ title: 'Example Hands-On Workshop', date: '2030-01-15' });
    const names = new NamesService({ port: rt, organiser: () => createHttpOrganiser(organiserOrigin, viaHandler), written: async () => undefined });
    return { s, w, names, dir };
  }
  test('paste, preview, add, and the same list again: the register refuses a second add and nothing changes', async () => {
    const r = await realRig();
    const p = await r.names.pastePreview(r.w.id, 'Name, Email\nAlex Again, ALEX@example.org\nRowan Blake\nRowan Blake, rowan@example.org\n');
    if (!p.ok) throw new Error(p.error);
    expect(p.value.plan!.rows.map((x) => x.result)).toEqual(['known', 'added', 'added']);
    expect(p.value.plan!.sameName).toEqual(['Rowan Blake']);
    expect(r.s.store.list().participants).toHaveLength(6);
    expect((await r.names.add(p.value.token!)).ok).toBe(true);
    expect(r.s.store.list().participants.filter((x) => x.name === 'Rowan Blake')).toHaveLength(2);
    const again = await r.names.pastePreview(r.w.id, 'Name, Email\nAlex Again, ALEX@example.org\nRowan Blake\nRowan Blake, rowan@example.org\n');
    expect(await r.names.add(tok(again))).toMatchObject({ ok: false, error: 'This list was already added. Nothing was changed.' });
    expect(r.s.store.list().participants).toHaveLength(8);
  });
  test('a recovery file replayed twice gives no duplicates, and the iPad sending the same check-ins live is answered already_applied', async () => {
    const r = await realRig();
    const { credential, deviceId } = await r.s.pairDevice({ label: 'Door iPad' });
    const snap = await r.s.roster(credential);
    const alex = snap.people.find((x: { displayName: string }) => x.displayName === 'Alex Example');
    const op = { opId: crypto.randomUUID(), personToken: alex.personToken, displayName: 'Alex Example', baseRevision: alex.revision, windowRevisionSeen: 1, recordedAt: new Date(r.s.clock.t).toISOString() };
    const file = join(r.dir, 'door.attendance-recovery.json');
    writeFileSync(file, JSON.stringify({ format: 'attendance-recovery', version: 1, eventId: snap.eventId, eventCode: snap.eventCode, deviceId, exportedAt: new Date(r.s.clock.t).toISOString(), operations: [op, op] }));
    const p = await r.names.openRecovery(r.w.id, file);
    expect(p.ok && p.value.report).toMatchObject({ deviceLabel: 'Door iPad', counts: { recorded: 1, already: 1 } });
    await r.names.importRecovery();
    await r.names.openRecovery(r.w.id, file);
    const again = await r.names.importRecovery();
    expect(again.ok && again.value.report!.counts).toEqual({ recorded: 0, already: 2, review: 0, refused: 0 });
    expect(r.s.store.list().participants.filter((x) => x.present)).toHaveLength(1);
    const { displayName: _, ...wire } = op;
    expect((await r.s.send(credential, wire)).body.results).toEqual([{ opId: op.opId, outcome: 'already_applied' }]);
  });
});

describe('Add writes exactly what the preview showed', () => {
  test('editing the text after a preview: Add with the old preview is refused until the new preview answers, then adds the new text', async () => {
    const r = await fakeRig();
    const a = await r.names.pastePreview(r.w.id, 'Aisha Rahman\nHenrik Olsen');
    const tokenA = tok(a);
    expect(tokenA).toMatch(/^[0-9a-f]{64}$/);
    // The organiser edits; the new preview is still on its way when Add (showing A) is pressed.
    const b = r.names.pastePreview(r.w.id, 'Sofia Marchetti');
    expect(await r.names.add(tokenA)).toEqual({ ok: false, error: 'The list changed after the preview. Check the new preview, then add.' });
    const tokenB = tok(await b);
    expect(tokenB).not.toBe(tokenA);
    expect(await r.names.add(tokenA)).toMatchObject({ ok: false });
    expect(r.sess.view().roster!.participants).toHaveLength(0);
    expect((await r.names.add(tokenB)).ok).toBe(true);
    expect(r.sess.view().roster!.participants.map((x) => x.name)).toEqual(['Sofia Marchetti']);
  });
  test('changing the columns of a file invalidates the earlier preview the same way', async () => {
    const r = await fakeRig();
    const file = join(r.dir, 'list.csv');
    writeFileSync(file, 'Name,Email,Date\r\nAisha Rahman,aisha@example.ac.uk,30/10/2026\r\nFelix Grant,felix@example.ac.uk,06/11/2026\r\n');
    const first = await r.names.openFile(r.w.id, file);
    const m = await r.names.remap({ ...(first.ok ? first.value.mapping! : ({} as never)), date: null });
    expect(await r.names.add(tok(first))).toMatchObject({ ok: false });
    expect((await r.names.add(tok(m))).ok).toBe(true);
    expect(r.sess.view().roster!.participants).toHaveLength(2);
  });
});

describe('the register opened for a sheet is always stopped', () => {
  /** A runtime whose openRegister answers only when the test says so, counting opens and releases. */
  async function slowRig() {
    const r = await fakeRig();
    const counts = { opened: 0, released: 0 };
    const pending: Array<() => void> = [];
    const real = r.rt.openRegister.bind(r.rt);
    const port = Object.create(r.rt) as typeof r.rt;
    port.openRegister = async (id: string) => {
      await new Promise<void>((go) => pending.push(go));
      const lease = await real(id);
      counts.opened += 1;
      return { organiserUrl: lease.organiserUrl, release: async () => { counts.released += 1; await lease.release(); } };
    };
    const names = new NamesService({ port, organiser: r.rt.fake.organiserFactory, written: async () => undefined });
    const answer = async (): Promise<void> => { while (!pending.length) await Promise.resolve(); pending.shift()!(); };
    return { ...r, names, counts, answer, pending };
  }
  test('closing the sheet while the register is still opening stops it as soon as it arrives', async () => {
    const r = await slowRig();
    const p = r.names.pastePreview(r.w.id, 'Aisha Rahman');
    while (!r.pending.length) await Promise.resolve();
    await r.names.close();
    await r.answer();
    expect((await p).ok).toBe(false);
    expect(r.counts).toEqual({ opened: 1, released: 1 });
    expect(r.rt.fake.leases()).toEqual([]);
  });
  test('two previews in flight share one register, and closing releases it once', async () => {
    const r = await slowRig();
    const a = r.names.pastePreview(r.w.id, 'Aisha Rahman');
    const b = r.names.pastePreview(r.w.id, 'Aisha Rahman\nHenrik Olsen');
    await r.answer();
    expect((await a).ok && (await b).ok).toBe(true);
    expect(r.pending).toHaveLength(0);
    await r.names.close();
    expect(r.counts).toEqual({ opened: 1, released: 1 });
    expect(r.rt.fake.leases()).toEqual([]);
  });
});
