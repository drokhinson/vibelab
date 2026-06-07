// Dependency-free placeholder PNG generator (uses only node:zlib). Emits solid
// brand-colored PNGs so the app boots before the real art is baked via
// generate-icons.mjs (sharp). Run: node scripts/make-placeholders.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const assets = resolve(__dirname, '..', 'assets');
mkdirSync(assets, { recursive: true });

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
function solidPng(w, h, [r, g, b]) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) {
    row[1 + x * 3] = r;
    row[1 + x * 3 + 1] = g;
    row[1 + x * 3 + 2] = b;
  }
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  const idat = deflateSync(raw);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const DARK = [13, 13, 20]; // #0d0d14
const ACCENT = [201, 146, 42]; // #C9922A

const targets = [
  { out: 'icon.png', w: 1024, h: 1024, color: ACCENT },
  { out: 'adaptive-icon.png', w: 1024, h: 1024, color: ACCENT },
  { out: 'splash.png', w: 1284, h: 2778, color: DARK },
  { out: 'favicon.png', w: 64, h: 64, color: ACCENT },
  { out: 'feature-graphic.png', w: 1024, h: 500, color: DARK },
];

for (const t of targets) {
  writeFileSync(resolve(assets, t.out), solidPng(t.w, t.h, t.color));
  console.log(`✓ ${t.out} (${t.w}x${t.h})`);
}
