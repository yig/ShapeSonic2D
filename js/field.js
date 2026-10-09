// A Field is a Shape placed on the screen: the inside mask and SDF on a grid
// covering the whole viewport, the corners in screen coordinates, and the
// sonification distances (in CSS pixels) derived from the shape's size.

import { SDF } from './sdf.js';
import { isInsidePixel } from './shape-loader.js';

const FIT_FRACTION = 0.72; // shape's long side relative to the short screen side
const MAX_CELLS = 700000; // SDF grid budget (cell size grows on big screens)

// Distances relative to the fitted shape size. The paper's 3D values are
// 50 cm (guidance) and 2 cm (edges/corners) for objects of roughly 25-40 cm.
const GUIDANCE_FRACTION = 0.6;
const CORNER_FRACTION = 0.08;
const CORNER_MIN_PX = 22; // keep corner zones fingertip-sized on phones

export async function buildField(shape, W, H) {
  const fitSize = FIT_FRACTION * Math.min(W, H);
  const fw = shape.aspect >= 1 ? fitSize : fitSize * shape.aspect;
  const fh = shape.aspect >= 1 ? fitSize / shape.aspect : fitSize;
  const fit = { x: (W - fw) / 2, y: (H - fh) / 2, w: fw, h: fh };

  const cell = Math.max(1, Math.sqrt((W * H) / MAX_CELLS));
  const gw = Math.ceil(W / cell);
  const gh = Math.ceil(H / cell);

  const canvas = document.createElement('canvas');
  canvas.width = gw;
  canvas.height = gh;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = await shape.raster(fw / cell, fh / cell);
  ctx.drawImage(img, fit.x / cell, fit.y / cell, fw / cell, fh / cell);
  const { data } = ctx.getImageData(0, 0, gw, gh);
  const inside = new Uint8Array(gw * gh);
  for (let i = 0; i < gw * gh; i++) {
    inside[i] = isInsidePixel(data[4 * i], data[4 * i + 1], data[4 * i + 2], data[4 * i + 3], shape.bg) ? 1 : 0;
  }
  const sdf = new SDF(inside, gw, gh, cell);

  // Keep only corners that lie on the boundary of the union (e.g. not a
  // corner of one SVG element buried inside another).
  const onBoundary = Math.max(3, 2.5 * cell);
  const corners = shape.corners
    .map(({ u, v }) => ({ x: fit.x + u * fw, y: fit.y + v * fh }))
    .filter((c) => Math.abs(sdf.sample(c.x, c.y)) <= onBoundary);

  return {
    shape,
    W, H, fit, cell, gw, gh, inside, sdf, corners,
    guidanceD: GUIDANCE_FRACTION * fitSize,
    cornerD: Math.max(CORNER_MIN_PX, CORNER_FRACTION * fitSize),
    contactD: Math.max(cell, -sdf.min),
  };
}

// Distance from (x, y) to the nearest corner (Infinity if there are none).
export function cornerDistance(field, x, y) {
  let best = Infinity;
  for (const c of field.corners) best = Math.min(best, Math.hypot(c.x - x, c.y - y));
  return best;
}
