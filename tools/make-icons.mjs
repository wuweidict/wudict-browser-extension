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
// The rasteriser is deliberately tiny: stroked polylines, rings and rounded squares,
// 4x supersampled. No anti-aliasing subtleties beyond the box filter, because at 16px
// nothing finer survives anyway.
//
// The mark is wudict's own, ported from the server's favicon.svg (identical to
// pages/docs/assets/logo.svg) rather than invented here: same geometry, same tile
// colour, so the toolbar button and the page it opens are visibly one product. The
// SVG's 32-unit viewBox maps to this file's unit square by /32. Keep them in step —
// a divergence is only visible to a user with both open, which is every user.
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

// `on` is the server's tile colour (#4c6680); `off` is the same hue with the colour
// drained out of it rather than an unrelated grey, so the two states are one mark in
// two moods. The white stroke clears 5.97:1 on `on` and 3.63:1 on `off` at its 235
// alpha — over the 3:1 a non-text mark owes, and separated by a 1.5x luminance step,
// which is what makes them tellable apart at 16px and to a colourblind eye alike.
// Disconnected is a badge, not a third icon: two independent facts on one 16px square
// is one too many.
const STATES = {
  on: { bg: [76, 102, 128, 255], fg: [255, 255, 255, 255] },
  off: { bg: [125, 128, 133, 255], fg: [255, 255, 255, 235] },
};

// The mark, in unit coordinates = favicon.svg's 32-unit values / 32.
//
//   <path d="M4 7h13M4 13h8" stroke-width="2"/>          two text lines
//   <circle cx="20" cy="18" r="5" stroke-width="2"/>     lens
//   <path d="M24 22 27.5 25.5" stroke-width="3"/>        handle
//
// Three constraints fix these numbers, and an edit that ignores them costs legibility
// at the only size that matters:
//
//   Centred. Ink bbox x[3,29] y[6,27] — margins 3/3/6/5, the extra unit at the top
//   answering a lens that carries its weight low. The mark this replaced sat four
//   units low and one right, with its handle 0.78px from the tile's corner radius.
//
//   13 and 8. The text lines are the Fibonacci pair: 1.625, within 0.4% of phi, and
//   integers — which phi is not. On a 16px grid an irrational ratio is a guarantee of
//   landing between pixels, so the approximation is not a compromise, it is the point.
//
//   Even widths on odd centres. A 32-unit coordinate halves at 16px, so a horizontal
//   stroke is crisp only when y/2 +/- w/4 is whole: y=7 and y=13 at width 2 give pixel
//   edges 3..4 and 6..7 exactly. That is also why the line gap is 6 and not the
//   Fibonacci 5 — parity is a real constraint and numerology is not. Circles and the
//   45-degree handle can never snap; they are why the 4x supersample stays.
const LINES = [
  [
    [4 / 32, 7 / 32],
    [17 / 32, 7 / 32],
  ],
  [
    [4 / 32, 13 / 32],
    [12 / 32, 13 / 32],
  ],
];
const LINE_WIDTH = 2 / 32;
const LENS = { cx: 20 / 32, cy: 18 / 32, r: 5 / 32, width: 2 / 32 };
// Starts inside the ring's annulus (5.66 from the centre, band 4..6), so the join is
// a union of two solids and needs no mitre.
const HANDLE = [
  [24 / 32, 22 / 32],
  [27.5 / 32, 25.5 / 32],
];
const HANDLE_WIDTH = 3 / 32;
const RADIUS = 7 / 32; // the SVG's rx
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

/** Stroked circle: the annulus between two radii, i.e. an unfilled lens. */
function ring({ cx, cy, r, width }) {
  const inner = r - width / 2;
  const outer = r + width / 2;
  return (x, y) => {
    const d = Math.hypot(x - cx, y - cy);
    return d >= inner && d <= outer;
  };
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
    for (const line of LINES) fill(canvas, colours.fg, polyline(line, LINE_WIDTH));
    fill(canvas, colours.fg, ring(LENS));
    fill(canvas, colours.fg, polyline([HANDLE[0], HANDLE[1]], HANDLE_WIDTH));
    const path = join(outDir, `${state}-${size}.png`);
    await writeFile(path, encodePng(canvas));
    written.push(path);
  }
}

console.log(`  generated ${written.length} icons -> ${outDir}`);
