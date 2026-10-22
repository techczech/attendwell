// Live pairing check of the packaged app, launched the way Finder launches it, on the real runtime and a real Cloudflare quick tunnel.
// Nothing shows on the screen: a test build (ATTENDWELL_TEST=1) creates its windows hidden, hides the Dock icon and mocks the Keychain;
// user data and the registers folder are temporary. The environment is the bare one launchd gives a Finder-launched app (PATH
// /usr/bin:/bin:/usr/sbin:/sbin, HOME, TMPDIR, USER), with the working folder at /.
//   1. starts check-in and waits for Online;
//   2. Pair an iPad: the QR drawn on the sheet encodes {address}/pair#v=1&code={code} for the address and code shown beside it;
//      the iPad's two calls (hello, pair) through that address pair a device, and the sheet says it is paired;
//   3. an abandoned attempt (sheet closed while the code is shown) does not block the next one: Pair an iPad shows a new code;
//   4. a second workshop opened while check-in runs says why it cannot pair (check-in is open for another workshop);
//   5. the app's log file (logs/attendwell.log in its data folder, private) has the tunnel's output and no pairing code;
//   6. quits, and checks no register or cloudflared process of this run remains and no window or dialog appeared.
// The tunnel address and the pairing codes are never printed.
// Run: ATTENDWELL_PACKAGED_APP=<test-build .app> node e2e/pairing-live.mjs   (a test build: bun run desktop:dist:mac:test, or an unsigned
// one: electron-builder --mac --dir -c.extraMetadata.attendwellTestBuild=true). Without ATTENDWELL_PACKAGED_APP it runs the built sources.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import QRCode from 'qrcode';
import { _electron as electron } from 'playwright-core';

const root = resolve(import.meta.dirname, '..');
const packaged = process.env.ATTENDWELL_PACKAGED_APP ? join(process.env.ATTENDWELL_PACKAGED_APP, 'Contents', 'MacOS', 'AttendWell') : null;
if (packaged && !existsSync(packaged)) { console.log(`FAILED  missing ${packaged}`); process.exit(1); }
if (!packaged && !existsSync(join(root, 'out', 'main', 'index.js'))) { console.log('FAILED  build first: bun run build'); process.exit(1); }
const userData = mkdtempSync(join(tmpdir(), 'attendwell-pair-'));
let failed = false;
const check = (ok, what) => { console.log(`${ok ? 'ok     ' : 'FAILED '} ${what}`); if (!ok) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const hide = (s) => String(s).replace(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g, '<tunnel>').replace(/\b[A-Z2-9]{4}-?[A-Z2-9]{4}\b/g, '<code>');

// The iPad's calls, as NativeDeviceAPI makes them. A fresh quick tunnel can take a few seconds to answer at the edge.
async function device(origin, name, body) {
  let last = null;
  for (let i = 0; i < 20; i += 1) {
    try {
      last = await fetch(`${origin}/device/v1/${name}`, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10_000),
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Attendance-Device-Protocol': '1' }, body: JSON.stringify(body) });
      if (![502, 530, 1033].includes(last.status)) return last;
    } catch { last = null; }
    await sleep(3000);
  }
  return last;
}

// The QR as the sheet draws it (PairSheet.tsx QrCode): one 1x1 square per dark module, offset by the 4-module quiet zone.
function qrPath(text) {
  const q = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const n = q.modules.size;
  const parts = [];
  for (let y = 0; y < n; y += 1) for (let x = 0; x < n; x += 1) if (q.modules.data[y * n + x]) parts.push(`M${x + 4} ${y + 4}h1v1h-1z`);
  return parts.join('');
}

const finderEnv = {
  PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: process.env.HOME, TMPDIR: process.env.TMPDIR ?? '/tmp/', USER: process.env.USER, LOGNAME: process.env.USER,
  ATTENDWELL_TEST: '1', ATTENDWELL_RUNTIME: 'real', ATTENDWELL_USER_DATA: userData, ATTENDWELL_REGISTERS: join(userData, 'registers'),
};
const app = await electron.launch({
  ...(packaged ? { executablePath: packaged, args: ['--use-mock-keychain'] } : { args: [root, '--use-mock-keychain'] }),
  cwd: '/', env: finderEnv, timeout: 60_000,
});
const pids = new Set();
const notePids = async () => { const p = await app.evaluate(() => globalThis.__attendwellDiag.childPids()); for (const v of Object.values(p)) if (v) pids.add(v); };
let pidTimer = null;
const codes = [];
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
  pidTimer = setInterval(() => { void notePids().catch(() => undefined); }, 250);
  await page.click('text=Set up AttendWell');
  await page.click('text=Continue');
  await page.fill('#wf-title', 'Fictional Pairing Lab');
  await page.click('text=Create workshop');
  await page.waitForSelector('button:has-text("Start check-in")', { timeout: 20_000 });

  // 1. Check-in.
  await page.click('button:has-text("Start check-in")');
  const t0 = Date.now();
  await page.waitForSelector('[aria-label="Check-in: Online"]', { timeout: 150_000 });
  const snap = await app.evaluate(() => globalThis.__attendwellDiag.status());
  check(snap.tunnel.state === 'online', `check-in is online after ${Math.round((Date.now() - t0) / 1000)} s`);

  // 2. Pair an iPad through the QR's own text.
  const sheet = '[role=dialog][aria-label="Pair an iPad"]';
  await page.click('button[aria-label="Pair an iPad"]');
  await page.waitForSelector(`${sheet} code.code`, { timeout: 20_000 });
  const code = await page.locator(`${sheet} code.code`).innerText();
  const address = await page.locator(`${sheet} .cant-scan code.mono:not(.code)`).innerText();
  codes.push(code);
  const payload = `${address}/pair#v=1&code=${code}`;
  const drawn = await page.locator(`${sheet} svg.qr path`).getAttribute('d');
  check(address === snap.tunnel.url, 'the address on the sheet is the live check-in address');
  check(drawn === qrPath(payload), 'the QR on the sheet encodes {address}/pair#v=1&code={code}');
  check(!(await page.locator(`${sheet} svg.qr.blurred`).count()), 'the QR is sharp (the code is live)');
  // As the iPad reads the QR (ParticipantAddress.pairingQR): the origin before /pair, the code after code=.
  const m = /^(https:\/\/[^/]+)\/pair#v=1&code=([A-Z2-9-]+)$/.exec(payload);
  const hello = await device(m[1], 'hello', { code: m[2] });
  check(hello?.status === 200, `the iPad's hello through the QR's address is accepted (${hello?.status})`);
  const credential = 'dc_' + randomBytes(32).toString('base64url');
  const pair = await device(m[1], 'pair', { code: m[2].replace('-', ''), credentialHash: createHash('sha256').update(credential).digest('hex') });
  check(pair?.status === 201, `the iPad's pair call through the QR's address pairs it (${pair?.status})`);
  await page.waitForSelector(`${sheet} :text("is paired")`, { timeout: 20_000 });
  check(true, 'the sheet says the iPad is paired');
  await page.keyboard.press('Escape');
  await page.waitForSelector(sheet, { state: 'detached' });

  // 3. An abandoned attempt, then another.
  await page.click('button[aria-label="Pair an iPad"]');
  await page.waitForSelector(`${sheet} code.code`, { timeout: 20_000 });
  codes.push(await page.locator(`${sheet} code.code`).innerText());
  await page.keyboard.press('Escape');
  await page.waitForSelector(sheet, { state: 'detached' });
  await page.keyboard.press('Meta+Shift+N');
  await page.waitForSelector(`${sheet} code.code`, { timeout: 20_000 });
  const again = await page.locator(`${sheet} code.code`).innerText();
  codes.push(again);
  check(again !== codes[1] && !(await page.locator(`${sheet} svg.qr.blurred`).count()), 'after an abandoned code, Pair an iPad shows a new live code');
  await page.keyboard.press('Escape');
  await page.waitForSelector(sheet, { state: 'detached' });

  // 4. Another workshop while this check-in runs.
  await page.keyboard.press('Meta+N');
  await page.fill('#wf-title', 'Fictional Second Lab');
  await page.click('[role=dialog][aria-label="New workshop"] button:has-text("Create workshop")');
  await page.dblclick('[role=option]:has-text("Fictional Second Lab")', { timeout: 20_000 });
  await page.waitForSelector('.pair-why', { timeout: 20_000 });
  const why = await page.locator('.pair-why').innerText().catch(() => '');
  check(/another workshop/i.test(why), `the second workshop says why it cannot pair ("${hide(why)}")`);

  const state = await app.evaluate(({ BrowserWindow }) => ({
    dialogs: globalThis.__dialogCalls, shown: globalThis.__shown, visible: BrowserWindow.getAllWindows().filter((w) => w.isVisible()).length,
  }));
  check(state.dialogs.length === 0, `no dialog was raised (${state.dialogs.join(',') || 'none'})`);
  check(state.shown === 0 && state.visible === 0, 'no window was shown');
} catch (e) {
  console.log(`FAILED  ${hide(e instanceof Error ? e.message : e)}`);
  failed = true;
} finally {
  if (pidTimer) clearInterval(pidTimer);
  await notePids().catch(() => undefined);
  const ok = await Promise.race([app.close().then(() => true, () => false), sleep(30_000).then(() => false)]);
  check(ok, 'the app exits on its own');
  await sleep(500);
  const left = [...pids].filter(isAlive);
  check(pids.size >= 2 && left.length === 0, `none of this run's ${pids.size} register and cloudflared processes remains${left.length ? `: ${left.join(', ')}` : ''}`);
  // 5. The log file.
  const logFile = join(userData, 'logs', 'attendwell.log');
  if (existsSync(logFile)) {
    const text = readFileSync(logFile, 'utf8');
    check((statSync(logFile).mode & 0o077) === 0, 'the log file is private to this user');
    check(/Registered tunnel connection/.test(text), 'the log file has the tunnel program\'s output');
    check(/check-in started|Check-in started/i.test(text), 'the log file records the check-in start');
    check(codes.every((c) => !text.includes(c) && !text.includes(c.replace('-', ''))), 'the log file has no pairing code');
  } else check(false, 'the app writes logs/attendwell.log in its data folder');
  rmSync(userData, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
