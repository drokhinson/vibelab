// Bake the SVG masters in assets/ to the PNGs app.json references. Requires
// sharp (dev-only): `npm i -D sharp && node scripts/generate-icons.mjs`.
// Commit the generated PNGs so EAS builds don't need sharp.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const assets = resolve(__dirname, '..', 'assets');

const targets = [
  { src: 'icon.svg', out: 'icon.png', width: 1024, height: 1024 },
  { src: 'adaptive-icon.svg', out: 'adaptive-icon.png', width: 1024, height: 1024 },
  { src: 'splash.svg', out: 'splash.png', width: 1284, height: 2778 },
  { src: 'favicon.svg', out: 'favicon.png', width: 64, height: 64 },
  { src: 'feature-graphic.svg', out: 'feature-graphic.png', width: 1024, height: 500 },
];

mkdirSync(assets, { recursive: true });
for (const t of targets) {
  const svg = readFileSync(resolve(assets, t.src));
  const buf = await sharp(svg, { density: 384 }).resize(t.width, t.height, { fit: 'cover' }).png({ compressionLevel: 9 }).toBuffer();
  writeFileSync(resolve(assets, t.out), buf);
  console.log(`✓ ${t.out} (${t.width}x${t.height})`);
}
