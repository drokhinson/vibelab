// Bake the SVG sources in /assets into the PNGs Expo needs.
//   icon.png            1024x1024 (iOS + generic Android)
//   adaptive-icon.png   1024x1024 (Android adaptive foreground, transparent bg)
//   splash.png          1242x1242 (Expo splash, contain)
//   favicon.png         64x64     (web)
//
// Run with:
//   cd projects/boardgame-buddy/app && npm i -D sharp && node scripts/generate-icons.mjs
//
// Sharp is a one-shot dev dependency so generation can be rerun whenever the
// SVG sources are tweaked. Generated PNGs are committed so EAS builds don't
// depend on contributors having sharp available.
//
// NOTE: the current PNGs are placeholder brand marks (a gold die on board-wood
// brown). Replace the SVG sources with polished art in the Phase 6 polish pass,
// add feature-graphic.svg (1024x500) for the Play Store, then rerun.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const assets = resolve(__dirname, '..', 'assets');

const targets = [
  { src: 'bgb-logo.svg', out: 'icon.png', width: 1024, height: 1024, fit: 'cover' },
  { src: 'adaptive-icon.svg', out: 'adaptive-icon.png', width: 1024, height: 1024, fit: 'contain', bg: { r: 0, g: 0, b: 0, alpha: 0 } },
  { src: 'splash.svg', out: 'splash.png', width: 1242, height: 1242, fit: 'cover' },
  { src: 'bgb-logo.svg', out: 'favicon.png', width: 64, height: 64, fit: 'cover' },
];

mkdirSync(assets, { recursive: true });

for (const t of targets) {
  const svg = readFileSync(resolve(assets, t.src));
  let pipe = sharp(svg, { density: 384 }).resize(t.width, t.height, {
    fit: t.fit,
    background: t.bg || { r: 0x2a, g: 0x18, b: 0x12, alpha: 1 },
  });
  const buf = await pipe.png({ compressionLevel: 9 }).toBuffer();
  writeFileSync(resolve(assets, t.out), buf);
  // eslint-disable-next-line no-console
  console.log(`✓ ${t.out} (${t.width}x${t.height})`);
}
