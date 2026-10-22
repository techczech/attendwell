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
    expect(release.windowsExeUrl).toContain(`/v${pkg.version}/AttendWell-${pkg.version}-setup.exe`);
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
  test('without a Store address the iPad item has no link; with one it does', async () => {
    const { build } = (await import(buildPath)) as { build: (r: unknown) => Array<[string, string]> };
    const index = (r: unknown) => build(r)[0]![1];
    expect(index(release)).toContain('Coming soon to the App Store');
    const withStore = index({ ...release, appStoreUrl: 'https://apps.apple.com/app/id1' });
    expect(withStore).toContain('href="https://apps.apple.com/app/id1"');
    expect(withStore).not.toContain('Coming soon');
  });
});
