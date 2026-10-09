// App wiring: UI, shape loading, per-frame sonification and drawing.

import { DEMO_SHAPES } from './shapes.js';
import { loadSVGShape, loadShapeFile } from './shape-loader.js';
import { buildField, cornerDistance } from './field.js';
import { Sonifier, HANDS, FINGERS, VOLUME, falloff } from './audio.js';
import { FingerTracker, HAND_MODES } from './input.js';

const NOTE_NAMES = ['C', 'D', 'E', 'G', 'A'];
const FINGER_RADIUS = 26;

const $ = (id) => document.getElementById(id);
const canvas = $('stage');
const ctx = canvas.getContext('2d');
const params = new URLSearchParams(location.search);

const state = {
  shape: null,
  field: null,
  maskImage: null,
  show: params.get('show') === '1',
  error: null,
};
let fieldGeneration = 0;

const sonifier = new Sonifier();
const tracker = new FingerTracker(canvas);

// ---- Theme ----------------------------------------------------------------

let colors = {};
function readColors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name) => cs.getPropertyValue(name).trim();
  colors = {
    bg: v('--stage-bg'),
    shape: v('--shape-fill'),
    corner: v('--corner'),
    hands: [v('--hand-left'), v('--hand-right')],
    text: v('--text'),
    muted: v('--muted'),
  };
  if (state.field) state.maskImage = makeMaskImage(state.field);
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', readColors);

// ---- Shape and field ----------------------------------------------------

function makeMaskImage(field) {
  const c = document.createElement('canvas');
  c.width = field.gw;
  c.height = field.gh;
  const g = c.getContext('2d');
  g.fillStyle = colors.shape;
  g.fillRect(0, 0, 1, 1);
  const [r, gg, b, a] = g.getImageData(0, 0, 1, 1).data;
  const img = g.createImageData(field.gw, field.gh);
  for (let i = 0; i < field.inside.length; i++) {
    if (!field.inside[i]) continue;
    img.data[4 * i] = r;
    img.data[4 * i + 1] = gg;
    img.data[4 * i + 2] = b;
    img.data[4 * i + 3] = a;
  }
  g.putImageData(img, 0, 0);
  return c;
}

async function rebuildField() {
  if (!state.shape) return;
  const gen = ++fieldGeneration;
  const W = canvas.clientWidth;
  const H = canvas.clientHeight;
  const field = await buildField(state.shape, W, H);
  if (gen !== fieldGeneration) return; // a newer shape or resize won
  state.field = field;
  state.maskImage = makeMaskImage(field);
  updateStatus();
}

async function setShape(loadShape, id = null) {
  try {
    setStatus('Loading…');
    state.shape = await loadShape();
    state.error = null;
    for (const b of document.querySelectorAll('.shape-list button')) {
      b.setAttribute('aria-pressed', String(b.dataset.id === id));
    }
    $('shape-name').textContent = state.shape.name;
    await rebuildField();
  } catch (err) {
    console.error(err);
    state.error = err.message || String(err);
    setStatus(state.error, true);
  }
}

function selectDemo(id) {
  const demo = DEMO_SHAPES.find((s) => s.id === id) || DEMO_SHAPES[0];
  return setShape(() => loadSVGShape(demo.svg, demo.label), demo.id);
}

function setStatus(text, isError = false) {
  const el = $('status');
  el.textContent = text;
  el.classList.toggle('error', isError);
}

function updateStatus() {
  const n = state.field ? state.field.corners.length : 0;
  setStatus(`${state.shape.name}: ${n} corner${n === 1 ? '' : 's'} detected.`);
}

// ---- Sonification -------------------------------------------------------

// Per-finger measurements and per-hand sound levels for the current frame.
function probe() {
  const field = state.field;
  const fingers = [...tracker.fingers.values()];
  const levels = [];
  for (let h = 0; h < HANDS; h++) levels.push({ guidance: 0, contact: new Array(FINGERS).fill(0), corner: 0 });
  if (!field) return { fingers, levels };
  const nearestOutside = [Infinity, Infinity];
  const nearestCorner = [Infinity, Infinity];
  for (const f of fingers) {
    f.sdf = field.sdf.sample(f.x, f.y);
    f.cornerDist = cornerDistance(field, f.x, f.y);
    if (f.sdf > 0) nearestOutside[f.hand] = Math.min(nearestOutside[f.hand], f.sdf);
    else levels[f.hand].contact[f.slot] = falloff(-f.sdf, field.contactD, VOLUME.contact);
    nearestCorner[f.hand] = Math.min(nearestCorner[f.hand], f.cornerDist);
  }
  for (let h = 0; h < HANDS; h++) {
    levels[h].guidance = falloff(nearestOutside[h], field.guidanceD, VOLUME.guidance);
    levels[h].corner = falloff(nearestCorner[h], field.cornerD, VOLUME.corner);
  }
  return { fingers, levels };
}

// ---- Drawing --------------------------------------------------------------

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(canvas.clientWidth * dpr);
  canvas.height = Math.round(canvas.clientHeight * dpr);
}

function draw(fingers) {
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = canvas.clientWidth;
  const H = canvas.clientHeight;
  ctx.fillStyle = colors.bg;
  ctx.fillRect(0, 0, W, H);
  const field = state.field;

  if (state.show && field && state.maskImage) {
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(state.maskImage, 0, 0, field.gw * field.cell, field.gh * field.cell);
    ctx.strokeStyle = colors.corner;
    ctx.fillStyle = colors.corner;
    for (const c of field.corners) {
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      ctx.arc(c.x, c.y, field.cornerD, 0, 2 * Math.PI);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(c.x, c.y, 4, 0, 2 * Math.PI);
      ctx.fill();
    }
  }

  // Midline hint: which half of the screen is which hand.
  if (fingers.length === 0 && tracker.handMode === 'split') {
    ctx.strokeStyle = colors.muted;
    ctx.globalAlpha = 0.25;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 6]);
    ctx.beginPath();
    ctx.moveTo(W / 2, 0);
    ctx.lineTo(W / 2, H);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  ctx.font = '600 14px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const f of fingers) {
    const color = colors.hands[f.hand];
    ctx.lineWidth = 3;
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.arc(f.x, f.y, FINGER_RADIUS, 0, 2 * Math.PI);
    // Only reveal contact state when the shape is shown.
    if (state.show && f.sdf <= 0) {
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.35;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.stroke();
    ctx.fillStyle = colors.text;
    ctx.fillText(NOTE_NAMES[f.slot], f.x, f.y - FINGER_RADIUS - 12);
  }
}

// Audio follows input events directly (see input.js); each frame also
// refreshes it, which covers field rebuilds and pluck re-triggering for
// fingers that are held still.
tracker.onChange = () => sonifier.update(probe().levels);

function frame() {
  const { fingers, levels } = probe();
  sonifier.update(levels);
  draw(fingers);
  requestAnimationFrame(frame);
}

// ---- UI -------------------------------------------------------------------

function setShow(show) {
  state.show = show;
  $('show-toggle').checked = show;
  $('show-btn').setAttribute('aria-pressed', String(show));
  $('show-btn').textContent = show ? 'Hide shape' : 'Show shape';
}

function setHandMode(mode) {
  if (!HAND_MODES.includes(mode)) return;
  tracker.handMode = mode;
  tracker.clear();
  $('hand-mode').value = mode;
  for (const el of document.querySelectorAll('[data-hand-mode]')) el.hidden = el.dataset.handMode !== mode;
  try {
    localStorage.setItem('shapesonic.handMode', mode);
  } catch {}
}

function setMenuOpen(open) {
  $('menu').hidden = !open;
  $('backdrop').hidden = !open;
  $('menu-btn').setAttribute('aria-expanded', String(open));
  if (open) tracker.clear();
}

function buildMenu() {
  const list = document.querySelector('.shape-list');
  for (const s of DEMO_SHAPES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = s.label;
    b.dataset.id = s.id;
    b.addEventListener('click', () => {
      selectDemo(s.id);
      setMenuOpen(false);
    });
    list.appendChild(b);
  }
  $('menu-btn').addEventListener('click', () => setMenuOpen($('menu').hidden));
  $('backdrop').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    setMenuOpen(false);
  });
  $('file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    await setShape(() => loadShapeFile(file));
    if (!state.error) setMenuOpen(false);
  });
  $('show-toggle').addEventListener('change', (e) => setShow(e.target.checked));
  $('show-btn').addEventListener('click', () => setShow(!state.show));
  $('hand-mode').addEventListener('change', (e) => setHandMode(e.target.value));
  $('feature-sound').addEventListener('change', (e) => (sonifier.featureSound = e.target.value));
  $('volume').addEventListener('input', (e) => sonifier.setMasterVolume(+e.target.value));
  document.addEventListener('keydown', (e) => {
    if (e.target.closest && e.target.closest('input, select')) return;
    if (e.key === 's' || e.key === 'S') setShow(!state.show);
    else if (e.key === 'Escape') setMenuOpen(false);
  });
}

async function startAudio() {
  const btn = $('start-btn');
  btn.disabled = true;
  btn.textContent = 'Loading sounds…';
  try {
    await sonifier.start();
    sonifier.setMasterVolume(+$('volume').value);
    $('start').hidden = true;
  } catch (err) {
    console.error(err);
    btn.disabled = false;
    btn.textContent = 'Try again';
    $('start-error').textContent =
      location.protocol === 'file:'
        ? 'Sounds cannot load from a file:// page. Serve this folder over HTTP (see DESIGN.md).'
        : `Could not start audio: ${err.message || err}`;
  }
}

// iOS Safari pinch/double-tap zoom.
for (const type of ['gesturestart', 'gesturechange', 'dblclick']) {
  document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
}

let resizeTimer = 0;
window.addEventListener('resize', () => {
  resizeCanvas();
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(rebuildField, 150);
});

readColors();
resizeCanvas();
buildMenu();
setShow(state.show);
setHandMode(params.get('hands') || (() => {
  try {
    return localStorage.getItem('shapesonic.handMode');
  } catch {
    return null;
  }
})() || 'split');
$('start-btn').addEventListener('click', startAudio);
if (params.get('audio') === '0') $('start').hidden = true; // for screenshots/tests
selectDemo(params.get('shape') || 'circle');
requestAnimationFrame(frame);

// Handle for debugging from the console and for test/browser.test.mjs.
window.shapesonic = { state, sonifier, tracker, probe };
