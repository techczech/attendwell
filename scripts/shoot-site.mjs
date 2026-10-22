// Full-page screenshots of the built site at desktop and phone width, hidden (headless shell), into site/.review-shots/ (gitignored).
// Usage: node scripts/shoot-site.mjs <path to chrome-headless-shell>
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = createRequire(join(root, 'desktop', 'package.json'))('playwright-core');
const out = join(root, 'site', '.review-shots');
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.argv[2], headless: true });
for (const [label, width, height] of [['desktop', 1280, 900], ['phone', 390, 844]]) {
  const page = await browser.newPage({ viewport: { width, height } });
  for (const name of ['index', 'support', 'privacy']) {
    await page.goto(pathToFileURL(join(root, 'site', `${name}.html`)).href);
    await page.screenshot({ path: join(out, `${name}-${label}.png`), fullPage: true });
    console.log('shot', `${name}-${label}.png`);
  }
}
await browser.close();
