// The Get started lifecycle (onboarding-and-help.md): the title-bar button reads "Get started"; once the example workshop has
// been opened it reads "Remove example"; once the example is removed (or hidden in Settings) it is gone, and the page is reached
// from Settings, the palette and Help. Pure.

export type GetStartedButton = 'get-started' | 'remove-example' | 'hidden';

export interface GetStartedFacts {
  setupDone: boolean;
  exampleOpened: boolean;
  exampleRemoved: boolean;
  /** The Settings switch "Hide the Get started button". */
  hiddenSetting: boolean;
}

export function getStartedButton(f: GetStartedFacts): GetStartedButton {
  if (!f.setupDone || f.hiddenSetting || f.exampleRemoved) return 'hidden';
  return f.exampleOpened ? 'remove-example' : 'get-started';
}

export interface Chapter { id: string; title: string; text: string; command: string | null; tryWith: string }

/** The six task chapters of the Get started page. A chapter is "tried" when its command has run. */
export const CHAPTERS: readonly Chapter[] = [
  { id: 'open', title: 'Open the example workshop', text: 'It has 12 fictional names and a pretend iPad, so nothing you do reaches a real register.', command: 'workshop.open', tryWith: 'Open' },
  { id: 'pair', title: 'Pair an iPad', text: 'Show the pairing code and scan it with the Check-in app on the iPad.', command: 'ipad.pair', tryWith: '' },
  { id: 'check-in', title: 'Check someone in by hand', text: 'Select a name in the register and mark them as here.', command: 'register.check-in', tryWith: '' },
  { id: 'held', title: 'Decide on a check-in held for review', text: 'Choose Check in or Keep not checked in for a held name.', command: 'held.check-in', tryWith: '' },
  { id: 'add', title: 'Add someone who is not on the list', text: 'Add a walk-in with a name and, if you have it, an email address.', command: 'person.add', tryWith: '' },
  { id: 'end', title: 'End check-in and export the register', text: 'Close the check-in address and save the register as a CSV file.', command: 'export.csv', tryWith: '' },
];

/** Commands that count towards a chapter besides its own (the held row has two decisions). */
const ALSO: Record<string, string> = { 'held.keep-not-checked-in': 'held.check-in' };

export function triedChapters(ran: readonly string[]): string[] {
  const set = new Set(ran.map((id) => ALSO[id] ?? id));
  return CHAPTERS.filter((c) => c.command !== null && set.has(c.command)).map((c) => c.id);
}

export const HOW_IT_WORKS: ReadonlyArray<{ icon: string; lead: string; text: string }> = [
  { icon: 'folder', lead: 'Files.', text: 'Each workshop is a folder in your registers folder with its details, its register and a note of where its names came from. Past sessions are these folders.' },
  { icon: 'globe', lead: 'Check-in address.', text: 'When a workshop is open, AttendWell opens a temporary address through Cloudflare that only paired iPads can use. It closes when you end check-in or quit, and it is new each time AttendWell starts, so iPads are paired again with a new code.' },
  { icon: 'tablet', lead: 'iPads.', text: 'An iPad saves each check-in first and sends it when it can, so a dropped connection loses nothing.' },
  { icon: 'mail', lead: 'Email addresses.', text: 'Used to merge duplicate names and for Email review after the session. They stay on this laptop.' },
];
