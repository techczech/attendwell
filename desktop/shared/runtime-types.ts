// The shapes the app uses from the headless runtime (desktop/runtime on its own branch). They mirror the runtime's
// README-runtime.md interface; the app depends on these, never on the runtime's files, so the two branches merge by
// pointing main/runtime-port.ts at the real createRuntime. Release 1: quick tunnel only.

export type WorkshopWhen = 'upcoming' | 'today' | 'past';

export interface WorkshopSummary {
  id: string;
  title: string;
  /** Local date, YYYY-MM-DD. */
  date: string;
  /** HH:MM. */
  startTime: string;
  endTime: string;
  archived: boolean;
  when: WorkshopWhen;
  /** People checked in, read from the register; null when unknown. */
  attended: number | null;
  /** People on the name list; null when no list has been added. The runtime's summary lacks it: the adapter reads it from provenance. */
  names: number | null;
}

export interface WorkshopListing {
  upcoming: WorkshopSummary[];
  today: WorkshopSummary[];
  past: WorkshopSummary[];
  archived: WorkshopSummary[];
}

export interface NewWorkshop {
  title: string;
  date: string;
  startTime?: string;
  endTime?: string;
}

export type TunnelFailureReason =
  | 'no-internet' | 'blocked-by-network' | 'cloudflared-missing' | 'port-in-use' | 'tunnel-refused' | 'stopped-unexpectedly';

export type TunnelState =
  | { state: 'off' }
  | { state: 'starting' }
  | { state: 'online'; url: string }
  | { state: 'reconnecting'; attempt: number; url: string | null }
  | { state: 'failed'; reason: TunnelFailureReason; message: string };

export type ServiceState =
  | { state: 'off' }
  | { state: 'starting' }
  | { state: 'running'; organiserUrl: string; participantPort: number; participantOrigin: string | null }
  | { state: 'restarting'; attempt: number }
  | { state: 'failed'; reason: string; message: string };

export interface RuntimeSnapshot {
  workshopId: string | null;
  session: 'idle' | 'starting' | 'running' | 'ending';
  service: ServiceState;
  tunnel: TunnelState;
}

export type ConnectionTest =
  | { ok: true }
  | { ok: false; reason: string; advice: string };

/** `endSession` result: whether nothing still runs or listens, and what does (plain words). */
export interface EndResult {
  clean: boolean;
  leftovers: string[];
}

/** A restarted quick tunnel has a new address: the register was restarted with it, and paired iPads must be paired again. */
export interface OriginChange {
  workshopId: string | null;
  previous: string | null;
  current: string | null;
}

/** Where a workshop's latest name list came from (the runtime's roster-provenance.json); `count` is the people on the list after it. */
export interface RosterProvenance {
  kind: 'paste' | 'spreadsheet' | 'booking-export';
  filename: string | null;
  sha256: string | null;
  importedAt: string;
  count: number;
}

/** The register service of one workshop, reachable on loopback for as long as the lease is held. */
export interface RegisterLease {
  organiserUrl: string;
  /** Stops the service if the lease started it; a no-op for a session's live service. */
  release(): Promise<void>;
}
