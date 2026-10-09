// Corner detection from SVG geometry (no DOM required; see shape-loader.js for
// how elements are found and their transforms obtained).
//
// Every filled outline is reduced to a list of closed loops of segments. For
// each segment we know the unit tangent where it starts and where it ends.
// A corner is a junction between consecutive segments whose tangents differ by
// more than a threshold angle. Tangents are mapped through the element's
// transform before comparing, so non-uniform scales are handled correctly.

const DEFAULT_ANGLE_DEG = 30;

// ---- Path data parsing --------------------------------------------------

const CMD_RE = /[MmLlHhVvCcSsQqTtAaZz]/;
const NUM_RE = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/;

// Parses SVG path data into [{cmd, args}] with one entry per command
// repetition (implicit repeats are expanded; implicit lineto after moveto is
// turned into an explicit L/l).
export function parsePathData(d) {
  const out = [];
  let i = 0;
  const n = d.length;
  const skip = () => {
    while (i < n && /[\s,]/.test(d[i])) i++;
  };
  const num = () => {
    skip();
    const m = NUM_RE.exec(d.slice(i, i + 64));
    if (!m) throw new Error(`Bad path data near "${d.slice(i, i + 16)}"`);
    i += m[0].length;
    return parseFloat(m[0]);
  };
  const flag = () => {
    skip();
    const c = d[i];
    if (c !== '0' && c !== '1') throw new Error('Bad arc flag in path data');
    i++;
    return c === '1' ? 1 : 0;
  };
  const arity = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
  let cmd = null;
  while (true) {
    skip();
    if (i >= n) break;
    if (CMD_RE.test(d[i])) {
      cmd = d[i++];
    } else if (cmd === null) {
      throw new Error('Path data must start with a command');
    }
    const up = cmd.toUpperCase();
    if (up === 'Z') {
      out.push({ cmd, args: [] });
      continue;
    }
    // Read one group of arguments; the outer loop repeats implicit groups.
    let args;
    if (up === 'A') args = [num(), num(), num(), flag(), flag(), num(), num()];
    else {
      args = [];
      for (let k = 0; k < arity[up]; k++) args.push(num());
    }
    out.push({ cmd, args });
    if (cmd === 'M') cmd = 'L';
    else if (cmd === 'm') cmd = 'l';
  }
  return out;
}

// ---- Geometry helpers ---------------------------------------------------

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const len = (v) => Math.hypot(v[0], v[1]);
const same = (a, b, eps) => Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps;

// First nonzero vector in the list (Bezier tangents degenerate when a control
// point coincides with an endpoint).
function firstNonzero(vs, eps) {
  for (const v of vs) if (len(v) > eps) return v;
  return null;
}

// Tangents at the ends of an SVG elliptical arc (SVG 1.1 spec, F.6.5).
function arcTangents(p0, rx, ry, phiDeg, fa, fs, p1) {
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  if (rx === 0 || ry === 0) {
    const t = sub(p1, p0);
    return [t, t];
  }
  const phi = (phiDeg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (p0[0] - p1[0]) / 2;
  const dy = (p0[1] - p1[1]) / 2;
  const x1p = cos * dx + sin * dy;
  const y1p = -sin * dx + cos * dy;
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lam > 1) {
    rx *= Math.sqrt(lam);
    ry *= Math.sqrt(lam);
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const coef = (fa !== fs ? 1 : -1) * Math.sqrt(Math.max(0, num / den));
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;
  const th1 = Math.atan2((y1p - cyp) / ry, (x1p - cxp) / rx);
  let th2 = Math.atan2((-y1p - cyp) / ry, (-x1p - cxp) / rx);
  let dth = th2 - th1;
  if (!fs && dth > 0) dth -= 2 * Math.PI;
  else if (fs && dth < 0) dth += 2 * Math.PI;
  const sgn = dth >= 0 ? 1 : -1;
  const tan = (th) => {
    const tx = -rx * Math.sin(th) * sgn;
    const ty = ry * Math.cos(th) * sgn;
    return [cos * tx - sin * ty, sin * tx + cos * ty];
  };
  return [tan(th1), tan(th1 + dth)];
}

// ---- Path -> loops of segments -----------------------------------------

// Converts path data to closed loops: [[{p0, p1, t0, t1}, ...], ...].
// Open subpaths are closed with a straight segment, as the fill rule does.
export function pathToLoops(d) {
  const cmds = parsePathData(d);
  const loops = [];
  let segs = [];
  let cur = [0, 0];
  let start = [0, 0];
  let prevCtrl = null; // last cubic control point (for S)
  let prevQ = null; // last quadratic control point (for T)
  let scale = 1;
  for (const { args } of cmds) for (const a of args) scale = Math.max(scale, Math.abs(a));
  const eps = scale * 1e-9;

  const push = (p1, t0, t1) => {
    if (t0 && t1 && len(sub(p1, cur)) > eps) segs.push({ p0: cur, p1, t0, t1 });
    cur = p1;
  };
  const closeLoop = () => {
    if (!same(cur, start, eps)) {
      const t = sub(start, cur);
      push(start, t, t);
    }
    if (segs.length) loops.push(segs);
    segs = [];
    cur = start;
  };

  for (const { cmd, args } of cmds) {
    const rel = cmd === cmd.toLowerCase();
    const up = cmd.toUpperCase();
    const P = (x, y) => (rel ? [cur[0] + x, cur[1] + y] : [x, y]);
    let ctrl = null;
    let q = null;
    switch (up) {
      case 'M':
        if (segs.length) closeLoop();
        cur = P(args[0], args[1]);
        start = cur;
        break;
      case 'L': {
        const p1 = P(args[0], args[1]);
        const t = sub(p1, cur);
        push(p1, t, t);
        break;
      }
      case 'H': {
        const p1 = [rel ? cur[0] + args[0] : args[0], cur[1]];
        const t = sub(p1, cur);
        push(p1, t, t);
        break;
      }
      case 'V': {
        const p1 = [cur[0], rel ? cur[1] + args[0] : args[0]];
        const t = sub(p1, cur);
        push(p1, t, t);
        break;
      }
      case 'C':
      case 'S': {
        let c1, c2, p1;
        if (up === 'C') {
          c1 = P(args[0], args[1]);
          c2 = P(args[2], args[3]);
          p1 = P(args[4], args[5]);
        } else {
          c1 = prevCtrl ? [2 * cur[0] - prevCtrl[0], 2 * cur[1] - prevCtrl[1]] : cur;
          c2 = P(args[0], args[1]);
          p1 = P(args[2], args[3]);
        }
        const p0 = cur;
        const t0 = firstNonzero([sub(c1, p0), sub(c2, p0), sub(p1, p0)], eps);
        const t1 = firstNonzero([sub(p1, c2), sub(p1, c1), sub(p1, p0)], eps);
        push(p1, t0, t1);
        ctrl = c2;
        break;
      }
      case 'Q':
      case 'T': {
        let c, p1;
        if (up === 'Q') {
          c = P(args[0], args[1]);
          p1 = P(args[2], args[3]);
        } else {
          c = prevQ ? [2 * cur[0] - prevQ[0], 2 * cur[1] - prevQ[1]] : cur;
          p1 = P(args[0], args[1]);
        }
        const p0 = cur;
        const t0 = firstNonzero([sub(c, p0), sub(p1, p0)], eps);
        const t1 = firstNonzero([sub(p1, c), sub(p1, p0)], eps);
        push(p1, t0, t1);
        q = c;
        break;
      }
      case 'A': {
        const p1 = P(args[5], args[6]);
        if (len(sub(p1, cur)) > eps) {
          const [t0, t1] = arcTangents(cur, args[0], args[1], args[2], args[3], args[4], p1);
          push(p1, t0, t1);
        }
        break;
      }
      case 'Z':
        closeLoop();
        break;
    }
    prevCtrl = ctrl;
    prevQ = q;
  }
  if (segs.length) closeLoop();
  return loops;
}

export function polygonToLoops(points) {
  if (points.length < 3) return [];
  const segs = [];
  for (let i = 0; i < points.length; i++) {
    const p0 = points[i];
    const p1 = points[(i + 1) % points.length];
    const t = sub(p1, p0);
    if (len(t) > 0) segs.push({ p0, p1, t0: t, t1: t });
  }
  return [segs];
}

export function parsePoints(str) {
  const nums = (str.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) || []).map(Number);
  const pts = [];
  for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i], nums[i + 1]]);
  return pts;
}

// ---- Corners ------------------------------------------------------------

// Returns corner points [[x, y], ...] of the loops after applying the affine
// matrix m = {a, b, c, d, e, f} (DOMMatrix-compatible), using a turning-angle
// threshold in degrees.
export function loopCorners(loops, m = null, angleDeg = DEFAULT_ANGLE_DEG) {
  const M = m || { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  const P = (p) => [M.a * p[0] + M.c * p[1] + M.e, M.b * p[0] + M.d * p[1] + M.f];
  const V = (v) => {
    const x = M.a * v[0] + M.c * v[1];
    const y = M.b * v[0] + M.d * v[1];
    const l = Math.hypot(x, y) || 1;
    return [x / l, y / l];
  };
  const cosThresh = Math.cos((angleDeg * Math.PI) / 180);
  const corners = [];
  for (const segs of loops) {
    const n = segs.length;
    for (let i = 0; i < n; i++) {
      const a = segs[i];
      const b = segs[(i + 1) % n];
      const ta = V(a.t1);
      const tb = V(b.t0);
      if (ta[0] * tb[0] + ta[1] * tb[1] < cosThresh) corners.push(P(a.p1));
    }
  }
  return corners;
}
