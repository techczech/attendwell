// Live smoke check of the built app on the real runtime: the compiled register, the participant gateway and a real Cloudflare quick
// tunnel (no account). Nothing shows on the screen: windows are created hidden (ATTENDWELL_TEST=1), the Dock icon is hidden, the
// Keychain is mocked (--use-mock-keychain), HOME is the real one, and user data and the registers folder are temporary.
//   1. creates a workshop and pastes three fictional names (a register lease on loopback, before check-in);
//   2. starts check-in; through the public address: the participant page and the names API answer 200, organiser routes are refused;
//      on 127.0.0.1 the organiser API refuses a request without the register's key;
//   3. issues a pairing code in the app and calls /device/v1/hello through the public address with it (the documented offer);
//   4. ends check-in (the public address then answers 530), reopens it, and quits while it is live;
//   5. checks that no register or cloudflared process of this run remains, and that no window or dialog appeared.
// The tunnel address and the pairing code are never printed. Run once with: bun run build && node e2e/live-smoke.mjs
// Needs: bun run desktop:sidecar && bun run desktop:cloudflared (at the repository root).
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright-core';

const root = resolve(import.meta.dirname, '..');
const key = process.platform === 'darwin' ? `darwin-${process.arch}` : 'windows-x64';
// ATTENDWELL_PACKAGED_APP=<path to the test-build .app> runs the packaged, signed app instead of the built sources (bun run desktop:dist:mac:test).
const packaged = process.env.ATTENDWELL_PACKAGED_APP ? join(process.env.ATTENDWELL_PACKAGED_APP, 'Contents', 'MacOS', 'AttendWell') : null;
for (const f of packaged ? [packaged] : [join(root, 'resources', 'sidecar', key), join(root, 'resources', 'cloudflared', key), join(root, 'out', 'main', 'index.js')]) {
  if (!existsSync(f)) { console.log(`FAILED  missing ${f}: build first (see the header of this file)`); process.exit(1); }
}
const userData = mkdtempSync(join(tmpdir(), 'attendwell-live-'));
let failed = false;
const check = (ok, what) => { console.log(`${ok ? 'ok     ' : 'FAILED '} ${what}`); if (!ok) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A fresh quick tunnel can take a few seconds to be reachable at the edge.
async function publicFetch(url, init = {}, tries = 20) {
  let last = null;
  for (let i = 0; i < tries; i += 1) {
    try { last = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000), ...init }); if (![502, 530, 1033].includes(last.status)) return last; } catch { last = null; }
    await sleep(3000);
  }
  return last;
}
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

const app = await electron.launch({
  ...(packaged ? { executablePath: packaged, args: ['--use-mock-keychain'] } : { args: [root, '--use-mock-keychain'], cwd: root }),
  env: { ...process.env, ATTENDWELL_TEST: '1', ATTENDWELL_RUNTIME: 'real', ATTENDWELL_USER_DATA: userData, ATTENDWELL_REGISTERS: join(userData, 'registers'), ELECTRON_RUN_AS_NODE: '' },
  timeout: 60_000,
});
const pids = new Set();
const status = () => app.evaluate(() => globalThis.__attendwellDiag.status());
const notePids = async () => { const p = await app.evaluate(() => globalThis.__attendwellDiag.childPids()); for (const v of Object.values(p)) if (v) pids.add(v); };
let pidTimer = null;
try {
  await app.evaluate(({ dialog, BrowserWindow }) => {
    globalThis.__dialogCalls = [];
    for (const name of ['showMessageBox', 'showMessageBoxSync', 'showErrorBox', 'showOpenDialog', 'showOpenDialogSync', 'showSaveDialog', 'showSaveDialogSync']) {
      dialog[name] = () => { globalThis.__dialogCalls.push(name); return name.endsWith('Sync') ? undefined : Promise.resolve({ canceled: true, filePaths: [] }); };
    }
    globalThis.__shown = 0;
    BrowserWindow.getAllWindows().forEach((w) => w.on('show', () => { globalThis.__shown += 1; }));
  });
  const page = await app.firstWindow();
  await page.waitForSelector('text=Welcome to AttendWell', { timeout: 30_000 });
  // The runtime is created once settings are read; the window appears after it.
  check(await app.evaluate(() => typeof globalThis.__attendwellDiag === 'object'), 'the app runs the real runtime');
  pidTimer = setInterval(() => { void notePids().catch(() => undefined); }, 250);
  await page.click('text=Set up AttendWell');
  await page.click('text=Continue');
  await page.fill('#wf-title', 'Fictional Live Smoke Lab');
  await page.click('text=Create workshop');
  await page.waitForSelector('button:has-text("Start check-in")', { timeout: 20_000 });
  check(true, 'a new workshop opens on the register');

  // 1. Three fictional names before check-in: the preview and the add run on a loopback register lease.
  await page.click('button:has-text("Paste names…")');
  await page.waitForSelector('[role=dialog][aria-label="Paste names"]');
  await page.fill('#names-text', 'Aisha Rahman, aisha.rahman@example.ac.uk\nHenrik Olsen\nSofia Marchetti <sofia.marchetti@example.ac.uk>');
  await page.waitForSelector('[role=dialog] button:has-text("Add 3 people"):not([disabled])', { timeout: 30_000 });
  await notePids();
  await page.click('[role=dialog] button:has-text("Add 3 people")');
  await page.waitForSelector('[role=dialog][aria-label="Paste names"]', { state: 'detached', timeout: 20_000 });
  for (const n of ['Aisha Rahman', 'Henrik Olsen', 'Sofia Marchetti']) await page.waitForSelector(`[role=option]:has-text("${n}")`, { timeout: 20_000 });
  check(true, 'three pasted names are in the register before check-in');
  check((await app.evaluate(() => globalThis.__attendwellDiag.childPids())).lease === null, 'the register opened for the name list is stopped when the sheet closes');

  // 2. Check-in on a real quick tunnel.
  await page.click('button:has-text("Start check-in")');
  await page.waitForSelector('[aria-label="Check-in: Online"]', { timeout: 120_000 });
  const snap = await status();
  check(snap.session === 'running' && snap.tunnel.state === 'online' && /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(snap.tunnel.url), 'check-in is online at a quick-tunnel address (not printed)');
  const url = snap.tunnel.url;
  const organiserUrl = snap.service.organiserUrl;
  const pageRes = await publicFetch(`${url}/check-in`);
  check(pageRes?.status === 200 && (await pageRes.text()).includes('<html'), `participant page through the public address (${pageRes?.status})`);
  const namesRes = await publicFetch(`${url}/api/participant-names`, {}, 3);
  const names = namesRes ? await namesRes.json().catch(() => null) : null;
  check(namesRes?.status === 200 && names?.participants?.length === 3 && !JSON.stringify(names).includes('@'), `names API through the public address: three names, no addresses (${namesRes?.status})`);
  for (const p of ['/api/roster', '/api/organiser/devices', '/api/names', '/api/check-in-window']) {
    const r = await publicFetch(`${url}${p}`, {}, 3);
    check(r?.status === 404, `organiser route ${p} refused through the public address (${r?.status})`);
  }
  const keyless = await fetch(`${organiserUrl}/api/roster`).then((r) => r.status, () => 0);
  check(keyless === 401, `organiser API on 127.0.0.1 refuses a request without the register's key (${keyless})`);
  const forged = await fetch(`${organiserUrl}/api/roster`, { headers: { Authorization: `Bearer ${'A'.repeat(43)}` } }).then((r) => r.status, () => 0);
  check(forged === 401, `organiser API on 127.0.0.1 refuses a wrong key (${forged})`);

  // 3. A pairing code from the app, used through the public address as the iPad would.
  await page.keyboard.press('Meta+Shift+N');
  await page.waitForSelector('[role=dialog][aria-label="Pair an iPad"] code.code', { timeout: 20_000 });
  const code = await page.locator('[role=dialog][aria-label="Pair an iPad"] code.code').innerText();
  check(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code), 'the app issued a pairing code (not printed)');
  const hello = await publicFetch(`${url}/device/v1/hello`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Attendance-Device-Protocol': '1' }, body: JSON.stringify({ code }) }, 3);
  const offer = hello ? await hello.json().catch(() => null) : null;
  const keys = offer ? Object.keys(offer).sort().join(',') : '';
  check(hello?.status === 200 && keys === 'deviceLabel,eventCode,eventDate,eventId,eventName' && offer.eventName === 'Fictional Live Smoke Lab', `/device/v1/hello through the public address gives the documented offer (${hello?.status}: ${keys || 'no body'})`);
  await page.keyboard.press('Escape');
  await page.waitForSelector('[role=dialog]', { state: 'detached' });

  // 4. End check-in: the public address closes.
  await page.click('button:has-text("End check-in")');
  await page.click('[role=dialog] button:has-text("End check-in")');
  await page.waitForSelector('[aria-label="Check-in: Check-in closed"]', { timeout: 30_000 });
  await sleep(3000);
  const after = await fetch(`${url}/api/participant-names`, { signal: AbortSignal.timeout(10_000) }).then((r) => r.status, () => 0);
  check(after === 530, `after End check-in the public address answers 530 (${after})`);
  const idle = await app.evaluate(() => globalThis.__attendwellDiag.childPids());
  check(!idle.service && !idle.tunnel && !idle.lease, 'no register or tunnel runs after End check-in');

  // Reopen, then quit while check-in is live: quitting ends it.
  await page.click('button:has-text("Reopen check-in")');
  await page.waitForSelector('[aria-label="Check-in: Online"]', { timeout: 120_000 });
  await notePids();
  check(true, 'check-in reopened on a new quick tunnel');

  const state = await app.evaluate(({ BrowserWindow }) => ({
    dialogs: globalThis.__dialogCalls, shown: globalThis.__shown,
    visible: BrowserWindow.getAllWindows().filter((w) => w.isVisible()).length, windows: BrowserWindow.getAllWindows().length,
  }));
  check(state.dialogs.length === 0, `no dialog was raised (${state.dialogs.join(',') || 'none'})`);
  check(state.shown === 0 && state.visible === 0, `no window was shown (windows: ${state.windows}, visible: ${state.visible})`);
} catch (e) {
  console.log(`FAILED  ${e instanceof Error ? e.message.replace(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g, '<tunnel>') : e}`);
  failed = true;
} finally {
  if (pidTimer) clearInterval(pidTimer);
  await notePids().catch(() => undefined);
  // 5. Quit (with check-in live, if the steps above got that far) and confirm nothing of this run is left.
  const closed = app.close().then(() => true, () => false);
  const ok = await Promise.race([closed, sleep(30_000).then(() => false)]);
  check(ok, 'the app exits on its own');
  await sleep(500);
  const left = [...pids].filter(isAlive);
  check(pids.size >= 3 && left.length === 0, `none of this run's ${pids.size} register and cloudflared processes remains${left.length ? `: ${left.join(', ')}` : ''}`);
  rmSync(userData, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
