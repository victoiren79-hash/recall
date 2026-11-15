// src/systems/audio.ts
// Procedural sound design (Web Audio API) — zero asset files. Every voice is
// synthesized from oscillators and filtered noise, so all audio is original,
// license-clean, offline, and adds nothing to the download.
//
// Design language (spec §10): quiet, pleasant, distinct, never essential.
// Interaction sounds are spatially placed at the card/connection positions
// (HRTF panners + a per-frame listener pose), so in VR you hear WHERE things
// happen. The completion sequence plays the loop as an ascending pentatonic
// melody and resolves on a literal chord.

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noiseBuf: AudioBuffer | null = null;

/** Pentatonic frequencies for the eight connections, in flow order. */
const LINK_NOTES = [261.63, 293.66, 329.63, 392.0, 440.0, 523.25, 587.33, 659.26];

/** Create/resume the context. Safe to call before any user gesture. */
export function ensureAudio(): AudioContext | null {
  try {
    if (!ctx) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      ctx = new Ctor();
      // Gentle limiting so layered voices never clip.
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -18;
      limiter.knee.value = 24;
      limiter.ratio.value = 6;
      limiter.attack.value = 0.004;
      limiter.release.value = 0.18;
      master = ctx.createGain();
      master.gain.value = 0.5;
      master.connect(limiter);
      limiter.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

/** Sync the listener to the head pose — call once per frame. */
export function updateListener(
  px: number,
  py: number,
  pz: number,
  yaw: number,
): void {
  const c = ctx;
  if (!c) return;
  const l = c.listener;
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  try {
    if (l.positionX) {
      l.positionX.value = px;
      l.positionY.value = py;
      l.positionZ.value = pz;
      l.forwardX.value = fx;
      l.forwardY.value = 0;
      l.forwardZ.value = fz;
      l.upX.value = 0;
      l.upY.value = 1;
      l.upZ.value = 0;
    } else if (l.setPosition) {
      l.setPosition(px, py, pz);
      l.setOrientation(fx, 0, fz, 0, 1, 0);
    }
  } catch {
    // Listener API differences — spatialization is best-effort.
  }
}

/** Route a voice through a HRTF panner at a world position (best-effort). */
function spatial(node: AudioNode, pos?: { x: number; y: number; z: number }): void {
  const c = ctx;
  if (!c || !master) return;
  if (pos) {
    try {
      const p = c.createPanner();
      p.panningModel = 'HRTF';
      p.distanceModel = 'inverse';
      p.refDistance = 0.4;
      p.maxDistance = 4;
      p.rolloffFactor = 1.1;
      if (p.positionX) {
        p.positionX.value = pos.x;
        p.positionY.value = pos.y;
        p.positionZ.value = pos.z;
      } else if (p.setPosition) {
        p.setPosition(pos.x, pos.y, pos.z);
      }
      node.connect(p);
      p.connect(master);
      return;
    } catch {
      // Fall through to non-spatial.
    }
  }
  node.connect(master);
}

function getNoise(c: AudioContext): AudioBuffer {
  if (!noiseBuf) {
    noiseBuf = c.createBuffer(1, Math.floor(c.sampleRate * 0.8), c.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  return noiseBuf;
}

interface ToneOpts {
  type?: OscillatorType;
  gain?: number;
  /** Seconds to reach full level. */
  attack?: number;
  /** Exponential pitch slide target. */
  slideTo?: number;
  delay?: number;
}

function tone(
  freq: number,
  dur: number,
  opts: ToneOpts = {},
  pos?: { x: number; y: number; z: number },
): void {
  const c = ensureAudio();
  if (!c || !master) return;
  const t0 = c.currentTime + (opts.delay ?? 0);
  const osc = c.createOscillator();
  osc.type = opts.type ?? 'sine';
  osc.frequency.setValueAtTime(freq, t0);
  if (opts.slideTo) {
    osc.frequency.exponentialRampToValueAtTime(opts.slideTo, t0 + dur);
  }
  const g = c.createGain();
  const peak = opts.gain ?? 0.12;
  const attack = opts.attack ?? 0.012;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g);
  spatial(g, pos);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
}

function noiseSweep(
  dur: number,
  f0: number,
  f1: number,
  gain: number,
): void {
  const c = ensureAudio();
  if (!c || !master) return;
  const t0 = c.currentTime;
  const src = c.createBufferSource();
  src.buffer = getNoise(c);
  const bp = c.createBiquadFilter();
  bp.type = 'bandpass';
  bp.Q.value = 1.1;
  bp.frequency.setValueAtTime(f0, t0);
  bp.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + dur * 0.3);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(bp);
  bp.connect(g);
  g.connect(master);
  src.start(t0);
  src.stop(t0 + dur + 0.05);
}

export const sfx = {
  /** Card grabbed — a soft tick at the card. */
  grab(pos?: { x: number; y: number; z: number }): void {
    tone(190, 0.09, { type: 'triangle', gain: 0.09, slideTo: 150 }, pos);
  },

  /** Card placed correctly — a warm thock pressed into the socket. */
  place(pos: { x: number; y: number; z: number }): void {
    tone(165, 0.16, { type: 'sine', gain: 0.2, slideTo: 92 }, pos);
    tone(520, 0.05, { type: 'triangle', gain: 0.05 }, pos);
  },

  /** A connection lit — the next note of the ascending pentatonic melody. */
  linkNote(index: number, pos?: { x: number; y: number; z: number }): void {
    const f = LINK_NOTES[((index % LINK_NOTES.length) + LINK_NOTES.length) % LINK_NOTES.length];
    tone(f, 0.5, { type: 'sine', gain: 0.13 }, pos);
    tone(f * 2, 0.28, { type: 'sine', gain: 0.045 }, pos);
  },

  /** Placement rejected — a muted low bump. Gentle, never punishing. */
  reject(pos?: { x: number; y: number; z: number }): void {
    tone(140, 0.14, { type: 'sine', gain: 0.11, slideTo: 108 }, pos);
  },

  /** Scramble — one soft whoosh as the cards fly to the table. */
  scramble(): void {
    noiseSweep(0.5, 520, 140, 0.09);
  },

  /** HUD button — a tiny, quiet tick. */
  button(): void {
    tone(1500, 0.025, { type: 'triangle', gain: 0.045 });
  },

  /** Day transition — two soft rising notes. */
  dayChime(): void {
    tone(392, 0.3, { type: 'sine', gain: 0.07 });
    tone(523.25, 0.4, { type: 'sine', gain: 0.07, delay: 0.18 });
  },

  /**
   * Completion comet: the melodic note for link `index`, scheduled `delay`
   * seconds out (Web Audio scheduling is sample-accurate).
   */
  cometNote(index: number, delay: number, pos?: { x: number; y: number; z: number }): void {
    const f = LINK_NOTES[((index % LINK_NOTES.length) + LINK_NOTES.length) % LINK_NOTES.length];
    tone(f, 0.55, { type: 'sine', gain: 0.15, delay }, pos);
    tone(f * 2, 0.3, { type: 'sine', gain: 0.05, delay: delay + 0.05 }, pos);
  },

  /** The final chord: all eight notes together over a low root. */
  finalChord(delay = 0): void {
    tone(130.81, 1.5, { type: 'sine', gain: 0.15, delay });
    for (const f of LINK_NOTES) {
      tone(f, 1.3, { type: 'sine', gain: 0.065, delay });
      tone(f * 2, 0.9, { type: 'sine', gain: 0.028, delay: delay + 0.03 });
    }
  },

  /** Soft airy swell for the shockwave rings. */
  swell(delay = 0): void {
    noiseSweep(1.1, 220, 900, 0.06);
    void delay;
  },
};
