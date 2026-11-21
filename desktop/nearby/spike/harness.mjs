// Mac-to-Mac measurement of the nearby link: the Mac helper and a headless fake iPad on this machine, plain node.
//   node desktop/nearby/spike/harness.mjs [a b c d e]     (default: all; writes docs/spike-evidence/mac-to-mac-<date>.jsonl)
// Uses only temp files: nothing here reads or writes ~/AttendWell.
import { mkdtempSync, mkdirSync, appendFileSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Register, helperPath, repoRoot, median, newKey, now, sleep, startMac, startSim, syntheticSnapshot } from './lib.mjs';

if (!existsSync(helperPath)) { console.error(`Build the helper first: bash desktop/nearby/build.sh (${helperPath})`); process.exit(2); }
const date = new Date().toISOString().slice(0, 10);
const evidenceDir = join(repoRoot, 'docs', 'spike-evidence');
mkdirSync(evidenceDir, { recursive: true });
const resultsFile = join(evidenceDir, `mac-to-mac-${date}.jsonl`);
const rawFile = join(evidenceDir, `mac-to-mac-${date}.raw.log`);
writeFileSync(resultsFile, ''); writeFileSync(rawFile, '');
const tmp = mkdtempSync(join(tmpdir(), 'nearby-spike-'));
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : ['a', 'b', 'c', 'd', 'e'];
const snapshot = syntheticSnapshot(500);
const out = (o) => { const line = JSON.stringify(o); console.log(line); appendFileSync(resultsFile, line + '\n'); };
const raw = (scenario, who, h) => { for (const e of h.events) if (e.type !== 'checkin' && e.type !== 'checkin-created' && e.type !== 'queue') appendFileSync(rawFile, `${scenario} ${who} ${JSON.stringify(e)}\n`); };
const summarise = (h) => ({ peerEvents: h.events.filter((e) => e.type === 'peer').length, logLines: h.events.filter((e) => e.type === 'log').length, stderr: h.events.filter((e) => e.type === 'stderr').length });
const connected = (e) => e.type === 'peer' && e.state === 'connected';

async function scenarioA() {
  const runs = [];
  for (let i = 0; i < 10; i++) {
    const key = newKey(), reg = new Register(join(tmp, `a${i}.jsonl`));
    const t0 = now();
    const mac = startMac({ key, register: reg, snapshot });
    await mac.waitFor((e) => e.type === 'ready', 10000);
    const sim = startSim({ key, queue: join(tmp, `a${i}.queue.json`) });
    const macConn = await mac.waitFor(connected, 40000);
    const simSnap = await sim.waitFor((e) => e.type === 'snapshot', 40000);
    const sent = mac.find((e) => e.type === 'snapshot-sent');
    runs.push({ run: i + 1, ok: !!(macConn && simSnap),
      startToConnectedMs: macConn ? macConn.h - t0 : null,
      connectedToSnapshotMs: macConn && simSnap ? simSnap.t - macConn.t : null,   // helper clocks: same uptime clock on this Mac
      sealedBytes: simSnap?.bytes ?? null, snapshotTransferMs: sent && simSnap ? simSnap.t - sent.t : null, names: simSnap?.names ?? null });
    raw('a' + (i + 1), 'mac', mac); raw('a' + (i + 1), 'sim', sim);
    await sim.kill('SIGTERM'); await mac.stop(); await sleep(1500);
  }
  const ok = runs.filter((r) => r.ok);
  const col = (k) => ok.map((r) => r[k]).filter((v) => v != null);
  out({ scenario: 'a', what: 'connection time, 10 runs', runs, successes: ok.length,
    startToConnectedMs: { median: median(col('startToConnectedMs')), max: Math.max(...col('startToConnectedMs')) },
    connectedToSnapshotMs: { median: median(col('connectedToSnapshotMs')), max: Math.max(...col('connectedToSnapshotMs')) } });
  const bytes = col('sealedBytes'), xfer = col('snapshotTransferMs');
  out({ scenario: 'b', what: '500-name snapshot', names: 500, plainJsonBytes: JSON.stringify(snapshot).length, sealedBytes: bytes[0] ?? null,
    transferMs: { median: median(xfer), max: Math.max(...xfer), min: Math.min(...xfer) }, samples: xfer.length });
}

/** 500 check-ins from the fake iPad; `disturb` is called once ~150 are recorded and returns the helpers to wait for afterwards. */
async function streamScenario(name, what, disturb) {
  const key = newKey(), reg = new Register(join(tmp, `${name}.jsonl`)), queue = join(tmp, `${name}.queue.json`);
  let mac = startMac({ key, register: reg, snapshot });
  await mac.waitFor((e) => e.type === 'ready', 10000);
  let sim = startSim({ key, queue, count: 500, intervalMs: 10 });
  if (!(await mac.waitFor(connected, 40000))) { out({ scenario: name, what, pass: false, reason: 'never connected' }); await sim.kill(); await mac.stop(); return; }
  while (reg.size < 150) await sleep(20);
  const ctx = { mac, sim, key, queue, reg };
  const d = await disturb(ctx);
  mac = ctx.mac; sim = ctx.sim;
  const finished = await Promise.race([sim.waitFor((e) => e.type === 'done', 120000), sleep(125000).then(() => null)]);
  await sleep(500);
  const lines = reg.lines();
  const expected = new Set(Array.from({ length: 500 }, (_, i) => `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`));
  const missing = [...expected].filter((id) => !reg.ids.has(id)).length;
  out({ scenario: name, what, pass: !!finished && reg.size === 500 && lines === 500 && missing === 0, recorded: reg.size, registerLines: lines, missing,
    repeatsReceivedAndDeduped: reg.duplicates, ...d, totalMs: finished ? finished.h - ctx.t0 : null });
  raw(name, 'mac', mac); raw(name, 'sim', sim);
  await sim.kill('SIGTERM'); await mac.stop(); await sleep(1500);
}

async function scenarioC() {
  await streamScenario('c', 'mac helper killed and restarted mid-stream', async (ctx) => {
    ctx.t0 = now();
    const recordedAtKill = ctx.reg.size; const killedAt = now();
    await ctx.mac.kill('SIGKILL');
    const old = ctx.mac;
    await sleep(1000);                                   // restart one second after the kill
    const restartAt = now();
    ctx.mac = startMac({ key: ctx.key, register: ctx.reg, snapshot });
    const conn = await ctx.mac.waitFor(connected, 90000);
    const firstAfter = await ctx.mac.waitFor((e) => e.type === 'checkin', 90000);
    raw('c', 'mac-before-kill', old);
    return { recordedAtKill, restartToConnectedMs: conn ? conn.h - restartAt : null, killToFirstCheckinAfterMs: firstAfter ? firstAfter.h - killedAt : null };
  });
}

async function scenarioD() {
  await streamScenario('d', 'fake iPad killed mid-stream and relaunched with the same queue file', async (ctx) => {
    ctx.t0 = now();
    const recordedAtKill = ctx.reg.size;
    await ctx.sim.kill('SIGKILL');
    const queuedOnDisk = (() => { try { return JSON.parse(readFileSync(ctx.queue, 'utf8')).length; } catch { return null; } })();
    const nConnectedBefore = ctx.mac.events.filter(connected).length;
    const killedAt = now();
    await sleep(1000);
    const relaunchAt = now();
    const old = ctx.sim;
    ctx.sim = startSim({ key: ctx.key, queue: ctx.queue, count: 500, intervalMs: 10 });
    const conn = await ctx.mac.waitFor((e) => connected(e) && ctx.mac.events.filter(connected).length > nConnectedBefore, 90000);
    raw('d', 'sim-before-kill', old);
    return { recordedAtKill, relaunchToConnectedMs: conn ? conn.h - relaunchAt : null, killToReconnectedMs: conn ? conn.h - killedAt : null };
  });
}

async function scenarioE() {
  const reg = new Register(join(tmp, 'e.jsonl'));
  const mac = startMac({ key: newKey(), register: reg, snapshot });
  await mac.waitFor((e) => e.type === 'ready', 10000);
  const sim = startSim({ key: newKey(), queue: join(tmp, 'e.queue.json'), count: 20, intervalMs: 20 });
  await sleep(25000);
  const anyConnected = [...mac.events, ...sim.events].some((e) => e.type === 'peer' && e.state === 'connected');
  const snaps = sim.events.filter((e) => e.type === 'snapshot').length;
  out({ scenario: 'e', what: 'wrong key', watchedSeconds: 25, anyPeerConnected: anyConnected, snapshotsReceived: snaps, checkinsRecorded: reg.size,
    macLog: summarise(mac), simLog: summarise(sim), pass: !anyConnected && snaps === 0 && reg.size === 0 });
  raw('e', 'mac', mac); raw('e', 'sim', sim);
  await sim.kill('SIGTERM'); await mac.stop();
}

out({ scenario: 'meta', date, helper: helperPath, host: process.env.HOST || undefined, scenarios: wanted });
if (wanted.includes('a') || wanted.includes('b')) await scenarioA();
if (wanted.includes('c')) await scenarioC();
if (wanted.includes('d')) await scenarioD();
if (wanted.includes('e')) await scenarioE();
process.exit(0);
