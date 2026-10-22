// Development aid: walks the app hidden and writes PNGs of its states to a folder (default /tmp/attendwell-shots), for comparing with the locked mockup.
// Run: bun run build && node e2e/shots.mjs [outdir]
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright-core';

const root = resolve(import.meta.dirname, '..');
const out = process.argv[2] ?? '/tmp/attendwell-shots';
mkdirSync(out, { recursive: true });
const userData = mkdtempSync(join(tmpdir(), 'attendwell-shots-'));
const app = await electron.launch({
  args: [root, '--use-mock-keychain'], cwd: root,
  env: { ...process.env, ATTENDWELL_TEST: '1', ATTENDWELL_USER_DATA: userData, ATTENDWELL_REGISTERS: join(userData, 'registers'), ELECTRON_RUN_AS_NODE: '' },
});
const page = await app.firstWindow();
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.setSize(1360, 792)));
const shot = async (p, name) => { await p.waitForTimeout(250); await p.screenshot({ path: join(out, `${name}.png`) }); console.log('shot', name); };
try {
  await page.waitForSelector('text=Welcome to AttendWell');
  await shot(page, '01-welcome');
  await page.click('text=Set up AttendWell');
  await shot(page, '02-folder');
  await page.click('text=Continue');
  await page.fill('#wf-title', 'Generative AI for Researchers');
  await page.fill('#wf-date', '2026-10-30');
  await page.fill('#wf-start', '14:00');
  await page.fill('#wf-end', '16:30');
  await shot(page, '03-workshop');
  await page.click('text=Create workshop');
  await page.waitForSelector('button:has-text("Start check-in")');
  await shot(page, '04-session');
  await page.keyboard.press('Meta+Shift+L');
  await page.waitForSelector('input[aria-label="Search workshops"]');
  await shot(page, '05-library');
  await page.keyboard.press('Meta+Shift+P');
  await page.keyboard.type('pair');
  await shot(page, '06-palette');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Meta+/');
  await shot(page, '07-cheat');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Meta+Shift+K');
  await page.keyboard.type('gen');
  await shot(page, '08-switcher');
  await page.keyboard.press('Escape');
  await page.click('text=Get started');
  await shot(page, '09-get-started');
  await app.evaluate(async ({ BrowserWindow }) => { /* open Settings through the registry command in main */ });
  await page.keyboard.press('Meta+,');
  await page.waitForTimeout(1200);
  const wins = app.windows();
  const settings = wins.find((w) => w.url().includes('settings.html'));
  if (settings) {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.setSize(1000, 690)));
    await shot(settings, '10-settings-general');
    await settings.click('text=Connection');
    await shot(settings, '11-settings-connection');
    await settings.click('text=Workshops');
    await shot(settings, '12-settings-workshops');
    await settings.click('text=Shortcuts');
    await shot(settings, '13-settings-shortcuts');
    await settings.click('text=About and updates').catch(() => settings.click('text=About'));
    await shot(settings, '14-settings-about');
    await settings.click('text=Changes');
    await shot(settings, '15-settings-changes');
  } else console.log('no settings window; windows:', wins.map((w) => w.url()));
} finally {
  await app.close().catch(() => undefined);
  rmSync(userData, { recursive: true, force: true });
}
