// What the session screen may ask the main process: every action is checked before anything runs; unknown shapes are refused.
import { describe, expect, test } from 'bun:test';
import { parseSessionAction, type SessionAction } from '../shared/ipc.ts';

const ok = (a: unknown): SessionAction => parseSessionAction(a);
const bad = (a: unknown): void => { expect(() => parseSessionAction(a), JSON.stringify(a)).toThrow('Bad argument'); };

describe('session actions', () => {
  test('the simple ones pass and drop any extra fields', () => {
    for (const kind of ['leave', 'start', 'retry', 'end', 'undo', 'pair-new', 'pair-close', 'export-csv'] as const) expect(ok({ kind, extra: 'x' })).toEqual({ kind });
  });
  test('mark, resolve, add and the pairing calls carry checked fields', () => {
    expect(ok({ kind: 'mark', id: 'manual-fake-1', present: true })).toEqual({ kind: 'mark', id: 'manual-fake-1', present: true });
    expect(ok({ kind: 'resolve', id: 'p3', action: 'dismiss' })).toEqual({ kind: 'resolve', id: 'p3', action: 'dismiss' });
    expect(ok({ kind: 'add', name: 'Tomasz Kowalski', email: '', markHere: true })).toEqual({ kind: 'add', name: 'Tomasz Kowalski', email: '', markHere: true });
    expect(ok({ kind: 'add', name: 'A' })).toEqual({ kind: 'add', name: 'A', email: '', markHere: false });
    expect(ok({ kind: 'pair-open' })).toEqual({ kind: 'pair-open' });
    expect(ok({ kind: 'pair-open', targetDeviceId: 'dev_1', label: 'Door iPad' })).toEqual({ kind: 'pair-open', targetDeviceId: 'dev_1', label: 'Door iPad' });
    expect(ok({ kind: 'rename', id: 'dev_1', label: 'Front desk' })).toEqual({ kind: 'rename', id: 'dev_1', label: 'Front desk' });
    expect(ok({ kind: 'dismiss-hold', id: 7 })).toEqual({ kind: 'dismiss-hold', id: 7 });
    expect(ok({ kind: 'copy', what: 'pair-code' })).toEqual({ kind: 'copy', what: 'pair-code' });
    expect(ok({ kind: 'quit', endFirst: true })).toEqual({ kind: 'quit', endFirst: true });
    expect(ok({ kind: 'quit' })).toEqual({ kind: 'quit', endFirst: false });
  });
  test('wrong types, odd ids, long text, unknown kinds and a copy of anything else are refused', () => {
    bad(null); bad('start'); bad({}); bad({ kind: 'delete-everything' });
    bad({ kind: 'mark', id: 'p1', present: 'yes' }); bad({ kind: 'mark', id: '../etc', present: true }); bad({ kind: 'mark', id: '', present: true });
    bad({ kind: 'resolve', id: 'p1', action: 'erase' });
    bad({ kind: 'add', name: '' }); bad({ kind: 'add', name: 'x'.repeat(201) }); bad({ kind: 'add', name: 'A', email: 'x'.repeat(255) });
    bad({ kind: 'rename', id: 'dev_1', label: '' }); bad({ kind: 'rename', id: 'dev_1', label: 'x'.repeat(41) });
    bad({ kind: 'dismiss-hold', id: -1 }); bad({ kind: 'dismiss-hold', id: '7' }); bad({ kind: 'dismiss-hold', id: 1.5 });
    bad({ kind: 'copy', what: 'clipboard text from the page' }); bad({ kind: 'pair-open', targetDeviceId: 'a b' }); bad({ kind: 'show', workshopId: 5 });
  });
  test('the names and recovery actions carry checked fields', () => {
    for (const kind of ['names-choose-file', 'names-close', 'recovery-choose-file', 'recovery-import', 'recovery-close'] as const) expect(ok({ kind, path: '/etc/passwd' })).toEqual({ kind });
    expect(ok({ kind: 'names-paste', text: 'Aisha Rahman, a@example.ac.uk' })).toEqual({ kind: 'names-paste', text: 'Aisha Rahman, a@example.ac.uk' });
    expect(ok({ kind: 'names-map', mapping: { header: true, name: 0, email: 1, extra: 3 } })).toEqual({ kind: 'names-map', mapping: { header: true, name: 0, first: null, last: null, email: 1, status: null, date: null } });
    expect(ok({ kind: 'recovery-file', path: '/Users/x/Door iPad.attendance-recovery.json' })).toEqual({ kind: 'recovery-file', path: '/Users/x/Door iPad.attendance-recovery.json' });
    bad({ kind: 'names-paste', text: 'x'.repeat(300_001) }); bad({ kind: 'names-paste' });
    bad({ kind: 'names-map', mapping: { name: -1 } }); bad({ kind: 'names-map', mapping: { email: '1' } }); bad({ kind: 'names-map', mapping: { date: 100 } });
    expect(ok({ kind: 'names-add', token: 'a'.repeat(64) })).toEqual({ kind: 'names-add', token: 'a'.repeat(64) });
    bad({ kind: 'names-add' }); bad({ kind: 'names-add', token: 'A'.repeat(64) }); bad({ kind: 'names-add', token: 'a'.repeat(65) });
    bad({ kind: 'recovery-file', path: '' }); bad({ kind: 'recovery-file', path: 'x'.repeat(4097) });
  });
});
