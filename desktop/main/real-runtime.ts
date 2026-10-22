// The real runtime (desktop/runtime, createRuntime) behind the app's RuntimePort. The app keeps its own shapes (shared/runtime-types.ts);
// this module maps between them, reads registers read-only for closed sessions, and gives the organiser client the register's per-start
// key. The key never leaves the main process: it is not in any snapshot, log line or IPC answer.
import path from 'node:path';
import { createRuntime, type Runtime, type RuntimeOptions, type RuntimeSnapshot as RtSnapshot, type WorkshopSummary as RtSummary } from '../runtime/index.ts';
import type { OriginChange, RegisterLease, RuntimeSnapshot, WorkshopListing, WorkshopSummary } from '../shared/runtime-types.ts';
import { createHttpOrganiser, type OrganiserFactory } from './organiser-client.ts';
import { readRegisterFile, type ReadOnlyOpener } from './register-reader.ts';
import type { RuntimePort } from './runtime-port.ts';

export interface RealRuntimeOptions {
  dataRoot: string;
  /** Packaged: process.resourcesPath. Development: desktop/resources. */
  resourcesRoot: string;
  /** Test seam: builds the runtime (default createRuntime with the quick tunnel). */
  create?: (o: Pick<RuntimeOptions, 'dataRoot' | 'resourcesRoot' | 'settings'>) => Runtime;
  /** Test seam: how a register is opened read-only (default node:sqlite). */
  openDb?: ReadOnlyOpener;
  fetchImpl?: typeof fetch;
  /** Lines from the register and cloudflared (never the organiser key; quick tunnels carry no credential). */
  log?: (line: string) => void;
}

export type RealRuntime = RuntimePort & {
  organiserFactory: OrganiserFactory;
  childPids(): { service: number | null; tunnel: number | null; lease: number | null };
  /** What the last shutdown left running, in plain words (empty when clean). */
  lastShutdown(): string[];
};

/** The runtime's snapshot in the app's shape. Failure details (the register's last output lines) and orphan notes stay in the main process. */
export function toAppSnapshot(s: RtSnapshot): RuntimeSnapshot {
  const sv = s.service;
  const service: RuntimeSnapshot['service'] =
    sv.state === 'running' ? { state: 'running', organiserUrl: sv.organiserUrl, participantPort: sv.participant && 'port' in sv.participant ? sv.participant.port : 0, participantOrigin: sv.participantOrigin }
      : sv.state === 'failed' ? { state: 'failed', reason: sv.reason, message: sv.message }
        : sv.state === 'restarting' ? { state: 'restarting', attempt: sv.attempt }
          : { state: sv.state };
  return { workshopId: s.workshopId, session: s.session, service, tunnel: { ...s.tunnel } as RuntimeSnapshot['tunnel'] };
}

export function createRealRuntime(opts: RealRuntimeOptions): RealRuntime {
  const make = opts.create ?? ((o) => createRuntime({ ...o, ...(opts.log ? { log: opts.log } : {}) }));
  let root = path.resolve(opts.dataRoot);
  let rt: Runtime = make({ dataRoot: root, resourcesRoot: opts.resourcesRoot, settings: { tunnel: { mode: 'quick' } } });
  const changeListeners = new Set<(s: RuntimeSnapshot) => void>();
  const originListeners = new Set<(c: OriginChange) => void>();
  let shutdownReport: string[] = [];

  // Listeners live here, so they survive a move of the library (a new runtime).
  const wire = (r: Runtime): void => {
    r.status.on('change', (s: RtSnapshot) => { if (r !== rt) return; const snap = toAppSnapshot(s); for (const l of [...changeListeners]) l(snap); });
    r.status.on('participant-origin-changed', (c: { workshopId: string; previous: string; current: string }) => {
      if (r !== rt) return;
      for (const l of [...originListeners]) l({ workshopId: c.workshopId, previous: c.previous, current: c.current });
    });
  };
  wire(rt);

  const summaryOf = (s: RtSummary): WorkshopSummary => {
    let names: number | null = null;
    try { names = rt.workshops.get(s.id).provenance?.count ?? null; } catch { /* an unreadable provenance file leaves the count unknown */ }
    return { id: s.id, title: s.title, date: s.date, startTime: s.startTime, endTime: s.endTime, archived: s.archived, when: s.when, attended: s.attended, names };
  };
  const listing = (includeArchived: boolean): WorkshopListing => {
    const l = rt.workshops.list({ includeArchived });
    return { upcoming: l.upcoming.map(summaryOf), today: l.today.map(summaryOf), past: l.past.map(summaryOf), archived: includeArchived ? l.archived.map(summaryOf) : [] };
  };

  const organiserFactory: OrganiserFactory = (organiserUrl) => {
    const owner = rt;
    // The key is looked up on every call, from the runtime that owns the register at this address.
    return createHttpOrganiser(organiserUrl, opts.fetchImpl ?? fetch, 8000, () => (owner === rt ? owner.organiserAuth(organiserUrl) : null));
  };

  const port: RealRuntime = {
    workshops: {
      async list(o) { return listing(o?.includeArchived === true); },
      async create(input) {
        const title = input.title.trim();
        if (!title) throw new Error('A workshop needs a title.');
        const rec = rt.workshops.create({ title, date: input.date, ...(input.startTime ? { startTime: input.startTime } : {}), ...(input.endTime ? { endTime: input.endTime } : {}) });
        const all = listing(true);
        const found = [...all.today, ...all.upcoming, ...all.past, ...all.archived].find((w) => w.id === rec.id);
        if (!found) throw new Error('The workshop was created but could not be read back.');
        return found;
      },
      async setArchived(id, archived) { rt.workshops.setArchived(id, archived); },
    },
    async openWorkshop(id) { rt.openWorkshop(id); },
    async startSession() { return toAppSnapshot(await rt.startSession()); },
    async retryTunnel() { return toAppSnapshot(await rt.retryTunnel()); },
    async endSession() { const r = await rt.endSession(); return { clean: r.clean, leftovers: [...r.leftovers] }; },
    async readRegister(id) {
      // get() checks the workshop folder, its db folder and the register files (links, containment, privacy) before anything is opened.
      const rec = rt.workshops.get(id);
      return readRegisterFile(rec.paths.database, opts.openDb);
    },
    async openRegister(id): Promise<RegisterLease> {
      const owner = rt;
      const info = await owner.openRegister(id);
      let released = false;
      return {
        organiserUrl: info.organiserUrl,
        release: async () => {
          if (released || info.live) return;
          released = true;
          await owner.releaseRegister(info.leaseId);
        },
      };
    },
    async recordRosterProvenance(id, p) {
      rt.workshops.recordRosterProvenance(id, { kind: p.kind, filename: p.filename, sha256: p.sha256, importedAt: p.importedAt, count: p.count });
    },
    dataRoot: () => root,
    workshopFolder: (id) => path.join(root, 'workshops', id),
    async setDataRoot(next) {
      const resolved = path.resolve(next);
      if (resolved === root) return;
      if (rt.status.get().session !== 'idle') throw new Error('End check-in before moving the registers folder.');
      const old = rt;
      // The old runtime is finished either way (shutdown refuses new work); anything it could not stop is kept for diagnostics.
      shutdownReport = [...(await old.shutdown()).leftovers];
      root = resolved;
      rt = make({ dataRoot: root, resourcesRoot: opts.resourcesRoot, settings: { tunnel: { mode: 'quick' } } });
      wire(rt);
      const snap = toAppSnapshot(rt.status.get());
      for (const l of [...changeListeners]) l(snap);
    },
    status: {
      get: () => toAppSnapshot(rt.status.get()),
      onChange(listener) { changeListeners.add(listener); return () => { changeListeners.delete(listener); }; },
      onOriginChanged(listener) { originListeners.add(listener); return () => { originListeners.delete(listener); }; },
    },
    async shutdown() {
      const r = await rt.shutdown();
      shutdownReport = [...r.leftovers];
      changeListeners.clear(); originListeners.clear();
    },
    organiserFactory,
    childPids: () => rt.childPids(),
    lastShutdown: () => [...shutdownReport],
  };
  return port;
}
