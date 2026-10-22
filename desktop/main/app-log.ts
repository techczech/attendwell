// The app's diagnostic log: logs/attendwell.log in the app's data folder (macOS: ~/Library/Application Support/AttendWell/logs).
// It holds what the next diagnosis needs: every line the register and cloudflared print, the check-in's state changes in plain words
// (starting, online at an address, failed and why, closed), and what the organiser's actions answered when they failed.
// It never holds a secret: the organiser key is never given to it (main/real-runtime.ts), pairing codes are never written by the
// callers, and anything shaped like a bearer key or a pairing code in a line is replaced before it is written (redactLine).
// The folder is private (0700) and the file is created 0600, never through a link. When the file passes `maxBytes` it moves to
// attendwell.1.log (replacing the previous one) and a new file starts. Logging never throws: a log that cannot be written goes quiet.
import { closeSync, constants, fstatSync, fchmodSync, mkdirSync, openSync, renameSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { RuntimeSnapshot } from '../shared/runtime-types.ts';

export interface AppLog {
  /** The log file (for the report a diagnosis starts from). */
  readonly file: string;
  /** Writes one line, stamped with the time. */
  write(line: string): void;
  close(): void;
}

export interface AppLogOptions {
  /** Default 1 MB. */
  maxBytes?: number;
  now?: () => Date;
}

const MAX_LINE = 2000;

/** One line as it is written: no line breaks or control characters, no bearer key, no pairing code, capped in length. */
export function redactLine(line: string): string {
  return line
    .replace(/[\r\n]+/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1<hidden>')
    .replace(/([?#&]code=)[^&\s"']+/gi, '$1<hidden>')
    .replace(/\b[A-Z2-9]{4}-[A-Z2-9]{4}\b/g, '<code>')
    .slice(0, MAX_LINE);
}

export function openAppLog(dataDir: string, opts: AppLogOptions = {}): AppLog {
  const dir = join(dataDir, 'logs');
  const file = join(dir, 'attendwell.log');
  const maxBytes = opts.maxBytes ?? 1_000_000;
  const now = opts.now ?? (() => new Date());
  let fd: number | null = null;
  let size = 0;
  let broken = false;

  const open = (): void => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // O_NOFOLLOW: a link planted at the log's name is refused, not followed (it is 0 on Windows, where links need admin rights).
    fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error('The log is not a file.');
    if (process.platform !== 'win32') fchmodSync(fd, 0o600);
    size = st.size;
  };
  const rotate = (): void => {
    if (fd !== null) { closeSync(fd); fd = null; }
    renameSync(file, join(dir, 'attendwell.1.log'));
    open();
  };

  return {
    file,
    write(line: string): void {
      if (broken) return;
      try {
        if (fd === null) open();
        if (size >= maxBytes) rotate();
        const text = `${now().toISOString()} ${redactLine(line)}\n`;
        size += writeSync(fd!, text);
      } catch {
        broken = true;
        try { if (fd !== null) closeSync(fd); } catch { /* already closed */ }
        fd = null;
      }
    },
    close(): void {
      if (fd !== null) { try { closeSync(fd); } catch { /* already closed */ } fd = null; }
    },
  };
}

/**
 * Turns the runtime's snapshots into plain-words lines for the log, one per change that matters: check-in starting, open, closing and
 * closed; the tunnel starting, online (with its address), reconnecting, failed (with the reason the organiser sees); the register
 * starting, running, restarting, failed (with its message). Repeated snapshots that change none of these write nothing.
 */
export function runtimeChangeLogger(write: (line: string) => void): (s: RuntimeSnapshot) => void {
  let last = { session: 'idle', tunnel: 'off', service: 'off' };
  return (s) => {
    const w = s.workshopId ? ` (workshop ${s.workshopId})` : '';
    const t = s.tunnel;
    const sv = s.service;
    const now = {
      session: s.session,
      tunnel: t.state === 'online' ? `online ${t.url}` : t.state === 'failed' ? `failed ${t.reason}` : t.state === 'reconnecting' ? `reconnecting ${t.attempt}` : t.state,
      service: sv.state === 'failed' ? `failed ${sv.reason}` : sv.state === 'restarting' ? `restarting ${sv.attempt}` : sv.state === 'running' ? `running ${sv.participantOrigin !== null}` : sv.state,
    };
    if (now.session !== last.session) {
      write(`${{ idle: 'Check-in closed', starting: 'Check-in starting', running: 'Check-in started', ending: 'Check-in closing' }[s.session]}${w}.`);
    }
    if (now.tunnel !== last.tunnel) {
      if (t.state === 'online') write(`Tunnel online at ${t.url}.`);
      else if (t.state === 'failed') write(`Tunnel failed (${t.reason}): ${t.message}`);
      else if (t.state === 'reconnecting') write(`Tunnel reconnecting, attempt ${t.attempt}.`);
      else if (t.state === 'starting') write('Tunnel starting.');
      else write('Tunnel off.');
    }
    if (now.service !== last.service) {
      if (sv.state === 'running') write(`Register running${sv.participantOrigin ? ' with the check-in address' : ' on this computer only (no check-in address)'}.`);
      else if (sv.state === 'failed') write(`Register failed (${sv.reason}): ${sv.message}`);
      else if (sv.state === 'restarting') write(`Register restarting, attempt ${sv.attempt}.`);
      else if (sv.state === 'starting') write('Register starting.');
      else write('Register stopped.');
    }
    last = now;
  };
}
