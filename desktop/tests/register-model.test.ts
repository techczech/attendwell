// The register view model: status, search, filters, sort, counts, the closed summary, CSV and the email review list.
import { describe, expect, test } from 'bun:test';
import {
  buildRegister, clockOf, initialsOf, registerCsv, reviewRecipients, stepSelection, summaryOf, type Roster, type RosterPerson,
} from '../shared/register-model.ts';

const at = (hh: number, mm: number): string => new Date(2026, 9, 30, hh, mm).toISOString();
const person = (id: string, name: string, over: Partial<RosterPerson> = {}): RosterPerson => ({
  id, name, email: `${name.toLowerCase().replace(/ /g, '.')}@example.ac.uk`, booking: 'confirmed', present: false, admitted: false, version: 0, updatedAt: null, ...over,
});
const roster: Roster = {
  participants: [
    person('a', 'Aisha Rahman', { present: true, version: 1, updatedAt: at(13, 41) }),
    person('b', 'Ben Okoye'),
    person('c', 'Carla Díaz', { present: true, version: 1, updatedAt: at(14, 2) }),
    person('manual-1', 'Tomasz Kowalski', { email: '', present: true, version: 1, updatedAt: at(14, 4) }),
    person('d', 'Marta Silva'),
    person('w', 'Wen Li', { booking: 'waiting' }),
  ],
  conflicts: [{ participantId: 'd', name: 'Marta Silva', reason: 'changed', queuedAt: null, receivedAt: null, count: 1 }],
};
const q = (over: Partial<Parameters<typeof buildRegister>[1]> = {}) => buildRegister(roster, { filter: 'all', sort: 'newest', query: '', readOnly: false, ...over });

describe('statuses and counts', () => {
  test('here, walk-in, not yet, held and waiting list', () => {
    const rows = Object.fromEntries(q().rows.map((r) => [r.id, r.status]));
    expect(rows).toEqual({ a: 'here', b: 'not-yet', c: 'here', 'manual-1': 'walk-in', d: 'held', w: 'waiting' });
  });
  test('counts and the headline', () => {
    const v = q();
    expect(v.counts).toEqual({ total: 6, here: 3, notYet: 2, held: 1, walkIns: 1 });
    expect(v.headline).toBe('3 of 6 here');
    expect(v.progress).toBeCloseTo(0.5);
    expect(q({ readOnly: true }).headline).toBe('3 of 6 attended');
  });
  test('a held reason is plain words, and a waiting-list person cannot be checked in', () => {
    expect(q().rows.find((r) => r.id === 'd')!.heldReason).toBe('Changed by an organiser after the iPad saved this check-in.');
    expect(q().rows.find((r) => r.id === 'w')!.canCheckIn).toBe(false);
    expect(q().rows.find((r) => r.id === 'b')!.canCheckIn).toBe(true);
  });
  test('a held check-in for a booking a re-import removed is still listed, and cannot be checked in', () => {
    const r = buildRegister({ participants: [], conflicts: [{ participantId: 'gone', name: 'Gone Away', reason: 'not-in-roster', queuedAt: null, receivedAt: null, count: 2 }] }, { filter: 'held', sort: 'name', query: '', readOnly: false });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ status: 'held', canCheckIn: false, inRoster: false });
    expect(r.counts.total).toBe(0);
  });
  test('arrival time is the local clock time of the check-in', () => {
    expect(q().rows.find((r) => r.id === 'a')!.arrived).toBe(clockOf(at(13, 41)));
    expect(q().rows.find((r) => r.id === 'b')!.arrived).toBeNull();
  });
});

describe('filters and search', () => {
  test('Here, Not yet and Held', () => {
    expect(q({ filter: 'here' }).rows.map((r) => r.id).sort()).toEqual(['a', 'c', 'manual-1']);
    expect(q({ filter: 'not-yet' }).rows.map((r) => r.id).sort()).toEqual(['b', 'w']);
    expect(q({ filter: 'held' }).rows.map((r) => r.id)).toEqual(['d']);
  });
  test('search matches name or email, ignoring case and accents', () => {
    expect(q({ query: 'diaz' }).rows.map((r) => r.id)).toEqual(['c']);
    expect(q({ query: 'AISHA.RAH' }).rows.map((r) => r.id)).toEqual(['a']);
    expect(q({ query: 'example.ac.uk' }).rows).toHaveLength(5);
  });
  test('no match is told apart from an empty register', () => {
    expect(q({ query: 'zzz' })).toMatchObject({ noMatch: true, empty: false });
    expect(buildRegister({ participants: [], conflicts: [] }, { filter: 'all', sort: 'newest', query: '', readOnly: false })).toMatchObject({ empty: true, noMatch: false, headline: '0 of 0 here', progress: 0 });
  });
});

describe('sort', () => {
  const ids = (sort: 'newest' | 'name' | 'arrival', readOnly = false) => q({ sort, readOnly }).rows.map((r) => r.id);
  test('newest arrivals first: arrivals newest first, then held, then the rest by name', () => {
    expect(ids('newest')).toEqual(['manual-1', 'c', 'a', 'd', 'b', 'w']);
  });
  test('arrival order is the reverse of the arrivals', () => expect(ids('arrival')).toEqual(['a', 'c', 'manual-1', 'd', 'b', 'w']));
  test('name A–Z', () => expect(ids('name')).toEqual(['a', 'b', 'c', 'd', 'manual-1', 'w'].sort((x, y) => (roster.participants.find((p) => p.id === x)!.name).localeCompare(roster.participants.find((p) => p.id === y)!.name))));
  test('a closed register lists held rows first', () => expect(ids('newest', true)[0]).toBe('d'));
});

describe('selection and names', () => {
  test('movement keys stop at the ends and start from the first or last row', () => {
    const rows = q().rows;
    expect(stepSelection(rows, null, 1)).toBe(rows[0]!.id);
    expect(stepSelection(rows, null, -1)).toBe(rows[rows.length - 1]!.id);
    expect(stepSelection(rows, rows[0]!.id, -1)).toBe(rows[0]!.id);
    expect(stepSelection(rows, rows[rows.length - 1]!.id, 1)).toBe(rows[rows.length - 1]!.id);
    expect(stepSelection([], null, 1)).toBeNull();
  });
  test('initials', () => {
    expect(initialsOf('Aisha Rahman')).toBe('AR');
    expect(initialsOf('Madonna')).toBe('M');
    expect(initialsOf('  ')).toBe('?');
  });
});

describe('closed summary, CSV and email review', () => {
  test('summary figures', () => expect(summaryOf(roster)).toMatchObject({ here: 3, total: 6, walkIns: 1, held: 1 }));
  test('CSV has a header, the status and the time, quotes commas, and defuses formulas', () => {
    const r: Roster = { participants: [person('x', '=HYPERLINK("x")', { email: 'a,b@example.ac.uk' }), person('y', 'Plain Name', { present: true, updatedAt: at(9, 5) })], conflicts: [] };
    const csv = registerCsv(r).split('\r\n');
    expect(csv[0]).toBe('Name,Email,Status,Arrived');
    expect(csv.some((l) => l.startsWith('"\'=HYPERLINK(""x"")"'))).toBe(true);
    expect(csv.some((l) => l.includes('"a,b@example.ac.uk"'))).toBe(true);
    expect(csv.find((l) => l.startsWith('Plain Name'))).toBe(`Plain Name,plain.name@example.ac.uk,Here,${clockOf(at(9, 5))}`);
    expect(registerCsv(r).endsWith('\r\n')).toBe(true);
  });
  test('email review lists people who are here with a valid address, once each, never held ones', () => {
    const r: Roster = {
      participants: [
        person('1', 'Zed One', { present: true, email: 'Shared@Example.ac.uk' }), person('2', 'Amy Two', { present: true, email: 'shared@example.ac.uk' }),
        person('3', 'Bea Three', { present: true, email: 'bea@example.ac.uk' }), person('4', 'No Address', { present: true, email: '' }), person('5', 'Not Here', { email: 'nh@example.ac.uk' }),
        person('6', 'Held One', { present: true, email: 'held@example.ac.uk' }),
      ],
      conflicts: [{ participantId: '6', name: 'Held One', reason: 'changed', queuedAt: null, receivedAt: null, count: 1 }],
    };
    const out = reviewRecipients(r);
    expect(out.recipients.map((x) => x.email)).toEqual(['bea@example.ac.uk', 'shared@example.ac.uk']);
    expect(out.skipped).toBe(2);
    expect(out.bcc).toBe('bea@example.ac.uk; shared@example.ac.uk');
  });
});
