// The names and recovery sheets' wording (lock notes "Names" and the Kiosk recovery line) and when their commands are available.
import { describe, expect, test } from 'bun:test';
import { planNames } from '../../server/names-list.ts';
import { exampleWorkshop } from '../../server/workshop-config.ts';
import { IDLE_CTX, registry, type CommandCtx, type SessionCtx } from '../shared/commands.ts';
import { addBlocked, addLabel, importTally, previewRows, recoveryLine, recoveryReason, resultText, shortDay, type RecoveryReport } from '../shared/names-model.ts';

const plan = (rows: Array<[string, string?, string?, string?]>, existing: Array<{ name: string; email: string }> = []) => planNames({
  existing, addedLists: {}, workshopDate: '2026-10-30', statuses: exampleWorkshop.sourceStatuses,
  rows: rows.map(([name, email = '', status, date], i) => ({ row: i + 2, name, email, ...(status ? { status } : {}), ...(date ? { date } : {}) })),
});

describe('names wording', () => {
  test('rows say what happened, in the locked words', () => {
    const p = plan([['Aisha Rahman', 'a@example.ac.uk'], ['Aisha R', 'A@example.ac.uk'], ['', 'r@example.ac.uk'], ['Priya V', '', 'Cancelled'], ['Felix Grant', '', '', '2026-11-06'], ['Henrik Olsen', 'h@example.ac.uk']], [{ name: 'Henrik Olsen', email: 'h@example.ac.uk' }]);
    expect(p.rows.map(resultText)).toEqual(['Added', 'Merged with row 2 (same email)', 'Skipped: no name', 'Skipped: booking cancelled', 'Skipped: date is Fri 6 Nov, not this workshop', 'Already in the register (same email)']);
    expect(importTally(p).map((t) => `${t.figure} ${t.text}`)).toEqual(['1 person will be on the list', '2 duplicates merged by email address', '3 rows skipped, reasons below']);
    expect(previewRows(p, 2).moreAdded).toBe(0);
    expect(shortDay('2026-11-06')).toBe('Fri 6 Nov');
  });
  test('the Add button names how many, and says why it is off', () => {
    const p = plan([['Aisha Rahman'], ['Henrik Olsen']]);
    expect(addLabel(p)).toBe('Add 2 people');
    expect(addLabel(plan([['Aisha Rahman']]))).toBe('Add 1 person');
    expect(addBlocked(p)).toBeNull();
    expect(addBlocked(null)).toBe('Paste or choose a list first.');
    expect(addBlocked({ ...p, alreadyAdded: { addedAt: '2026-10-21T09:00:00Z', filename: null } })).toContain('already added');
    expect(addBlocked(plan([['', 'x@example.ac.uk']]))).toBe('There is nobody new on this list.');
  });
  test('the recovery line before and after importing', () => {
    const r: RecoveryReport = { eventCode: 'H4KD', deviceId: 'dev_1', deviceLabel: 'Door iPad', exportedAt: null, rows: [], counts: { recorded: 3, already: 1, review: 0, refused: 0 }, written: true };
    expect(recoveryLine(r)).toBe('3 check-ins recorded · 1 was already recorded · 0 need review.');
    expect(recoveryLine({ ...r, counts: { recorded: 1, already: 2, review: 1, refused: 1 } })).toBe('1 check-in recorded · 2 were already recorded · 1 needs review · 1 could not be read.');
    expect(recoveryLine({ ...r, written: false })).toBe('3 check-ins to record · 1 already recorded · 0 will need review.');
    expect(recoveryReason({ opId: 'x', name: 'A', outcome: 'review', reason: 'stale' })).toBe('Changed by an organiser after the iPad saved this check-in.');
  });
});

describe('commands', () => {
  const session = (phase: SessionCtx['phase']): CommandCtx => ({
    ...IDLE_CTX, view: 'session', workshopCount: 1,
    session: { phase, registerOpen: false, pair: { ok: false, reason: 'x' }, canUndo: false, hasAddress: false, canRetry: false, hasPeople: false, hasPresent: false, otherLive: false, person: null, device: null, repairName: null },
  });
  test('names and recovery files work before Start, while open and after End, but not while check-in is closing', () => {
    for (const phase of ['ready', 'online', 'closed', 'past'] as const) {
      for (const id of ['names.paste', 'names.import', 'ipad.import-recovery']) expect(registry.byId(id)!.available!(session(phase)), `${id} ${phase}`).toBeNull();
    }
    for (const id of ['names.paste', 'names.import', 'ipad.import-recovery']) expect(registry.byId(id)!.available!(session('ending')), id).toBe('Wait until check-in has closed.');
    expect(registry.byId('ipad.import-recovery')!.available!({ ...IDLE_CTX, view: 'library', selectedWorkshop: true })).toBe('Open a workshop first.');
  });
});
