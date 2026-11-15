// src/systems/motion.ts
// Pure motion helpers for the UI/UX polish layer: frame-rate independent
// damping, damped springs and the easing curves shared by card snaps, tray
// returns, panel transitions and HUD feedback (spec §9 timings).
//
// No three.js / IWSDK imports — pure math, safe to unit-test.

/** Frame-rate independent exponential approach (iOS-like smooth follow). */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-lambda * dt));
}

export function easeOutCubic(t: number): number {
  const u = 1 - t;
  return 1 - u * u * u;
}

export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** Gentle single overshoot for card settling (physical, not cartoonish). */
export function easeOutBack(t: number, overshoot = 1.15): number {
  const c3 = overshoot + 1;
  const u = t - 1;
  return 1 + c3 * u * u * u + overshoot * u * u;
}

export function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/**
 * Damped spring driving scale pops, grab compression and button presses.
 * Semi-implicit Euler with a clamped step so tab-switch frame spikes never
 * explode the integrator.
 */
export class SpringValue {
  value: number;
  vel = 0;
  target: number;
  stiffness: number;
  damping: number;

  constructor(value = 1, stiffness = 170, damping = 20) {
    this.value = value;
    this.target = value;
    this.stiffness = stiffness;
    this.damping = damping;
  }

  snap(v: number): void {
    this.value = v;
    this.target = v;
    this.vel = 0;
  }

  /** Jump to a value while keeping velocity (spring will seek `target`). */
  setValueKeepTarget(v: number): void {
    this.value = v;
    this.vel = 0;
  }

  update(dt: number): number {
    const step = Math.min(dt, 1 / 30);
    const acc = (this.target - this.value) * this.stiffness - this.vel * this.damping;
    this.vel += acc * step;
    this.value += this.vel * step;
    return this.value;
  }
}
