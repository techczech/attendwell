#!/usr/bin/env node
// Checks the built site/: internal links and #anchors resolve, every <img> has alt text, no {{placeholder}} survives, no external scripts or fonts.
// Usage: node scripts/check-site.mjs
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'site');
const walk = (dir) => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return n.startsWith('.') ? [] : statSync(p).isDirectory() ? walk(p) : [p]; });
const files = walk(ROOT);
const problems = [];
let checked = 0;
const idsCache = new Map();
const idsOf = (f) => {
  if (!idsCache.has(f)) idsCache.set(f, new Set([...readFileSync(f, 'utf8').matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])));
  return idsCache.get(f);
};

for (const file of files) {
  const rel = relative(ROOT, file);
  const ext = extname(file);
  if (!['.html', '.css', '.json'].includes(ext)) continue;
  const text = readFileSync(file, 'utf8');
  if (text.includes('{{')) problems.push(`${rel}: unresolved {{ placeholder`);
  if (ext !== '.html') continue;
  for (const m of text.matchAll(/<img\b[^>]*>/g)) if (!/\salt="/.test(m[0])) problems.push(`${rel}: <img> without alt: ${m[0].slice(0, 80)}`);
  if (/<script\b/i.test(text)) problems.push(`${rel}: contains a script`);
  for (const m of text.matchAll(/<link\b[^>]*>/g)) if (/href="https?:/.test(m[0])) problems.push(`${rel}: external <link>: ${m[0]}`);
  for (const [, attr, raw] of text.matchAll(/\s(href|src)="([^"]*)"/g)) {
    if (!raw || /^(https?:|mailto:)/.test(raw)) continue;
    checked++;
    const [path, hash] = raw.split('#');
    const target = path === '' ? file : join(dirname(file), decodeURIComponent(path));
    if (!existsSync(target) || statSync(target).isDirectory()) { problems.push(`${rel}: ${attr}="${raw}" does not resolve`); continue; }
    if (hash && extname(target) === '.html' && !idsOf(target).has(hash)) problems.push(`${rel}: ${attr}="${raw}" has no #${hash}`);
  }
}

if (problems.length) {
  console.error(`check-site: ${problems.length} problem(s) in ${checked} internal references`);
  for (const p of problems) console.error(`  x ${p}`);
  process.exit(1);
}
console.log(`check-site: OK, ${checked} internal references across ${files.filter((f) => f.endsWith('.html')).length} pages resolve, no placeholders left`);
