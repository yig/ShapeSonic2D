// Multi-touch input via Pointer Events (touch, pen, and mouse alike).
//
// A touchscreen does not say which hand or finger a touch belongs to, so the
// hand is decided when the touch starts, by one of two modes:
// * 'split': by which half of the screen it is in;
// * 'order': the first five simultaneous touches are the left hand and the
//   next five the right hand (the earliest free slot, left hand first).
// The finger is the lowest free of that hand's five pentatonic slots.
// A mouse acts as a single fingertip while a button is held.
//
// For low latency, onChange() is called on every finger change, so the audio
// can be updated immediately instead of on the next animation frame. Where
// supported (Chrome, secure contexts) we also listen to pointerrawupdate,
// which is delivered as soon as input arrives rather than aligned to frames.

import { HANDS, FINGERS } from './audio.js';

export const HAND_MODES = ['split', 'order'];

export class FingerTracker {
  constructor(el) {
    this.el = el;
    this.fingers = new Map(); // pointerId -> {id, hand, slot, x, y}
    this.handMode = 'split';
    this.onChange = null;

    el.addEventListener('pointerdown', (e) => this.down(e));
    el.addEventListener('pointermove', (e) => this.move(e));
    if ('onpointerrawupdate' in window) el.addEventListener('pointerrawupdate', (e) => this.move(e));
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
    const hands = this.handMode === 'order' ? [...Array(HANDS).keys()] : [x < this.el.clientWidth / 2 ? 0 : 1];
    const free = hands.map((h) => this.freeSlot(h));
    const i = free.findIndex((s) => s >= 0);
    if (i < 0) return; // no free finger slot (more than five on one hand)
    const hand = hands[i];
    const slot = free[i];
    try {
      this.el.setPointerCapture(e.pointerId);
    } catch {}
    this.fingers.set(e.pointerId, { id: e.pointerId, hand, slot, x, y });
    this.changed();
  }

  changed() {
    if (this.onChange) this.onChange();
  }

  freeSlot(hand) {
    const used = new Set([...this.fingers.values()].filter((f) => f.hand === hand).map((f) => f.slot));
    for (let slot = 0; slot < FINGERS; slot++) if (!used.has(slot)) return slot;
    return -1;
  }

  move(e) {
    const f = this.fingers.get(e.pointerId);
    if (!f) return;
    if (e.type === 'pointermove') e.preventDefault();
    const { x, y } = this.pos(e);
    if (x === f.x && y === f.y) return; // already seen via pointerrawupdate
    f.x = x;
    f.y = y;
    this.changed();
  }

  up(e) {
    if (this.fingers.delete(e.pointerId)) this.changed();
  }

  clear() {
    this.fingers.clear();
    this.changed();
  }
}
