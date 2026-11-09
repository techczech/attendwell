// End-to-end check, hidden (fake runtime, fictional names, a temporary data folder; no port, no tunnel): Start check-in opens check-in
// on the iPad and the rail shows it with Close now and Open check-in; a newer booking export updates the bookings of people already in
// the register (cancelled included) after a preview. Exits 1 on any failure; PNGs go to desktop/e2e/shots/.
// Run: bun run build && node e2e/window-and-bookings.mjs [outdir]
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright-core';

const root = resolve(import.meta.dirname, '..');
const out = process.argv[2] ?? join(root, 'e2e', 'shots');
mkdirSync(out, { recursive: true });
const userData = mkdtempSync(join(tmpdir(), 'attendwell-e2e-'));
const csv = join(userData, 'booking-export.csv');
const write = (rows) => writeFileSync(csv, ['User Fullname,User Email,Status', ...rows].join('\r\n') + '\r\n');
write(['Aisha Rahman,aisha.rahman@example.ac.uk,Booked', 'Henrik Olsen,henrik.olsen@example.ac.uk,Booked', 'Sofia Marchetti,sofia.marchetti@example.ac.uk,Waiting List']);
const app = await electron.launch({
  args: [root, '--use-mock-keychain'], cwd: root,
  env: { ...process.env, ATTENDWELL_TEST: '1', ATTENDWELL_USER_DATA: userData, ATTENDWELL_REGISTERS: join(userData, 'registers'), ATTENDWELL_TEST_NAMES_FILE: csv, ELECTRON_RUN_AS_NODE: '' },
});
const page = await app.firstWindow();
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.setSize(1440, 900)));
const shot = async (name) => { await page.waitForTimeout(350); await page.screenshot({ path: join(out, `${name}.png`) }); console.log('shot', name); };
const people = () => app.evaluate(() => globalThis.__attendwellFake.register(globalThis.__attendwellFake.current() ?? '').people.map((p) => [p.name, p.booking]));
const panel = '[aria-label="Check-in on the iPad"]';
let failed = false;
try {
  await page.waitForSelector('text=Welcome to AttendWell');
  await page.click('text=Set up AttendWell');
  await page.click('text=Continue');
  await page.fill('#wf-title', 'Window and bookings check');
  await page.fill('#wf-start', '00:01');
  await page.fill('#wf-end', '23:00');
  await page.click('text=Create workshop');
  await page.waitForSelector('button:has-text("Start check-in")');
  await page.keyboard.press('Meta+Shift+I');
  await page.click('[role=dialog] button:has-text("Add 3 people")');
  await page.waitForSelector('[role=dialog]', { state: 'detached' });

  await page.click('button:has-text("Start check-in")');
  await page.waitForSelector('[aria-label="Check-in: Online"]');
  await page.waitForSelector(`${panel} >> text=Open until`);
  await shot('w01-window-open');
  await page.click(`${panel} button:has-text("Close now")`);
  await page.waitForSelector(`${panel} >> text=Check-in on the iPad is closed`);
  await shot('w02-window-closed');
  await page.click(`${panel} button:has-text("Open check-in")`);
  await page.waitForSelector(`${panel} >> text=Open until`);

  write(['Aisha Rahman,aisha.rahman@example.ac.uk,Cancelled', 'Henrik Olsen,henrik.olsen@example.ac.uk,Booked', 'Sofia Marchetti,sofia.marchetti@example.ac.uk,Booked', 'Tom Whitfield,tom.whitfield@example.ac.uk,Booked']);
  await page.keyboard.press('Meta+Shift+I');
  // Booking changes are offered unticked: the list only adds until the organiser ticks the box.
  await page.waitForSelector('[role=dialog] button:has-text("Add 1 person")');
  await page.check('[role=dialog] .update-bookings input[type=checkbox]');
  await page.waitForSelector('[role=dialog] button:has-text("Add 1 person, update 2 bookings")');
  await shot('w03-import-updates-preview');
  const before = JSON.stringify(await people());
  if (!before.includes('["Aisha Rahman","confirmed"]')) throw new Error(`the preview changed the register: ${before}`);
  await page.click('[role=dialog] button:has-text("Add 1 person, update 2 bookings")');
  await page.waitForSelector('[role=dialog]', { state: 'detached' });
  const after = Object.fromEntries(await people());
  const want = { 'Aisha Rahman': 'cancelled', 'Henrik Olsen': 'confirmed', 'Sofia Marchetti': 'confirmed', 'Tom Whitfield': 'confirmed' };
  for (const [n, b] of Object.entries(want)) if (after[n] !== b) throw new Error(`${n}: expected ${b}, got ${after[n]}`);
  await shot('w04-after-update');
  console.log('PASS window and bookings');
} catch (e) {
  failed = true;
  console.log('FAILED', e instanceof Error ? e.message : e);
  await shot('w99-failed').catch(() => undefined);
} finally {
  await app.close().catch(() => undefined);
  rmSync(userData, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
