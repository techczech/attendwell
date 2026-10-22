import { describe, expect, test } from 'bun:test';
import type { WorkshopListing, WorkshopSummary } from '../shared/runtime-types.ts';
import {
  checkNewWorkshop, dateBadge, folderName, librarySections, librarySubtitle, longDate, matches, rowOf, shortPath, statNote, statText, switcherRows, visibleIds, weekdayAndTimes,
} from '../shared/workshops.ts';

const w = (id: string, title: string, date: string, when: WorkshopSummary['when'], extra: Partial<WorkshopSummary> = {}): WorkshopSummary => ({
  id, title, date, startTime: '10:00', endTime: '12:00', archived: false, when, attended: null, names: null, ...extra,
});
const TODAY = '2026-10-30';
const listing: WorkshopListing = {
  today: [w('t', 'Generative AI for Researchers', '2026-10-30', 'today', { startTime: '14:00', endTime: '16:30', names: 28 })],
  upcoming: [w('u2', 'AI Tools for Teaching', '2026-12-03', 'upcoming'), w('u1', 'Prompting for Literature Reviews', '2026-11-13', 'upcoming', { names: 22 })],
  past: [
    w('p1', 'Copilot for Research Admin', '2026-10-21', 'past', { attended: 19, names: 24 }),
    w('p2', 'Generative AI Essentials', '2026-10-09', 'past', { attended: 31, names: 35 }),
    w('p3', 'Writing with AI Assistants', '2026-09-24', 'past', { attended: 17, names: 20 }),
  ],
  archived: [],
};
const q = (over: Partial<Parameters<typeof librarySections>[1]> = {}) => librarySections(listing, { filter: 'all', query: '', sort: 'date-nearest', today: TODAY, exampleId: null, ...over });

describe('library sections', () => {
  test('Today, Upcoming and Past, in that order, nearest first within each', () => {
    const s = q();
    expect(s.map((x) => x.title)).toEqual(['Today', 'Upcoming', 'Past']);
    expect(s[1]!.rows.map((r) => r.id)).toEqual(['u1', 'u2']);
    expect(s[2]!.rows.map((r) => r.id)).toEqual(['p1', 'p2', 'p3']);
  });
  test('filters', () => {
    expect(q({ filter: 'upcoming' }).map((x) => x.title)).toEqual(['Upcoming']);
    expect(q({ filter: 'past' }).map((x) => x.title)).toEqual(['Past']);
  });
  test('search matches title words and the date text; a section with no match is left out', () => {
    expect(visibleIds(q({ query: 'copilot' }))).toEqual(['p1']);
    expect(visibleIds(q({ query: 'gen ai' }))).toEqual(['t', 'p2']);
    expect(visibleIds(q({ query: 'nov' }))).toEqual(['u1']);
    expect(q({ query: 'zzz' })).toEqual([]);
    expect(matches(listing.past[0]!, '  ')).toBe(true);
  });
  test('sorts: newest first, title A to Z, attendance highest first', () => {
    expect(q({ sort: 'date-newest' })[2]!.rows.map((r) => r.id)).toEqual(['p1', 'p2', 'p3']);
    expect(q({ sort: 'date-newest' })[1]!.rows.map((r) => r.id)).toEqual(['u2', 'u1']);
    expect(q({ sort: 'title' })[2]!.rows.map((r) => r.title)).toEqual(['Copilot for Research Admin', 'Generative AI Essentials', 'Writing with AI Assistants']);
    expect(q({ sort: 'attendance' })[2]!.rows.map((r) => r.id)).toEqual(['p2', 'p1', 'p3']);
  });
  test('nearest first puts the closest past session first, not the oldest', () => {
    const only = librarySections({ ...listing, upcoming: [], today: [] }, { filter: 'all', query: '', sort: 'date-nearest', today: TODAY, exampleId: null });
    expect(only[0]!.rows[0]!.id).toBe('p1');
  });
  test('the arrow keys walk the rows as shown', () => {
    expect(visibleIds(q())).toEqual(['t', 'u1', 'u2', 'p1', 'p2', 'p3']);
  });
});

describe('row wording', () => {
  test('stat text for each state', () => {
    expect(statText(listing.today[0]!)).toBe('28 names');
    expect(statText(listing.upcoming[0]!)).toBe('No names yet');
    expect(statText(listing.past[0]!)).toBe('19 of 24 attended');
    expect(statText({ when: 'past', attended: 5, names: null })).toBe('5 attended');
    expect(statText({ when: 'past', attended: null, names: 9 })).toBe('9 names');
  });
  test('notes and chips', () => {
    expect(statNote(listing.today[0]!, false)).toBe('No one here yet');
    expect(statNote(listing.upcoming[1]!, false)).toBe('Name list added');
    expect(statNote(listing.upcoming[0]!, false)).toBe('Add a name list');
    expect(statNote(listing.past[0]!, true)).toBe('From Get started');
    expect(rowOf(listing.past[0]!, 'p1').chip).toBe('Example');
    expect(rowOf(listing.past[0]!, null).chip).toBe('Finished');
    expect(rowOf(listing.today[0]!, null).chip).toBe('Today');
    expect(rowOf(listing.upcoming[0]!, null).chip).toBe('Upcoming');
  });
  test('dates', () => {
    expect(longDate('2026-10-30')).toBe('Fri 30 Oct 2026');
    expect(dateBadge('2026-09-01')).toEqual({ month: 'SEP', day: '1' });
    expect(weekdayAndTimes(listing.today[0]!)).toBe('Fri · 14:00–16:30');
    expect(longDate('2026-02-31')).toBe('2026-02-31');
  });
  test('subtitle and short path', () => {
    expect(librarySubtitle(8, 'Documents/AttendWell')).toBe('8 in Documents/AttendWell');
    expect(librarySubtitle(0, 'Documents/AttendWell')).toBe('No workshops in Documents/AttendWell');
    expect(shortPath('/Users/a/Documents/AttendWell', '/Users/a')).toBe('Documents/AttendWell');
    expect(shortPath('C:\\Users\\a\\Documents\\AttendWell\\', 'C:\\Users\\a')).toBe('Documents/AttendWell');
    expect(shortPath('/Volumes/Drive/Registers', '/Users/a')).toBe('/Volumes/Drive/Registers');
  });
});

describe('switcher', () => {
  test('matching workshops with their state; the live one says check-in is open', () => {
    const rows = switcherRows(listing, 'gen', { id: 't', here: 12, names: 28 }, TODAY);
    expect(rows.map((r) => r.id)).toEqual(['t', 'p2']);
    expect(rows[0]!.state).toBe('Today · check-in open · 12 of 28 here');
    expect(rows[1]!.state).toBe('Fri 9 Oct · 31 of 35 attended');
  });
});

describe('new workshop form', () => {
  const ok = { title: 'Generative AI for Researchers', date: '2026-10-30', startTime: '14:00', endTime: '16:30' };
  test('a good form has no problems', () => expect(checkNewWorkshop(ok)).toEqual({}));
  test('each field is explained in plain words', () => {
    expect(checkNewWorkshop({ ...ok, title: '  ' }).title).toBe('Give the workshop a title.');
    expect(checkNewWorkshop({ ...ok, date: '' }).date).toBeTruthy();
    expect(checkNewWorkshop({ ...ok, startTime: '9' }).startTime).toBe('Write the time as 14:00.');
    expect(checkNewWorkshop({ ...ok, endTime: '13:00' }).endTime).toBe('The end must be after the start.');
    expect(checkNewWorkshop({ ...ok, startTime: '', endTime: '' })).toEqual({});
  });
  test('the folder name', () => {
    expect(folderName('2026-10-30', 'Generative AI for Researchers')).toBe('2026-10-30-generative-ai-for-researchers');
    expect(folderName('2026-10-30', '???')).toBe('2026-10-30-workshop');
  });
});
