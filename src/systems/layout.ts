// src/systems/layout.ts
// Pure module: no IWSDK imports, no DOM, no renderer.

import type { Pack, PackNode } from '../packs/types';

// ---- Tunable constants (validated by layout.test.ts) ----
// Cycle layout: sockets follow the flow around a floating ring (reference
// arrangement), not a horizontal row. Heights loosely encode the stage.
// The whole structure floats at desk distance (~0.8-0.9 m) so it occupies
// roughly two thirds of the central view — cards are the dominant elements.
export const CYCLE_CENTER = { x: 0.02, y: 0.06 };
// Glasses comfort envelope (validated by layout.test.ts).
export const FOV_HALF_X_DEG = 37;
export const FOV_UP_DEG = 25;
export const FOV_DOWN_DEG = 43;
export const MAX_REACH = 1.2;

export const CARD_WIDTH = 0.115;
export const CARD_HEIGHT = 0.115;
export const CARD_DEPTH = 0.011;

// Immersive spatial composition: the cycle floats UP in front of the player
// while the tray of loose cards sits DOWN on the desk — look down to pick a
// concept, look up to place it. Positions are head-relative at a comfortable
// ~0.85 m, with generous spacing between sockets.
export const DEPTH_SCALE = 1;

// Tray arc down at the desk: two staggered rows (4 + 5), centre-out fill.
export const TRAY_RADIUS = 0.85;
export const TRAY_HALF_ANGLE_DEG = 28;
export const TRAY_Y = -0.3;
export const TRAY_ROWS = 2;
export const TRAY_ROW_GAP = 0.145;
export const TRAY_ROW_COUNTS = [4, 5] as const;
export const TRAY_EXTRA_SLOTS = 2;

// Fixed anchors sit above the structure, left of centre (reference: sun).
export const ANCHOR_RADIUS = 0.6;
export const ANCHOR_Y = 0.40;
export const ANCHOR_X = -0.1;

// Flow-ordered socket positions (movable nodes, index = flow order).
// Screen-fraction positions measured directly from the reference mockup and
// converted through the runtime's projection, so the composition matches the
// reference element-for-element: evaporation lower-left, the flow climbs
// through cooling to clouds upper-right, precipitation right, collection
// bottom-centre-right.
export const CYCLE_SOCKETS: ReadonlyArray<Vec3> = [
  { x: -0.4, y: -0.02, z: -0.8 },   // evaporation (mid-left)
  { x: -0.176, y: 0.02, z: -0.84 }, // water vapor (centre)
  { x: 0.018, y: 0.229, z: -0.84 }, // cooling (upper-middle)
  { x: 0.229, y: 0.088, z: -0.84 }, // condensation
  { x: 0.387, y: 0.264, z: -0.82 }, // clouds (upper-right)
  { x: 0.458, y: -0.035, z: -0.78 },// precipitation (right)
  { x: 0.194, y: -0.132, z: -0.8 }, // collection (bottom-right-of-centre)
];
export const CYCLE_ANCHOR: Vec3 = { x: -0.21, y: 0.334, z: -0.86 };

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface LayoutSocket {
  index: number;
  order: number;
  band: number;
  position: Vec3;
}

export interface LayoutAnchor {
  id: string;
  band: number;
  position: Vec3;
}

export interface TraySlot {
  index: number;
  position: Vec3;
}

export interface Layout {
  sockets: LayoutSocket[];
  solution: Record<string, number>;
  anchors: LayoutAnchor[];
  tray: TraySlot[];
}

export interface LayoutOptions {
  mirror?: boolean;
  /** Swing the cycle ring around its centre (session variety). */
  rotDeg?: number;
  radius?: number;
  halfAngleDeg?: number;
  sameBandExtraRatio?: number;
  bandSpacing?: number;
  bandYMin?: number;
  trayRadius?: number;
  trayHalfAngleDeg?: number;
  trayY?: number;
  trayRows?: number;
  trayRowGap?: number;
  trayRowCounts?: readonly number[];
  trayExtraSlots?: number;
  anchorRadius?: number;
  anchorY?: number;
}

function degToRad(d: number): number {
  return (d * Math.PI) / 180;
}




function applyMirror(p: Vec3, mirror: boolean): Vec3 {
  return mirror ? { x: -p.x, y: p.y, z: p.z } : p;
}

export function distanceFromHead(p: Vec3): number {
  return Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z);
}

export function fitsGlassesFov(
  p: Vec3,
  cardSize: { width: number; height: number },
  opts?: { upDeg?: number },
): boolean {
  if (distanceFromHead(p) > MAX_REACH) return false;
  const halfW = cardSize.width / 2;
  const halfH = cardSize.height / 2;
  const tanX = Math.tan(degToRad(FOV_HALF_X_DEG));
  const tanUp = Math.tan(degToRad(opts?.upDeg ?? FOV_UP_DEG));
  const tanDown = Math.tan(degToRad(FOV_DOWN_DEG));
  const zDist = -p.z;
  if (zDist <= 0) return false;
  const corners: Array<{ x: number; y: number }> = [
    { x: p.x - halfW, y: p.y + halfH },
    { x: p.x + halfW, y: p.y + halfH },
    { x: p.x - halfW, y: p.y - halfH },
    { x: p.x + halfW, y: p.y - halfH },
  ];
  for (const c of corners) {
    if (Math.abs(c.x) / zDist > tanX) return false;
    if (c.y / zDist > tanUp) return false;
    if (-c.y / zDist > tanDown) return false;
  }
  return true;
}


function positionOnArc(angle: number, radius: number, y: number): Vec3 {
  return { x: Math.sin(angle) * radius, y, z: -Math.cos(angle) * radius };
}

function angleForOrder(order: number, count: number, halfAngleDeg: number): number {
  if (count <= 1) return 0;
  const half = degToRad(halfAngleDeg);
  const step = (2 * half) / (count - 1);
  // Centre-out fill keeps any occupied-slot count symmetric.
  const mid = (count - 1) / 2;
  return (order - mid) * step;
}

export function shuffleTray(ids: string[], seed: number): string[] {
  const out = ids.slice();
  let s = (seed >>> 0) || 1;
  for (let i = out.length - 1; i > 0; i--) {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;  s >>>= 0;
    const j = s % (i + 1);
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

export function buildLayout(pack: Pack, opts: LayoutOptions = {}): Layout {
  const mirror = opts.mirror ?? false;
  const trayRadius = opts.trayRadius ?? TRAY_RADIUS;
  const trayHalfAngleDeg = opts.trayHalfAngleDeg ?? TRAY_HALF_ANGLE_DEG;
  const trayY = opts.trayY ?? TRAY_Y;
  const trayRows = opts.trayRows ?? TRAY_ROWS;
  const trayRowGap = opts.trayRowGap ?? TRAY_ROW_GAP;
  const trayRowCounts = opts.trayRowCounts ?? TRAY_ROW_COUNTS;
  const extra = opts.trayExtraSlots ?? TRAY_EXTRA_SLOTS;

  const movable: PackNode[] = [];
  const fixed: PackNode[] = [];
  for (const n of pack.nodes) {
    if (n.fixed) fixed.push(n);
    else movable.push(n);
  }


  const sockets: LayoutSocket[] = [];
  const solution: Record<string, number> = {};
  const rotRad = (opts.rotDeg ?? 0) * (Math.PI / 180);
  const cosR = Math.cos(rotRad);
  const sinR = Math.sin(rotRad);
  for (let order = 0; order < movable.length; order++) {
    const node = movable[order];
    const base = CYCLE_SOCKETS[order % CYCLE_SOCKETS.length];
    // Session rotation swings the ring around the cycle centre (subtle).
    const dx = base.x - CYCLE_CENTER.x;
    const dy = base.y - CYCLE_CENTER.y;
    const pos: Vec3 = {
      x: (CYCLE_CENTER.x + dx * cosR - dy * sinR) * DEPTH_SCALE,
      y: (CYCLE_CENTER.y + dx * sinR + dy * cosR) * DEPTH_SCALE,
      z: base.z * DEPTH_SCALE,
    };
    sockets.push({
      index: order,
      order,
      band: node.band,
      position: applyMirror(pos, mirror),
    });
    solution[node.id] = order;
  }

  const anchors: LayoutAnchor[] = fixed.map((n, i) => {
    // Anchors stay on the left regardless of mirroring (HUD owns the right).
    const stepX = i * 0.0;
    return {
      id: n.id,
      band: n.band,
      position: {
        x: (CYCLE_ANCHOR.x - stepX) * DEPTH_SCALE,
        y: CYCLE_ANCHOR.y * DEPTH_SCALE,
        z: CYCLE_ANCHOR.z * DEPTH_SCALE,
      },
    };
  });

  const trayCount = movable.length + extra;
  const tray: TraySlot[] = [];
  let slotIndex = 0;
  for (let r = 0; r < trayRows && slotIndex < trayCount; r++) {
    const count = trayRowCounts[r] ?? 0;
    const rowY = trayY - r * trayRowGap;
    const remaining = trayCount - slotIndex;
    const thisRow = Math.min(count, remaining);
    for (let i = 0; i < thisRow; i++) {
      const angle = angleForOrder(i, thisRow, trayHalfAngleDeg);
      const pos = applyMirror(positionOnArc(angle, trayRadius, rowY), mirror);
      tray.push({
        index: slotIndex,
        position: {
          x: pos.x * DEPTH_SCALE,
          y: pos.y * DEPTH_SCALE,
          z: pos.z * DEPTH_SCALE,
        },
      });
      slotIndex++;
    }
  }

  return { sockets, solution, anchors, tray };
}