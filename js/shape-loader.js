// Turns SVG text or a raster image into a Shape:
//
//   {
//     name,
//     aspect,          // width / height of the shape's bounding box
//     corners,         // [{u, v}] in [0, 1]^2, relative to the bounding box
//     bg,              // null, or [r, g, b] colour that counts as outside
//     raster(w, h),    // async; returns a drawable covering the bounding box
//   }
//
// Inside/outside rule: a pixel is inside if it is painted (alpha >= 50%) and,
// when a background colour was detected, its colour differs from it.

import { pathToLoops, polygonToLoops, parsePoints, loopCorners } from './svg-corners.js';
import { detectRasterCorners } from './raster-corners.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const GEOMETRY = 'path,rect,circle,ellipse,polygon,polyline';
const NON_RENDERED = 'defs,clipPath,mask,symbol,pattern,marker,linearGradient,radialGradient';
const MAX_RASTER = 1024; // long side when analysing raster images
const BG_COLOR_TOLERANCE = 60; // Euclidean RGB distance

export function isInsidePixel(r, g, b, a, bg) {
  if (a < 128) return false;
  if (!bg) return true;
  const dr = r - bg[0], dg = g - bg[1], db = b - bg[2];
  return dr * dr + dg * dg + db * db > BG_COLOR_TOLERANCE * BG_COLOR_TOLERANCE;
}

function parseCssColor(str) {
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(str);
  if (!m) return null;
  if (m[4] !== undefined && parseFloat(m[4]) === 0) return null;
  return [+m[1], +m[2], +m[3]];
}

function dedupe(corners, tol) {
  const out = [];
  for (const c of corners) {
    if (!out.some((o) => Math.hypot(o.u - c.u, o.v - c.v) < tol)) out.push(c);
  }
  return out;
}

// Outline loops of a geometry element in its own user space.
function elementLoops(el) {
  const num = (name) => parseFloat(el.getAttribute(name)) || 0;
  switch (el.localName) {
    case 'path':
      return pathToLoops(el.getAttribute('d') || '');
    case 'polygon':
    case 'polyline':
      return polygonToLoops(parsePoints(el.getAttribute('points') || ''));
    case 'rect': {
      // Rounded rectangles have no corners.
      if (num('rx') > 0 || num('ry') > 0) return [];
      const x = num('x'), y = num('y'), w = num('width'), h = num('height');
      return polygonToLoops([[x, y], [x + w, y], [x + w, y + h], [x, y + h]]);
    }
    default:
      return []; // circle, ellipse: smooth
  }
}

export async function loadSVGShape(text, name) {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  if (doc.querySelector('parsererror')) throw new Error('Could not parse the SVG file.');
  if (doc.documentElement.localName !== 'svg') throw new Error('Not an SVG file.');
  const root = document.importNode(doc.documentElement, true);
  // Drop the root's own viewport mapping so root user space = analysis space.
  for (const a of ['width', 'height', 'viewBox', 'preserveAspectRatio', 'x', 'y']) root.removeAttribute(a);
  root.querySelectorAll('script,foreignObject').forEach((e) => e.remove());

  // Geometry queries (getBBox, getScreenCTM, computed fill) need the SVG to be
  // in the document and rendered, though it can be invisible.
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;overflow:hidden;opacity:0;pointer-events:none';
  host.appendChild(root);
  document.body.appendChild(host);
  try {
    const rootInv = root.getScreenCTM().inverse();
    const items = [];
    for (const el of root.querySelectorAll(GEOMETRY)) {
      if (el.closest(NON_RENDERED)) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const filled = cs.fill !== 'none';
      const stroked = cs.stroke !== 'none' && parseFloat(cs.strokeWidth) > 0;
      if (!filled && !stroked) continue;
      const m = rootInv.multiply(el.getScreenCTM());
      const bb = el.getBBox();
      const sw = stroked ? parseFloat(cs.strokeWidth) / 2 : 0;
      const pts = [
        [bb.x - sw, bb.y - sw], [bb.x + bb.width + sw, bb.y - sw],
        [bb.x - sw, bb.y + bb.height + sw], [bb.x + bb.width + sw, bb.y + bb.height + sw],
      ].map(([x, y]) => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f]);
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      items.push({
        el, m, filled, fill: cs.fill,
        box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
      });
    }
    if (!items.length) throw new Error('The SVG has no visible shapes.');

    const union = (list) => list.reduce(
      (u, it) => [Math.min(u[0], it.box[0]), Math.min(u[1], it.box[1]), Math.max(u[2], it.box[2]), Math.max(u[3], it.box[3])],
      [Infinity, Infinity, -Infinity, -Infinity]);

    // A first element covering everything else is treated as a background.
    let bg = null;
    let shapes = items;
    if (items.length > 1 && items[0].filled) {
      const all = union(items);
      const b = items[0].box;
      const tol = 0.01 * Math.max(all[2] - all[0], all[3] - all[1]);
      const color = parseCssColor(items[0].fill);
      if (color && b[0] <= all[0] + tol && b[1] <= all[1] + tol && b[2] >= all[2] - tol && b[3] >= all[3] - tol) {
        bg = color;
        shapes = items.slice(1);
      }
    }
    const [x0, y0, x1, y1] = union(shapes);
    const bw = x1 - x0, bh = y1 - y0;
    if (!(bw > 0 && bh > 0)) throw new Error('The SVG shapes have no area.');

    let corners = [];
    for (const it of shapes) {
      if (!it.filled) continue;
      for (const [x, y] of loopCorners(elementLoops(it.el), it.m)) {
        corners.push({ u: (x - x0) / bw, v: (y - y0) / bh });
      }
    }
    corners = dedupe(corners, 0.005);

    root.setAttribute('viewBox', `${x0} ${y0} ${bw} ${bh}`);
    root.setAttribute('preserveAspectRatio', 'none');
    if (!root.getAttribute('xmlns')) root.setAttribute('xmlns', SVG_NS);

    return {
      name,
      aspect: bw / bh,
      corners,
      bg,
      async raster(w, h) {
        root.setAttribute('width', Math.max(1, Math.ceil(w)));
        root.setAttribute('height', Math.max(1, Math.ceil(h)));
        const blob = new Blob([new XMLSerializer().serializeToString(root)], { type: 'image/svg+xml' });
        const url = URL.createObjectURL(blob);
        try {
          const img = new Image();
          img.src = url;
          await img.decode();
          return img;
        } finally {
          URL.revokeObjectURL(url);
        }
      },
    };
  } finally {
    host.remove();
  }
}

// Background of a raster image: transparent if the border is mostly
// transparent, otherwise the median border colour.
function detectBackground(data, w, h) {
  const rs = [], gs = [], bs = [];
  let transparent = 0, count = 0;
  const visit = (x, y) => {
    const i = 4 * (y * w + x);
    count++;
    if (data[i + 3] < 128) transparent++;
    else {
      rs.push(data[i]);
      gs.push(data[i + 1]);
      bs.push(data[i + 2]);
    }
  };
  for (let x = 0; x < w; x++) { visit(x, 0); visit(x, h - 1); }
  for (let y = 1; y < h - 1; y++) { visit(0, y); visit(w - 1, y); }
  if (transparent >= count / 2) return null;
  const med = (a) => a.sort((p, q) => p - q)[a.length >> 1];
  return [med(rs), med(gs), med(bs)];
}

export async function loadRasterShape(blob, name) {
  const url = URL.createObjectURL(blob);
  let img;
  try {
    img = new Image();
    img.src = url;
    await img.decode();
  } finally {
    URL.revokeObjectURL(url);
  }
  const s = Math.min(1, MAX_RASTER / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * s));
  const h = Math.max(1, Math.round(img.naturalHeight * s));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  const bg = detectBackground(data, w, h);

  // Classify, then crop to the inside pixels' bounding box.
  const inside = new Uint8Array(w * h);
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = 4 * (y * w + x);
      if (isInsidePixel(data[i], data[i + 1], data[i + 2], data[i + 3], bg)) {
        inside[y * w + x] = 1;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) throw new Error('The image has no filled region (it all looks like background).');
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
  const mask = new Float32Array(cw * ch);
  const out = document.createElement('canvas');
  out.width = cw;
  out.height = ch;
  const octx = out.getContext('2d');
  const od = octx.createImageData(cw, ch);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const v = inside[(y + y0) * w + (x + x0)];
      mask[y * cw + x] = v;
      const j = 4 * (y * cw + x);
      od.data[j] = od.data[j + 1] = od.data[j + 2] = 0;
      od.data[j + 3] = v ? 255 : 0;
    }
  }
  octx.putImageData(od, 0, 0);

  return {
    name,
    aspect: cw / ch,
    corners: detectRasterCorners(mask, cw, ch).map(({ u, v }) => ({ u, v })),
    bg: null, // the mask canvas is already transparent outside
    async raster() {
      return out;
    },
  };
}

export async function loadShapeFile(file) {
  const isSVG = file.type === 'image/svg+xml' || /\.svgz?$/i.test(file.name);
  const name = file.name.replace(/\.[^.]+$/, '');
  return isSVG ? loadSVGShape(await file.text(), name) : loadRasterShape(file, name);
}
