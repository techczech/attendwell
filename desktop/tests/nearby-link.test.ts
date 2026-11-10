import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { loadOrCreateKey, startNearbyLink } from '../main/nearby-link.ts';

const tmp = (): string => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'awn-'));
function helperRoot(): string {
  const root = tmp();
  const dir = join(root, 'nearby', 'darwin-arm64'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'attendwell-nearby'), '#!/bin/sh\n'); chmodSync(join(dir, 'attendwell-nearby'), 0o755);
  return root;
}
function fakeChild() {
  const c = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; pid: number };
  c.stdin = new PassThrough(); c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.pid = 1;
  const written: string[] = []; c.stdin.on('data', (d: Buffer) => written.push(d.toString()));
  return { c, written };
}

describe('the nearby key', () => {
  test('is made once, 32 random bytes as base64url, mode 0600, and read back unchanged', () => {
    const dir = tmp();
    const a = loadOrCreateKey(dir);
    expect(a.workshopId).toBe('nearby-test');
    expect(Buffer.from(a.key, 'base64url').length).toBe(32);
    expect(statSync(join(dir, 'nearby-key.json')).mode & 0o777).toBe(0o600);
    expect(loadOrCreateKey(dir)).toEqual(a);
  });
});

describe('the nearby link', () => {
  test('stays off in test mode, off outside macOS, and a missing helper is logged and harmless', () => {
    const logs: string[] = [];
    const base = { userData: tmp(), resourcesRoot: helperRoot(), appLog: (l: string) => logs.push(l) };
    expect(startNearbyLink({ ...base, env: { ATTENDWELL_TEST: '1' }, platform: 'darwin' }).view().available).toBe(false);
    expect(startNearbyLink({ ...base, env: {}, platform: 'win32' }).view().available).toBe(false);
    const none = startNearbyLink({ ...base, resourcesRoot: tmp(), env: {}, platform: 'darwin' });
    expect(none.view().available).toBe(false);
    expect(logs.join('\n')).toContain('helper is not in this build');
  });

  test('gives the key on stdin, tracks the peer, counts each check-in once and acknowledges every copy', () => {
    const { c, written } = fakeChild();
    const link = startNearbyLink({ userData: tmp(), resourcesRoot: helperRoot(), env: {}, platform: 'darwin', appLog: () => undefined, spawnFn: () => c as unknown as ChildProcess });
    const v0 = link.view();
    expect(v0.available).toBe(true); expect(v0.state).toBe('waiting');
    expect(JSON.parse(v0.payload!)).toEqual({ v: 1, workshopId: 'nearby-test', key: v0.key! });
    const sent = written.join('');
    expect(sent).toContain(v0.key!); expect(sent).toContain('"type":"snapshot"'); expect(sent.match(/Synthetic Person/g)!.length).toBe(500);
    c.stdout.write('{"type":"peer","state":"connected","peer":"Room iPad"}\n{"type":"checkin","opId":"a","nameId":"n1","at":1}\n{"type":"checkin","opId":"a","nameId":"n1","at":1}\n{"type":"checkin","opId":"b","nameId":"n2","at":2}\n');
    const v = link.view();
    expect(v.state).toBe('connected'); expect(v.peerName).toBe('Room iPad'); expect(v.checkins).toBe(2);
    expect(written.join('').match(/"type":"ack"/g)!.length).toBe(3);
    expect(readFileSync(link.logFile, 'utf8')).not.toContain(v0.key!);
    c.stdout.write('{"type":"peer","state":"notConnected","peer":"Room iPad"}\n');
    expect(link.view().state).toBe('waiting');
  });

  test('restarts the helper once after an unexpected exit, then gives up quietly', async () => {
    const kids = [fakeChild(), fakeChild()]; let n = 0; const logs: string[] = [];
    const link = startNearbyLink({ userData: tmp(), resourcesRoot: helperRoot(), env: {}, platform: 'darwin', appLog: (l) => logs.push(l), restartDelayMs: 5, spawnFn: () => kids[n++]!.c as unknown as ChildProcess });
    kids[0]!.c.emit('exit', 1, null);
    await new Promise((r) => setTimeout(r, 40));
    expect(n).toBe(2); expect(link.view().available).toBe(true);
    kids[1]!.c.emit('exit', 1, null);
    await new Promise((r) => setTimeout(r, 40));
    expect(n).toBe(2); expect(link.view().available).toBe(false);
    expect(logs.some((l) => l.includes('stopped unexpectedly'))).toBe(true);
  });

  test('a stop is not an unexpected exit', async () => {
    const k = fakeChild(); let n = 0;
    const link = startNearbyLink({ userData: tmp(), resourcesRoot: helperRoot(), env: {}, platform: 'darwin', appLog: () => undefined, restartDelayMs: 5, spawnFn: () => { n++; return k.c as unknown as ChildProcess; } });
    link.stop(); k.c.emit('exit', 0, null);
    await new Promise((r) => setTimeout(r, 30));
    expect(n).toBe(1);
  });
});
