// Runs the Mac helper on this host and the iPad spike app's XCTest on an iOS Simulator against it: one snapshot, 20 check-ins.
//   node desktop/nearby/spike/sim-test.mjs [simulator-udid]     (default: the iPad (A16) simulator; avoids the usually-booted Pro)
// Appends one line per run to docs/spike-evidence/simulator-to-host-<date>.jsonl. Temp files only; the key goes to xcodebuild in its environment, not argv.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, appendFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Register, helperPath, repoRoot, newKey, sleep, startMac, syntheticSnapshot } from './lib.mjs';

if (!existsSync(helperPath)) { console.error('Build the helper first: bash desktop/nearby/build.sh'); process.exit(2); }
const udid = process.argv[2] || '8A3F0109-DE3E-437E-87E3-6BB269FAA8C2';
const tmp = mkdtempSync(join(tmpdir(), 'nearby-simtest-'));
const key = newKey(), reg = new Register(join(tmp, 'register.jsonl'));
const mac = startMac({ key, register: reg, snapshot: syntheticSnapshot(500) });
await mac.waitFor((e) => e.type === 'ready', 10000);

const resultFile = join(tmp, 'result.json');
const project = join(repoRoot, 'ipad', 'NearbySpike', 'NearbySpike.xcodeproj');
const t0 = Date.now();
// Async, not spawnSync: the harness must keep recording and acking the Mac helper's check-ins while xcodebuild runs.
let hung = false;
const r = await new Promise((resolve) => {
  const p = spawn('xcodebuild', ['test', '-project', project, '-scheme', 'NearbySpike', '-destination', `platform=iOS Simulator,id=${udid}`,
    '-derivedDataPath', join(repoRoot, 'ipad', 'NearbySpike', '.build'), '-only-testing:NearbySpikeTests'],
    { env: { ...process.env, TEST_RUNNER_NEARBY_KEY: key, TEST_RUNNER_NEARBY_RESULT_FILE: resultFile } });
  // A run that hangs (seen once with Simulator Multipeer) is cut off and recorded as hung rather than blocking for ever.
  const hang = setTimeout(() => { hung = true; p.kill('SIGKILL'); }, 180000);
  let out = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
  p.on('exit', (status) => { clearTimeout(hang); resolve({ status, stdout: out, stderr: '' }); });
});
await sleep(500);
const tail = (r.stdout + r.stderr).split('\n').slice(-25).join('\n');
const result = existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, 'utf8')) : null;
const expectedIds = result?.opIds ?? [];
const evidence = {
  date: new Date().toISOString(), simulatorUdid: udid, xcodebuildExit: r.status, hung, elapsedMs: Date.now() - t0,
  macRecorded: reg.size, macRegisterLines: reg.lines(), macRecordedAllTestOpIds: expectedIds.length === 20 && expectedIds.every((id) => reg.ids.has(id)),
  macEvents: mac.events.filter((e) => ['peer', 'log', 'snapshot-sent'].includes(e.type)).map((e) => `+${e.h - mac.startedAt}ms ${e.type} ${e.state ?? e.msg ?? e.bytes}`),
  clientTimings: result && { connectAndSnapshotSeconds: result.connectAndSnapshotSeconds, twentyCheckinsAckedSeconds: result.twentyCheckinsAckedSeconds },
  clientLog: result?.log, xcodebuildTail: r.status === 0 ? undefined : tail,
  pass: r.status === 0 && reg.size === 20 && reg.lines() === 20,
};
const outDir = join(repoRoot, 'docs', 'spike-evidence'); mkdirSync(outDir, { recursive: true });
appendFileSync(join(outDir, `simulator-to-host-${new Date().toISOString().slice(0, 10)}.jsonl`), JSON.stringify(evidence) + '\n');   // one line per run
console.log(JSON.stringify({ pass: evidence.pass, xcodebuildExit: evidence.xcodebuildExit, macRecorded: evidence.macRecorded, clientTimings: evidence.clientTimings, elapsedMs: evidence.elapsedMs }));
await mac.stop();
process.exit(evidence.pass ? 0 : 1);
