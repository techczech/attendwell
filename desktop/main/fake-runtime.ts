// A stand-in for the headless runtime, for development and tests. It keeps one folder per workshop
// (workshop.json) under the registers folder, answers the same calls as the real runtime, and never opens a
// port, a process or a window. Names and attendance are fictional.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Roster } from '../shared/register-model.ts';
import type { ConnectionTest, EndResult, NewWorkshop, OriginChange, RegisterLease, RosterProvenance, RuntimeSnapshot, TunnelFailureReason, TunnelState, WorkshopListing, WorkshopSummary } from '../shared/runtime-types.ts';
import { folderName } from '../shared/workshops.ts';
import { FakeRegister } from './fake-organiser.ts';
import type { OrganiserFactory } from './organiser-client.ts';
import type { RuntimePort } from './runtime-port.ts';

export interface FakeRuntimeOptions {
  dataRoot: string;
  /** Today, for "today / upcoming / past". */
  now?: () => Date;
  /** What Test connection answers (default: passes). */
  connectionTest?: ConnectionTest;
  /** Names a new workshop starts with (fictional); null for none. Applied at create. */
  seed?: (input: { id: string; title: string; date: string }) => Roster | null;
  /** Milliseconds between "starting" and the tunnel answering (default 0). */
  startDelayMs?: number;
}

/** What a test (or the dev build) does to the fake: the tunnel, the address, the register behind it. */
export interface FakeControls {
  /** The register of a workshop (created empty if it has none yet). */
  register(id: string): FakeRegister;
  organiserFactory: OrganiserFactory;
  /** The next startSession finds this tunnel failure (then clears). */
  failNextTunnel(reason: TunnelFailureReason, message?: string): void;
  /** Moves a running session's tunnel to any state. */
  setTunnel(t: TunnelState): void;
  setService(s: RuntimeSnapshot['service']): void;
  /** A restarted quick tunnel: a new address, the register restarted with it, `participant-origin-changed` fired. */
  changeOrigin(): string;
  /** Number of sessions started so far. */
  starts(): number;
  /** The workshop the runtime has chosen. */
  current(): string | null;
  /** Register leases open now (workshop ids), for tests. */
  leases(): string[];
  /** The provenance recorded for a workshop. */
  provenance(id: string): RosterProvenance | null;
}

export type FakeRuntime = RuntimePort & { fake: FakeControls };

const ADDRESSES = ['quiet-river-1234', 'amber-field-5678', 'calm-harbour-9012', 'bright-lantern-3456'];
const address = (n: number): string => `https://${ADDRESSES[n % ADDRESSES.length]}.trycloudflare.com`;

const pad = (n: number): string => String(n).padStart(2, '0');
export const localDate = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

interface Stored { id: string; title: string; date: string; startTime: string; endTime: string; archived: boolean; attended: number | null; names: number | null }

export function createFakeRuntime(options: FakeRuntimeOptions): FakeRuntime {
  const now = options.now ?? (() => new Date());
  let root = options.dataRoot;
  let items = new Map<string, Stored>();
  let chosen: string | null = null;
  const listeners = new Set<(s: RuntimeSnapshot) => void>();
  const originListeners = new Set<(c: OriginChange) => void>();
  const registers = new Map<string, FakeRegister>();
  let addressN = 0;
  let starts = 0;
  let nextFailure: { reason: TunnelFailureReason; message: string } | null = null;
  // Register leases: a loopback address per lease, the workshop it opens.
  const leaseUrls = new Map<string, string>();
  let leaseN = 0;
  const provenanceOf = new Map<string, RosterProvenance>();
  const idle = (): RuntimeSnapshot => ({ workshopId: chosen, session: 'idle', service: { state: 'off' }, tunnel: { state: 'off' } });
  let snap: RuntimeSnapshot = idle();
  const publish = (next: RuntimeSnapshot): void => { snap = next; for (const l of [...listeners]) l(snap); };
  const currentUrl = (): string => address(addressN);
  const dirOf = (id: string): string => join(root, id);

  const load = (): void => {
    items = new Map();
    if (!existsSync(root)) return;
    for (const name of readdirSync(root, { withFileTypes: true })) {
      if (!name.isDirectory()) continue;
      const file = join(dirOf(name.name), 'workshop.json');
      if (!existsSync(file)) continue;
      try {
        const v = JSON.parse(readFileSync(file, 'utf8')) as Stored;
        if (typeof v.id === 'string' && typeof v.title === 'string' && typeof v.date === 'string') items.set(v.id, v);
      } catch { /* an unreadable folder is skipped, as the real library does */ }
    }
  };
  const save = (s: Stored): void => {
    mkdirSync(dirOf(s.id), { recursive: true });
    writeFileSync(join(dirOf(s.id), 'workshop.json'), JSON.stringify(s, null, 2) + '\n');
  };
  const registerFile = (id: string): string => join(dirOf(id), 'register.json');
  const registerFor = (id: string): FakeRegister => {
    let r = registers.get(id);
    if (r) return r;
    let roster: Roster | undefined;
    try { if (existsSync(registerFile(id))) roster = JSON.parse(readFileSync(registerFile(id), 'utf8')) as Roster; } catch { /* an unreadable register file starts empty */ }
    const now = options.now ?? (() => new Date());
    r = new FakeRegister({ now: () => now().getTime(), participantOrigin: currentUrl, eventName: items.get(id)?.title ?? 'Workshop', eventDate: items.get(id)?.date ?? '' }, roster);
    registers.set(id, r);
    return r;
  };
  const persist = (id: string): void => {
    const r = registers.get(id);
    const s = items.get(id);
    if (!r || !s) return;
    const roster = r.snapshot();
    mkdirSync(dirOf(id), { recursive: true });
    writeFileSync(registerFile(id), JSON.stringify(roster));
    s.attended = roster.participants.filter((p) => p.present).length;
    s.names = roster.participants.length;
    save(s);
  };
  load();

  const summarise = (s: Stored): WorkshopSummary => {
    const today = localDate(now());
    return {
      id: s.id, title: s.title, date: s.date, startTime: s.startTime, endTime: s.endTime, archived: s.archived,
      when: s.date === today ? 'today' : s.date > today ? 'upcoming' : 'past', attended: s.attended, names: s.names,
    };
  };

  return {
    workshops: {
      async list(opts) {
        const out: WorkshopListing = { upcoming: [], today: [], past: [], archived: [] };
        for (const s of items.values()) {
          const sum = summarise(s);
          if (s.archived) { if (opts?.includeArchived) out.archived.push(sum); continue; }
          out[sum.when].push(sum);
        }
        return out;
      },
      async create(input: NewWorkshop) {
        const title = input.title.trim();
        if (!title) throw new Error('A workshop needs a title.');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new Error('The date must be YYYY-MM-DD.');
        const base = folderName(input.date, title);
        let id = base;
        for (let n = 2; items.has(id); n += 1) id = `${base}-${n}`;
        const s: Stored = { id, title, date: input.date, startTime: input.startTime ?? '', endTime: input.endTime ?? '', archived: false, attended: null, names: null };
        items.set(id, s);
        save(s);
        const seeded = options.seed?.({ id, title, date: input.date }) ?? null;
        if (seeded) { const r = registerFor(id); r.people = seeded.participants.map((p) => ({ ...p })); r.conflicts = seeded.conflicts.map((c) => ({ ...c })); persist(id); }
        return summarise(s);
      },
      async setArchived(id, archived) {
        const s = items.get(id);
        if (!s) throw new Error('No such workshop.');
        s.archived = archived;
        save(s);
      },
    },
    async openWorkshop(id) {
      if (!items.has(id)) throw new Error('No such workshop.');
      if (snap.session !== 'idle' && snap.workshopId !== id) throw new Error('Another workshop is open for check-in. End it first.');
      chosen = id;
      if (snap.session === 'idle') publish(idle());
    },
    async startSession() {
      if (!chosen) throw new Error('Open a workshop first.');
      if (snap.session !== 'idle') throw new Error('Check-in is already open.');
      const id = chosen;
      starts += 1;
      addressN += 1;
      publish({ workshopId: id, session: 'starting', service: { state: 'starting' }, tunnel: { state: 'starting' } });
      if (options.startDelayMs) await new Promise((r) => setTimeout(r, options.startDelayMs));
      const url = currentUrl();
      const service = { state: 'running' as const, organiserUrl: 'http://127.0.0.1:1', participantPort: 1, participantOrigin: url };
      if (nextFailure) {
        const f = nextFailure; nextFailure = null;
        publish({ workshopId: id, session: 'running', service: { ...service, participantOrigin: null }, tunnel: { state: 'failed', reason: f.reason, message: f.message } });
      } else publish({ workshopId: id, session: 'running', service, tunnel: { state: 'online', url } });
      return snap;
    },
    async retryTunnel() {
      if (snap.session !== 'running') throw new Error('Check-in is not open.');
      addressN += 1;
      const url = currentUrl();
      publish({ ...snap, service: { state: 'running', organiserUrl: 'http://127.0.0.1:1', participantPort: 1, participantOrigin: url }, tunnel: { state: 'online', url } });
      return snap;
    },
    async endSession(): Promise<EndResult> {
      const id = snap.workshopId;
      if (snap.session === 'idle' || !id) return { clean: true, leftovers: [] };
      publish({ ...snap, session: 'ending' });
      persist(id);
      publish({ workshopId: id, session: 'idle', service: { state: 'off' }, tunnel: { state: 'off' } });
      return { clean: true, leftovers: [] };
    },
    async readRegister(id) {
      if (!items.has(id)) throw new Error('No such workshop.');
      return registers.has(id) || existsSync(registerFile(id)) ? registerFor(id).snapshot() : null;
    },
    async openRegister(id): Promise<RegisterLease> {
      if (!items.has(id)) throw new Error('No such workshop.');
      if (snap.workshopId === id && snap.session === 'running' && snap.service.state === 'running') {
        return { organiserUrl: snap.service.organiserUrl, release: async () => undefined };
      }
      leaseN += 1;
      const url = `http://127.0.0.1:${41000 + leaseN}`;
      leaseUrls.set(url, id);
      registerFor(id);
      let released = false;
      return { organiserUrl: url, release: async () => { if (released) return; released = true; leaseUrls.delete(url); persist(id); } };
    },
    async recordRosterProvenance(id, p) {
      const s = items.get(id);
      if (!s) throw new Error('No such workshop.');
      provenanceOf.set(id, { ...p });
      mkdirSync(dirOf(id), { recursive: true });
      writeFileSync(join(dirOf(id), 'roster-provenance.json'), JSON.stringify(p, null, 2) + '\n');
      s.names = p.count;
      save(s);
    },
    dataRoot: () => root,
    workshopFolder: (id) => dirOf(id),
    async setDataRoot(path) { root = path; chosen = null; registers.clear(); load(); snap = idle(); },
    status: {
      get: () => snap,
      onChange(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
      onOriginChanged(listener) { originListeners.add(listener); return () => { originListeners.delete(listener); }; },
    },
    async testConnection() {
      return options.connectionTest ?? { ok: true };
    },
    async shutdown() {
      if (snap.workshopId && snap.session !== 'idle') persist(snap.workshopId);
      listeners.clear(); originListeners.clear();
    },
    fake: {
      register: registerFor,
      organiserFactory: (url) => {
        const leased = leaseUrls.get(url);
        if (leased) return registerFor(leased);
        if (!snap.workshopId) throw new Error('No workshop is open.');
        return registerFor(snap.workshopId);
      },
      failNextTunnel(reason, message = 'The tunnel could not start.') { nextFailure = { reason, message }; },
      setTunnel(t) { publish({ ...snap, tunnel: t }); },
      setService(sv) { publish({ ...snap, service: sv }); },
      changeOrigin() {
        const previous = currentUrl();
        addressN += 1;
        const url = currentUrl();
        publish({ ...snap, service: { state: 'running', organiserUrl: 'http://127.0.0.1:1', participantPort: 1, participantOrigin: url }, tunnel: { state: 'online', url } });
        for (const l of [...originListeners]) l({ workshopId: snap.workshopId, previous, current: url });
        return url;
      },
      starts: () => starts,
      current: () => snap.workshopId,
      leases: () => [...leaseUrls.values()],
      provenance: (id) => provenanceOf.get(id) ?? null,
    },
  };
}
