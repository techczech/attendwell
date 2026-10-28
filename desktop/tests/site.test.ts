// The website's update feed must pass the app's own parser, and the site build must leave no placeholder behind.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { validateFeed } from '@app-patterns/updates';
import { UPDATE_IDENTITY } from '../main/updates.ts';

const repo = resolve(import.meta.dir, '..', '..');
const read = (p: string) => readFileSync(join(repo, p), 'utf8');
const release = JSON.parse(read('site/release.json'));
const pkg = JSON.parse(read('desktop/package.json'));

describe('site/updates.json', () => {
  test('is accepted by the update parser against the app\'s own feed address', () => {
    const r = validateFeed(read('site/updates.json'), UPDATE_IDENTITY.feedUrl);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.latest.version).toBe(pkg.version);
  });
  test('announces the version in desktop/package.json and site/release.json', () => {
    expect(release.version).toBe(pkg.version);
    expect(release.macDmgUrl).toContain(`/v${pkg.version}/AttendWell-${pkg.version}-arm64.dmg`);
    expect(release.windowsExeUrl).toBeNull();
  });
});

describe('site build', () => {
  const buildPath = join(repo, 'scripts/build-site.mjs');
  test('resolves every placeholder and builds the same pages that are committed', async () => {
    const { build } = (await import(buildPath)) as { build: (r?: unknown) => Array<[string, string]> };
    const pages = build();
    expect(pages.map(([f]) => f)).toEqual(['index.html', 'privacy.html', 'support.html']);
    for (const [file, html] of pages) {
      expect(html, file).not.toContain('{{');
      expect(read(`site/${file}`), `${file} is stale: run node scripts/build-site.mjs`).toBe(html);
    }
  });
  test('the iPad item links the source and promises no App Store or TestFlight download', async () => {
    const { build } = (await import(buildPath)) as { build: (r: unknown) => Array<[string, string]> };
    const index = build(release)[0]![1];
    expect(index).toContain('href="https://github.com/techczech/attendwell/tree/main/ipad"');
    expect(index).toContain('no official download or TestFlight build');
    expect(index).not.toMatch(/Windows|Coming soon/);
  });
  test('the Mac pages claim notarisation only when release.json says so', async () => {
    const { build } = (await import(buildPath)) as { build: (r: unknown) => Array<[string, string]> };
    const text = (r: unknown) => build(r).map(([, h]) => h).join('\n');
    expect(release.macNotarised).toBe(false);
    expect(text(release)).not.toMatch(/signed and notarised/i);
    expect(text(release)).toContain('Open Anyway');
    expect(text({ ...release, macNotarised: true })).toContain('Signed and notarised.');
  });
});
