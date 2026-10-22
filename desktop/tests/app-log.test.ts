// The app's diagnostic log (main/app-log.ts): where it is, who can read it, what it never holds, how it rotates, that it never throws,
// and the plain-words lines it writes for the check-in's state changes.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAppLog, redactLine, runtimeChangeLogger } from '../main/app-log.ts';
import type { RuntimeSnapshot } from '../shared/runtime-types.ts';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'aw-log-')); dirs.push(d); return d; };
const posix = process.platform !== 'win32';
const at = new Date('2026-10-22T14:51:28.000Z');

describe('the log file', () => {
  test('logs/attendwell.log in the data folder, one stamped line per write, private to this user', () => {
    const d = tmp();
    const log = openAppLog(d, { now: () => at });
    log.write('Tunnel starting.');
    log.write('2026-10-22T14:52:23Z INF Registered tunnel connection connIndex=0 location=ewr15 protocol=quic');
    log.close();
    expect(log.file).toBe(join(d, 'logs', 'attendwell.log'));
    expect(readFileSync(log.file, 'utf8')).toBe('2026-10-22T14:51:28.000Z Tunnel starting.\n2026-10-22T14:51:28.000Z 2026-10-22T14:52:23Z INF Registered tunnel connection connIndex=0 location=ewr15 protocol=quic\n');
    if (posix) {
      expect(statSync(log.file).mode & 0o777).toBe(0o600);
      expect(statSync(join(d, 'logs')).mode & 0o777).toBe(0o700);
    }
  });
  test('appends across runs of the app', () => {
    const d = tmp();
    const a = openAppLog(d, { now: () => at }); a.write('first run'); a.close();
    const b = openAppLog(d, { now: () => at }); b.write('second run'); b.close();
    expect(readFileSync(b.file, 'utf8').split('\n').filter(Boolean)).toHaveLength(2);
  });
  test('past the size limit the file moves to attendwell.1.log and a new one starts', () => {
    const d = tmp();
    const log = openAppLog(d, { now: () => at, maxBytes: 200 });
    for (let i = 0; i < 10; i += 1) log.write(`line ${i} ${'x'.repeat(40)}`);
    log.close();
    const old = join(d, 'logs', 'attendwell.1.log');
    expect(existsSync(old)).toBe(true);
    expect(statSync(log.file).size).toBeLessThan(300);
    expect(readFileSync(log.file, 'utf8')).toContain('line 9');
    expect(readFileSync(old, 'utf8')).not.toContain('line 9');
  });
  test.skipIf(!posix)('a link planted at the log\'s name is not followed, and the app carries on without a log', () => {
    const d = tmp();
    const target = join(d, 'elsewhere.txt');
    writeFileSync(target, 'untouched');
    mkdirSync(join(d, 'logs'), { mode: 0o700 });
    symlinkSync(target, join(d, 'logs', 'attendwell.log'));
    const log = openAppLog(d);
    expect(() => log.write('anything')).not.toThrow();
    expect(() => log.write('again')).not.toThrow();
    expect(readFileSync(target, 'utf8')).toBe('untouched');
  });
  test('a data folder that cannot be written never throws', () => {
    const d = tmp();
    writeFileSync(join(d, 'logs'), 'a file where the folder should be');
    const log = openAppLog(d);
    expect(() => { log.write('anything'); log.close(); }).not.toThrow();
  });
});

describe('what a line never holds', () => {
  test('a bearer key, a pairing code or a code in a pairing address is replaced; line breaks are removed', () => {
    expect(redactLine('Authorization: Bearer AbC123_-x.y~z+/=')).toBe('Authorization: Bearer <hidden>');
    expect(redactLine('code K7QM-4TZP shown')).toBe('code <code> shown');
    expect(redactLine('https://quiet-river.trycloudflare.com/pair#v=1&code=K7QM4TZP')).toBe('https://quiet-river.trycloudflare.com/pair#v=1&code=<hidden>');
    expect(redactLine('one\r\ntwo\u0007')).toBe('one two');
    expect(redactLine('x'.repeat(5000))).toHaveLength(2000);
  });
  test('cloudflared\'s own lines pass unchanged', () => {
    const line = 'INF Registered tunnel connection connIndex=0 connection=2952c89c-e658-4a14-9d7c-a049a93dc04d event=0 ip=198.41.200.193 location=ewr15 protocol=quic';
    expect(redactLine(line)).toBe(line);
  });
});

describe('check-in state changes in plain words', () => {
  const idle: RuntimeSnapshot = { workshopId: 'w1', session: 'idle', service: { state: 'off' }, tunnel: { state: 'off' } };
  test('a check-in that starts, goes online, loses its address, fails and closes', () => {
    const lines: string[] = [];
    const log = runtimeChangeLogger((l) => lines.push(l));
    log(idle);
    log({ ...idle, session: 'starting', tunnel: { state: 'starting' } });
    log({ ...idle, session: 'starting', tunnel: { state: 'starting' } });
    log({ ...idle, session: 'starting', tunnel: { state: 'online', url: 'https://quiet-river.trycloudflare.com' } });
    log({ ...idle, session: 'running', tunnel: { state: 'online', url: 'https://quiet-river.trycloudflare.com' }, service: { state: 'running', organiserUrl: 'http://127.0.0.1:4318', participantPort: 0, participantOrigin: 'https://quiet-river.trycloudflare.com' } });
    const running = { session: 'running' as const, service: { state: 'running' as const, organiserUrl: 'http://127.0.0.1:4318', participantPort: 0, participantOrigin: 'https://quiet-river.trycloudflare.com' } };
    log({ ...idle, ...running, tunnel: { state: 'reconnecting', attempt: 1, url: null } });
    log({ ...idle, ...running, tunnel: { state: 'reconnecting', attempt: 1, url: null } });
    log({ ...idle, ...running, tunnel: { state: 'failed', reason: 'blocked-by-network', message: 'This network is blocking the connection to Cloudflare.' } });
    log({ ...idle, session: 'ending', service: running.service, tunnel: { state: 'off' } });
    log(idle);
    expect(lines).toEqual([
      'Check-in starting (workshop w1).',
      'Tunnel starting.',
      'Tunnel online at https://quiet-river.trycloudflare.com.',
      'Check-in started (workshop w1).',
      'Register running with the check-in address.',
      'Tunnel reconnecting, attempt 1.',
      'Tunnel failed (blocked-by-network): This network is blocking the connection to Cloudflare.',
      'Check-in closing (workshop w1).',
      'Tunnel off.',
      'Check-in closed (workshop w1).',
      'Register stopped.',
    ]);
  });
  test('a register that fails is logged with its message', () => {
    const lines: string[] = [];
    const log = runtimeChangeLogger((l) => lines.push(l));
    log({ ...idle, session: 'starting', service: { state: 'starting' } });
    log({ ...idle, session: 'starting', service: { state: 'restarting', attempt: 1 } });
    log({ ...idle, session: 'starting', service: { state: 'restarting', attempt: 2 } });
    log({ ...idle, session: 'idle', service: { state: 'failed', reason: 'exited', message: 'The register stopped and could not be restarted.' } });
    expect(lines).toEqual([
      'Check-in starting (workshop w1).', 'Register starting.', 'Register restarting, attempt 1.', 'Register restarting, attempt 2.',
      'Check-in closed (workshop w1).', 'Register failed (exited): The register stopped and could not be restarted.',
    ]);
  });
});
