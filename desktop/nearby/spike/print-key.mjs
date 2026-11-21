// Prints the fixed spike key and a QR code in the terminal, so the iPad spike app can be paired with the Mac test build
// (ATTENDWELL_NEARBY_SPIKE=1). Run from the repository root:  node desktop/nearby/spike/print-key.mjs
// The QR carries {"v":1,"workshopId":...,"key":...}; the iPad spike app also accepts the bare key pasted.
// qrcode comes from desktop/node_modules (bun install in desktop/).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { v, workshopId, key } = JSON.parse(readFileSync(join(here, 'spike-key.json'), 'utf8'));
const QRCode = createRequire(join(here, '..', '..', 'package.json'))('qrcode');
const text = JSON.stringify({ v, workshopId, key });
console.log(`Spike key (a fixed test key, not a secret that protects anything):\n${key}\n\nQR text:\n${text}\n`);
console.log(await QRCode.toString(text, { type: 'terminal', small: true }));
