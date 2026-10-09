// End-to-end check in headless Chrome over the DevTools protocol.
// Usage: python3 -m http.server 8123 &  then  node test/browser.test.mjs
// Simulates touches and checks the sound levels the app computes.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL_BASE = process.env.URL_BASE || 'http://localhost:8123/';
const PORT = 9300 + Math.floor(Math.random() * 600);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shapesonic-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--autoplay-policy=no-user-gesture-required', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, nextId = 1;
const pending = new Map();
const logs = [];
function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((ok, fail) => pending.set(id, { ok, fail }));
}
async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}
let fail = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fail++; };

try {
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page');
    } catch { await sleep(100); }
  }
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      msg.error ? p.fail(new Error(msg.error.message)) : p.ok(msg.result);
    } else if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
      logs.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
    } else if (msg.method === 'Runtime.exceptionThrown') {
      logs.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    }
  });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 800, height: 600, deviceScaleFactor: 2, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 10 });
  await send('Page.navigate', { url: `${URL_BASE}?shape=square` });
  await sleep(1500);

  // Start audio through the real button.
  await evaluate(`document.getElementById('start-btn').click()`);
  for (let i = 0; i < 50; i++) { if (await evaluate('shapesonic.sonifier.ready')) break; await sleep(100); }
  check(await evaluate('shapesonic.sonifier.ready'), 'audio engine started and sounds decoded');
  check(await evaluate(`document.getElementById('start').hidden`), 'start overlay dismissed');

  const field = await evaluate(`(() => { const f = shapesonic.state.field; return { W: f.W, H: f.H, fit: f.fit, corners: f.corners, guidanceD: f.guidanceD, cornerD: f.cornerD, contactD: f.contactD }; })()`);
  check(Math.abs(field.fit.y + field.fit.h / 2 - 300) < 1 && field.W === 800 && field.H === 600, `square centered in 800x600 (fit ${JSON.stringify(field.fit)})`);
  check(field.corners.length === 4, `square has 4 corners on the boundary`);

  // Pointer moves are delivered with the next animation frame, so wait a bit.
  const touch = async (type, points) => {
    await send('Input.dispatchTouchEvent', {
      type, touchPoints: points.map(([x, y], i) => ({ x, y, id: i, radiusX: 5, radiusY: 5 })),
    });
    await sleep(50);
  };
  const levels = () => evaluate(`JSON.parse(JSON.stringify(shapesonic.probe().levels))`);
  const { x: fx, y: fy, w: fw } = field.fit;

  // One finger far outside, left half.
  await touch('touchStart', [[20, 300]]);
  let L = await levels();
  check(L[0].guidance < 0.1 && L[0].contact.every((v) => v === 0), `far outside: guidance faint (${JSON.stringify(L[0])})`);
  // Move near the shape's left side, outside.
  await touch('touchMove', [[fx - 10, 300]]);
  L = await levels();
  check(L[0].guidance > 0.8 && L[1].guidance === 0, `just outside: left guidance loud (${L[0].guidance.toFixed(2)}), right silent`);
  // Move just inside.
  await touch('touchMove', [[fx + 5, 300]]);
  L = await levels();
  check(L[0].guidance === 0 && L[0].contact[0] > 0.6, `just inside: contact C loud (${L[0].contact[0].toFixed(2)}), guidance off`);
  // Second finger on the right half, at the center (deep inside), and a third at a corner.
  await touch('touchMove', [[fx + 5, 300], [fx + fw / 2 + 2, 300]]);
  await touch('touchStart', [[fx + 5, 300], [fx + fw / 2 + 2, 300], [fx + fw + 2, fy - 2]]);
  L = await levels();
  check(L[1].contact[0] < 0.1, `right-hand finger at center: contact quiet (${L[1].contact[0].toFixed(3)})`);
  check(L[1].corner > 0.85, `right-hand finger at corner: corner sound (${L[1].corner.toFixed(2)})`);
  const slots = await evaluate(`[...shapesonic.tracker.fingers.values()].map(f => [f.hand, f.slot])`);
  check(JSON.stringify(slots) === '[[0,0],[1,0],[1,1]]', `hand/slot assignment ${JSON.stringify(slots)}`);
  await sleep(200);
  const gains = await evaluate(`shapesonic.sonifier.hands.map(h => ({ g: h.guidanceGain.gain.value, c: h.contactGains.map(g => +g.gain.value.toFixed(3)), k: h.featureGain.gain.value }))`);
  check(gains[0].c[0] > 0.2 && gains[1].k > 0.5, `Web Audio gains follow levels ${JSON.stringify(gains)}`);
  await touch('touchEnd', []);
  L = await levels();
  check(L.every((h) => h.guidance === 0 && h.corner === 0 && h.contact.every((v) => v === 0)), 'all fingers lifted: silent');

  // Touch-order hand mode, driven with synthetic PointerEvents so that single
  // fingers can be lifted. Six touches, all on the right half.
  await evaluate(`(() => { const s = document.getElementById('hand-mode'); s.value = 'order'; s.dispatchEvent(new Event('change')); })()`);
  const pointer = (type, id, x, y) => evaluate(`document.getElementById('stage').dispatchEvent(new PointerEvent('${type}',
    { pointerId: ${id}, pointerType: 'touch', clientX: ${x}, clientY: ${y}, bubbles: true, cancelable: true }))`);
  const slotsNow = () => evaluate(`[...shapesonic.tracker.fingers.values()].map(f => [f.hand, f.slot])`);
  for (let i = 0; i < 6; i++) await pointer('pointerdown', 100 + i, 500 + 40 * i, 500);
  check(JSON.stringify(await slotsNow()) === '[[0,0],[0,1],[0,2],[0,3],[0,4],[1,0]]', `touch order: first five left, sixth right ${JSON.stringify(await slotsNow())}`);
  // Lift the second touch; a new touch takes its freed left-hand slot.
  await pointer('pointerup', 101, 540, 500);
  await pointer('pointerdown', 106, 300, 100);
  const last = (await slotsNow()).at(-1);
  check(JSON.stringify(last) === '[0,1]', `touch order: new touch reuses freed left slot ${JSON.stringify(last)}`);
  for (const id of [100, 102, 103, 104, 105, 106]) await pointer('pointerup', id, 0, 0);
  check((await slotsNow()).length === 0, 'touch order: all lifted');
  check(await evaluate(`localStorage.getItem('shapesonic.handMode')`) === 'order', 'hand mode remembered');
  await evaluate(`(() => { const s = document.getElementById('hand-mode'); s.value = 'split'; s.dispatchEvent(new Event('change')); })()`);

  // Mouse fallback.
  await send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: fx + 5, y: 300 });
  check((await levels())[0].contact[0] === 0, 'mouse hover without button: silent');
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: fx + 5, y: 300, button: 'left', buttons: 1, clickCount: 1 });
  check((await levels())[0].contact[0] > 0.6, 'mouse button down inside: contact');
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: fx + 5, y: 300, button: 'left', buttons: 0, clickCount: 1 });

  // Every demo shape builds.
  for (const id of ['circle', 'square', 'triangle', 'annulus', 'cat']) {
    await send('Page.navigate', { url: `${URL_BASE}?shape=${id}&audio=0` });
    await sleep(800);
    const n = await evaluate(`shapesonic.state.field ? shapesonic.state.field.corners.length : -1`);
    check(n === { circle: 0, square: 4, triangle: 3, annulus: 0, cat: 7 }[id], `${id}: ${n} corners in app`);
  }

  // Loading a PNG through the file loader (raster corner detection).
  const png = fs.readFileSync(new URL('./fixtures/triangle.png', import.meta.url)).toString('base64');
  const n = await evaluate(`(async () => {
    const bytes = Uint8Array.from(atob('${png}'), (c) => c.charCodeAt(0));
    const file = new File([bytes], 'triangle.png', { type: 'image/png' });
    const { loadShapeFile } = await import('./js/shape-loader.js');
    const shape = await loadShapeFile(file);
    return shape.corners.length;
  })()`);
  check(n === 3, `PNG triangle on white background: ${n} corners`);

  // SVG with a background rect, nested transforms, and a buried vertex.
  const svgRes = await evaluate(`(async () => {
    const { loadSVGShape } = await import('./js/shape-loader.js');
    const s = await loadSVGShape(\`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300">
      <rect width="400" height="300" fill="#fff"/>
      <g transform="translate(200 150) scale(2 1)"><g transform="rotate(45)">
        <rect x="-40" y="-40" width="80" height="80" fill="#222"/>
      </g></g>
      <circle cx="200" cy="150" r="20" fill="#222"/>
    </svg>\`, 'test');
    return { n: s.corners.length, bg: s.bg, aspect: s.aspect };
  })()`);
  check(svgRes.n === 4 && JSON.stringify(svgRes.bg) === '[255,255,255]' && Math.abs(svgRes.aspect - 2) < 0.01,
    `SVG with background and transforms: ${JSON.stringify(svgRes)}`);

  check(logs.length === 0, `no console errors${logs.length ? ': ' + logs.join(' | ') : ''}`);
} catch (e) {
  console.error(e);
  fail++;
} finally {
  ws?.close();
  chrome.kill();
}
process.exit(fail ? 1 : 0);
