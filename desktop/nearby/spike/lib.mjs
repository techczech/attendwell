// Shared by harness.mjs and sim-test.mjs: runs the attendwell-nearby helper, keeps a temp JSON-lines register deduped by opId.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
export const nearbyDir = join(here, '..');
export const repoRoot = join(nearbyDir, '..', '..');
export const helperPath = process.env.NEARBY_BIN || join(nearbyDir, '.build', 'arm64-apple-macosx', 'release', 'attendwell-nearby');
export const now = () => Number(process.hrtime.bigint() / 1000000n);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const newKey = () => randomBytes(32).toString('base64url');

export function syntheticSnapshot(n = 500, version = 1) {
  return { type: 'snapshot', version, workshopId: 'spike-workshop', title: 'Spike workshop', open: true,
    names: Array.from({ length: n }, (_, i) => ({ id: `n${i}`, displayName: `Synthetic Person ${i} Longname-${(i * 7919) % 1000}`, hidden: false })) };
}

/** The parent's register: JSON lines, one per distinct opId; duplicates are counted but never recorded twice. */
export class Register {
  constructor(file) { this.file = file; this.ids = new Set(); this.duplicates = 0;
    if (existsSync(file)) for (const l of readFileSync(file, 'utf8').split('\n').filter(Boolean)) this.ids.add(JSON.parse(l).opId); }
  record(c) { if (this.ids.has(c.opId)) { this.duplicates++; return false; } appendFileSync(this.file, JSON.stringify(c) + '\n'); this.ids.add(c.opId); return true; }
  get size() { return this.ids.size; }
  lines() { if (!existsSync(this.file)) return 0; return readFileSync(this.file, 'utf8').split('\n').filter(Boolean).length; }
}

/** A running helper. Every stdout line becomes an event {..., h: harness ms at receipt}; `on` and `waitFor` watch them. */
class Helper {
  constructor(args, key, firstLines) {
    this.events = []; this.watchers = []; this.startedAt = now();
    this.proc = spawn(helperPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.exited = new Promise((r) => this.proc.once('exit', (code, sig) => { this.exitInfo = { code, sig }; r(this.exitInfo); }));
    this.proc.stdin.on('error', () => {});
    createInterface({ input: this.proc.stdout }).on('line', (l) => {
      let e; try { e = JSON.parse(l); } catch { e = { type: 'garbage', line: l }; }
      e.h = now(); this.events.push(e); for (const w of [...this.watchers]) w(e);
    });
    createInterface({ input: this.proc.stderr }).on('line', (l) => this.events.push({ type: 'stderr', line: l, h: now() }));
    this.write({ type: 'key', key, workshopId: 'spike-workshop' });
    for (const l of firstLines || []) this.write(l);
  }
  write(o) { if (this.proc.stdin.writable) this.proc.stdin.write(JSON.stringify(o) + '\n'); }
  on(fn) { this.watchers.push(fn); }
  find(pred) { return this.events.find(pred); }
  waitFor(pred, ms = 30000) {
    const hit = this.events.find(pred); if (hit) return Promise.resolve(hit);
    return new Promise((resolve) => { const t = setTimeout(() => { this.watchers = this.watchers.filter((w) => w !== f); resolve(null); }, ms);
      const f = (e) => { if (pred(e)) { clearTimeout(t); this.watchers = this.watchers.filter((w) => w !== f); resolve(e); } }; this.watchers.push(f); });
  }
  kill(sig = 'SIGKILL') { this.proc.kill(sig); return this.exited; }
  /** Graceful for the mac role: closing stdin makes the helper stop and exit. */
  async stop() { try { this.proc.stdin.end(); } catch {} const t = setTimeout(() => this.proc.kill('SIGKILL'), 3000); await this.exited; clearTimeout(t); }
}

/** Starts the mac helper wired to a register: each check-in is recorded first, then acked (also when it is a repeat). */
export function startMac({ key, register, snapshot, device = 'spike-mac' }) {
  const h = new Helper(['--role', 'mac', '--device', device], key, snapshot ? [snapshot] : []);
  h.on((e) => { if (e.type === 'checkin') { const fresh = register.record({ opId: e.opId, nameId: e.nameId, at: e.at, peer: e.peer }); h.write({ type: 'ack', opIds: [e.opId] }); if (!fresh) h.repeats = (h.repeats || 0) + 1; } });
  return h;
}

export function startSim({ key, queue, count = 0, intervalMs = 5, device = 'spike-ipad' }) {
  return new Helper(['--role', 'ipad-sim', '--queue', queue, '--count', String(count), '--interval-ms', String(intervalMs), '--device', device], key);
}

export const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
