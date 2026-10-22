import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { effectiveEnv, readTestBuildMarker, testSwitchesAllowed } from '../main/test-mode.ts';
import { usesRealRuntime } from '../main/runtime-factory.ts';

const env = { ATTENDWELL_TEST: '1', ATTENDWELL_RUNTIME: 'fake', ATTENDWELL_USER_DATA: '/x', ATTENDWELL_REGISTERS: '/y', HOME: '/h' };

describe('test switches', () => {
  test('a packaged release build ignores every ATTENDWELL_ variable and runs the real runtime', () => {
    expect(testSwitchesAllowed({ isPackaged: true, testBuild: false })).toBe(false);
    const e = effectiveEnv({ isPackaged: true, testBuild: false }, env);
    expect(Object.keys(e)).toEqual(['HOME']);
    expect(e.ATTENDWELL_TEST).toBeUndefined();
    expect(usesRealRuntime(e)).toBe(true);
  });
  test('development keeps them', () => {
    expect(testSwitchesAllowed({ isPackaged: false, testBuild: false })).toBe(true);
    expect(effectiveEnv({ isPackaged: false, testBuild: false }, env)).toBe(env);
  });
  test('a packaged test build keeps them', () => {
    expect(effectiveEnv({ isPackaged: true, testBuild: true }, env).ATTENDWELL_TEST).toBe('1');
  });
  test('the marker is read from package.json; a missing or plain package.json means a release build', () => {
    const d = mkdtempSync(join(tmpdir(), 'aw-tm-'));
    try {
      expect(readTestBuildMarker(d)).toBe(false);
      writeFileSync(join(d, 'package.json'), '{"version":"1"}');
      expect(readTestBuildMarker(d)).toBe(false);
      writeFileSync(join(d, 'package.json'), '{"attendwellTestBuild":true}');
      expect(readTestBuildMarker(d)).toBe(true);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});
