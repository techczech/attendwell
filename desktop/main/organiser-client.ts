// The organiser's side of the register service: the loopback-only API the laptop uses to mark people, add walk-ins, pair iPads and
// manage devices (server/http-attendance.ts, docs/reference-device-api.md). The window never talks to it; the main process does, through
// this one interface, so the screens are tested against a fake (fake-organiser.ts) and the real thing is tested against the real service.
import type { DeviceList } from '../shared/devices-model.ts';
import type { PairingOffer } from '../shared/pairing-model.ts';
import type { Roster, RosterConflict, RosterPerson } from '../shared/register-model.ts';
import type { AddNamesRequest, AddNamesResult, RecoveryReport } from '../shared/names-model.ts';

export class OrganiserError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export interface OrganiserClient {
  roster(): Promise<Roster>;
  setAttendance(id: string, present: boolean, version: number): Promise<Roster>;
  resolveConflict(id: string, action: 'check-in' | 'dismiss'): Promise<Roster>;
  addParticipant(name: string, email: string): Promise<Roster>;
  devices(): Promise<DeviceList>;
  createPairing(input: { label?: string; targetDeviceId?: string }): Promise<PairingOffer>;
  cancelPairing(sessionId: string): Promise<void>;
  renameDevice(id: string, label: string): Promise<DeviceList>;
  revokeDevice(id: string): Promise<DeviceList>;
  dismissHold(id: number): Promise<DeviceList>;
  /** A pasted or imported name list: `dryRun` previews (nothing written), otherwise adds (server/names-list.ts). */
  addNames(input: AddNamesRequest, dryRun: boolean): Promise<AddNamesResult>;
  /** An iPad's recovery file, through the same idempotent operations path as a live upload. */
  importRecovery(file: unknown, dryRun: boolean): Promise<RecoveryReport>;
}

/** Given the organiser address the runtime reports (`service.organiserUrl`), the client for it. */
export type OrganiserFactory = (organiserUrl: string) => OrganiserClient;

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Only an http address on this computer's loopback, with a port and nothing else, is ever called. */
export function loopbackOrigin(url: string): string {
  let u: URL;
  try { u = new URL(url); } catch { throw new OrganiserError('The register address is not valid.', 0); }
  if (u.protocol !== 'http:' || !LOOPBACK.has(u.hostname) || !u.port || u.username || u.password || (u.pathname !== '/' && u.pathname !== '')) {
    throw new OrganiserError('The register address is not on this computer.', 0);
  }
  return u.origin;
}

const asRoster = (v: unknown): Roster => {
  const o = v as { participants?: unknown[]; conflicts?: unknown[] };
  const participants: RosterPerson[] = (Array.isArray(o?.participants) ? o.participants : []).map((p) => {
    const r = p as Record<string, unknown>;
    return {
      id: String(r.id), name: String(r.name ?? ''), email: String(r.email ?? ''), booking: String(r.booking ?? 'confirmed'), present: r.present === true,
      admitted: r.admitted === true, version: Number(r.version ?? 0), updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : null,
    };
  });
  const conflicts: RosterConflict[] = (Array.isArray(o?.conflicts) ? o.conflicts : []).map((c) => {
    const r = c as Record<string, unknown>;
    return { participantId: String(r.participantId), name: String(r.name ?? ''), reason: String(r.reason ?? ''), queuedAt: typeof r.queuedAt === 'string' ? r.queuedAt : null, receivedAt: typeof r.receivedAt === 'string' ? r.receivedAt : null, count: Number(r.count ?? 1) };
  });
  return { participants, conflicts };
};

/**
 * `auth`: the register's organiser key, looked up on every call (a register restarted after a crash or a new tunnel address has a
 * new key). Sent only as the Authorization header to this loopback address; never logged, never in an error message.
 */
export function createHttpOrganiser(organiserUrl: string, fetchImpl: typeof fetch = fetch, timeoutMs = 8000, auth?: () => string | null): OrganiserClient {
  const origin = loopbackOrigin(organiserUrl);
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Origin: origin, 'X-Attendance-Request': '1' };
    if (auth) {
      const key = auth();
      if (!key) throw new OrganiserError('The register is not running. Check the connection panel, then try again.', 0);
      headers.Authorization = `Bearer ${key}`;
    }
    if (body !== undefined || method !== 'GET') headers['Content-Type'] = 'application/json';
    let res: Response;
    try {
      res = await fetchImpl(`${origin}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : method !== 'GET' ? { body: '{}' } : {}), signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    } catch {
      throw new OrganiserError('The register did not answer. Check the connection panel, then try again.', 0);
    }
    const text = await res.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* a non-JSON answer is an error below */ }
    if (!res.ok) throw new OrganiserError(typeof (json as { error?: unknown })?.error === 'string' ? (json as { error: string }).error : 'The register refused that change.', res.status);
    return json as T;
  }
  return {
    roster: async () => asRoster(await call('GET', '/api/roster')),
    setAttendance: async (id, present, version) => asRoster(await call('POST', '/api/attendance', { id, present, version, opId: `op-${crypto.randomUUID()}` })),
    resolveConflict: async (id, action) => asRoster(await call('POST', '/api/resolve-conflict', { id, action })),
    addParticipant: async (name, email) => asRoster(await call('POST', '/api/add-participant', { name, ...(email ? { email } : {}) })),
    devices: () => call<DeviceList>('GET', '/api/organiser/devices'),
    createPairing: (input) => call<PairingOffer>('POST', '/api/organiser/pairing-sessions', input),
    cancelPairing: async (sessionId) => { await call('DELETE', `/api/organiser/pairing-sessions/${encodeURIComponent(sessionId)}`); },
    renameDevice: (id, label) => call<DeviceList>('PATCH', `/api/organiser/devices/${encodeURIComponent(id)}`, { label }),
    revokeDevice: (id) => call<DeviceList>('POST', `/api/organiser/devices/${encodeURIComponent(id)}/revoke`),
    dismissHold: (id) => call<DeviceList>('POST', `/api/organiser/device-holds/${encodeURIComponent(String(id))}/dismiss`),
    addNames: async (input, dryRun) => {
      const r = await call<{ plan: AddNamesResult['plan']; written: boolean; roster: unknown }>('POST', '/api/names', { ...input, dryRun });
      return { plan: r.plan, written: r.written === true, roster: asRoster(r.roster) };
    },
    importRecovery: (file, dryRun) => call<RecoveryReport>('POST', '/api/organiser/recovery-import', { file, dryRun }),
  };
}
