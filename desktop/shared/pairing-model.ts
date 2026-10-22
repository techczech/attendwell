// The pairing sheet's state machine (Kiosk laptop states: issuing, active, paired, expired, locked, error), as a pure reducer.
// The organiser API owns the truth: a code lives five minutes; every fifth wrong code pauses the open pairing (30 s, 60, 120, 240) and
// nothing locks for good (docs/reference-device-api.md, "Pairing"); a spent code makes the pairing disappear and the device appear.
import type { DeviceList, DeviceRecord, PairingInfo } from './devices-model.ts';

export interface PairingOffer {
  sessionId: string;
  label: string;
  targetDeviceId: string | null;
  /** XXXX-XXXX */
  shortCode: string;
  /** {participantOrigin}/pair#v=1&code=XXXX-XXXX */
  qrPayload: string;
  baseUrl: string;
  expiresAt: string;
  serverTime: string;
  eventCode: string;
}

export type PairingState =
  | { phase: 'idle' }
  | { phase: 'issuing'; label: string; targetDeviceId: string | null }
  | { phase: 'open'; offer: PairingOffer; skewMs: number; issuedAt: number; info: PairingInfo | null; gone: boolean }
  | { phase: 'paired'; offer: PairingOffer; device: { id: string; label: string }; repaired: boolean }
  | { phase: 'error'; message: string; label: string; targetDeviceId: string | null };

export type PairingEvent =
  | { type: 'request'; label: string; targetDeviceId: string | null }
  | { type: 'issued'; offer: PairingOffer; now: number }
  | { type: 'failed'; message: string }
  | { type: 'poll'; list: DeviceList; now: number }
  | { type: 'close' };

export const IDLE: PairingState = { phase: 'idle' };

const ms = (iso: string | null | undefined): number | null => { if (!iso) return null; const n = new Date(iso).getTime(); return Number.isNaN(n) ? null : n; };

/** Which device a spent code produced: the targeted row, or the newest active one paired since the code was shown. */
function pairedDevice(devices: DeviceRecord[], offer: PairingOffer, since: number): DeviceRecord | null {
  const fresh = devices.filter((d) => d.status === 'active' && (ms(d.pairedAt) ?? 0) >= since);
  if (offer.targetDeviceId) return fresh.find((d) => d.id === offer.targetDeviceId) ?? null;
  return fresh.sort((a, b) => (ms(b.pairedAt) ?? 0) - (ms(a.pairedAt) ?? 0))[0] ?? null;
}

export function reduce(state: PairingState, e: PairingEvent): PairingState {
  switch (e.type) {
    case 'request': return { phase: 'issuing', label: e.label, targetDeviceId: e.targetDeviceId };
    case 'failed': return { phase: 'error', message: e.message, label: state.phase === 'issuing' ? state.label : '', targetDeviceId: state.phase === 'issuing' ? state.targetDeviceId : null };
    case 'close': return IDLE;
    case 'issued': {
      // Server time may differ from this clock; the countdown uses the server's clock, moved by the difference seen now.
      const server = ms(e.offer.serverTime);
      return { phase: 'open', offer: e.offer, skewMs: server === null ? 0 : server - e.now, issuedAt: server ?? e.now, info: null, gone: false };
    }
    case 'poll': {
      if (state.phase !== 'open') return state;
      const mine = e.list.pairing?.sessionId === state.offer.sessionId ? e.list.pairing : null;
      if (mine) return { ...state, info: mine, gone: false };
      const device = pairedDevice(e.list.devices, state.offer, state.issuedAt - 1000);
      if (device) return { phase: 'paired', offer: state.offer, device: { id: device.id, label: device.label }, repaired: state.offer.targetDeviceId !== null };
      return { ...state, info: null, gone: true };
    }
  }
}

export type PairingKind = 'issuing' | 'waiting' | 'paused' | 'expired' | 'paired' | 'error';

export interface PairingView {
  kind: PairingKind;
  /** Stepper: 1 Name this iPad (done), 2 Scan the code, 3 Paired. */
  step: 2 | 3;
  label: string;
  /** Pair again for one row: the name is fixed and step 2 reads differently. */
  repair: boolean;
  qrPayload: string | null;
  shortCode: string | null;
  baseUrl: string | null;
  eventCode: string | null;
  /** Milliseconds until the code expires; 0 once it has. */
  remainingMs: number;
  /** "4:12" */
  countdown: string;
  /** Milliseconds the pairing stays paused. */
  pausedMs: number;
  wrongAttempts: number;
  message: string | null;
  device: { id: string; label: string } | null;
}

export const clock = (msLeft: number): string => {
  const s = Math.max(0, Math.ceil(msLeft / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const NONE: Omit<PairingView, 'kind' | 'step' | 'label' | 'repair'> = {
  qrPayload: null, shortCode: null, baseUrl: null, eventCode: null, remainingMs: 0, countdown: '0:00', pausedMs: 0, wrongAttempts: 0, message: null, device: null,
};

export function pairingView(s: PairingState, now: number): PairingView | null {
  switch (s.phase) {
    case 'idle': return null;
    case 'issuing': return { ...NONE, kind: 'issuing', step: 2, label: s.label, repair: s.targetDeviceId !== null };
    case 'error': return { ...NONE, kind: 'error', step: 2, label: s.label, repair: s.targetDeviceId !== null, message: s.message };
    case 'paired': return { ...NONE, kind: 'paired', step: 3, label: s.device.label, repair: s.repaired, device: s.device, qrPayload: null, shortCode: null };
    case 'open': {
      const serverNow = now + s.skewMs;
      const expires = ms(s.info?.expiresAt ?? s.offer.expiresAt) ?? 0;
      const remainingMs = Math.max(0, expires - serverNow);
      const pausedUntil = ms(s.info?.pausedUntil);
      const pausedMs = pausedUntil === null ? 0 : Math.max(0, pausedUntil - serverNow);
      const kind: PairingKind = remainingMs === 0 || s.gone || s.info?.state === 'expired' ? 'expired' : pausedMs > 0 || s.info?.state === 'paused' ? 'paused' : 'waiting';
      return {
        kind, step: 2, label: s.offer.label, repair: s.offer.targetDeviceId !== null, qrPayload: s.offer.qrPayload, shortCode: s.offer.shortCode, baseUrl: s.offer.baseUrl,
        eventCode: s.offer.eventCode, remainingMs, countdown: clock(remainingMs), pausedMs, wrongAttempts: s.info?.wrongAttempts ?? 0, message: null, device: null,
      };
    }
  }
}

/** The sheet's heading under the stepper, in the Kiosk wording. */
export function pairingMessage(v: PairingView): string {
  switch (v.kind) {
    case 'issuing': return 'Creating a pairing code…';
    case 'waiting': return `This code pairs one iPad and expires in ${v.countdown}.`;
    case 'paused': return `Too many wrong codes. This code is paused for ${clock(v.pausedMs)}; then it works again. Or show a new code.`;
    case 'expired': return 'This code has expired.';
    case 'error': return v.message ?? "Couldn't create a pairing code.";
    case 'paired': return v.repair
      ? `${v.label} is paired again.`
      : `${v.label} is paired. It will appear as Connected once it has the names list.`;
  }
}

/** Step 2 of the instructions: a paired iPad reaches Pair again through Organiser and its PIN. */
export const PAIR_STEPS = (repair: boolean): string[] => [
  'Open the Check-in app on the iPad.',
  repair ? 'Tap "Organiser", enter the PIN, then tap "Pair again".' : 'Tap "Scan pairing code".',
  'Point the camera at this code.',
];
