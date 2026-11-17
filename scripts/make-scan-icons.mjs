// Draws the Tracklab Scan icon (scan-frame corners and a sweep line) and
// writes the PNGs. No image library needed: shapes are drawn from their
// distance fields (smooth edges) and encoded with Node's own zlib.
//
//   node scripts/make-scan-icons.mjs                 public/scan-icon-192.png, -512.png
//   node scripts/make-scan-icons.mjs <expo-assets>   also the Expo app's icon, adaptive-icon, splash-icon, favicon
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ORANGE = [255, 138, 0];
const INK = [11, 11, 15];

// The mark, in a 512 box. Stroke 44, round ends.
const W = 44, A = 70, B = 442, L = 120, R = 46;
const segments = [[150, 256, 362, 256]];
const arcs = [];
for (const [x, y, dx, dy] of [[A, A, 1, 1], [B, A, -1, 1], [A, B, 1, -1], [B, B, -1, -1]]) {
  segments.push([x, y + dy * L, x, y + dy * R], [x + dx * R, y, x + dx * L, y]);
  arcs.push([x + dx * R, y + dy * R, -dx, -dy]); // centre, and the quadrant the arc bends through
}
const segDist = (px, py, [ax, ay, bx, by]) => {
  const vx = bx - ax, vy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy)));
  return Math.hypot(px - ax - t * vx, py - ay - t * vy);
};
const arcDist = (px, py, [cx, cy, qx, qy]) => {
  const ox = px - cx, oy = py - cy;
  if (Math.sign(ox) !== qx && ox !== 0) return Infinity;
  if (Math.sign(oy) !== qy && oy !== 0) return Infinity;
  return Math.abs(Math.hypot(ox, oy) - R);
};
/** Coverage (0..1) of the mark at a point of the 512 box; `px` is one pixel in box units. */
function mark(x, y, px) {
  let d = Infinity;
  for (const s of segments) d = Math.min(d, segDist(x, y, s));
  for (const a of arcs) d = Math.min(d, arcDist(x, y, a));
  return Math.max(0, Math.min(1, (W / 2 - d) / px + 0.5));
}
/** Coverage of a rounded square (x, y, size, radius). */
function roundRect(x, y, rx, ry, w, r, px) {
  const cx = Math.max(rx + r, Math.min(rx + w - r, x)), cy = Math.max(ry + r, Math.min(ry + w - r, y));
  const d = Math.hypot(x - cx, y - cy) - r;
  return Math.max(0, Math.min(1, 0.5 - d / px));
}

/**
 * full:   orange square edge to edge, mark inside the maskable safe zone (home-screen icons)
 * fg:     transparent with the black mark (Android adaptive icon foreground)
 * splash: transparent with an orange rounded tile and the mark
 */
function draw(size, kind) {
  const px = 512 / size;
  const scale = kind === 'full' ? 0.72 : kind === 'fg' ? 0.62 : 0.56;
  const out = Buffer.alloc(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const x = (i + 0.5) * px, y = (j + 0.5) * px;
      let rgb = [0, 0, 0], alpha = 0;
      if (kind === 'full') {
        const shade = 0.10 - 0.20 * (y / 512); // a little lighter at the top, darker at the bottom
        rgb = ORANGE.map(c => (shade > 0 ? c + (255 - c) * shade : c * (1 + shade)));
        alpha = 1;
      } else if (kind === 'splash') {
        const t = roundRect(x, y, 56, 56, 400, 112, px);
        rgb = ORANGE; alpha = t;
      }
      const m = mark(256 + (x - 256) / scale, 256 + (y - 256) / scale, px / scale);
      if (m > 0) {
        const a = m + alpha * (1 - m);
        rgb = rgb.map((c, k) => (INK[k] * m + c * alpha * (1 - m)) / a);
        alpha = a;
      }
      const o = (j * size + i) * 4;
      out[o] = Math.round(rgb[0]); out[o + 1] = Math.round(rgb[1]); out[o + 2] = Math.round(rgb[2]); out[o + 3] = Math.round(alpha * 255);
    }
  }
  return png(size, out);
}

const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let j = 0; j < size; j++) rgba.copy(raw, j * (size * 4 + 1) + 1, j * size * 4, (j + 1) * size * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const files = [
  [join(root, 'public', 'scan-icon-192.png'), 192, 'full'],
  [join(root, 'public', 'scan-icon-512.png'), 512, 'full'],
];
const expo = process.argv[2];
if (expo) files.push(
  [join(expo, 'icon.png'), 1024, 'full'],
  [join(expo, 'adaptive-icon.png'), 1024, 'fg'],
  [join(expo, 'splash-icon.png'), 1024, 'splash'],
  [join(expo, 'favicon.png'), 48, 'full'],
);
for (const [file, size, kind] of files) {
  const data = draw(size, kind);
  writeFileSync(file, data);
  console.log(`${file}  ${size}px  ${data.length} bytes`);
}
