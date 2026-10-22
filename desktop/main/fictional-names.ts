// Fictional people for the example workshop (a finished session): nobody real, addresses on example.ac.uk.
import type { Roster, RosterPerson } from '../shared/register-model.ts';

const NAMES: Array<[string, string | null]> = [
  ['Aisha Rahman', '13:41'], ['Amara Okafor', '14:15'], ['Callum MacLeod', '13:54'], ['Chiara Bellini', '14:12'], ['Daniel Foster', '13:58'], ['Dev Patel', '14:07'],
  ['Eleanor Voss', '14:08'], ['Fatima Al-Sayed', null], ['Hannah Brecht', '14:10'], ['Henrik Olsen', '13:44'], ['Imogen Pryce', '14:01'], ['Isla Cunningham', '14:11'],
];

/** `arrived` false gives the same people with nobody checked in yet (a workshop about to start). */
export function fictionalNames(day = '2026-09-01', arrived = true): Roster {
  const participants: RosterPerson[] = NAMES.map(([name, at], i) => ({
    id: `ex-${i + 1}`, name, email: `${name.toLowerCase().replace(/[^a-z ]/g, '').replace(/ /g, '.')}@example.ac.uk`, booking: 'confirmed', present: arrived && at !== null, admitted: false,
    version: arrived && at ? 1 : 0, updatedAt: arrived && at ? new Date(`${day}T${at}:00`).toISOString() : null,
  }));
  return { participants, conflicts: [] };
}
