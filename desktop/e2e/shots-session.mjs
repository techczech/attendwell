// Development aid: walks the session screens hidden (fake runtime, fictional names) and writes PNGs to desktop/e2e/shots/ for comparison
// with the locked mockup PNGs. Nothing shows on the screen. Run: bun run build && node e2e/shots-session.mjs [outdir]
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright-core';

const root = resolve(import.meta.dirname, '..');
const out = process.argv[2] ?? join(root, 'e2e', 'shots');
mkdirSync(out, { recursive: true });
const userData = mkdtempSync(join(tmpdir(), 'attendwell-shots-'));
const app = await electron.launch({
  args: [root, '--use-mock-keychain'], cwd: root,
  env: { ...process.env, ATTENDWELL_TEST: '1', ATTENDWELL_SEED_NAMES: '1', ATTENDWELL_USER_DATA: userData, ATTENDWELL_REGISTERS: join(userData, 'registers'), ELECTRON_RUN_AS_NODE: '' },
});
const page = await app.firstWindow();
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.setSize(1440, 900)));
const shot = async (name) => { await page.waitForTimeout(350); await page.screenshot({ path: join(out, `${name}.png`) }); console.log('shot', name); };
const fake = (fn, arg) => app.evaluate((_e, a) => { const f = globalThis.__attendwellFake; const id = f.current(); return new Function('f', 'id', 'a', `return (${a.fn})(f, id, a.arg)`)(f, id, a); }, { fn: fn.toString(), arg });
try {
  await page.waitForSelector('text=Welcome to AttendWell');
  await page.click('text=Set up AttendWell');
  await page.click('text=Continue');
  await page.fill('#wf-title', 'Generative AI for Researchers');
  await page.fill('#wf-start', '14:00');
  await page.fill('#wf-end', '16:30');
  await page.click('text=Create workshop');
  await page.waitForSelector('button:has-text("Start check-in")');
  await shot('s01-ready');
  await page.click('button:has-text("Start check-in")');
  await page.waitForSelector('[aria-label="Check-in: Online"]');
  await shot('s02-online-no-ipads');
  // arrivals: a dozen people, one walk-in, one held
  await fake((f, id) => {
    const r = f.register(id);
    const at = (h, m) => new Date(new Date().setHours(h, m, 0, 0)).toISOString();
    const times = [[13, 41], [13, 44], [13, 47], [13, 49], [13, 52], [13, 54], [13, 56], [13, 57], [13, 58], [14, 1], [14, 2]];
    r.people.slice(0, 11).forEach((p, i) => { p.present = true; p.version += 1; p.updatedAt = at(...times[i]); });
    r.people.push({ id: 'manual-9', name: 'Tomasz Kowalski', email: '', booking: 'confirmed', present: true, admitted: false, version: 1, updatedAt: at(14, 4) });
    r.simulateHeldCheckIn(r.people[11].id);
  });
  await page.waitForTimeout(3300);
  await page.keyboard.press('Meta+Shift+N');
  await page.waitForSelector('[role=dialog] svg.qr');
  await shot('s03-pair-active');
  await fake((f, id) => f.register(id).simulateWrongCodes(5));
  await page.waitForTimeout(1800);
  await shot('s04-pair-paused');
  await fake((f, id) => f.register(id).simulateExpired());
  await page.waitForTimeout(1800);
  await shot('s05-pair-expired');
  await page.click('button:has-text("Show a new code")');
  await page.waitForTimeout(500);
  await fake((f, id) => { const r = f.register(id); const d = r.simulatePaired(); r.simulateHeartbeat(d.id, { reportedPending: 0, needsReview: 1 }); });
  await page.waitForSelector('text=is paired');
  await shot('s06-pair-paired');
  await page.click('button:has-text("Done")');
  await page.waitForTimeout(3300);
  await shot('s07-live');
  await fake((f) => f.setTunnel({ state: 'reconnecting', attempt: 2, url: null }));
  await page.waitForTimeout(500);
  await shot('s08-reconnecting');
  await fake((f) => f.setTunnel({ state: 'failed', reason: 'blocked-by-network', message: 'x' }));
  await page.waitForTimeout(500);
  await shot('s09-failed');
  await fake((f) => f.setTunnel({ state: 'online', url: 'https://quiet-river-1234.trycloudflare.com' }));
  await fake((f) => f.changeOrigin());
  await page.waitForTimeout(3300);
  await shot('s10-restart-repair');
  await page.click('[aria-label="Actions for iPad 1"]');
  await shot('s11-device-menu');
  await page.click('[role=menuitem]:has-text("Revoke")');
  await shot('s12-revoke-confirm');
  await page.keyboard.press('Escape');
  await page.click('button:has-text("Add person")');
  await shot('s13-add-person');
  await page.keyboard.press('Escape');
  await page.click('button:has-text("End check-in")');
  await shot('s14-end-confirm');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('attendwell:quit-requested', null));
  await page.waitForSelector('[role=dialog][aria-label="Quit AttendWell"]');
  await shot('s15-quit-confirm');
  await page.keyboard.press('Escape');
  await page.click('button:has-text("End check-in")');
  await page.click('[role=dialog] button:has-text("End check-in")');
  await page.waitForSelector('button:has-text("Reopen check-in")');
  await shot('s16-closed');
  await page.keyboard.press('Meta+Shift+L');
  await page.waitForSelector('input[aria-label="Search workshops"]');
  await page.keyboard.press('Meta+Shift+K');
  await page.keyboard.type('gen');
  await page.keyboard.press('Escape');
  await shot('s17-library');
} finally {
  await app.close().catch(() => undefined);
  rmSync(userData, { recursive: true, force: true });
}
