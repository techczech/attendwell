// Builds the app icon set in desktop/build/ from the master drawing (src/assets/app-icon.svg): icon.png (1024), icons/<size>.png,
// icon.icns (macOS) and icon.ico (Windows). The two container files are written here directly (PNG data inside), so the script
// runs on any system and gives the same bytes every time.
// Run: bun run icons
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const svg = readFileSync(resolve(root, '../src/assets/app-icon.svg'), 'utf8');
const out = join(root, 'build');
mkdirSync(join(out, 'icons'), { recursive: true });

export function renderPng(size: number): Buffer {
  return Buffer.from(new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng());
}

/** An .icns file: 'icns', total length, then (type, length, PNG data) entries. */
export function icns(entries: Array<{ type: string; png: Buffer }>): Buffer {
  const body = Buffer.concat(entries.map((e) => {
    const head = Buffer.alloc(8);
    head.write(e.type, 0, 4, 'ascii');
    head.writeUInt32BE(8 + e.png.length, 4);
    return Buffer.concat([head, e.png]);
  }));
  const head = Buffer.alloc(8);
  head.write('icns', 0, 4, 'ascii');
  head.writeUInt32BE(8 + body.length, 4);
  return Buffer.concat([head, body]);
}

/** An .ico file with PNG-encoded images (Windows Vista and later). A 256 pixel image is written as 0. */
export function ico(images: Array<{ size: number; png: Buffer }>): Buffer {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const dir = images.map((i) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(i.size >= 256 ? 0 : i.size, 0);
    e.writeUInt8(i.size >= 256 ? 0 : i.size, 1);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(i.png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += i.png.length;
    return e;
  });
  return Buffer.concat([head, ...dir, ...images.map((i) => i.png)]);
}

if (import.meta.main) {
  const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
  const png = new Map(sizes.map((s) => [s, renderPng(s)]));
  for (const s of sizes) writeFileSync(join(out, 'icons', `${s}x${s}.png`), png.get(s)!);
  writeFileSync(join(out, 'icon.png'), png.get(1024)!);
  writeFileSync(join(out, 'icon.icns'), icns([
    { type: 'icp4', png: png.get(16)! }, { type: 'icp5', png: png.get(32)! }, { type: 'icp6', png: png.get(64)! },
    { type: 'ic07', png: png.get(128)! }, { type: 'ic08', png: png.get(256)! }, { type: 'ic09', png: png.get(512)! }, { type: 'ic10', png: png.get(1024)! },
  ]));
  writeFileSync(join(out, 'icon.ico'), ico([16, 24, 32, 48, 64, 128, 256].map((s) => ({ size: s, png: png.get(s)! }))));
  console.log('Wrote', join(out, 'icon.icns'), join(out, 'icon.ico'), join(out, 'icon.png'), 'and icons/*.png');
}
