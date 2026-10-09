// Run with: node test/corners.test.mjs [dir-with-pgm-masks]
// Checks SVG corner detection on the demo shapes and, if PGM alpha masks of
// the demo shapes are provided (e.g. rendered with rsvg-convert and
// `magick X.png -alpha extract X.pgm`), the raster corner detector too.
import fs from 'node:fs';
import path from 'node:path';
import { DEMO_SHAPES } from '../js/shapes.js';
import { pathToLoops, polygonToLoops, parsePoints, loopCorners } from '../js/svg-corners.js';
import { detectRasterCorners } from '../js/raster-corners.js';
import { SDF } from '../js/sdf.js';

const expected = { circle: 0, square: 4, triangle: 3, annulus: 0, cat: 7 };
// The raster detector also fires (weakly) on the cat's tightly curved tail tip
// and the bottom of the notch between its paws.
const expectedRaster = { ...expected, cat: [7, 9] };
const inRange = (n, e) => (Array.isArray(e) ? n >= e[0] && n <= e[1] : n === e);
let fail = 0;
const check = (ok, msg) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!ok) fail++;
};

function svgLoops(svg) {
  const d = /\sd="([^"]+)"/.exec(svg);
  if (d) return pathToLoops(d[1]);
  const pts = /points="([^"]+)"/.exec(svg);
  if (pts) return polygonToLoops(parsePoints(pts[1]));
  const r = /<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/.exec(svg);
  if (r) {
    const [x, y, w, h] = r.slice(1).map(Number);
    return polygonToLoops([[x, y], [x + w, y], [x + w, y + h], [x, y + h]]);
  }
  return [];
}

for (const s of DEMO_SHAPES) {
  const c = loopCorners(svgLoops(s.svg));
  check(c.length === expected[s.id], `svg ${s.id}: ${c.length} corners ${JSON.stringify(c.map((p) => p.map((v) => +v.toFixed(1))))}`);
}

function readPGM(file) {
  const buf = fs.readFileSync(file);
  const header = buf.toString('latin1', 0, 64).split(/\s+/);
  const [magic, w, h, max] = header;
  if (magic !== 'P5') throw new Error('expected binary PGM');
  const off = buf.length - w * h;
  const mask = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) mask[i] = buf[off + i] / +max;
  return { mask, w: +w, h: +h };
}

const dir = process.argv[2];
if (dir) {
  for (const s of DEMO_SHAPES) {
    const f = path.join(dir, `${s.id}.pgm`);
    if (!fs.existsSync(f)) continue;
    const { mask, w, h } = readPGM(f);
    const c = detectRasterCorners(mask, w, h);
    check(inRange(c.length, expectedRaster[s.id]), `raster ${s.id}: ${c.length} corners ${JSON.stringify(c.map((p) => [+(p.u * 100).toFixed(1), +(p.v * 100).toFixed(1), +p.strength.toFixed(2)]))}`);
  }
}

// SDF sanity: disk of radius 40 in a 100x100 grid.
{
  const w = 100, h = 100, inside = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) inside[y * w + x] = Math.hypot(x + 0.5 - 50, y + 0.5 - 50) < 40 ? 1 : 0;
  const sdf = new SDF(inside, w, h, 1);
  const err = Math.max(...[[50, 50, -40], [90, 50, 0], [50, 5, 5], [0.5, 0.5, Math.hypot(49.5, 49.5) - 40]].map(([x, y, e]) => Math.abs(sdf.sample(x, y) - e)));
  check(err < 1.5, `sdf disk max error ${err.toFixed(3)}`);
}

process.exit(fail ? 1 : 0);
