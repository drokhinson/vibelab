// Bake the SVG sources in /assets into the PNGs Expo needs.
//   icon.png            1024x1024 (iOS + generic Android)
//   adaptive-icon.png   1024x1024 (Android adaptive foreground)
//   splash.png          1284x2778 (Expo splash)
//   favicon.png         64x64     (web)
//
// Run with:
//   cd projects/sauceboss/app && npm i -D sharp && node scripts/generate-icons.mjs
//
// Sharp is added as a one-shot dev dependency so the generation can be
// rerun whenever icon.svg / splash.svg get tweaked. Generated PNGs are
// committed so EAS builds don't depend on contributors having sharp
// available.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const assets = resolve(__dirname, '..', 'assets');

const targets = [
  { src: 'icon.svg',          out: 'icon.png',          width: 1024, height: 1024 },
  { src: 'adaptive-icon.svg', out: 'adaptive-icon.png', width: 1024, height: 1024 },
  { src: 'splash.svg',        out: 'splash.png',        width: 1284, height: 2778 },
  { src: 'favicon.svg',       out: 'favicon.png',       width: 64,   height: 64   },
];

mkdirSync(assets, { recursive: true });

for (const t of targets) {
  const svg = readFileSync(resolve(assets, t.src));
  const buf = await sharp(svg, { density: 384 })
    .resize(t.width, t.height, { fit: 'cover' })
    .png({ compressionLevel: 9 })
    .toBuffer();
  writeFileSync(resolve(assets, t.out), buf);
  console.log(`✓ ${t.out} (${t.width}x${t.height})`);
}
