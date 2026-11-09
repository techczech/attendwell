// Spike only (branch spike/multipeer-nearby-link), behind ATTENDWELL_NEARBY_SPIKE=1, honoured only where the other test switches
// are (the ENV passed in comes from main/test-mode.ts, so a release build never sees it). Starts the bundled attendwell-nearby
// helper in mac role with the fixed spike key, feeds it a 500-name synthetic snapshot, and logs every stdout line to
// <userData>/nearby-spike.log. Check-ins are acknowledged but not recorded anywhere: this only proves the link and the permissions.
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import spike from '../nearby/spike/spike-key.json';

export function startNearbySpike(o: { env: NodeJS.ProcessEnv; userData: string; resourcesRoot: string }): { stop(): void } | null {
  if (o.env.ATTENDWELL_NEARBY_SPIKE !== '1' || process.platform !== 'darwin') return null;
  const logFile = join(o.userData, 'nearby-spike.log');
  const log = (line: string) => { try { appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`); } catch { /* the spike must never break the app */ } };
  const program = join(o.resourcesRoot, 'nearby', 'darwin-arm64', 'attendwell-nearby');
  const child: ChildProcess = spawn(program, ['--role', 'mac'], { stdio: ['pipe', 'pipe', 'pipe'] });
  log(`spawned ${program} pid ${child.pid}`);
  child.on('error', (e) => log(`spawn error: ${e.message}`));
  child.on('exit', (code, sig) => log(`helper exited code=${code} signal=${sig}`));
  child.stderr?.on('data', (d: Buffer) => log(`stderr: ${d.toString().trimEnd()}`));
  let buffer = '';
  child.stdout?.on('data', (d: Buffer) => {
    buffer += d.toString();
    let i: number;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
      log(line);
      try { const e = JSON.parse(line); if (e.type === 'checkin') child.stdin?.write(JSON.stringify({ type: 'ack', opIds: [e.opId] }) + '\n'); } catch { /* not JSON: logged above */ }
    }
  });
  // The key goes over stdin, never argv (visible in ps).
  child.stdin?.on('error', () => undefined);
  child.stdin?.write(JSON.stringify({ type: 'key', key: spike.key, workshopId: spike.workshopId }) + '\n');
  const names = Array.from({ length: 500 }, (_, i) => ({ id: `n${i}`, displayName: `Synthetic Person ${i}`, hidden: false }));
  child.stdin?.write(JSON.stringify({ type: 'snapshot', version: 1, workshopId: spike.workshopId, title: 'Nearby spike', open: true, names }) + '\n');
  // Closing stdin makes the helper stop and exit.
  return { stop: () => { try { child.stdin?.end(); } catch { /* already gone */ } } };
}
