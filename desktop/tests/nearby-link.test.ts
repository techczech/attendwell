import { afterEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { loadOrCreateKey, startNearbyLink } from '../main/nearby-link.ts';
import { createFakeRuntime } from '../main/fake-runtime.ts';
import { NamesService } from '../main/names-service.ts';

const roots: string[] = [];
const tmp = (): string => {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'awn-'));
  roots.push(root);
  return root;
};
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !condition(); attempt++) await new Promise((resolve) => setTimeout(resolve, 2));
}
const noRecord = { recordCheckIn: async () => { throw new Error('No check-in expected'); } };

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
    const base = { ...noRecord, userData: tmp(), resourcesRoot: helperRoot(), appLog: (l: string) => logs.push(l) };
    expect(startNearbyLink({ ...base, env: { ATTENDWELL_TEST: '1' }, platform: 'darwin' }).view().available).toBe(false);
    expect(startNearbyLink({ ...base, env: {}, platform: 'win32' }).view().available).toBe(false);
    const none = startNearbyLink({ ...base, resourcesRoot: tmp(), env: {}, platform: 'darwin' });
    expect(none.view().available).toBe(false);
    expect(none.extendPairingQR('https://example.org/pair#v=1&code=ABCD-EFGH')).toBe('https://example.org/pair#v=1&code=ABCD-EFGH');
    expect(logs.join('\n')).toContain('helper is not in this build');
  });

  test('connects before any workshop is open, then publishes changing names and window without email addresses', () => {
    const { c, written } = fakeChild();
    const link = startNearbyLink({ ...noRecord, userData: tmp(), resourcesRoot: helperRoot(), env: {}, platform: 'darwin', appLog: () => undefined, spawnFn: () => c as unknown as ChildProcess });
    const initial = link.view();
    expect(initial.state).toBe('waiting');
    expect(JSON.parse(initial.payload!)).toEqual({ v: 1, workshopId: 'nearby-test', key: initial.key });
    const oldQR = 'https://example.org/s/event/pair#v=1&code=ABCD-EFGH';
    const extended = new URL(link.extendPairingQR(oldQR));
    const inner = new URL('https://fixture.invalid/?' + decodeURIComponent(extended.hash.slice(1)));
    expect([...inner.searchParams]).toEqual([['v', '1'], ['code', 'ABCD-EFGH']]);
    expect(inner.hash).toBe('#nearby=' + initial.key);
    const messages = () => written.map((line) => JSON.parse(line));
    expect(messages()[1]).toMatchObject({ type: 'snapshot', title: 'No workshop open on the Mac', open: false, names: [] });
    c.stdout.write('{"type":"peer","state":"connected","peer":"Room iPad"}\n');
    expect(link.view()).toMatchObject({ state: 'connected', peerName: 'Room iPad' });
    const participants = [
      { id: 'alex@example.org', name: 'Alex Example <alex@example.org>', email: 'alex@example.org', booking: 'confirmed', admitted: false, present: false, version: 0, updatedAt: null },
      { id: 'waiting', name: 'Waiting Example', email: 'waiting@example.org', booking: 'waiting', admitted: false, present: false, version: 0, updatedAt: null },
    ];
    const workshop = { id: 'workshop', title: 'Workshop – chair@example.org', roster: { participants, conflicts: [] }, open: false };
    link.updateWorkshop(workshop);
    link.updateWorkshop({ ...workshop, open: true });
    link.updateWorkshop({ ...workshop, open: true });
    const snapshots = messages().filter((m) => m.type === 'snapshot');
    expect(snapshots.map((s) => [s.version, s.open])).toEqual([[1, false], [2, false], [3, true]]);
    expect(snapshots[2].names).toMatchObject([{ displayName: 'Alex Example', hidden: false }, { displayName: 'Waiting Example', hidden: true }]);
    expect(JSON.stringify(snapshots)).not.toContain('example.org');
    expect(link.view().workshopTitle).toBe(workshop.title);
    expect(readFileSync(link.logFile, 'utf8')).not.toContain(initial.key!);
    c.stdout.write('{"type":"peer","state":"notConnected","peer":"Room iPad"}\n');
    expect(link.view().state).toBe('waiting');
    link.stop();
  });

  test('acks only after the fake register durably records, retries a failed write, and dedupes across restart', async () => {
    const dataRoot = tmp();
    let runtime = createFakeRuntime({ dataRoot });
    const workshop = await runtime.workshops.create({ title: 'Test workshop', date: '2026-11-20' });
    const lease = await runtime.openRegister(workshop.id);
    await runtime.fake.organiserFactory(lease.organiserUrl).addParticipant('Alex Example', 'alex@example.org');
    await lease.release();
    const roster = (await runtime.readRegister(workshop.id))!;
    const spawnLink = () => {
      const { c, written } = fakeChild();
      const names = new NamesService({ port: runtime, organiser: runtime.fake.organiserFactory, written: async () => undefined });
      let allowRecord: () => void = () => undefined;
      const canRecord = new Promise<void>((resolve) => { allowRecord = resolve; });
      let attempts = 0;
      const link = startNearbyLink({
        userData: tmp(), resourcesRoot: helperRoot(), env: {}, platform: 'darwin', appLog: () => undefined, spawnFn: () => c as unknown as ChildProcess,
        async recordCheckIn(id, checkIn) {
          attempts += 1;
          await canRecord;
          return names.recordNearbyCheckIn(id, checkIn);
        },
      });
      link.updateWorkshop({ id: workshop.id, title: workshop.title, roster, open: false });
      const sent = () => written.map((line) => JSON.parse(line));
      const deliver = (opId: string, nameId: string) => c.stdout.write(JSON.stringify({ type: 'checkin', opId, nameId, at: '2026-11-20T10:00:00Z', workshopId: workshop.id }) + '\n');
      return { link, allowRecord, acks: () => sent().filter((m) => m.type === 'ack').flatMap((m) => m.opIds), deliver,
        nameId: sent().at(-1).names[0].id as string, attempts: () => attempts };
    };
    const first = spawnLink();
    const known = 'op-nearby-known';
    const unknown = 'op-nearby-unknown';
    first.deliver(known, first.nameId);
    first.deliver(known, first.nameId);
    expect(first.acks()).toEqual([]);
    expect((await runtime.readRegister(workshop.id))?.participants[0]?.present).toBe(false);
    first.allowRecord();
    await until(() => first.acks().length === 2);
    expect(first.acks()).toEqual([known, known]);
    expect(first.attempts()).toBe(1);
    expect((await runtime.readRegister(workshop.id))?.participants[0]).toMatchObject({ present: true, late: true, version: 1 });
    const originalOpen = runtime.openRegister.bind(runtime);
    runtime.openRegister = async () => { throw new Error('Temporary write failure'); };
    first.deliver(unknown, 'missing-name');
    await until(() => first.attempts() === 2);
    expect(first.attempts()).toBe(2);
    expect(first.acks()).toEqual([known, known]);
    runtime.openRegister = originalOpen;
    // Replay an old workshop's outbox after the Mac has returned to the Workshops window.
    first.link.updateWorkshop(null);
    first.deliver(unknown, 'missing-name');
    await until(() => first.acks().length === 3);
    expect(first.acks()).toEqual([known, known, unknown]);
    expect((await runtime.readRegister(workshop.id))?.conflicts).toMatchObject([{ participantId: 'missing-name', reason: 'unknown-nearby-name-late', count: 1 }]);
    first.link.stop();

    runtime = createFakeRuntime({ dataRoot });
    const second = spawnLink();
    second.allowRecord();
    second.deliver(known, second.nameId);
    second.deliver(unknown, 'missing-name');
    await until(() => second.acks().length === 2);
    expect(second.acks()).toEqual([known, unknown]);
    expect(second.link.view().checkins).toBe(0);
    expect((await runtime.readRegister(workshop.id))?.participants[0]?.version).toBe(1);
    expect((await runtime.readRegister(workshop.id))?.conflicts[0]?.count).toBe(1);
    second.link.stop();
  });

  test('restarts the helper once after an unexpected exit, then gives up quietly', async () => {
    const kids = [fakeChild(), fakeChild()]; let n = 0; const logs: string[] = [];
    const link = startNearbyLink({ ...noRecord, userData: tmp(), resourcesRoot: helperRoot(), env: {}, platform: 'darwin', appLog: (l) => logs.push(l), restartDelayMs: 5, spawnFn: () => kids[n++]!.c as unknown as ChildProcess });
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
    const link = startNearbyLink({ ...noRecord, userData: tmp(), resourcesRoot: helperRoot(), env: {}, platform: 'darwin', appLog: () => undefined, restartDelayMs: 5, spawnFn: () => { n++; return k.c as unknown as ChildProcess; } });
    link.stop(); k.c.emit('exit', 0, null);
    await new Promise((r) => setTimeout(r, 30));
    expect(n).toBe(1);
  });
});
