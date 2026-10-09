// Multi-touch input via Pointer Events (touch, pen, and mouse alike).
//
// A touchscreen does not say which hand or finger a touch belongs to, so:
// * hand: decided when the touch starts, by which half of the screen it is in;
// * finger: the lowest free of the hand's five pentatonic slots.
// A mouse acts as a single fingertip while a button is held.

import { FINGERS } from './audio.js';

export class FingerTracker {
  constructor(el) {
    this.el = el;
    this.fingers = new Map(); // pointerId -> {id, hand, slot, x, y}

    el.addEventListener('pointerdown', (e) => this.down(e));
    el.addEventListener('pointermove', (e) => this.move(e));
    el.addEventListener('pointerup', (e) => this.up(e));
    el.addEventListener('pointercancel', (e) => this.up(e));
    el.addEventListener('lostpointercapture', (e) => this.up(e));
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  pos(e) {
    const r = this.el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  down(e) {
    e.preventDefault();
    if (this.fingers.has(e.pointerId)) return;
    const { x, y } = this.pos(e);
    const hand = x < this.el.clientWidth / 2 ? 0 : 1;
    const used = new Set([...this.fingers.values()].filter((f) => f.hand === hand).map((f) => f.slot));
    let slot = 0;
    while (slot < FINGERS && used.has(slot)) slot++;
    if (slot === FINGERS) return; // more than five fingers on one side
    try {
      this.el.setPointerCapture(e.pointerId);
    } catch {}
    this.fingers.set(e.pointerId, { id: e.pointerId, hand, slot, x, y });
  }

  move(e) {
    const f = this.fingers.get(e.pointerId);
    if (!f) return;
    e.preventDefault();
    Object.assign(f, this.pos(e));
  }

  up(e) {
    this.fingers.delete(e.pointerId);
  }

  clear() {
    this.fingers.clear();
  }
}
