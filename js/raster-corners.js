// Corner detection for raster shapes (PNG etc.), by convolution.
//
// The binary mask is resampled to a fixed working resolution, smoothed, and
// differentiated (Sobel). The structure tensor (gradient outer products
// averaged by a Gaussian window) has two large eigenvalues only where the
// boundary turns within the window, so its smaller eigenvalue (Shi-Tomasi
// variant of the Harris detector) is a corner response that is ~0 along
// straight or gently curved boundaries. Corners are local maxima of the
// response above an absolute threshold, since the input is always a clean
// 0/1 mask and responses are therefore comparable across images.

const WORK_SIZE = 256; // long side of the working raster, in cells
const PAD = 16; // padding so corners on the bounding box get a full window
const SMOOTH_SIGMA = 1.0;
const WINDOW_SIGMA = 2.5;
const NMS_RADIUS = 6;
// Fraction of the response of an ideal 90-degree corner. Calibrated on the
// demo shapes (test/corners.test.mjs): smooth circles give no detections,
// while the cat's ~60-degree paw-notch corners score ~0.3.
const THRESHOLD = 0.2;

function gaussianKernel(sigma) {
  const r = Math.ceil(3 * sigma);
  const k = new Float32Array(2 * r + 1);
  let s = 0;
  for (let i = -r; i <= r; i++) s += k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
  for (let i = 0; i < k.length; i++) k[i] /= s;
  return k;
}

function blur(src, w, h, sigma) {
  const k = gaussianKernel(sigma);
  const r = (k.length - 1) / 2;
  const tmp = new Float32Array(w * h);
  const dst = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) {
        const xx = Math.min(w - 1, Math.max(0, x + i));
        s += k[i + r] * src[y * w + xx];
      }
      tmp[y * w + x] = s;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) {
        const yy = Math.min(h - 1, Math.max(0, y + i));
        s += k[i + r] * tmp[yy * w + x];
      }
      dst[y * w + x] = s;
    }
  }
  return dst;
}

// Box-filter resample of a w x h mask (values 0..1) into a padded working grid.
function resample(mask, w, h) {
  const scale = WORK_SIZE / Math.max(w, h);
  const iw = Math.max(1, Math.round(w * scale));
  const ih = Math.max(1, Math.round(h * scale));
  const W = iw + 2 * PAD;
  const H = ih + 2 * PAD;
  const out = new Float32Array(W * H);
  const sx = w / iw;
  const sy = h / ih;
  for (let y = 0; y < ih; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < iw; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let s = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) s += mask[yy * w + xx];
      out[(y + PAD) * W + (x + PAD)] = s / ((y1 - y0) * (x1 - x0));
    }
  }
  return { img: out, W, H, iw, ih };
}

// Smaller eigenvalue of the structure tensor at every cell.
export function cornerResponse(img, W, H) {
  const I = blur(img, W, H, SMOOTH_SIGMA);
  const xx = new Float32Array(W * H);
  const yy = new Float32Array(W * H);
  const xy = new Float32Array(W * H);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const p = (dx, dy) => I[(y + dy) * W + (x + dx)];
      const gx = (p(1, -1) + 2 * p(1, 0) + p(1, 1) - p(-1, -1) - 2 * p(-1, 0) - p(-1, 1)) / 8;
      const gy = (p(-1, 1) + 2 * p(0, 1) + p(1, 1) - p(-1, -1) - 2 * p(0, -1) - p(1, -1)) / 8;
      const i = y * W + x;
      xx[i] = gx * gx;
      yy[i] = gy * gy;
      xy[i] = gx * gy;
    }
  }
  const Sxx = blur(xx, W, H, WINDOW_SIGMA);
  const Syy = blur(yy, W, H, WINDOW_SIGMA);
  const Sxy = blur(xy, W, H, WINDOW_SIGMA);
  const R = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const m = (Sxx[i] + Syy[i]) / 2;
    const d = (Sxx[i] - Syy[i]) / 2;
    R[i] = m - Math.sqrt(d * d + Sxy[i] * Sxy[i]);
  }
  return R;
}

// Response of an ideal axis-aligned 90-degree corner, used to normalize.
let refResponse = null;
function referenceResponse() {
  if (refResponse === null) {
    const W = 64;
    const img = new Float32Array(W * W);
    for (let y = 32; y < W; y++) for (let x = 32; x < W; x++) img[y * W + x] = 1;
    const R = cornerResponse(img, W, W);
    refResponse = R.reduce((a, b) => Math.max(a, b), 0);
  }
  return refResponse;
}

// mask: Float32Array/Uint8Array of w*h values in [0, 1] (1 = inside).
// Returns corners as [{u, v, strength}] with u, v in [0, 1] relative to the
// mask's extent.
export function detectRasterCorners(mask, w, h, threshold = THRESHOLD) {
  const { img, W, H, iw, ih } = resample(mask, w, h);
  const R = cornerResponse(img, W, H);
  const T = threshold * referenceResponse();
  const corners = [];
  const r = NMS_RADIUS;
  for (let y = r; y < H - r; y++) {
    for (let x = r; x < W - r; x++) {
      const v = R[y * W + x];
      if (v < T) continue;
      let isMax = true;
      for (let dy = -r; dy <= r && isMax; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (dx * dx + dy * dy > r * r || (dx === 0 && dy === 0)) continue;
          const o = R[(y + dy) * W + (x + dx)];
          // Break ties toward the earliest cell so plateaus yield one peak.
          if (o > v || (o === v && (dy < 0 || (dy === 0 && dx < 0)))) {
            isMax = false;
            break;
          }
        }
      }
      if (!isMax) continue;
      // Sub-cell refinement: response-weighted centroid in a 3x3 window.
      let sx = 0, sy = 0, sw = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const wgt = Math.max(0, R[(y + dy) * W + (x + dx)] - T);
          sx += wgt * (x + dx);
          sy += wgt * (y + dy);
          sw += wgt;
        }
      }
      const cx = sw > 0 ? sx / sw : x;
      const cy = sw > 0 ? sy / sw : y;
      corners.push({
        u: (cx + 0.5 - PAD) / iw,
        v: (cy + 0.5 - PAD) / ih,
        strength: v / referenceResponse(),
      });
    }
  }
  return corners;
}
