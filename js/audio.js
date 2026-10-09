// Sonification engine (Web Audio), following Section 3 of the ShapeSonic paper:
//
// * Left hand -> left channel, right hand -> right channel; left-hand sounds
//   are pitched lower than right-hand sounds. (The contact, edge and corner
//   recordings come as hard-panned LEFT/RIGHT pairs that already differ in
//   pitch; the guidance loop is shared, so we pan it and lower it 2 semitones
//   for the left hand.)
// * Guidance: one ambient loop per hand; the closest outside fingertip sets
//   the volume.
// * Contact: one loop per fingertip, pitched on a major pentatonic scale,
//   volume from that fingertip's depth inside the shape. Switches abruptly.
// * Corner (or edge): a pluck per hand, re-triggered while any fingertip of
//   that hand is near a corner; the closest one sets the volume.
//
// Volume falloff: V(x) = a + b * exp(-5x / D) for 0 <= x < D, else 0, with the
// paper's (a, b) per sound (supplemental Table 1).

export const HANDS = 2; // 0 = left, 1 = right
export const FINGERS = 5; // pentatonic slots per hand

const PENTATONIC = [0, 2, 4, 7, 9]; // semitones: C D E G A
const LEFT_GUIDANCE_SEMITONES = -2;

export const VOLUME = {
  guidance: { a: 0, b: 1 },
  contact: { a: 0, b: 0.8 },
  corner: { a: 0.6, b: 0.4 },
};

// Gain smoothing time constants (s). Contact is abrupt by design.
const TAU = { guidance: 0.04, contact: 0.004, corner: 0.02 };
const PLUCK_INTERVAL = 0.45; // s between re-triggered plucks
// Relative loudness of each sound family (the recordings differ in level).
const MIX = { guidance: 0.5, contact: 0.45, corner: 0.9 };

const FILES = {
  guidance: 'audio/guidance.mp3',
  contact: ['audio/contact-left.mp3', 'audio/contact-right.mp3'],
  edge: ['audio/edge-left.mp3', 'audio/edge-right.mp3'],
  corner: ['audio/corner-left.mp3', 'audio/corner-right.mp3'],
};

export function falloff(x, D, { a, b }) {
  return x >= 0 && x < D ? a + b * Math.exp((-5 * x) / D) : 0;
}

const semitones = (s) => Math.pow(2, s / 12);

export class Sonifier {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.featureSound = 'corner'; // or 'edge'
    this.lastPluck = [-Infinity, -Infinity];
  }

  // Must be called from a user gesture (autoplay policies).
  async start() {
    if (this.ctx) {
      await this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC({ latencyHint: 'interactive' });
    this.ctx = ctx;
    // iOS: play through the silent switch, like a media app.
    try {
      if (navigator.audioSession) navigator.audioSession.type = 'playback';
    } catch {}
    const resumed = ctx.resume();

    const load = async (url) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Could not load ${url}`);
      const bytes = await res.arrayBuffer();
      return new Promise((ok, fail) => ctx.decodeAudioData(bytes, ok, fail));
    };
    const [guidance, contact, edge, corner] = await Promise.all([
      load(FILES.guidance),
      Promise.all(FILES.contact.map(load)),
      Promise.all(FILES.edge.map(load)),
      Promise.all(FILES.corner.map(load)),
    ]);
    this.buffers = { edge, corner };
    await resumed;

    this.master = ctx.createGain();
    this.master.gain.value = 0.8;
    this.master.connect(ctx.destination);

    const loop = (buffer, rate, dest) => {
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = true;
      src.playbackRate.value = rate;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      src.connect(gain).connect(dest);
      src.start(0, Math.random() * buffer.duration);
      return gain;
    };

    this.hands = [];
    for (let h = 0; h < HANDS; h++) {
      const pan = new StereoPannerNode(ctx, { pan: h === 0 ? -1 : 1 });
      pan.connect(this.master);
      const guidanceGain = loop(guidance, h === 0 ? semitones(LEFT_GUIDANCE_SEMITONES) : 1, pan);
      const contactGains = PENTATONIC.map((s) => loop(contact[h], semitones(s), this.master));
      const featureGain = ctx.createGain();
      featureGain.gain.value = 0;
      featureGain.connect(this.master);
      this.hands.push({ guidanceGain, contactGains, featureGain });
    }
    this.ready = true;
  }

  setMasterVolume(v) {
    if (this.master) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  // levels: per hand {guidance, contact: [5], corner} volumes in [0, 1].
  update(levels) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    for (let h = 0; h < HANDS; h++) {
      const node = this.hands[h];
      const lv = levels[h];
      node.guidanceGain.gain.setTargetAtTime(MIX.guidance * lv.guidance, t, TAU.guidance);
      for (let f = 0; f < FINGERS; f++) {
        node.contactGains[f].gain.setTargetAtTime(MIX.contact * lv.contact[f], t, TAU.contact);
      }
      node.featureGain.gain.setTargetAtTime(MIX.corner * lv.corner, t, TAU.corner);
      if (lv.corner > 0) {
        if (t - this.lastPluck[h] >= PLUCK_INTERVAL) {
          const src = this.ctx.createBufferSource();
          src.buffer = this.buffers[this.featureSound][h];
          src.connect(node.featureGain);
          src.start(t);
          this.lastPluck[h] = t;
        }
      } else {
        // Leaving the corner zone and coming back plucks immediately.
        this.lastPluck[h] = -Infinity;
      }
    }
  }

  silence() {
    if (!this.ready) return;
    const quiet = { guidance: 0, contact: new Array(FINGERS).fill(0), corner: 0 };
    this.update([quiet, quiet]);
  }
}
