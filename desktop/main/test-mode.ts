// The one place that decides whether the ATTENDWELL_* test switches (ATTENDWELL_TEST, _RUNTIME, _USER_DATA, _REGISTERS, _SEED_NAMES,
// the test file-picker answers) are honoured. They are honoured in development (not packaged) and in a package built as a test build
// (package.json "attendwellTestBuild": true, set by `bun run dist:mac:test`). A release build ignores them all: they are removed from
// the environment the app reads, so launching the installed app with them set changes nothing.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface TestModeInput {
  isPackaged: boolean;
  /** package.json's "attendwellTestBuild" marker. */
  testBuild: boolean;
}

export const testSwitchesAllowed = (i: TestModeInput): boolean => !i.isPackaged || i.testBuild;

/** The environment the app reads: the real one when switches are allowed, otherwise with every ATTENDWELL_* variable removed. */
export function effectiveEnv(i: TestModeInput, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (testSwitchesAllowed(i)) return env;
  return Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith('ATTENDWELL_')));
}

/** Reads the build marker from the package.json beside the app code (inside the asar when packaged). */
export function readTestBuildMarker(appPath: string): boolean {
  try { return JSON.parse(readFileSync(join(appPath, 'package.json'), 'utf8')).attendwellTestBuild === true; } catch { return false; }
}
