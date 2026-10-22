// The paired iPads as the window shows them: Kiosk wording and figures (lock notes), the "pair again" rule after a new address,
// and held check-ins that matched nobody. Pure. Input is the organiser API's device list (docs/reference-device-api.md).
import { clockOf } from './register-model.ts';

export interface DeviceRecord {
  id: string;
  label: string;
  status: 'active' | 'revoked';
  pairedAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  appVersion: string | null;
  protocolVersion: number | null;
  reportedPending: number | null;
  reportedHeld: number | null;
  oldestPendingAt: string | null;
  reportedAt: string | null;
  checkInsReceived: number;
  needsReview: number;
  unmatchedCheckIns: number;
}

export interface DeviceHold {
  id: number;
  opId: string;
  deviceId: string | null;
  deviceLabel: string | null;
  reason: string;
  recordedAt: string | null;
  receivedAt: string | null;
}

export interface PairingInfo {
  sessionId: string;
  label: string;
  targetDeviceId: string | null;
  expiresAt: string;
  state: 'waiting' | 'paused' | 'expired';
  wrongAttempts: number;
  pausedUntil: string | null;
}

export interface DeviceList {
  eventId: string;
  eventCode: string;
  eventName: string;
  eventDate: string;
  serverTime: string;
  pairing: PairingInfo | null;
  devices: DeviceRecord[];
  unmatchedCheckIns: DeviceHold[];
  adjustedText: Array<{ participantId: string | null; original: string; shownAs: string }>;
}

/** The iPad is called Connected while it has been heard from in the last minute and a half (it reports about every 30 seconds). */
export const CONNECTED_MS = 90_000;

export type DeviceTone = 'good' | 'warn' | 'bad' | 'neutral';

export function agoText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h`;
}

export interface DeviceRow {
  id: string;
  label: string;
  tone: DeviceTone;
  /** "Connected · Last seen 5 s ago", "Not seen for 6 min", "Revoked 09:41", … */
  statusText: string;
  icon: 'dot' | 'ban' | 'hourglass' | 'download';
  /** "3", "—" when the iPad has not reported. */
  unsent: string;
  /** Shown as "(last reported)" after the figure: the iPad is revoked or not connected right now (not seen for a while, check-in closed, or needs an update), so the figure is only its last report. */
  unsentStale: boolean;
  needsReview: string;
  appVersion: string;
  revoked: boolean;
  /** The row's own Pair again button is offered (revoked, or the address changed and it has not been seen since). */
  pairAgainButton: boolean;
  needsRepair: boolean;
  /** Pending check-ins the iPad holds (for the confirmation and the banner). */
  pending: number;
}

export interface DeviceContext {
  now: number;
  /** The check-in address is open (a session is running). When false the rows show the state at close. */
  live: boolean;
  /** When check-in closed (ISO), for "Check-in closed 16:31". */
  closedAt: string | null;
  /** Ids of devices that must be paired again (see repairTargets). */
  repair: ReadonlySet<string>;
}

const t = (iso: string | null): number | null => { if (!iso) return null; const n = new Date(iso).getTime(); return Number.isNaN(n) ? null : n; };
const figure = (n: number | null): string => (n === null ? '—' : String(n));

export function deviceRow(d: DeviceRecord, c: DeviceContext): DeviceRow {
  const seen = t(d.lastSeenAt);
  const needsRepair = c.live && d.status === 'active' && c.repair.has(d.id);
  const base = {
    id: d.id, label: d.label, unsent: figure(d.reportedPending), unsentStale: d.status === 'revoked' && d.reportedPending !== null,
    needsReview: String(d.needsReview), appVersion: d.appVersion ?? '—', revoked: d.status === 'revoked', needsRepair, pending: d.reportedPending ?? 0,
  };
  if (d.status === 'revoked') return { ...base, tone: 'bad', icon: 'ban', statusText: `Revoked ${clockOf(d.revokedAt) ?? ''}`.trim(), pairAgainButton: c.live };
  if (d.protocolVersion !== null && d.protocolVersion !== 1) return { ...base, unsentStale: d.reportedPending !== null, tone: 'warn', icon: 'download', statusText: 'Update needed', pairAgainButton: false };
  if (seen === null) return { ...base, tone: 'neutral', icon: 'hourglass', statusText: 'Paired – waiting for first contact', pairAgainButton: needsRepair };
  if (!c.live) return { ...base, unsentStale: d.reportedPending !== null, tone: 'neutral', icon: 'dot', statusText: `Check-in closed ${clockOf(c.closedAt) ?? ''}`.trim(), pairAgainButton: false };
  const age = c.now - seen;
  if (!needsRepair && age <= CONNECTED_MS) return { ...base, tone: 'good', icon: 'dot', statusText: `Connected · Last seen ${agoText(age)} ago`, pairAgainButton: false };
  const text = needsRepair || (d.reportedPending ?? 0) > 0 ? `Not seen for ${agoText(age)}` : `Last seen ${agoText(age)} ago`;
  return { ...base, unsentStale: d.reportedPending !== null, tone: 'warn', icon: 'dot', statusText: text, pairAgainButton: needsRepair };
}

/**
 * Devices that need pairing again: active ones not heard from since this check-in address began. The address is new at every start
 * (quick tunnel), and after a restart the register's origin changed, so an iPad paired earlier cannot reach it until it is paired again.
 */
export function repairTargets(devices: DeviceRecord[], addressSince: string | null): DeviceRecord[] {
  const since = t(addressSince);
  if (since === null) return [];
  return devices.filter((d) => d.status === 'active' && (t(d.lastSeenAt) ?? t(d.pairedAt) ?? 0) < since && (t(d.pairedAt) ?? 0) < since);
}

export interface RepairBanner {
  /** "Door iPad needs pairing again." */
  title: string;
  /** "AttendWell has a new check-in address since it restarted at 14:04. Door iPad has 3 check-ins saved; they arrive once it is paired again." */
  body: string;
  button: string;
  /** Exactly one iPad needs it: ⇧⌘N targets it. */
  targetId: string | null;
  ids: string[];
}

export function repairBanner(targets: DeviceRecord[], addressSince: string | null): RepairBanner | null {
  if (targets.length === 0) return null;
  const since = clockOf(addressSince);
  const when = since ? ` since it restarted at ${since}` : '';
  if (targets.length === 1) {
    const d = targets[0]!;
    const n = d.reportedPending ?? 0;
    const saved = n > 0 ? ` ${d.label} has ${n} check-in${n === 1 ? '' : 's'} saved; they arrive once it is paired again.` : '';
    return { title: `${d.label} needs pairing again.`, body: `AttendWell has a new check-in address${when}.${saved}`, button: `Pair ${d.label} again`, targetId: d.id, ids: [d.id] };
  }
  const total = targets.reduce((n, d) => n + (d.reportedPending ?? 0), 0);
  const saved = total > 0 ? ` They have ${total} check-ins saved; they arrive once each is paired again.` : '';
  return { title: `${targets.length} iPads need pairing again.`, body: `AttendWell has a new check-in address${when}.${saved}`, button: 'Pair an iPad', targetId: null, ids: targets.map((d) => d.id) };
}

/** The confirmation for Revoke, in the Kiosk wording. */
export function revokeText(d: DeviceRecord): { title: string; body: string } {
  const n = d.reportedPending ?? 0;
  const held = n > 0 ? ` It reported ${n} check-in${n === 1 ? '' : 's'} that haven't arrived. They stay on the iPad; pair it again to receive them.` : '';
  return { title: `Revoke ${d.label}?`, body: `It will stop sending check-ins.${held}` };
}

export const HOLD_TEXT: Record<string, string> = {
  unknown_person: 'An iPad sent a check-in for someone who is not in this register.',
  invalid: 'An iPad sent a check-in this register could not use.',
};
export const holdText = (reason: string): string => HOLD_TEXT[reason] ?? 'An iPad sent a check-in this register could not use.';
