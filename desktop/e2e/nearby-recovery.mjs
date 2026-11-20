// Run against the signed test build: node e2e/nearby-recovery.mjs
// Hidden Electron, fake register/tunnel, real bundled helper and a headless nearby client.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron } from 'playwright-core';

const root = resolve(import.meta.dirname, '..');
const contents = join(root, 'release-test/mac-arm64/AttendWell.app/Contents');
const program = join(contents, 'Resources/nearby/darwin-arm64/attendwell-nearby');
const shots = join(root, 'e2e/shots/nearby-recovery');
const data = mkdtempSync(join(tmpdir(), 'attendwell-nearby-e2e-'));
const log = join(data, 'nearby.log');
const queue = join(data, 'queue.json');
let app;
let client;

function helperPids() {
  return [...readFileSync(log, 'utf8').matchAll(/started helper pid (\d+)/g)].map((m) => Number(m[1]));
}

async function stopClient() {
  if (!client) return;
  if (client.exitCode === null && client.signalCode === null) {
    const exited = once(client, 'exit');
    client.kill();
    await exited;
  }
  client = undefined;
}

try {
  app = await electron.launch({
    executablePath: join(contents, 'MacOS/AttendWell'),
    cwd: root,
    args: ['--use-mock-keychain'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ATTENDWELL_TEST: '1', ATTENDWELL_NEARBY: '1',
      ATTENDWELL_RUNTIME: 'fake', ATTENDWELL_USER_DATA: data, ATTENDWELL_REGISTERS: join(data, 'registers') },
  });
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => {
    globalThis.__visibleNearbyTestWindows = 0;
    const win = BrowserWindow.getAllWindows()[0];
    win.on('show', () => { globalThis.__visibleNearbyTestWindows += 1; });
    win.setSize(1440, 950);
  });
  await page.getByText('Set up AttendWell', { exact: true }).click();
  await page.getByText('Continue', { exact: true }).click();
  await page.fill('#wf-title', 'Nearby recovery workshop');
  await page.getByText('Create workshop', { exact: true }).click();
  const panel = page.getByRole('region', { name: 'Connection', exact: true });
  const devices = page.getByRole('region', { name: 'Devices', exact: true });
  const connected = panel.getByText('iPad connected locally: Room iPad', { exact: true });
  const lost = panel.getByText(/^Connection to the iPad lost at \d\d:\d\d$/);
  const reconnect = panel.getByRole('button', { name: 'Reconnect', exact: true });
  await page.getByRole('button', { name: 'Paste names…', exact: true }).click();
  await page.fill('#names-text', 'Alex Example, alex@example.org');
  await page.getByRole('button', { name: 'Add 1 person', exact: true }).click();
  await page.getByRole('option', { name: /Alex Example/ }).waitFor();

  const key = JSON.parse(readFileSync(join(data, 'nearby-key.json'), 'utf8'));
  function startClient() {
    client = spawn(program, ['--role', 'ipad-sim', '--device', 'Room iPad', '--queue', queue],
      { stdio: ['pipe', 'ignore', 'ignore'] });
    client.stdin.end(JSON.stringify({ type: 'key', ...key }) + '\n');
  }
  startClient();
  await connected.waitFor({ timeout: 45_000 });
  await devices.getByLabel('1 iPads', { exact: true }).waitFor();

  await app.evaluate(() => globalThis.__attendwellFake.failNextTunnel('blocked-by-network'));
  await page.getByRole('button', { name: 'Start check-in', exact: true }).click();
  await panel.getByRole('button', { name: 'Try again', exact: true }).waitFor();
  await panel.getByText('Internet route (optional)', { exact: true }).waitFor();
  await page.getByLabel('Check-in: iPad connected locally', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Check-in: Connection trouble', { exact: true }).count(), 0);
  mkdirSync(shots, { recursive: true });
  await panel.screenshot({ path: join(shots, 'mac-connected.png') });
  console.log('Local iPad counted and shown in green with the internet tunnel failed');

  for (let failure = 0; failure < 2; failure += 1) {
    const before = helperPids();
    process.kill(before.at(-1), 'SIGTERM');
    await connected.waitFor({ state: 'hidden', timeout: 10_000 });
    await connected.waitFor({ timeout: 45_000 });
    assert.equal(helperPids().length, before.length + 1);
  }
  console.log('Two consecutive helper exits recovered and reconnected');

  await stopClient();
  await lost.waitFor({ timeout: 35_000 });
  await devices.getByLabel('0 iPads', { exact: true }).waitFor();
  await panel.getByText(/Can't see the Mac\. Put both on the same Wi-Fi/).waitFor({ timeout: 25_000 });
  await panel.screenshot({ path: join(shots, 'mac-lost.png') });
  const before = helperPids().length;
  await reconnect.click();
  for (let i = 0; i < 40 && helperPids().length === before; i += 1) await delay(100);
  assert.equal(helperPids().length, before + 1);
  const { workshopId, personId } = await app.evaluate(() => {
    const fake = globalThis.__attendwellFake;
    const workshopId = fake.current();
    return { workshopId, personId: fake.register(workshopId).people[0].id };
  });
  const operation = { workshopId, opId: 'fixture-nearby-replay',
    nameId: createHash('sha256').update(personId).digest('hex'), at: new Date().toISOString() };
  writeFileSync(queue, JSON.stringify([operation, operation]));
  startClient();
  await connected.waitFor({ timeout: 45_000 });
  for (let i = 0; i < 80 && JSON.parse(readFileSync(queue, 'utf8')).length; i += 1) await delay(100);
  assert.deepEqual(JSON.parse(readFileSync(queue, 'utf8')), []);
  const person = await app.evaluate(() => {
    const fake = globalThis.__attendwellFake;
    return fake.register(fake.current()).people[0];
  });
  assert.equal(person.present, true);
  assert.equal(person.version, 1);
  console.log('A queued check-in and its duplicate were acknowledged after one register write');
  await panel.getByRole('button', { name: 'Try again', exact: true }).click();
  await page.getByLabel('Check-in: Online', { exact: true }).waitFor();
  console.log('Reconnect replaced the helper and the optional internet retry still works');

  assert.equal(await app.evaluate(({ BrowserWindow }) =>
    globalThis.__visibleNearbyTestWindows + BrowserWindow.getAllWindows().filter((win) => win.isVisible()).length), 0);
  console.log('No Electron window became visible');
} finally {
  await stopClient();
  try { await app?.close(); }
  finally { rmSync(data, { recursive: true, force: true }); }
}
