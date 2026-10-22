// Headless smoke test: launches the built app with a temporary data folder, opens the command palette and the cheat sheet, opens a workshop,
// pastes a name list of three fictional people before check-in starts, starts check-in on the fake runtime, shows the pairing sheet, adds a walk-in and ends check-in,
// checks that no dialog was raised and that no window was ever visible, then quits. Nothing shows on the screen: windows are
// created hidden (ATTENDWELL_TEST=1), the Dock icon is hidden, the Keychain is mocked, and HOME is the real one.
// Run once with: bun run smoke   (builds first)
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright-core';

const root = resolve(import.meta.dirname, '..');
const userData = mkdtempSync(join(tmpdir(), 'attendwell-smoke-'));
let failed = false;
const check = (ok, what) => { console.log(`${ok ? 'ok     ' : 'FAILED '} ${what}`); if (!ok) failed = true; };

const app = await electron.launch({
  args: [root, '--use-mock-keychain'],
  cwd: root,
  env: { ...process.env, ATTENDWELL_TEST: '1', ATTENDWELL_USER_DATA: userData, ATTENDWELL_REGISTERS: join(userData, 'registers'), ELECTRON_RUN_AS_NODE: '' },
  timeout: 60_000,
});
try {
  // Record every dialog call and every window that ever became visible.
  await app.evaluate(({ dialog, BrowserWindow }) => {
    globalThis.__dialogCalls = [];
    for (const name of ['showMessageBox', 'showMessageBoxSync', 'showErrorBox', 'showOpenDialog', 'showOpenDialogSync', 'showSaveDialog', 'showSaveDialogSync']) {
      dialog[name] = (...a) => { globalThis.__dialogCalls.push(name); return name.endsWith('Sync') ? undefined : Promise.resolve({ canceled: true, filePaths: [] }); };
    }
    globalThis.__shown = 0;
    const watch = (w) => w.on('show', () => { globalThis.__shown += 1; });
    BrowserWindow.getAllWindows().forEach(watch);
  });

  const page = await app.firstWindow();
  await page.waitForSelector('text=Welcome to AttendWell', { timeout: 30_000 });
  check(true, 'first run opens on Welcome');

  await page.keyboard.press('Meta+Shift+P');
  await page.waitForSelector('[role=dialog][aria-label="Command palette"]');
  await page.keyboard.type('settings');
  const rows = await page.locator('[role=option]').allInnerTexts();
  check(rows.some((r) => r.includes('Settings…')), `palette finds Settings… (${rows.length} row)`);
  await page.keyboard.press('Escape');
  await page.waitForSelector('[role=dialog]', { state: 'detached' });

  await page.keyboard.press('Meta+/');
  await page.waitForSelector('[role=dialog][aria-label="Keyboard shortcuts"]');
  const sheet = await page.locator('[role=dialog][aria-label="Keyboard shortcuts"]').innerText();
  check(sheet.includes('Command palette') && sheet.includes('Pair an iPad'), 'cheat sheet lists the registry commands');
  await page.keyboard.press('Escape');

  // A workshop, a session on the fake runtime, the pairing sheet, a walk-in, and the end of check-in.
  await page.click('text=Set up AttendWell');
  await page.click('text=Continue');
  await page.fill('#wf-title', 'Smoke workshop');
  await page.click('text=Create workshop');
  await page.waitForSelector('button:has-text("Start check-in")', { timeout: 15_000 });
  check(true, 'a new workshop opens on the register, ready to start check-in');

  // Before check-in starts: paste three names, see the preview, add them, and see them in the register.
  await page.click('button:has-text("Paste names…")');
  await page.waitForSelector('[role=dialog][aria-label="Paste names"]');
  await page.fill('#names-text', 'Aisha Rahman, aisha.rahman@example.ac.uk\nHenrik Olsen\nSofia Marchetti <sofia.marchetti@example.ac.uk>');
  await page.waitForSelector('[role=dialog] button:has-text("Add 3 people"):not([disabled])', { timeout: 15_000 });
  check(true, 'the paste sheet previews three people');
  // Editing the text turns Add off at once, before the new preview answers, so Add never writes a list other than the one shown.
  const three = await page.inputValue('#names-text');
  await page.fill('#names-text', `${three}\nTom Whitfield`);
  check(await page.$eval('[role=dialog] .btn.primary', (b) => b.disabled), 'editing the pasted text turns Add off until the new preview answers');
  await page.waitForSelector('[role=dialog] button:has-text("Add 4 people"):not([disabled])', { timeout: 15_000 });
  await page.fill('#names-text', three);
  await page.waitForSelector('[role=dialog] button:has-text("Add 3 people"):not([disabled])', { timeout: 15_000 });
  await page.click('[role=dialog] button:has-text("Add 3 people")');
  await page.waitForSelector('[role=dialog][aria-label="Paste names"]', { state: 'detached', timeout: 10_000 });
  for (const n of ['Aisha Rahman', 'Henrik Olsen', 'Sofia Marchetti']) await page.waitForSelector(`[role=option]:has-text("${n}")`, { timeout: 10_000 });
  check(true, 'the three pasted names are in the register');
  await page.click('button:has-text("Start check-in")');
  await page.waitForSelector('[aria-label="Check-in: Online"]', { timeout: 15_000 });
  check(true, 'check-in starts on the fake runtime and goes online');

  await page.keyboard.press('Meta+Shift+N');
  await page.waitForSelector('[role=dialog][aria-label="Pair an iPad"] svg.qr', { timeout: 10_000 });
  const code = await page.locator('[role=dialog][aria-label="Pair an iPad"] code.code').innerText();
  check(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code), 'the pairing sheet shows a QR and a code in the XXXX-XXXX shape');
  await page.keyboard.press('Escape');
  await page.waitForSelector('[role=dialog]', { state: 'detached' });

  await page.click('button:has-text("Add person")');
  await page.fill('#ap-name', 'Test Walkin');
  await page.click('[role=dialog] button:has-text("Add person")');
  await page.waitForSelector('[role=option]:has-text("Test Walkin"):has-text("Walk-in")', { timeout: 10_000 });
  check(true, 'a walk-in is added on the laptop and shown as here');

  await page.click('button:has-text("End check-in")');
  await page.click('[role=dialog] button:has-text("End check-in")');
  await page.waitForSelector('[aria-label="Check-in: Check-in closed"]', { timeout: 15_000 });
  await page.waitForSelector('button:has-text("Reopen check-in")');
  check(true, 'End check-in closes the address; the register stays and can be reopened');

  const state = await app.evaluate(({ BrowserWindow }) => ({
    dialogs: globalThis.__dialogCalls,
    shown: globalThis.__shown,
    visible: BrowserWindow.getAllWindows().filter((w) => w.isVisible()).length,
    windows: BrowserWindow.getAllWindows().length,
  }));
  check(state.dialogs.length === 0, `no dialog was raised (${state.dialogs.join(',') || 'none'})`);
  check(state.shown === 0 && state.visible === 0, `no window was shown (windows: ${state.windows}, visible: ${state.visible})`);
} catch (e) {
  console.log(`FAILED  ${e instanceof Error ? e.message : e}`);
  failed = true;
} finally {
  const closed = app.close().then(() => true, () => false);
  const ok = await Promise.race([closed, new Promise((r) => setTimeout(() => r(false), 15_000))]);
  check(ok, 'the app exits on its own');
  rmSync(userData, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
