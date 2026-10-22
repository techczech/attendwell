// The seam between the Electron app and the headless runtime. The app calls only this; the real runtime
// (desktop/runtime/createRuntime, adapted in real-runtime.ts) and the fake one in fake-runtime.ts both satisfy it.
import type { Roster } from '../shared/register-model.ts';
import type { ConnectionTest, EndResult, NewWorkshop, OriginChange, RegisterLease, RosterProvenance, RuntimeSnapshot, WorkshopListing, WorkshopSummary } from '../shared/runtime-types.ts';

export interface RuntimePort {
  workshops: {
    list(opts?: { includeArchived?: boolean }): Promise<WorkshopListing>;
    create(input: NewWorkshop): Promise<WorkshopSummary>;
    setArchived(id: string, archived: boolean): Promise<void>;
  };
  /** Chooses the workshop the next session runs (no session starts in the frame). Rejects while another workshop's session runs. */
  openWorkshop(id: string): Promise<void>;
  /** Gateway, tunnel, then the register, for the chosen workshop. Resolves with the snapshot; a tunnel failure leaves the register running and is in the snapshot. */
  startSession(): Promise<RuntimeSnapshot>;
  /** Tries the tunnel again without stopping the register. */
  retryTunnel(): Promise<RuntimeSnapshot>;
  /** Closes the public address and stops the register (the register's file stays); then checks that nothing still runs. */
  endSession(): Promise<EndResult>;
  /**
   * The register of any workshop, read-only, with the register service stopped (closed and past sessions, and the list before the session
   * starts). The real adapter opens `<workshopFolder>/db/attendance.sqlite` read-only (node:sqlite) and maps people and open held
   * check-ins to Roster; null when the workshop has no register yet.
   */
  readRegister(id: string): Promise<Roster | null>;
  /**
   * The register service of one workshop on this computer's loopback only, so names can be added and iPad recovery files imported
   * before Start check-in and after End: the same service and the same write path as a live session, with no gateway, no tunnel and
   * the participant window left as it is. While that workshop's check-in runs, the lease is the live service and `release` does
   * nothing. The adapter starts the service with the workshop's service.json (prepareService) and stops it on release; it must stop a
   * leased service before `startSession` for the same workshop (or reuse it), so two services never open one register.
   */
  openRegister(id: string): Promise<RegisterLease>;
  /** Records where the latest name list came from (workshops.recordRosterProvenance); the library's "N names" reads `count` back. */
  recordRosterProvenance(id: string, provenance: RosterProvenance): Promise<void>;
  /** The folder that holds one folder per workshop; the adapter owns where it is. */
  dataRoot(): string;
  /** The folder one workshop lives in (the real runtime keeps it at <dataRoot>/workshops/<id>). */
  workshopFolder(id: string): string;
  /** Moves the library to another registers folder (Settings > Workshops, first run). */
  setDataRoot(path: string): Promise<void>;
  status: {
    get(): RuntimeSnapshot;
    /** Returns an unsubscribe function. */
    onChange(listener: (snapshot: RuntimeSnapshot) => void): () => void;
    /** The runtime's `participant-origin-changed` event. */
    onOriginChanged(listener: (change: OriginChange) => void): () => void;
  };
  /** Settings > Connection > Test connection. Absent in the real runtime until it grows the call: the app then shows "not available yet". */
  testConnection?(): Promise<ConnectionTest>;
  shutdown(): Promise<void>;
}

/**
 * The real runtime is `createRuntime({dataRoot, resourcesRoot, settings:{tunnel:{mode:'quick'}}})` adapted to RuntimePort in
 * real-runtime.ts (list adds `names` from each workshop's roster provenance count); runtime-factory.ts chooses it or the fake.
 */
export type RuntimeFactory = (opts: { dataRoot: string }) => RuntimePort;
