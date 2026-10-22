// Where the runtime comes from: the one switch. The app runs the real runtime (desktop/runtime, adapted in real-runtime.ts) with the
// organiser client for the address it reports (organiser-client.ts, carrying the register's per-start key). Test mode
// (ATTENDWELL_TEST=1) runs the fake, which never opens a port, a process or a window, unless ATTENDWELL_RUNTIME=real asks for the real one
// (the hidden live smoke check, e2e/live-smoke.mjs).
import { createFakeRuntime, type FakeControls } from './fake-runtime.ts';
import { fictionalNames } from './fictional-names.ts';
import type { OrganiserFactory } from './organiser-client.ts';
import { createRealRuntime, type RealRuntime } from './real-runtime.ts';
import type { RuntimeFactory, RuntimePort } from './runtime-port.ts';

export const createRuntimePort: RuntimeFactory = ({ dataRoot }) => createFakeRuntime({ dataRoot, seed: ({ title }) => (title === 'Example workshop' ? fictionalNames() : null) });

export interface RuntimeBundle {
  port: RuntimePort;
  organiser: OrganiserFactory;
  /** Only the fake has controls; the dev screenshot script and tests drive it. */
  fake?: FakeControls;
  /** Only the real runtime: its own children's process IDs, and what the last shutdown left running. */
  real?: Pick<RealRuntime, 'childPids' | 'lastShutdown'>;
}

export interface RuntimeBundleOptions {
  dataRoot: string;
  /** Packaged: process.resourcesPath; development: desktop/resources. Needed by the real runtime only. */
  resourcesRoot?: string;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}

/** True when the app runs the real runtime: always outside test mode; in test mode only when ATTENDWELL_RUNTIME=real. */
export const usesRealRuntime = (env: NodeJS.ProcessEnv = process.env): boolean => env.ATTENDWELL_TEST !== '1' || env.ATTENDWELL_RUNTIME === 'real';

export function createRuntimeBundle(opts: RuntimeBundleOptions): RuntimeBundle {
  const env = opts.env ?? process.env;
  if (usesRealRuntime(env)) {
    if (!opts.resourcesRoot) throw new Error('The real runtime needs the resources folder.');
    const rt = createRealRuntime({ dataRoot: opts.dataRoot, resourcesRoot: opts.resourcesRoot, ...(opts.log ? { log: opts.log } : {}) });
    return { port: rt, organiser: rt.organiserFactory, real: { childPids: rt.childPids, lastShutdown: rt.lastShutdown } };
  }
  const test = env.ATTENDWELL_TEST === '1';
  // Dev aid for the screenshot script: every new workshop starts with fictional names when ATTENDWELL_SEED_NAMES=1 (test mode only).
  const seedAll = test && env.ATTENDWELL_SEED_NAMES === '1';
  const rt = createFakeRuntime({
    dataRoot: opts.dataRoot, startDelayMs: test ? 0 : 500,
    seed: ({ title }) => (title === 'Example workshop' ? fictionalNames() : seedAll ? fictionalNames(undefined, false) : null),
  });
  return { port: rt, organiser: rt.fake.organiserFactory, fake: rt.fake };
}
