/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: agpl
 */

// Generate the toolbar icon set as PNGs, with no image dependency.
//
// Two reasons this is code rather than checked-in art. Chrome will not accept an
// SVG in `action.default_icon` or `icons` (Firefox will), so bitmaps are mandatory;
// and the icon carries *state* — the same mark in two tints — which is exactly the
// kind of thing that rots when maintained as eight hand-exported files.
//
// The rasteriser is deliberately tiny: filled polygons and discs, 4x supersampled,
// which is all a stroked "W" on a rounded square needs. No anti-aliasing subtleties
// beyond the box filter, because at 16px nothing finer survives anyway.
//
// Usage: node tools/make-icons.mjs <out-dir>

import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const outDir = process.argv[2];
if (!outDir) {
  console.error('usage: make-icons.mjs <out-dir>');
  process.exit(2);
}

const SIZES = [16, 32, 48, 128];

// `on` is the options page accent; `off` is a neutral the browser's own greyed
// affordances sit next to without clashing. Disconnected is a badge, not a third
// icon: two independent facts on one 16px square is one too many.
const STATES = {
  on: { bg: [11, 92, 173, 255], fg: [255, 255, 255, 255] },
  off: { bg: [126, 126, 126, 255], fg: [255, 255, 255, 235] },
};

// Unit-square geometry, scaled per size. The W is a polyline stroked with round
// joins; the strokes are wide because thin ones vanish at 16px.
const W_POINTS = [
  [0.2, 0.29],
  [0.355, 0.73],
  [0.5, 0.45],
  [0.645, 0.73],
  [0.8, 0.29],
];
const W_WIDTH = 0.115;
const RADIUS = 0.22;
const SS = 4; // supersample factor

// ------------------------------------------------------------------ rasteriser

function createCanvas(size) {
  return { size, data: new Uint8Array(size * size * 4) };
}

/** Source-over composite of one colour over the accumulated buffer. */
function blend(canvas, x, y, [r, g, b, a], coverage) {
  const alpha = (a / 255) * coverage;
  if (alpha <= 0) return;
  const i = (y * canvas.size + x) * 4;
  const dst = canvas.data;
  const da = dst[i + 3] / 255;
  const out = alpha + da * (1 - alpha);
  if (out <= 0) return;
  for (let c = 0; c < 3; c += 1) {
    const src = [r, g, b][c];
    dst[i + c] = Math.round((src * alpha + dst[i + c] * da * (1 - alpha)) / out);
  }
  dst[i + 3] = Math.round(out * 255);
}

/**
 * Fill everything the `inside` predicate accepts, sampled SSxSS per pixel.
 *
 * A predicate rather than a scanline polygon fill: the shapes here are unions of
 * convex primitives, and a union of predicates is trivially correct where a union
 * of polygons needs a real boolean op.
 */
function fill(canvas, colour, inside) {
  const { size } = canvas;
  const step = 1 / (size * SS);
  const half = step / 2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const ux = (x * SS + sx) * step + half;
          const uy = (y * SS + sy) * step + half;
          if (inside(ux, uy)) hits += 1;
        }
      }
      if (hits > 0) blend(canvas, x, y, colour, hits / (SS * SS));
    }
  }
}

/** Rounded square inset from the edges, in unit coordinates. */
function roundedSquare(inset, radius) {
  const lo = inset;
  const hi = 1 - inset;
  return (x, y) => {
    if (x < lo || x > hi || y < lo || y > hi) return false;
    const cx = Math.min(Math.max(x, lo + radius), hi - radius);
    const cy = Math.min(Math.max(y, lo + radius), hi - radius);
    const dx = x - cx;
    const dy = y - cy;
    return dx * dx + dy * dy <= radius * radius;
  };
}

/** Distance from a point to a segment; the stroke is its sublevel set. */
function segmentDistance(px, py, [ax, ay], [bx, by]) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const len = vx * vx + vy * vy;
  const t = len === 0 ? 0 : Math.min(1, Math.max(0, (wx * vx + wy * vy) / len));
  const dx = wx - t * vx;
  const dy = wy - t * vy;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Polyline stroked with round caps and joins — free, given the distance form. */
function polyline(points, width) {
  const r = width / 2;
  return (x, y) => {
    for (let i = 0; i < points.length - 1; i += 1) {
      if (segmentDistance(x, y, points[i], points[i + 1]) <= r) return true;
    }
    return false;
  };
}

// ------------------------------------------------------------------ png writer

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, body) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

function encodePng(canvas) {
  const { size, data } = canvas;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  // 10..12: deflate, adaptive filtering, no interlace — all zero.

  // Filter type 0 on every scanline. The images are tiny; a filter search would
  // save bytes nobody is counting.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    Buffer.from(data.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ----------------------------------------------------------------------- build

await mkdir(outDir, { recursive: true });

const written = [];
for (const [state, colours] of Object.entries(STATES)) {
  for (const size of SIZES) {
    const canvas = createCanvas(size);
    // A hairline inset keeps the rounded corners from being clipped flat by the
    // pixel grid at 16px.
    fill(canvas, colours.bg, roundedSquare(0.03, RADIUS));
    fill(canvas, colours.fg, polyline(W_POINTS, W_WIDTH));
    const path = join(outDir, `${state}-${size}.png`);
    await writeFile(path, encodePng(canvas));
    written.push(path);
  }
}

console.log(`  generated ${written.length} icons -> ${outDir}`);
