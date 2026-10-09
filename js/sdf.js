// Signed distance field from a binary inside/outside raster.
//
// Uses the exact Euclidean distance transform of Felzenszwalb & Huttenlocher
// ("Distance Transforms of Sampled Functions", 2012), run twice: once to get
// every outside cell's distance to the nearest inside cell and once for the
// reverse. Distances are measured between cell centers, so we subtract half a
// cell to place the zero level set on the boundary between cells.
//
// Convention (matches the paper): negative inside, positive outside.

const INF = 1e20;

// 1D squared distance transform of f (length n) into d. v, z are scratch.
function edt1d(f, d, v, z, n) {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let r = v[k];
    let s = (f[q] + q * q - (f[r] + r * r)) / (2 * q - 2 * r);
    while (s <= z[k]) {
      k--;
      r = v[k];
      s = (f[q] + q * q - (f[r] + r * r)) / (2 * q - 2 * r);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const r = v[k];
    d[q] = (q - r) * (q - r) + f[r];
  }
}

// In-place 2D squared distance transform. grid holds 0 at feature cells and
// INF elsewhere; on return it holds squared distances to the nearest feature.
function edt2d(grid, w, h) {
  const n = Math.max(w, h);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x];
    edt1d(f, d, v, z, h);
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) f[x] = grid[row + x];
    edt1d(f, d, v, z, w);
    for (let x = 0; x < w; x++) grid[row + x] = d[x];
  }
}

export class SDF {
  // inside: Uint8Array (1 = inside) of size w*h. cell: world units per cell.
  constructor(inside, w, h, cell = 1) {
    this.w = w;
    this.h = h;
    this.cell = cell;
    const N = w * h;
    const toIn = new Float64Array(N);
    const toOut = new Float64Array(N);
    let any = false;
    for (let i = 0; i < N; i++) {
      if (inside[i]) {
        toIn[i] = 0;
        toOut[i] = INF;
        any = true;
      } else {
        toIn[i] = INF;
        toOut[i] = 0;
      }
    }
    const data = new Float32Array(N);
    this.data = data;
    this.min = 0;
    if (!any) {
      data.fill(Math.hypot(w, h) * cell);
      return;
    }
    edt2d(toIn, w, h);
    edt2d(toOut, w, h);
    let min = Infinity;
    for (let i = 0; i < N; i++) {
      const s = inside[i]
        ? -(Math.sqrt(toOut[i]) - 0.5) * cell
        : (Math.sqrt(toIn[i]) - 0.5) * cell;
      data[i] = s;
      if (s < min) min = s;
    }
    this.min = min;
  }

  // Bilinearly interpolated signed distance at world position (x, y).
  sample(x, y) {
    const { w, h, data } = this;
    let gx = x / this.cell - 0.5;
    let gy = y / this.cell - 0.5;
    gx = Math.min(Math.max(gx, 0), w - 1);
    gy = Math.min(Math.max(gy, 0), h - 1);
    const x0 = Math.min(Math.floor(gx), w - 2 < 0 ? 0 : w - 2);
    const y0 = Math.min(Math.floor(gy), h - 2 < 0 ? 0 : h - 2);
    const x1 = Math.min(x0 + 1, w - 1);
    const y1 = Math.min(y0 + 1, h - 1);
    const tx = gx - x0;
    const ty = gy - y0;
    const a = data[y0 * w + x0];
    const b = data[y0 * w + x1];
    const c = data[y1 * w + x0];
    const d = data[y1 * w + x1];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  }
}
