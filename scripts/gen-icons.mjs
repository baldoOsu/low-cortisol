// Draws the dev/prod toolbar icons (anti-aliased circles on transparency) with a tiny pure-Node PNG encoder.
// Deterministic output. Usage: node scripts/gen-icons.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'extension', 'static', 'icons');
const SIZES = [16, 48, 128];

// Radii are fractions of the icon's half-size.
const STYLES = {
  // Calm teal disc with a lighter inner disc.
  prod: { outer: '#2a9d8f', inner: '#a8dadc', layers: [[0.94, 'outer'], [0.5, 'inner']] },
  // Amber disc with a thick pale inner ring.
  dev: { outer: '#e9a23b', inner: '#fff3d6', layers: [[0.94, 'outer'], [0.62, 'inner'], [0.34, 'outer']] },
};

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** RGBA pixels (Uint8Array, width*height*4) → PNG bytes, filter 0 on every row. */
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

function hexRgb(hex) {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

/** Coverage of a disc of radius r (centre of the icon) over the pixel at (px, py), 4x4 supersampled. */
function coverage(px, py, half, r) {
  const n = 4;
  let hit = 0;
  for (let sy = 0; sy < n; sy++) {
    for (let sx = 0; sx < n; sx++) {
      const dx = px + (sx + 0.5) / n - half;
      const dy = py + (sy + 0.5) / n - half;
      if (dx * dx + dy * dy <= r * r) hit++;
    }
  }
  return hit / (n * n);
}

function drawIcon(flavor, size) {
  const style = STYLES[flavor];
  const half = size / 2;
  const rgba = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Composite the layers (largest first) with "over"; premultiplied accumulation.
      let r = 0, g = 0, b = 0, a = 0;
      for (const [frac, colourKey] of style.layers) {
        const cov = coverage(x, y, half, frac * half);
        if (cov === 0) continue;
        const [cr, cg, cb] = hexRgb(style[colourKey]);
        r = cr * cov + r * (1 - cov);
        g = cg * cov + g * (1 - cov);
        b = cb * cov + b * (1 - cov);
        a = cov + a * (1 - cov);
      }
      const i = (y * size + x) * 4;
      rgba[i] = a ? Math.round(r / a) : 0;
      rgba[i + 1] = a ? Math.round(g / a) : 0;
      rgba[i + 2] = a ? Math.round(b / a) : 0;
      rgba[i + 3] = Math.round(a * 255);
    }
  }
  return encodePng(size, size, rgba);
}

mkdirSync(outDir, { recursive: true });
for (const flavor of Object.keys(STYLES)) {
  for (const size of SIZES) {
    const file = join(outDir, `${flavor}-${size}.png`);
    writeFileSync(file, drawIcon(flavor, size));
    console.log(`wrote ${file}`);
  }
}
