// Development aid: the name-list and recovery sheets, hidden (fake runtime, fictional names), as PNGs in desktop/e2e/shots/ for comparison
// with the locked names-empty, names-paste, names-preview and recovery-import frames. Nothing shows on the screen.
// Run: bun run build && node e2e/shots-names.mjs [outdir]
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright-core';

const root = resolve(import.meta.dirname, '..');
const out = process.argv[2] ?? join(root, 'e2e', 'shots');
mkdirSync(out, { recursive: true });
const userData = mkdtempSync(join(tmpdir(), 'attendwell-shots-'));
const csv = join(userData, 'booking-export.csv');
const rows = ['User Fullname,User Email,Start Date,Status', 'Aisha Rahman,aisha.rahman@example.ac.uk,30/10/2026,Booked', 'Henrik Olsen,henrik.olsen@example.ac.uk,30/10/2026,Booked',
  'Sofia Marchetti,sofia.marchetti@example.ac.uk,30/10/2026,Booked', 'Tom Whitfield,tom.whitfield@example.ac.uk,30/10/2026,Booked', 'Ngozi Adeyemi,ngozi.adeyemi@example.ac.uk,30/10/2026,Booked',
  'Sofia Marchetti,Sofia.Marchetti@example.ac.uk,30/10/2026,Booked', ',rowan.blake@example.ac.uk,30/10/2026,Booked', 'Priya Venkataraman,priya.venkataraman@example.ac.uk,30/10/2026,Cancelled',
  'Felix Grant,felix.grant@example.ac.uk,06/11/2026,Booked', 'Callum MacLeod,callum.macleod@example.ac.uk,30/10/2026,Booked'];
writeFileSync(csv, rows.join('\r\n') + '\r\n');
const recovery = join(userData, 'Door iPad recovery 2026-10-30 16.40.attendance-recovery.json');
const app = await electron.launch({
  args: [root, '--use-mock-keychain'], cwd: root,
  env: { ...process.env, ATTENDWELL_TEST: '1', ATTENDWELL_USER_DATA: userData, ATTENDWELL_REGISTERS: join(userData, 'registers'), ATTENDWELL_TEST_NAMES_FILE: csv, ATTENDWELL_TEST_RECOVERY_FILE: recovery, ELECTRON_RUN_AS_NODE: '' },
});
const page = await app.firstWindow();
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.setSize(1440, 900)));
const shot = async (name) => { await page.waitForTimeout(400); await page.screenshot({ path: join(out, `${name}.png`) }); console.log('shot', name); };
try {
  await page.waitForSelector('text=Welcome to AttendWell');
  await page.click('text=Set up AttendWell');
  await page.click('text=Continue');
  await page.fill('#wf-title', 'Generative AI for Researchers');
  await page.fill('#wf-date', '2026-10-30');
  await page.fill('#wf-start', '14:00');
  await page.fill('#wf-end', '16:30');
  await page.click('text=Create workshop');
  await page.waitForSelector('button:has-text("Paste names…")');
  await shot('n01-names-empty');
  await page.click('button:has-text("Paste names…")');
  await page.fill('#names-text', ['Aisha Rahman, aisha.rahman@example.ac.uk', 'Henrik Olsen', 'Sofia Marchetti, sofia.marchetti@example.ac.uk', 'Tom Whitfield', 'Ngozi Adeyemi, ngozi.adeyemi@example.ac.uk',
    'Callum MacLeod', 'Yuki Tanaka', 'Rebecca Hartley, rebecca.hartley@example.ac.uk', 'Sofia Marchetti, sofia.marchetti@example.ac.uk', 'Mateusz Nowak', '', 'Imogen Pryce', 'Lars Eriksson', 'Sam Patel', 'Sam Patel'].join('\n'));
  await page.waitForSelector('[role=dialog] button:has-text("Add 13 people")');
  await shot('n02-names-paste');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Meta+Shift+I');
  await page.waitForSelector('[role=dialog][aria-label="Import names"]');
  await shot('n03-names-preview');
  await page.click('[role=dialog] button:has-text("Add 6 people")');
  await page.waitForSelector('[role=dialog]', { state: 'detached' });
  const people = await app.evaluate(() => globalThis.__attendwellFake.register(globalThis.__attendwellFake.current() ?? '').people.map((p) => p.id));
  writeFileSync(recovery, JSON.stringify({ format: 'attendance-recovery', version: 1, eventId: 'evt_fake', eventCode: 'H4KD', deviceId: null, exportedAt: '2026-10-30T16:40:00Z',
    operations: people.slice(0, 3).map((id, i) => ({ opId: `00000000-0000-4000-8000-00000000000${i}`, personToken: `pt_${id}`, displayName: 'x', baseRevision: 0, windowRevisionSeen: 1, recordedAt: '2026-10-30T14:05:00Z' })) }));
  await page.click('button:has-text("Import iPad recovery file")');
  await page.click('[role=dialog] button:has-text("Choose file")');
  await page.waitForSelector('[role=dialog] button:has-text("Import check-ins"):not([disabled])');
  await shot('n04-recovery-preview');
  await page.click('[role=dialog] button:has-text("Import check-ins")');
  await page.waitForSelector('[role=dialog] button:has-text("Done")');
  await shot('n05-recovery-done');
} catch (e) {
  console.log('FAILED', e instanceof Error ? e.message : e);
  await shot('n99-failed');
} finally {
  await app.close();
  rmSync(userData, { recursive: true, force: true });
}
