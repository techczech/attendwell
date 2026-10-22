import { describe, expect, test } from 'bun:test';
import { CHAPTERS, getStartedButton, triedChapters } from '../shared/get-started.ts';

const base = { setupDone: true, exampleOpened: false, exampleRemoved: false, hiddenSetting: false };

describe('Get started button lifecycle', () => {
  test('Get started, then Remove example once the example is opened, then gone', () => {
    expect(getStartedButton(base)).toBe('get-started');
    expect(getStartedButton({ ...base, exampleOpened: true })).toBe('remove-example');
    expect(getStartedButton({ ...base, exampleOpened: true, exampleRemoved: true })).toBe('hidden');
  });
  test('hidden during first run and when Settings hides it', () => {
    expect(getStartedButton({ ...base, setupDone: false })).toBe('hidden');
    expect(getStartedButton({ ...base, hiddenSetting: true })).toBe('hidden');
    expect(getStartedButton({ ...base, exampleOpened: true, hiddenSetting: true })).toBe('hidden');
  });
});

describe('chapters', () => {
  test('six chapters, each tried when its command has run', () => {
    expect(CHAPTERS).toHaveLength(6);
    expect(triedChapters([])).toEqual([]);
    expect(triedChapters(['workshop.open', 'ipad.pair'])).toEqual(['open', 'pair']);
    expect(triedChapters(['held.keep-not-checked-in'])).toEqual(['held']);
  });
  test('every chapter command is a registered command', async () => {
    const { registry } = await import('../shared/commands.ts');
    for (const c of CHAPTERS) expect(registry.byId(c.command!), c.id).toBeDefined();
  });
});
