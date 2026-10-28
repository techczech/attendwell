// Builds site/index.html, privacy.html and support.html from the approved copy in site-copy/*.md and the one config file site/release.json.
// No dependencies. Run: node scripts/build-site.mjs   (the Pages workflow runs it before deploying site/).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const release = JSON.parse(readFileSync(join(root, 'site/release.json'), 'utf8'));

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** What the pages say about Apple's check on the Mac download; it follows release.json and never claims notarisation that has not happened. */
function macTrust(r) {
  return r.macNotarised
    ? { short: 'Signed and notarised.', support: 'The Mac app is signed and notarised and opens like any other downloaded app.' }
    : { short: 'Signed with a Developer ID, not yet notarised by Apple.',
        support: 'The Mac app is signed with a Developer ID but is not notarised by Apple, so macOS blocks it the first time you open it. Open System Settings, choose Privacy & Security, scroll to the message about AttendWell and choose Open Anyway.' };
}

/** Fills the placeholders from release.json. Exported for the tests. */
export function fillPlaceholders(md, r) {
  const contactLink = `[Open an issue on GitHub](${r.issuesUrl})`;
  let out = md;
  // Without an email address the "You can also write to" line has nothing to say; the issue link above it already covers it.
  if (!r.contactEmail) out = out.replace(/\n?You can also write to \{\{CONTACT_EMAIL\}\}\.\n?/g, '\n');
  const email = r.contactEmail ? `[${r.contactEmail}](mailto:${r.contactEmail})` : contactLink;
  return out
    .replaceAll('{{MAC_DMG_URL}}', r.macDmgUrl ?? '')
    .replaceAll('{{IPAD_SOURCE_URL}}', r.ipadSourceUrl ?? '')
    .replaceAll('{{MAC_TRUST}}', macTrust(r).short)
    .replaceAll('{{MAC_SUPPORT}}', macTrust(r).support)
    .replaceAll('{{CONTACT_EMAIL}}', email);
}

function inline(s) {
  const holds = [];
  const keep = (html) => `\u0000${holds.push(html) - 1}\u0000`;
  let t = s
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, url) => keep(`<a href="${esc(url)}">${inline(text)}</a>`))
    .replace(/<(https?:\/\/[^>\s]+)>/g, (_, url) => keep(`<a href="${esc(url)}">${esc(url)}</a>`));
  t = esc(t).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => holds[Number(i)]);
}

/** The small subset of markdown the copy uses: headings, paragraphs, bullet and numbered lists, links, bold. */
export function markdownToHtml(md) {
  const lines = md.split('\n');
  const out = [];
  let para = [];
  let list = null;
  const flushPara = () => { if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`); para = []; };
  const flushList = () => { if (list) out.push(`<${list.tag}>\n${list.items.map((i) => `<li>${inline(i)}</li>`).join('\n')}\n</${list.tag}>`); list = null; };
  for (const line of lines) {
    let m;
    if ((m = line.match(/^(#{1,3}) (.+)$/))) {
      flushPara(); flushList();
      const n = m[1].length;
      out.push(`<h${n} id="${slug(m[2])}">${inline(m[2])}</h${n}>`);
    } else if ((m = line.match(/^- (.+)$/)) || (m = line.match(/^\d+\. (.+)$/))) {
      flushPara();
      const tag = /^-/.test(line) ? 'ul' : 'ol';
      if (list && list.tag !== tag) flushList();
      list ??= { tag, items: [] };
      list.items.push(m[1]);
    } else if (line.trim() === '') {
      flushPara(); flushList();
    } else {
      flushList(); para.push(line.trim());
    }
  }
  flushPara(); flushList();
  return out.join('\n');
}

function parseCopy(file) {
  const text = readFileSync(join(root, 'site-copy', file), 'utf8');
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error(`${file}: no front matter`);
  const meta = Object.fromEntries(m[1].split('\n').map((l) => { const i = l.indexOf(':'); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
  return { meta, body: m[2] };
}

const nav = [['index.html', 'Home'], ['support.html', 'Support'], ['privacy.html', 'Privacy']];

export function page({ file, meta, content, r }) {
  const links = nav.map(([href, label]) => `<a href="${href}"${href === file ? ' aria-current="page"' : ''}>${label}</a>`).join('\n      ')
    + `\n      <a href="${esc(r.sourceUrl)}">Source on GitHub</a>`;
  const hero = file === 'index.html'
    ? `\n    <img class="hero-icon" src="icon-256.png" width="128" height="128" alt="The AttendWell app icon">` : '';
  return `<!doctype html>
<html lang="en-GB">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(meta.title)}</title>
  <meta name="description" content="${esc(meta.description)}">
  <link rel="icon" type="image/png" href="favicon.png">
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <a class="skip" href="#main">Skip to the content</a>
  <header class="site-header">
    <a class="brand" href="index.html"><img src="favicon.png" width="32" height="32" alt="">AttendWell</a>
    <nav aria-label="Main">
      ${links}
    </nav>
  </header>
  <main id="main">${hero}
${content}
  </main>
  <footer class="site-footer">
    <p>AttendWell is free and open source under the MIT licence. <a href="${esc(r.sourceUrl)}">Source on GitHub</a>.</p>
    <p>Made by Dominik Lukeš.</p>
  </footer>
</body>
</html>
`;
}

export function build(r = release) {
  const pages = [];
  for (const [file, copy] of [['index.html', 'index.md'], ['privacy.html', 'privacy.md'], ['support.html', 'support.md']]) {
    const { meta, body } = parseCopy(copy);
    pages.push([file, page({ file, meta, content: markdownToHtml(fillPlaceholders(body, r)), r })]);
  }
  return pages;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const [file, html] of build()) writeFileSync(join(root, 'site', file), html);
  console.log('build-site: wrote index.html, privacy.html, support.html');
}
