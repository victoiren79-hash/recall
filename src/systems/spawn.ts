// src/systems/spawn.ts
// Builds the SEE-state scene: sockets, cards, anchors, links, tray, room.
//
// Coordinate contract (shared with interaction.ts and index.ts):
//  - `root` is positioned at the head pose (position + yaw + optional session
//    rotation). EVERY child uses root-LOCAL, head-relative coordinates taken
//    straight from layout.ts (head at the local origin, looking toward -z).
//  - Re-anchoring (XR session start/end) only moves `root`.
// All materials are unlit (MeshBasicMaterial) so nothing depends on scene lighting.
//
// Visual language — matched element-for-element to the reference mockup:
//  - Warm, softly lit study room: grey-purple wall, plant, wooden shelf with
//    books, dark framed artwork, and a LIGHT LAVENDER curved table.
//  - Cards are bright frosted-glass tiles with a hot cyan border, a large
//    painted icon, and a dark label pill straddling the bottom edge.
//  - Links are luminous blue arrows with real bloom; the sun link is golden.
//  - "Sun Heat" is a golden-outlined pill under a burning sun orb.
//  - While a card is held, a dashed grey preview arc curves toward the
//    nearest empty socket (the reference's drag affordance).

import {
  AmbientLight,
  PointLight,
  Mesh,
  PlaneGeometry,
  CylinderGeometry,
  BoxGeometry,
  MeshBasicMaterial,
  MeshStandardMaterial,
  MeshPhysicalMaterial,
  CanvasTexture,
  SRGBColorSpace,
  DoubleSide,
  AdditiveBlending,
  Sprite,
  SpriteMaterial,
  QuadraticBezierCurve3,
  Shape,
  ShapeGeometry,
  ExtrudeGeometry,
  TubeGeometry,
  ConeGeometry,
  SphereGeometry,
  RingGeometry,
  Group,
  Quaternion,
  Vector3,
  type Texture,
  type Material,
  type BufferGeometry,
} from '@iwsdk/core';

import type { Distractor, Pack, PackLink, PackNode } from '../packs/types';
import { sfx } from './audio';
import type { Layout, Vec3 } from './layout';
import { CARD_WIDTH, CARD_HEIGHT } from './layout';
import { Card, Socket, LinkLine } from '../components';
import { clamp01, damp, easeInOutCubic, easeOutCubic } from './motion';

export interface HeadPose {
  position: Vec3;
  yaw: number;
}

export interface SpawnOptions {
  /** Extra yaw applied to the whole structure ("rotated layout" sessions). */
  rotDeg?: number;
  /** Distractor pieces spawned into the tray's outer slots. */
  distractors?: Distractor[];
  /** Links rendered nearly invisible until satisfied. */
  hiddenLinkIds?: string[];
  /** Per-link strength 0..1 (drives ghost brightness via feedback). */
  linkStrengths?: Record<string, number>;
  /** Movable nodes that start in the tray (weak links in session 4+). */
  removedNodeIds?: string[];
}

/** Materials driving one link's visual state (the feedback system animates these). */
export interface LinkMaterialPair {
  core: MeshBasicMaterial;
  glow: MeshBasicMaterial;
}

export interface SpawnHandles {
  cardsByNodeId: Map<string, any>;
  socketsByIndex: Map<number, any>;
  linksById: Map<string, any>;
  linkMaterialsById: Map<string, LinkMaterialPair>;
  /** Tray slot index for cards spawned outside sockets (removed nodes + distractors). */
  traySpawnSlots: Map<string, number>;
  /** Tray cards with a per-card hover phase — the idle float animation. */
  floatItems: Array<{ entity: any; phase: number }>;
  /**
   * XR framing: while presenting, the cycle pulls in (the wide XR field of
   * view makes the same distances feel far). The tray keeps its natural arc
   * positions in both modes (framing retired by user request). No-op on the
   * flat page.
   */
  applyXRLayout: (isXR: boolean) => void;
  sharedGeometries: BufferGeometry[];
  sharedMaterials: Material[];
  sharedTextures: Texture[];
  /** Every entity created for this structure — disposed on session teardown. */
  entities: any[];
  /** Materials that breathe (pulse) so the rebuild state feels alive. */
  pulseItems: Array<{
    mat: { opacity: number };
    base: number;
    amp: number;
    speed: number;
    phase: number;
  }>;
  /** Advance the pulse animations. Call once per frame, t in seconds. */
  tickPulse: (t: number) => void;
  /**
   * Show (from != null) or hide the dashed preview arc from a held card to
   * the nearest empty socket. Coordinates are structure-local. Call every
   * frame while a card is held so the arc tracks the card.
   */
  setDragPreview: (from: Vec3 | null, to: Vec3) => void;
  /** Un-rotated head anchor; the HUD parents here and stays head-stable. */
  root: any;
  /** Rotated inner group holding the structure (session rotation lives here). */
  structure: any;
  baseHead: HeadPose;
  rotRad: number;
  // ---- UI/UX polish layer (spec §5) ----
  /** Advance the polish animations (ripples, link draws, motes, glow). */
  tickMotion: (dt: number, t: number) => void;
  /** Expanding ring at a socket position (structure-local) after a snap. */
  rippleAt: (pos: Vec3) => void;
  /** Progressive illumination + traveling light for a newly satisfied link. */
  playLinkDraw: (linkId: string) => void;
  /** True while the polish layer is animating a link's materials. */
  isLinkAnimating: (linkId: string) => boolean;
  /** Completion: illumination wave through every connection, in sequence. */
  playCompletionWave: () => void;
  /** Completion: gentle environmental light transition (no fireworks). */
  setCompletionGlow: (on: boolean) => void;
  /** Build any connection whose endpoints are both placed but missing. */
  ensureLinks: () => void;
  /** World midpoint of a connection, for its spatial note. */
  linkMidpoint: (id: string) => { x: number; y: number; z: number } | null;
  /** Diagnostic snapshot of the completion-sequence state (dev/e2e). */
  completionDebug: () => {
    waveLinks: number;
    ringVisible: boolean;
    ringScale: number;
    bloomVisible: boolean;
    bloomOpacity: number;
    flareArmed: boolean;
    flareActive: boolean;
    dotsBusy: number;
  };
}

// Luminous arrows matched to the reference: THIN bright lines whose halo
// comes from the bloom pass (not fat tubes), with clean, clearly-aimed
// arrowheads at the destination edge.
const LINK_BACK_OFFSET_M = 0.014;
const LINK_CORE_RADIUS_M = 0.0035;
const LINK_GLOW_RADIUS_M = 0.01;
const ARROWHEAD_RADIUS_M = 0.014;
const ARROWHEAD_LENGTH_M = 0.034;
// Gentle curve — the reference arcs are smooth, not banana loops.
const LINK_BOW_CENTER = { x: 0.02, y: 0.05, z: -0.85 };
const LINK_BOW_RATIO = 0.1;
// The closing Collection → Evaporation link sweeps below the whole cycle.
const WRAP_LINK_BOW_RATIO = 0.3;
// Links attach just outside the card edges instead of at the centres.
const LINK_EDGE_INSET_M = 0.062;

// 2x canvas resolution keeps cards crisp at the desk distance.
const CARD_TEX_W = 1024;
const CARD_TEX_H = 1024;

const FONT_STACK =
  '600 {SIZE}px system-ui, -apple-system, "Segoe UI", "Segoe UI Emoji", "Noto Color Emoji", Roboto, Arial, sans-serif';
const EMOJI_STACK =
  '{SIZE}px system-ui, -apple-system, "Segoe UI Emoji", "Noto Color Emoji", "Apple Color Emoji", sans-serif';

const DEG_TO_RAD = Math.PI / 180;

function linkIdOf(from: string, to: string): string {
  return from + '>' + to;
}

function yawFacingHead(local: Vec3): number {
  return Math.atan2(-local.x, -local.z);
}

function pushBehind(p: Vec3): Vec3 {
  const len = Math.hypot(p.x, p.z);
  if (len < 1e-6) return { x: p.x, y: p.y, z: p.z };
  return {
    x: p.x + (p.x / len) * LINK_BACK_OFFSET_M,
    y: p.y,
    z: p.z + (p.z / len) * LINK_BACK_OFFSET_M,
  };
}

function wrapLabel(ctx: CanvasRenderingContext2D, label: string, maxWidth: number): string[] {
  const words = label.split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const w of words) {
    const candidate = current ? current + ' ' + w : w;
    if (ctx.measureText(candidate).width <= maxWidth || !current) {
      current = candidate;
    } else {
      lines.push(current);
      current = w;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/** Rounded-rectangle path (centred) for extruded tiles and socket outlines. */
function roundedRectShape(w: number, h: number, r: number): Shape {
  const shape = new Shape();
  const x = -w / 2;
  const y = -h / 2;
  shape.moveTo(x + r, y);
  shape.lineTo(x + w - r, y);
  shape.quadraticCurveTo(x + w, y, x + w, y + r);
  shape.lineTo(x + w, y + h - r);
  shape.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  shape.lineTo(x + r, y + h);
  shape.quadraticCurveTo(x, y + h, x, y + h - r);
  shape.lineTo(x, y + r);
  shape.quadraticCurveTo(x, y, x + r, y);
  return shape;
}

type IconPainter = (ctx: CanvasRenderingContext2D, x: number, y: number, s: number) => void;

/** Procedural concept icons — glossy 3D-looking art as in the reference. */
const ICON_PAINTERS: Record<string, IconPainter> = {
  droplet(ctx, x, y, s) {
    const r = s * 0.36;
    const g = ctx.createLinearGradient(x - r, y - r, x + r, y + r);
    g.addColorStop(0, '#8fdcff');
    g.addColorStop(0.45, '#2ba0e8');
    g.addColorStop(1, '#0a5ba8');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(x, y - s * 0.56);
    ctx.bezierCurveTo(x + r * 1.2, y - s * 0.08, x + r, y + s * 0.24, x, y + s * 0.44);
    ctx.bezierCurveTo(x - r, y + s * 0.24, x - r * 1.2, y - s * 0.08, x, y - s * 0.56);
    ctx.fill();
    // glossy highlight
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath();
    ctx.ellipse(x - r * 0.34, y - s * 0.02, r * 0.18, r * 0.34, -0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.beginPath();
    ctx.ellipse(x + r * 0.3, y + s * 0.22, r * 0.1, r * 0.16, 0.5, 0, Math.PI * 2);
    ctx.fill();
  },
  vapor(ctx, x, y, s) {
    const puffs: Array<[number, number, number]> = [
      [-s * 0.28, s * 0.18, s * 0.22],
      [s * 0.04, s * 0.0, s * 0.3],
      [s * 0.32, s * 0.16, s * 0.2],
      [s * 0.0, s * 0.32, s * 0.24],
      [-s * 0.18, -s * 0.16, s * 0.2],
    ];
    for (const [dx, dy, r] of puffs) {
      const g = ctx.createRadialGradient(x + dx - r * 0.25, y + dy - r * 0.35, r * 0.15, x + dx, y + dy, r);
      g.addColorStop(0, 'rgba(255, 255, 255, 1)');
      g.addColorStop(0.55, 'rgba(214, 230, 244, 0.98)');
      g.addColorStop(1, 'rgba(130, 165, 200, 0.75)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x + dx, y + dy, r, 0, Math.PI * 2);
      ctx.fill();
    }
  },
  snowflake(ctx, x, y, s) {
    const r = s * 0.46;
    ctx.strokeStyle = '#dcedfa';
    ctx.lineCap = 'round';
    for (let k = 0; k < 6; k++) {
      const a = (k * Math.PI) / 3;
      const dx = Math.cos(a) * r;
      const dy = Math.sin(a) * r;
      ctx.lineWidth = s * 0.075;
      ctx.strokeStyle = 'rgba(160, 210, 250, 0.9)';
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + dx, y + dy);
      ctx.stroke();
      for (const t of [0.55, 0.8]) {
        const bx = x + dx * t;
        const by = y + dy * t;
        const bl = r * 0.28;
        for (const side of [-1, 1]) {
          const ba = a + side * Math.PI / 3.2;
          ctx.lineWidth = s * 0.06;
          ctx.strokeStyle = '#ffffff';
          ctx.beginPath();
          ctx.moveTo(bx, by);
          ctx.lineTo(bx + Math.cos(ba) * bl, by + Math.sin(ba) * bl);
          ctx.stroke();
        }
      }
    }
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(x, y, s * 0.07, 0, Math.PI * 2);
    ctx.fill();
  },
  condensation(ctx, x, y, s) {
    // Condensation: droplets beading on a cold surface — visually distinct
    // from Evaporation's single rising droplet.
    const surfaceY = y - s * 0.08;
    const sheen = ctx.createLinearGradient(x - s * 0.5, surfaceY, x + s * 0.5, surfaceY);
    sheen.addColorStop(0, 'rgba(160, 215, 255, 0.12)');
    sheen.addColorStop(0.5, 'rgba(195, 232, 255, 0.55)');
    sheen.addColorStop(1, 'rgba(160, 215, 255, 0.12)');
    ctx.fillStyle = sheen;
    ctx.beginPath();
    ctx.roundRect(x - s * 0.5, surfaceY - s * 0.05, s, s * 0.075, s * 0.035);
    ctx.fill();
    const bead = (cx: number, cy: number, r: number): void => {
      const g = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, r * 0.1, cx, cy, r);
      g.addColorStop(0, '#cdeaff');
      g.addColorStop(0.55, '#3aa7e8');
      g.addColorStop(1, '#0a5ba8');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
      ctx.beginPath();
      ctx.ellipse(cx - r * 0.3, cy - r * 0.35, r * 0.22, r * 0.13, -0.6, 0, Math.PI * 2);
      ctx.fill();
    };
    bead(x - s * 0.15, surfaceY + s * 0.2, s * 0.17);
    bead(x + s * 0.15, surfaceY + s * 0.12, s * 0.1);
    bead(x + s * 0.33, surfaceY + s * 0.05, s * 0.065);
    // Wisps of vapor arriving at the surface.
    ctx.strokeStyle = 'rgba(214, 235, 250, 0.7)';
    ctx.lineWidth = s * 0.03;
    ctx.lineCap = 'round';
    const wisps: Array<[number, number, number]> = [
      [-s * 0.3, -s * 0.28, s * 0.07],
      [s * 0.24, -s * 0.32, s * 0.055],
    ];
    for (const [dx, dy, r] of wisps) {
      ctx.beginPath();
      ctx.arc(x + dx, y + dy, r, 0, Math.PI * 2);
      ctx.stroke();
    }
  },
  cloud(ctx, x, y, s) {
    const puffs: Array<[number, number, number]> = [
      [-s * 0.34, s * 0.1, s * 0.24],
      [-s * 0.1, -s * 0.12, s * 0.3],
      [s * 0.18, -s * 0.04, s * 0.27],
      [s * 0.38, s * 0.12, s * 0.2],
    ];
    for (const [dx, dy, r] of puffs) {
      const g = ctx.createRadialGradient(x + dx - r * 0.25, y + dy - r * 0.4, r * 0.2, x + dx, y + dy, r);
      g.addColorStop(0, '#f2f7fc');
      g.addColorStop(0.65, '#dfeaf6');
      g.addColorStop(1, 'rgba(185, 208, 232, 0.95)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x + dx, y + dy, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = 'rgba(214, 230, 246, 0.95)';
    ctx.beginPath();
    ctx.roundRect(x - s * 0.44, y + s * 0.12, s * 0.88, s * 0.18, s * 0.09);
    ctx.fill();
  },
  rain(ctx, x, y, s) {
    // Rain-streak icon: vertical blue lines falling across the icon area
    // (spec: "dark card with vertical blue rain lines").
    ctx.lineCap = 'round';
    for (let k = 0; k < 7; k++) {
      const dx = -s * 0.36 + k * s * 0.12;
      const len = s * (0.28 + ((k * 29) % 3) * 0.09);
      const y0 = -s * 0.4 + ((k * 17) % 3) * s * 0.12;
      const g = ctx.createLinearGradient(x + dx, y + y0, x + dx, y + y0 + len);
      g.addColorStop(0, 'rgba(190, 235, 255, 0.95)');
      g.addColorStop(1, 'rgba(70, 160, 235, 0.4)');
      ctx.strokeStyle = g;
      ctx.lineWidth = s * 0.055;
      ctx.beginPath();
      ctx.moveTo(x + dx, y + y0);
      ctx.lineTo(x + dx - s * 0.03, y + y0 + len);
      ctx.stroke();
    }
  },
  lake(ctx, x, y, s) {
    // rolling hills
    ctx.fillStyle = '#3f8f57';
    ctx.beginPath();
    ctx.ellipse(x - s * 0.24, y + s * 0.08, s * 0.36, s * 0.3, 0, Math.PI, 0);
    ctx.fill();
    ctx.fillStyle = '#4da866';
    ctx.beginPath();
    ctx.ellipse(x + s * 0.26, y + s * 0.1, s * 0.32, s * 0.26, 0, Math.PI, 0);
    ctx.fill();
    // little tree
    ctx.fillStyle = '#2e6e44';
    ctx.beginPath();
    ctx.arc(x - s * 0.05, y - s * 0.06, s * 0.09, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#6b4a2e';
    ctx.fillRect(x - s * 0.065, y - s * 0.01, s * 0.03, s * 0.07);
    // lake
    const g = ctx.createLinearGradient(x, y - s * 0.02, x, y + s * 0.34);
    g.addColorStop(0, '#7fd0ff');
    g.addColorStop(1, '#1e7ac2');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(x, y + s * 0.18, s * 0.44, s * 0.2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.beginPath();
    ctx.ellipse(x - s * 0.1, y + s * 0.13, s * 0.16, s * 0.045, 0, 0, Math.PI * 2);
    ctx.fill();
  },
  sun(ctx, x, y, s) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, s * 0.42);
    g.addColorStop(0, '#fff6d0');
    g.addColorStop(0.55, '#ffd45e');
    g.addColorStop(1, 'rgba(255, 150, 40, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, s * 0.42, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#ffcf5a';
    ctx.lineWidth = s * 0.05;
    ctx.lineCap = 'round';
    for (let k = 0; k < 12; k++) {
      const a = (k * Math.PI) / 6;
      ctx.beginPath();
      ctx.moveTo(x + Math.cos(a) * s * 0.3, y + Math.sin(a) * s * 0.3);
      ctx.lineTo(x + Math.cos(a) * s * 0.42, y + Math.sin(a) * s * 0.42);
      ctx.stroke();
    }
  },
};


/**
 * Card face texture — clean transparent hologram: a whisper of glass with a
 * thin glowing border, one big painted icon, and clear white text beneath it.
 * No boxy fills, no label pill — one image, easy clear text.
 */
function makeCardTexture(
  label: string,
  icon: string | undefined,
  maxAnisotropy: number,
): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = CARD_TEX_W;
  canvas.height = CARD_TEX_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('spawn: 2D canvas context unavailable');

  ctx.clearRect(0, 0, CARD_TEX_W, CARD_TEX_H);

  // Frosted glass with ONE clean thin border — crisp stroke, no glow, no
  // double lines (user: "clean one line borders").
  ctx.fillStyle = 'rgba(16, 32, 64, 0.32)';
  ctx.beginPath();
  ctx.roundRect(24, 24, CARD_TEX_W - 48, CARD_TEX_H - 48, 84);
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = 'rgba(170, 216, 255, 0.75)';
  ctx.stroke();

  // Icon: big painted concept art centred in the upper portion.
  const iconCx = CARD_TEX_W / 2;
  const iconCy = CARD_TEX_H * 0.37;
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
  ctx.shadowBlur = 16;
  ctx.shadowOffsetY = 7;
  if (icon && ICON_PAINTERS[icon]) {
    ICON_PAINTERS[icon](ctx, iconCx, iconCy, 440);
  } else if (icon) {
    ctx.font = EMOJI_STACK.replace('{SIZE}', '420');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(icon, iconCx, iconCy);
  }
  ctx.restore();

  // Soft scrim behind the label: a gentle shade grounding the text into the
  // glass — NOT a pill or box (user rejected that), just material shading.
  const scrim = ctx.createLinearGradient(0, CARD_TEX_H * 0.6, 0, CARD_TEX_H - 24);
  scrim.addColorStop(0, 'rgba(6, 10, 20, 0)');
  scrim.addColorStop(1, 'rgba(6, 10, 20, 0.5)');
  ctx.fillStyle = scrim;
  ctx.beginPath();
  ctx.roundRect(24, CARD_TEX_H * 0.6, CARD_TEX_W - 48, CARD_TEX_H * 0.4 - 24, [0, 0, 84, 84]);
  ctx.fill();

  // Big, bold, letter-spaced white label (user: "make the texts clearly").
  let fontSize = 118;
  const labelFont = (size: number): string =>
    FONT_STACK.replace('{SIZE}', String(size)).replace('600 ', '800 ');
  ctx.font = labelFont(fontSize);
  while (ctx.measureText(label).width > CARD_TEX_W - 120 && fontSize > 66) {
    fontSize -= 6;
    ctx.font = labelFont(fontSize);
  }
  ctx.save();
  (ctx as unknown as { letterSpacing: string }).letterSpacing = '3px';
  ctx.shadowColor = 'rgba(2, 6, 14, 0.95)';
  ctx.shadowBlur = 16;
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, CARD_TEX_W / 2, CARD_TEX_H * 0.83);
  ctx.restore();

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = maxAnisotropy;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Anchor plate, matched to the reference: "Sun Heat" as a golden-outlined
 * pill on a dark body, "(Fixed Anchor)" caption in grey below it.
 */
function makeAnchorPlateTexture(label: string, maxAnisotropy: number): CanvasTexture {
  const widthPx = 1024;
  const heightPx = 640;
  const canvas = document.createElement('canvas');
  canvas.width = widthPx;
  canvas.height = heightPx;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('spawn: 2D canvas context unavailable');

  ctx.clearRect(0, 0, widthPx, heightPx);

  // Golden pill.
  ctx.shadowColor = '#ffc44d';
  ctx.shadowBlur = 40;
  ctx.fillStyle = 'rgba(20, 16, 8, 0.92)';
  ctx.beginPath();
  ctx.roundRect(72, 60, widthPx - 144, 300, 150);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.lineWidth = 8;
  ctx.strokeStyle = 'rgba(255, 200, 84, 0.95)';
  ctx.stroke();
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(255, 240, 200, 0.8)';
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffffff';
  ctx.font = FONT_STACK.replace('{SIZE}', '124');
  ctx.fillText(label, widthPx / 2, 214);

  // Caption pill.
  ctx.fillStyle = 'rgba(12, 16, 26, 0.85)';
  ctx.beginPath();
  ctx.roundRect(192, 430, widthPx - 384, 150, 75);
  ctx.fill();
  ctx.fillStyle = 'rgba(196, 208, 226, 0.95)';
  ctx.font = FONT_STACK.replace('{SIZE}', '78');
  ctx.fillText('(Fixed Anchor)', widthPx / 2, 510);

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = maxAnisotropy;
  texture.needsUpdate = true;
  return texture;
}

/** Soft radial glow used by the anchor orb (hot core -> warm halo). */
function makeRadialGlowTexture(): CanvasTexture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('spawn: 2D canvas context unavailable');

  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255, 252, 230, 1)');
  grad.addColorStop(0.16, 'rgba(255, 220, 120, 0.95)');
  grad.addColorStop(0.42, 'rgba(255, 176, 64, 0.4)');
  grad.addColorStop(1, 'rgba(255, 150, 40, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/**
 * The room's back wall, per the spec: near-black charcoal/navy
 * (#0a0e14 -> #1a1f2e), low-key, with soft light washes and a fine plaster
 * grain. The furniture (plant, shelf, artwork) is real 3D geometry now —
 * the wall is just the calm surface behind it.
 */
function makeWallTexture(): CanvasTexture {
  const W = 2048;
  const H = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('spawn: 2D canvas context unavailable');

  const wall = ctx.createLinearGradient(0, 0, 0, H);
  wall.addColorStop(0, '#1e2534');
  wall.addColorStop(0.5, '#303a52');
  wall.addColorStop(1, '#3e4a66');
  ctx.fillStyle = wall;
  ctx.fillRect(0, 0, W, H);

  // Fine plaster grain: low-alpha speckle keeps the wall from reading flat.
  ctx.fillStyle = 'rgba(255, 255, 255, 0.016)';
  for (let i = 0; i < 2600; i++) {
    const x = (i * 761) % W;
    const y = (i * 397) % H;
    const s = 1 + ((i * 13) % 3);
    ctx.fillRect(x, y, s, s);
  }
  ctx.fillStyle = 'rgba(0, 0, 0, 0.02)';
  for (let i = 0; i < 1800; i++) {
    const x = (i * 947) % W;
    const y = (i * 613) % H;
    const s = 1 + ((i * 7) % 3);
    ctx.fillRect(x, y, s, s);
  }

  // Very soft light washes: faint window light upper-left, cool pool centre.
  const warm = ctx.createRadialGradient(W * 0.14, H * 0.24, 0, W * 0.14, H * 0.24, W * 0.28);
  warm.addColorStop(0, 'rgba(150, 168, 205, 0.13)');
  warm.addColorStop(1, 'rgba(150, 168, 205, 0)');
  ctx.fillStyle = warm;
  ctx.fillRect(0, 0, W, H);
  const cool = ctx.createRadialGradient(W * 0.48, H * 0.42, 0, W * 0.48, H * 0.42, W * 0.3);
  cool.addColorStop(0, 'rgba(105, 145, 200, 0.11)');
  cool.addColorStop(1, 'rgba(105, 145, 200, 0)');
  ctx.fillStyle = cool;
  ctx.fillRect(0, 0, W, H);

  // Soft vignette.
  const vig = ctx.createRadialGradient(W / 2, H / 2, H * 0.45, W / 2, H / 2, W * 0.6);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(0,0,0,0.2)');
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, W, H);

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/** The floor: dark planks with a light pool under the desk. */
function makeFloorTexture(): CanvasTexture {
  const W = 1024;
  const H = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('spawn: 2D canvas context unavailable');

  ctx.fillStyle = '#17141c';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(255,255,255,0.03)';
  ctx.lineWidth = 2;
  for (let y = 0; y <= H; y += H / 14) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }
  const pool = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, W * 0.5);
  pool.addColorStop(0, 'rgba(140, 130, 170, 0.14)');
  pool.addColorStop(1, 'rgba(140, 130, 170, 0)');
  ctx.fillStyle = pool;
  ctx.fillRect(0, 0, W, H);

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/**
 * The curved table in the foreground, per the spec: light tan/beige surface
 * softly lit from above, arcing across the bottom of the frame.
 */
function makeDeskTexture(): CanvasTexture {
  const W = 1024;
  const H = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('spawn: 2D canvas context unavailable');

  const base = ctx.createRadialGradient(W * 0.5, H * 0.34, 0, W * 0.5, H * 0.34, W * 0.72);
  base.addColorStop(0, '#c6c0d6');
  base.addColorStop(0.45, '#a8a2bc');
  base.addColorStop(0.8, '#8f8aa4');
  base.addColorStop(1, '#7d7890');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, W, H);

  // Fine brushed streaks.
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1.5;
  for (let i = 0; i < 60; i++) {
    const y = (i * 17) % H;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y + ((i * 13) % 9) - 4);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(40,30,60,0.05)';
  for (let i = 0; i < 40; i++) {
    const y = (i * 23) % H;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y + ((i * 11) % 7) - 3);
    ctx.stroke();
  }

  // Gentle cool reflection under the hologram.
  const cyan = ctx.createRadialGradient(W * 0.48, H * 0.52, 0, W * 0.48, H * 0.52, W * 0.3);
  cyan.addColorStop(0, 'rgba(110, 150, 215, 0.1)');
  cyan.addColorStop(1, 'rgba(110, 150, 215, 0)');
  ctx.fillStyle = cyan;
  ctx.fillRect(0, 0, W, H);

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/** Framed-art canvas: dark panel with faint burgundy waves (reference). */
function makeArtTexture(): CanvasTexture {
  const W = 256;
  const H = 384;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('spawn: 2D canvas context unavailable');
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#1e1826');
  bg.addColorStop(0.5, '#261822');
  bg.addColorStop(1, '#14121a');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(170, 60, 45, 0.34)';
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  for (let k = 0; k < 4; k++) {
    ctx.beginPath();
    ctx.moveTo(W * (0.2 + k * 0.14), H * (0.25 + k * 0.16));
    ctx.quadraticCurveTo(
      W * (0.4 + k * 0.1), H * (0.12 + k * 0.2),
      W * (0.62 + k * 0.1), H * (0.34 + k * 0.14),
    );
    ctx.stroke();
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/** Hot sun core with radiating rays: white -> orange -> transparent. */
function makeSunCoreTexture(): CanvasTexture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('spawn: 2D canvas context unavailable');
  const c = size / 2;
  // Radiating rays.
  ctx.lineCap = 'round';
  for (let k = 0; k < 14; k++) {
    const a = (k * Math.PI * 2) / 14;
    const r0 = c * 0.42;
    const r1 = c * (0.6 + ((k * 31) % 3) * 0.08);
    const g = ctx.createLinearGradient(
      c + Math.cos(a) * r0, c + Math.sin(a) * r0,
      c + Math.cos(a) * r1, c + Math.sin(a) * r1,
    );
    g.addColorStop(0, 'rgba(255, 210, 110, 0.95)');
    g.addColorStop(1, 'rgba(255, 170, 60, 0)');
    ctx.strokeStyle = g;
    ctx.lineWidth = size * 0.02;
    ctx.beginPath();
    ctx.moveTo(c + Math.cos(a) * r0, c + Math.sin(a) * r0);
    ctx.lineTo(c + Math.cos(a) * r1, c + Math.sin(a) * r1);
    ctx.stroke();
  }
  // Burning disc.
  const g = ctx.createRadialGradient(c, c, 0, c, c, c * 0.52);
  g.addColorStop(0, 'rgba(255, 255, 245, 1)');
  g.addColorStop(0.4, 'rgba(255, 214, 110, 1)');
  g.addColorStop(0.75, 'rgba(255, 150, 40, 0.9)');
  g.addColorStop(1, 'rgba(255, 130, 30, 0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(c, c, c * 0.52, 0, Math.PI * 2);
  ctx.fill();
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/** Soft cyan radial halo (card backlights, ambient backdrop). */
function makeCyanHaloTexture(): CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('spawn: 2D canvas context unavailable');

  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(120, 210, 255, 0.55)');
  grad.addColorStop(0.4, 'rgba(60, 150, 220, 0.22)');
  grad.addColorStop(1, 'rgba(30, 90, 160, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

export function spawnStructure(
  world: any,
  pack: Pack,
  layout: Layout,
  head: HeadPose,
  opts: SpawnOptions = {},
): SpawnHandles {
  const cardsByNodeId = new Map<string, any>();
  const socketsByIndex = new Map<number, any>();
  const linksById = new Map<string, any>();
  const linkMaterialsById = new Map<string, LinkMaterialPair>();
  /** Bezier of each built link — the traveling-light polish follows it. */
  const linkCurvesById = new Map<string, QuadraticBezierCurve3>();
  /** Fat tube geometry per link, reused for the completion's glowing pulses. */
  const linkGlowGeometries = new Map<string, BufferGeometry>();
  /** Orb sprites, registered by buildAnchor for the completion sun-flare. */
  const sunOrbs: Array<{ glow: any; core: any }> = [];
  const traySpawnSlots = new Map<string, number>();
  const floatItems: Array<{ entity: any; phase: number }> = [];
  const sharedGeometries: BufferGeometry[] = [];
  const sharedMaterials: Material[] = [];
  const sharedTextures: Texture[] = [];

  const hiddenLinks = new Set(opts.hiddenLinkIds ?? []);
  const strengths = opts.linkStrengths ?? {};
  const entities: any[] = [];
  const track = (entity: any): any => {
    entities.push(entity);
    return entity;
  };

  const maxAnisotropy =
    typeof world?.renderer?.capabilities?.getMaxAnisotropy === 'function'
      ? world.renderer.capabilities.getMaxAnisotropy()
      : 1;

  // Soft cyan glow texture: shared by the ambient backdrop, completion
  // bloom/shockwave, and traveling lights (the card halo was removed —
  // cards carry only their solid border).
  const haloTexture = makeCyanHaloTexture();
  sharedTextures.push(haloTexture);
  // Breathing materials: socket targets and tray pieces pulse so the rebuild
  // state reads as alive and inviting instead of ghosted-out.
  const pulseItems: Array<{
    mat: { opacity: number };
    base: number;
    amp: number;
    speed: number;
    phase: number;
  }> = [];
  const pulse = (
    mat: { opacity: number },
    base: number,
    amp: number,
    speed: number,
    phase = 0,
  ): void => {
    pulseItems.push({ mat, base, amp, speed, phase });
    mat.opacity = base;
  };
  // --- shared geometries ---
  // Socket targets: thin rounded-rect outlines that MATCH the card's glass
  // boundary — same corner radius plus the 8 mm offset, so an empty socket
  // and a placed card never read as two different border-radius elements.
  const socketShape = roundedRectShape(CARD_WIDTH + 0.016, CARD_HEIGHT + 0.016, 0.0174);
  socketShape.holes.push(roundedRectShape(CARD_WIDTH + 0.004, CARD_HEIGHT + 0.004, 0.0114));
  const socketGeometry = new ShapeGeometry(socketShape, 10);
  sharedGeometries.push(socketGeometry);

  const cardGeometry = new PlaneGeometry(CARD_WIDTH, CARD_HEIGHT);
  sharedGeometries.push(cardGeometry);

  // Extruded rounded-rect tile body: gives every card real 3D thickness.
  // Footprint follows the GLASS boundary (the texture's rounded fill) with
  // the same corner radius, so the slab edge sits just inside the face's
  // border — one border, no translucent slab sticking out with sharper
  // corners (user: "two different border-radius elements").
  const cardBodyGeometry = new ExtrudeGeometry(
    roundedRectShape(CARD_WIDTH - 0.0054, CARD_HEIGHT - 0.0054, 0.0094),
    {
      depth: 0.007,
      bevelEnabled: true,
      bevelThickness: 0.0012,
      bevelSize: 0.0012,
      bevelSegments: 2,
      curveSegments: 12,
    },
  );
  sharedGeometries.push(cardBodyGeometry);

  const arrowheadGeometry = new ConeGeometry(ARROWHEAD_RADIUS_M, ARROWHEAD_LENGTH_M, 12);
  sharedGeometries.push(arrowheadGeometry);

  // --- shared materials ---
  const socketMaterial = new MeshBasicMaterial({
    color: 0x6fd2ff,
    transparent: true,
    opacity: 0.3,
    side: DoubleSide,
  });
  sharedMaterials.push(socketMaterial);
  pulse(socketMaterial, 0.3, 0.14, 2.2);

  // --- root ---
  const rotRad = (opts.rotDeg ?? 0) * DEG_TO_RAD;
  const root = track(world.createTransformEntity(undefined));
  // Session rotation applies to the structure only — the HUD stays head-stable.
  // The ring pivots around the cycle centre (not the head) so a rotated
  // session never swings cards closer to the player's face.
  const structure = track(world.createTransformEntity(undefined, { parent: root }));
  structure.object3D.rotation.set(0, rotRad, 0);
  const cosR = Math.cos(rotRad);
  const sinR = Math.sin(rotRad);
  const pivotX = 0.02;
  const pivotZ = -0.85;
  structure.object3D.position.set(
    pivotX - (cosR * pivotX + sinR * pivotZ),
    0,
    pivotZ - (-sinR * pivotX + cosR * pivotZ),
  );
  root.object3D.position.set(head.position.x, head.position.y, head.position.z);
  root.object3D.rotation.set(0, head.yaw, 0);

  // --- environment: warm lit wall, floor, light lavender desk (head-stable) ---
  const wallTexture = makeWallTexture();
  sharedTextures.push(wallTexture);
  const wallMaterial = new MeshStandardMaterial({ map: wallTexture, roughness: 0.95, metalness: 0 });
  sharedMaterials.push(wallMaterial);
  const wallGeometry = new PlaneGeometry(6.4, 3.6);
  sharedGeometries.push(wallGeometry);
  const wall = new Mesh(wallGeometry, wallMaterial);
  wall.raycast = () => {};
  const wallEntity = track(world.createTransformEntity(wall, { parent: root }));
  wallEntity.object3D.position.set(0, 0.1, -2.35);

  const floorTexture = makeFloorTexture();
  sharedTextures.push(floorTexture);
  const floorMaterial = new MeshStandardMaterial({ map: floorTexture, roughness: 0.95, metalness: 0 });
  sharedMaterials.push(floorMaterial);
  const floorGeometry = new PlaneGeometry(5.2, 2.6);
  sharedGeometries.push(floorGeometry);
  const floor = new Mesh(floorGeometry, floorMaterial);
  floor.raycast = () => {};
  const floorEntity = track(world.createTransformEntity(floor, { parent: root }));
  floorEntity.object3D.position.set(0, -1.58, -1.32);
  floorEntity.object3D.rotation.set(-Math.PI / 2, 0, 0);

  // Curved desk filling the foreground: LIGHT lavender surface (reference).
  // Physical material with a soft clearcoat — the gentle sheen is what makes
  // it read as a lit tabletop instead of a flat decal.
  const deskTexture = makeDeskTexture();
  sharedTextures.push(deskTexture);
  const deskMaterial = new MeshPhysicalMaterial({
    map: deskTexture,
    roughness: 0.5,
    metalness: 0.04,
    clearcoat: 0.35,
    clearcoatRoughness: 0.5,
  });
  sharedMaterials.push(deskMaterial);
  const deskGeometry = new CylinderGeometry(1.0, 1.06, 0.07, 64);
  sharedGeometries.push(deskGeometry);
  const desk = new Mesh(deskGeometry, deskMaterial);
  desk.raycast = () => {};
  const deskEntity = track(world.createTransformEntity(desk, { parent: root }));
  deskEntity.object3D.position.set(0, -0.82, -1.3);

  // Realistic lighting, tuned to the reference's softly-lit study: a brighter
  // ambient base so the room reads cosy rather than cavernous, cool light
  // from the hologram, warm light from the sun.
  const ambientLight = new AmbientLight(0x5a6480, 2.4);
  track(world.createTransformEntity(ambientLight, { parent: root }));
  const holoLight = new PointLight(0x6fb4ff, 5.5, 6, 1.6);
  track(world.createTransformEntity(holoLight, { parent: root }));
  holoLight.position.set(0.02, 0.05, -0.8);
  const sunLight = new PointLight(0xffc46a, 3.4, 6, 1.8);
  track(world.createTransformEntity(sunLight, { parent: root }));
  sunLight.position.set(-0.24, 0.55, -0.95);

  // ---- room props: real 3D furniture for depth (user: proper 3D world) ----
  // Pure decoration: raycast-stubbed, everything in the shared disposal
  // lists. Positioned to match the reference composition — wooden shelf with
  // books and a houseplant mid-left, framed artwork right of centre — so the
  // room reads as a place, not a backdrop.
  const unitBox = new BoxGeometry(1, 1, 1);
  sharedGeometries.push(unitBox);
  const propMaterial = (color: number, roughness = 0.85): MeshStandardMaterial => {
    const m = new MeshStandardMaterial({ color, roughness, metalness: 0.04 });
    sharedMaterials.push(m);
    return m;
  };
  const propMesh = (
    color: number,
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    sz: number,
    roughness = 0.85,
  ): Mesh => {
    const mesh = new Mesh(unitBox, propMaterial(color, roughness));
    mesh.raycast = () => {};
    mesh.scale.set(sx, sy, sz);
    mesh.position.set(x, y, z);
    track(world.createTransformEntity(mesh, { parent: root }));
    return mesh;
  };

  // Baseboard along the wall foot — grounds the wall to the floor.
  propMesh(0x1b2130, 0, -1.62, -2.33, 6.4, 0.1, 0.03, 0.7);

  // Wooden shelf unit (left): sides, back panel, two planks, top board.
  const shelfX = -2.575;
  const shelfZ = -2.28;
  propMesh(0x43331f, shelfX - 0.455, -0.28, shelfZ, 0.045, 1.5, 0.22);
  propMesh(0x43331f, shelfX + 0.455, -0.28, shelfZ, 0.045, 1.5, 0.22);
  propMesh(0x322416, shelfX, -0.28, shelfZ - 0.1, 0.87, 1.44, 0.02);
  propMesh(0x6f573c, shelfX, 0.06, shelfZ, 0.86, 0.035, 0.2);
  propMesh(0x6f573c, shelfX, -0.6, shelfZ, 0.86, 0.035, 0.2);
  propMesh(0x5c462e, shelfX, 0.485, shelfZ, 0.95, 0.05, 0.24);

  // Books on the top plank — varied spines, two leaning (reference).
  const bookColors = [
    0x8a4a4a, 0x4a6a9a, 0x3a3a52, 0x4a7a58, 0xc0b090,
    0x8a5a42, 0x6a4a7a, 0xa87a5a, 0x42587a,
  ];
  let bookX = -2.9;
  for (let i = 0; i < 10 && bookX < -2.32; i++) {
    const bw = 0.03 + ((i * 37) % 5) * 0.007;
    const bh = 0.3 + ((i * 53) % 7) * 0.024;
    const book = propMesh(
      bookColors[i % bookColors.length],
      bookX + bw / 2,
      0.078 + bh / 2,
      shelfZ,
      bw,
      bh,
      0.15,
    );
    if (i === 4) book.rotation.z = -0.1;
    if (i === 7) book.rotation.z = 0.07;
    bookX += bw + 0.012;
  }
  // A small horizontal stack on the lower plank.
  propMesh(0x6e4a35, -2.72, -0.5665, shelfZ, 0.24, 0.032, 0.16);
  propMesh(0x3d5a7a, -2.7, -0.535, shelfZ + 0.01, 0.21, 0.03, 0.15);
  propMesh(0xa89878, -2.68, -0.506, shelfZ - 0.01, 0.18, 0.028, 0.14);

  // Houseplant on the shelf top (reference: broad leaves upper-left).
  const pot = new Mesh(new CylinderGeometry(0.085, 0.115, 0.17, 12), propMaterial(0x5a3a2e, 0.9));
  pot.raycast = () => {};
  pot.position.set(-2.6, 0.595, -2.26);
  track(world.createTransformEntity(pot, { parent: root }));
  sharedGeometries.push(pot.geometry as BufferGeometry);
  const soil = new Mesh(new CylinderGeometry(0.078, 0.078, 0.02, 12), propMaterial(0x1d140e, 1));
  soil.raycast = () => {};
  soil.position.set(-2.6, 0.67, -2.26);
  track(world.createTransformEntity(soil, { parent: root }));
  sharedGeometries.push(soil.geometry as BufferGeometry);
  const trunk = new Mesh(new CylinderGeometry(0.014, 0.02, 0.3, 8), propMaterial(0x2e2218, 0.95));
  trunk.raycast = () => {};
  trunk.position.set(-2.6, 0.82, -2.26);
  trunk.rotation.z = 0.08;
  track(world.createTransformEntity(trunk, { parent: root }));
  sharedGeometries.push(trunk.geometry as BufferGeometry);
  const leafGeometry = new SphereGeometry(1, 8, 6);
  sharedGeometries.push(leafGeometry);
  const leafSpecs: Array<[number, number, number, number, number, number, number]> = [
    [-2.78, 1.02, -2.22, 0.55, -0.2, 0.34, 0.1],
    [-2.5, 1.06, -2.2, -0.5, 0.25, 0.3, 0.095],
    [-2.62, 1.12, -2.14, 0.05, 0.0, 0.36, 0.1],
    [-2.86, 0.9, -2.18, 0.9, -0.3, 0.28, 0.09],
    [-2.4, 0.92, -2.18, -0.85, 0.3, 0.27, 0.085],
    [-2.66, 1.22, -2.1, 0.0, 0.1, 0.32, 0.095],
    [-2.5, 1.2, -2.12, -0.25, -0.15, 0.3, 0.09],
  ];
  const leafColors = [0x4a8a5c, 0x3a7a4c, 0x5a9a68, 0x427a52, 0x52885e, 0x4a8a5c, 0x3a7a4c];
  leafSpecs.forEach(([x, y, z, rz, ry, len, wid], i) => {
    const leaf = new Mesh(leafGeometry, propMaterial(leafColors[i % leafColors.length], 0.8));
    leaf.raycast = () => {};
    leaf.scale.set(len, wid, wid * 0.7);
    leaf.position.set(x, y, z);
    leaf.rotation.z = rz;
    leaf.rotation.y = ry;
    track(world.createTransformEntity(leaf, { parent: root }));
  });

  // Framed artwork right of centre (reference: dark frame, faint red waves).
  propMesh(0x0d0d12, 0.62, 0.9, -2.31, 0.5, 0.72, 0.035, 0.5);
  const artTexture = makeArtTexture();
  sharedTextures.push(artTexture);
  const artMaterial = new MeshStandardMaterial({ map: artTexture, roughness: 0.9 });
  sharedMaterials.push(artMaterial);
  const artGeometry = new PlaneGeometry(0.42, 0.62);
  sharedGeometries.push(artGeometry);
  const art = new Mesh(artGeometry, artMaterial);
  art.raycast = () => {};
  art.position.set(0.62, 0.9, -2.288);
  track(world.createTransformEntity(art, { parent: root }));

  // Soft cool fill from the window side (upper-left) for gentle modelling,
  // and a warm pool over the desk so the foreground feels lit, not spotlit
  // against darkness (user: room must feel like the reference).
  const fillLight = new PointLight(0x9aa0c0, 3.2, 10, 2);
  track(world.createTransformEntity(fillLight, { parent: root }));
  fillLight.position.set(-2.4, 1.5, -1.6);
  const deskLight = new PointLight(0xcabfe0, 1.3, 5, 2);
  track(world.createTransformEntity(deskLight, { parent: root }));
  deskLight.position.set(0, 0.9, -1.35);

  // Soft contact shadow of the floating structure on the table.
  const shadowGeometry = new PlaneGeometry(1.5, 1.0);
  sharedGeometries.push(shadowGeometry);
  const shadowCanvas = document.createElement('canvas');
  shadowCanvas.width = 256;
  shadowCanvas.height = 256;
  const shadowCtx = shadowCanvas.getContext('2d');
  if (!shadowCtx) throw new Error('spawn: 2D canvas context unavailable');
  const shadowGrad = shadowCtx.createRadialGradient(128, 128, 0, 128, 128, 128);
  shadowGrad.addColorStop(0, 'rgba(30, 24, 44, 0.34)');
  shadowGrad.addColorStop(1, 'rgba(30, 24, 44, 0)');
  shadowCtx.fillStyle = shadowGrad;
  shadowCtx.fillRect(0, 0, 256, 256);
  const shadowTexture = new CanvasTexture(shadowCanvas);
  shadowTexture.colorSpace = SRGBColorSpace;
  sharedTextures.push(shadowTexture);
  const shadowMaterial = new MeshBasicMaterial({
    map: shadowTexture,
    transparent: true,
    depthWrite: false,
  });
  sharedMaterials.push(shadowMaterial);
  const shadow = new Mesh(shadowGeometry, shadowMaterial);
  shadow.raycast = () => {};
  const shadowEntity = track(world.createTransformEntity(shadow, { parent: root }));
  shadowEntity.object3D.position.set(0, -0.782, -1.05);
  shadowEntity.object3D.rotation.set(-Math.PI / 2, 0, 0);

  // Ambient backdrop: one broad soft pool behind the structure so the room
  // has depth instead of dead black.
  const backdropMaterial = new SpriteMaterial({
    map: haloTexture,
    transparent: true,
    opacity: 0.12,
    depthWrite: false,
    blending: AdditiveBlending,
  });
  sharedMaterials.push(backdropMaterial);
  const backdrop = new Sprite(backdropMaterial);
  // Sprites are decoration only — keep them out of the pointer raycast set
  // (Sprite.raycast needs the raycaster camera, which XR pointers leave null,
  // and that crash kills the XR frame loop).
  backdrop.raycast = () => {};
  const backdropEntity = track(world.createTransformEntity(backdrop, { parent: root }));
  backdropEntity.object3D.scale.set(2.4, 1.7, 1);
  backdropEntity.object3D.position.set(0, 0.02, -1.55);
  // Ambient backdrop breathes very slowly (spec §5E: restrained atmosphere).
  pulse(backdropMaterial, 0.12, 0.05, 0.3);

  // Warm golden wash on the wall behind the sun anchor.
  const sunWashMaterial = new SpriteMaterial({
    map: haloTexture,
    color: 0xffc46a,
    transparent: true,
    opacity: 0.42,
    depthWrite: false,
    blending: AdditiveBlending,
  });
  sharedMaterials.push(sunWashMaterial);
  const sunWash = new Sprite(sunWashMaterial);
  sunWash.raycast = () => {};
  const sunWashEntity = track(world.createTransformEntity(sunWash, { parent: root }));
  sunWashEntity.object3D.scale.set(1.3, 1.3, 1);
  sunWashEntity.object3D.position.set(-0.17, 0.25, -1.6);

  // --- socket outlines (empty-slot targets, card-sized) ---
  for (const s of layout.sockets) {
    const socketMesh = new Mesh(socketGeometry, socketMaterial);
    const entity = track(world.createTransformEntity(socketMesh, { parent: structure }));
    entity.object3D.position.set(s.position.x, s.position.y, s.position.z);
    entity.object3D.rotation.set(0, yawFacingHead(s.position), 0);
    socketMesh.name = `socket-${s.index}`;
    entity.addComponent(Socket, {
      index: s.index,
      band: s.band,
      order: s.order,
      occupant: '',
    });
    socketsByIndex.set(s.index, entity);
  }

  // --- card builder ---
  const buildCard = (
    nodeOrLabel: PackNode | { label: string; icon?: string },
    localPos: Vec3,
    socketIndex: number,
    extra: { nodeId: string; kind: string; state: string; band?: number; inTray?: boolean },
  ): any => {
    const texture = makeCardTexture(nodeOrLabel.label, nodeOrLabel.icon, maxAnisotropy);
    sharedTextures.push(texture);

    const material = new MeshBasicMaterial({
      transparent: true,
      side: DoubleSide,
      map: texture,
      depthWrite: false, // prevents z-fighting with the socket ring
    });
    sharedMaterials.push(material);

    // 3D tile: extruded rounded-rect body + textured glass face.
    // These meshes must stay raycastable: IWSDK's pointer rays (and the
    // DistanceGrabbable handle) only fire on meshes with a real raycast().
    // Stubbing them here used to make every card invisible to XR input —
    // no hover, no grab, no select. Only decoration (sprites below) is exempt.
    const bodyMaterial = new MeshBasicMaterial({
      color: 0x9cc8ff,
      transparent: true,
      opacity: 0.12,
    });
    sharedMaterials.push(bodyMaterial);
    const body = new Mesh(cardBodyGeometry, bodyMaterial);

    const face = new Mesh(cardGeometry, material);
    face.position.z = 0.0095;

    const tile = new Group();
    tile.add(body, face);

    // Tray-spawned cards stay head-stable (root frame); socket cards live in
    // the rotated structure frame. Interaction re-parents on snap / glide.
    const parentObj = extra.inTray ? root : structure;
    const entity = track(world.createTransformEntity(tile, { parent: parentObj }));
    entity.object3D.position.set(localPos.x, localPos.y, localPos.z);
    entity.object3D.rotation.set(0, yawFacingHead(localPos), 0);

    // Friendly name — the XR emulator's target resolver lists scene objects
    // by name, letting hand sequences target cards/sockets precisely.
    tile.name = `card-${extra.nodeId}`;
    // Material handles for the interaction polish layer (hover glow, grab
    // compression, snap flash, amber rejection tint — spec §3/§5).
    (entity as any).cardMats = { face: material, body: bodyMaterial };
    entity.addComponent(Card, {
      nodeId: extra.nodeId,
      label: nodeOrLabel.label,
      band: extra.band ?? 0,
      fixed: false,
      kind: extra.kind,
      state: extra.state,
      socketIndex,
    });
    cardsByNodeId.set(extra.nodeId, entity);
    return entity;
  };

  // --- movable cards: placed per the layout solution, weak ones in the tray ---
  const removedNodes = new Set<string>(opts.removedNodeIds ?? []);
  let trayCursor = 0;
  for (const node of pack.nodes) {
    if (node.fixed) continue;
    if (removedNodes.has(node.id)) {
      const slot = layout.tray[trayCursor];
      trayCursor++;
      if (slot) {
        const trayCard = buildCard(node, slot.position, -1, {
          nodeId: node.id,
          kind: 'card',
          state: 'free',
          band: node.band,
          inTray: true,
        });
        traySpawnSlots.set(node.id, slot.index);
        floatItems.push({ entity: trayCard, phase: slot.index * 1.7 });
      }
      continue;
    }
    const idx = layout.solution[node.id];
    const socket = layout.sockets[idx];
    buildCard(node, socket.position, idx, {
      nodeId: node.id,
      kind: 'card',
      state: 'placed',
      band: node.band,
    });
    const socketEntity = socketsByIndex.get(idx);
    if (socketEntity) socketEntity.setValue(Socket, 'occupant', node.id);
  }

  // --- distractor cards in the tray's outer slots ---
  // Disabled - these warning cards look bad in XR mode
  // const distractors = opts.distractors ?? [];
  // distractors.forEach((d, i) => {
  //   const slotIndex = layout.tray.length - distractors.length + i;
  //   const slot = layout.tray[slotIndex];
  //   if (!slot) return;
  //   const distractorCard = buildCard({ label: d.label, icon: '⚠️' }, slot.position, -1, {
  //     nodeId: `distractor-${i}`,
  //     kind: 'distractor',
  //     state: 'free',
  //     inTray: true,
  //   });
  //   traySpawnSlots.set(`distractor-${i}`, slotIndex);
  //   floatItems.push({ entity: distractorCard, phase: slotIndex * 1.7 });
  // });

  // --- fixed anchors: golden "Sun Heat" pill with the burning orb above ---
  const buildAnchor = (node: PackNode, localPos: Vec3): void => {
    const glowTexture = makeRadialGlowTexture();
    sharedTextures.push(glowTexture);

    const glowMaterial = new SpriteMaterial({
      map: glowTexture,
      transparent: true,
      depthWrite: false,
    });
    sharedMaterials.push(glowMaterial);

    const glow = new Sprite(glowMaterial);
    glow.raycast = () => {};
    glow.userData.isSunOrb = true;
    const glowEntity = track(world.createTransformEntity(glow, { parent: structure }));
    // Orb directly above the pill (reference composition).
    glowEntity.object3D.position.set(localPos.x, localPos.y + 0.115, localPos.z);
    glowEntity.object3D.scale.set(0.34, 0.34, 1);

    // Hot core on top of the halo: reads as a burning sphere.
    const coreTexture = makeSunCoreTexture();
    sharedTextures.push(coreTexture);
    const coreMaterial = new SpriteMaterial({
      map: coreTexture,
      transparent: true,
      depthWrite: false,
    });
    sharedMaterials.push(coreMaterial);
    // Spec §5E: very subtle sunlight changes — the orb slowly breathes.
    pulse(coreMaterial, 1, 0.14, 0.45);
    pulse(glowMaterial, 1, 0.2, 0.35);
    const core = new Sprite(coreMaterial);
    core.raycast = () => {};
    core.userData.isSunOrb = true;
    const coreEntity = track(world.createTransformEntity(core, { parent: structure }));
    coreEntity.object3D.position.set(localPos.x, localPos.y + 0.115, localPos.z);
    coreEntity.object3D.scale.set(0.15, 0.15, 1);
    // Registered for the completion sun-flare (the orb swells once).
    sunOrbs.push({ glow: glowEntity, core: coreEntity });

    const plateTexture = makeAnchorPlateTexture(node.label, maxAnisotropy);
    sharedTextures.push(plateTexture);

    const plateGeometry = new PlaneGeometry(0.14, 0.0875);
    sharedGeometries.push(plateGeometry);

    const plateMaterial = new MeshBasicMaterial({
      transparent: true,
      side: DoubleSide,
      map: plateTexture,
      depthWrite: false,
    });
    sharedMaterials.push(plateMaterial);

    const plate = new Mesh(plateGeometry, plateMaterial);
    const plateEntity = track(world.createTransformEntity(plate, { parent: structure }));
    // The anchor position IS the pill; a touch closer to the head so it
    // sorts in front of the orb's halo.
    plateEntity.object3D.position.set(localPos.x, localPos.y, localPos.z + 0.012);
    plateEntity.object3D.rotation.set(0, yawFacingHead(localPos), 0);

    plateEntity.addComponent(Card, {
      nodeId: node.id,
      label: node.label,
      band: node.band,
      fixed: true,
      kind: 'anchor',
      state: 'placed',
      socketIndex: -1,
    });
    cardsByNodeId.set(node.id, plateEntity);
  };

  for (const a of layout.anchors) {
    const node = pack.nodes.find((n) => n.id === a.id);
    if (!node) continue;
    buildAnchor(node, a.position);
  }

  // --- luminous links with arrowheads ---
  // Link endpoints sit on the visual anchor points: the sun link leaves from
  // the pill under the orb; card links attach just outside the card edges.
  const posByNodeId = new Map<string, Vec3>();
  for (const node of pack.nodes) {
    if (node.fixed) {
      const anchor = layout.anchors.find((x) => x.id === node.id);
      if (anchor) {
        // The golden arrow leaves the pill's lower edge (reference).
        posByNodeId.set(node.id, pushBehind({
          x: anchor.position.x - 0.02,
          y: anchor.position.y - 0.02,
          z: anchor.position.z + 0.012,
        }));
      }
    } else if (!removedNodes.has(node.id)) {
      const idx = layout.solution[node.id];
      const socket = layout.sockets[idx];
      if (socket) posByNodeId.set(node.id, pushBehind(socket.position));
    }
  }

  const upY = new Vector3(0, 1, 0);
  const bowCenter = new Vector3(LINK_BOW_CENTER.x, LINK_BOW_CENTER.y, LINK_BOW_CENTER.z);

  const buildLink = (link: PackLink): void => {
    const a = posByNodeId.get(link.from);
    const b = posByNodeId.get(link.to);
    if (!a || !b) return; // an endpoint is removed (weak link) — skip until placed

    const aV = new Vector3(a.x, a.y, a.z);
    const bV = new Vector3(b.x, b.y, b.z);
    const chord = aV.distanceTo(bV);

    // Attach to the card edges: pull both endpoints in along the chord.
    const dirAB = bV.clone().sub(aV).normalize();
    const inset = Math.min(LINK_EDGE_INSET_M, chord * 0.3);
    const aEdge = aV.clone().addScaledVector(dirAB, inset);
    const bEdge = bV.clone().addScaledVector(dirAB, -inset);

    const mid = aEdge.clone().add(bEdge).multiplyScalar(0.5);
    const outward = mid.clone().sub(bowCenter);
    if (outward.lengthSq() < 1e-8) outward.set(0, -1, 0);
    outward.normalize();
    // The wrap link (Collection → Evaporation) sags below the whole cycle.
    const ord = pack.nodes.map((n) => n.id);
    const isWrap = ord.indexOf(link.to) < ord.indexOf(link.from);
    const ratio = isWrap ? WRAP_LINK_BOW_RATIO : LINK_BOW_RATIO;
    const bowVec = isWrap
      ? new Vector3(0, -1, 0).multiplyScalar(aEdge.distanceTo(bEdge) * ratio)
      : outward.multiplyScalar(aEdge.distanceTo(bEdge) * ratio);
    const control = mid.clone().add(bowVec);
    const curve = new QuadraticBezierCurve3(aEdge, control, bEdge);

    const coreGeometry = new TubeGeometry(curve, 32, LINK_CORE_RADIUS_M, 8, false);
    sharedGeometries.push(coreGeometry);

    // Glow halo on the SAME curve as the core — a re-sampled sub-curve would
    // deviate and render as a duplicate parallel line.
    const glowGeometry = new TubeGeometry(curve, 32, LINK_GLOW_RADIUS_M, 8, false);
    sharedGeometries.push(glowGeometry);

    // Golden for the sun link, saturated luminous blue for the water cycle
    // (reference: deep glowing blue with a bright core, direction unmistakable).
    const fromAnchor = pack.nodes.find((n) => n.id === link.from)?.fixed ?? false;
    const coreColor = fromAnchor ? 0xffd98a : 0x9fd0ff;
    const glowColor = fromAnchor ? 0xffb84d : 0x2e9fff;

    const coreMaterial = new MeshBasicMaterial({
      color: coreColor,
      transparent: true,
      opacity: 1,
    });
    const glowMaterial = new MeshBasicMaterial({
      color: glowColor,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    sharedMaterials.push(coreMaterial, glowMaterial);

    const core = new Mesh(coreGeometry, coreMaterial);
    const coreEntity = track(world.createTransformEntity(core, { parent: structure }));
    // Single thin luminous line — the bloom pass supplies the soft halo
    // around it (a second fat tube read as a stacked, muddy line).

    // Arrowhead at the destination edge, tip on the curve end point.
    const tangent = curve.getTangent(1).normalize();
    const arrowhead = new Mesh(arrowheadGeometry, coreMaterial);
    const arrowEntity = track(world.createTransformEntity(arrowhead, { parent: structure }));
    arrowEntity.object3D.position.copy(bEdge).addScaledVector(tangent, -ARROWHEAD_LENGTH_M / 2);
    arrowEntity.object3D.quaternion.copy(new Quaternion().setFromUnitVectors(upY, tangent));

    const id = linkIdOf(link.from, link.to);
    const hidden = hiddenLinks.has(id);
    const strength = strengths[id] ?? 1;
    linkCurvesById.set(id, curve);
    linkGlowGeometries.set(id, glowGeometry);
    coreEntity.addComponent(LinkLine, {
      linkId: id,
      strength,
      lit: !hidden,
      hidden,
    });
    if (hidden) {
      coreMaterial.opacity = 0.06;
      glowMaterial.opacity = 0.02;
    }
    linksById.set(id, coreEntity);
    linkMaterialsById.set(id, { core: coreMaterial, glow: glowMaterial });
  };

  for (const link of pack.links) buildLink(link);

  // Weak-link sessions: links whose cards start in the tray are skipped at
  // spawn (an endpoint is unplaced). Once both endpoints are placed again the
  // connection must EXIST — otherwise a rebuilt structure stays visually
  // disconnected ("not even connected anymore"). Rebuild any missing link
  // whose endpoints are now both known; refreshFeedback then draws it in.
  const endpointAnchorPos = (nodeId: string): Vec3 | undefined => {
    const node = pack.nodes.find((n) => n.id === nodeId);
    if (!node) return undefined;
    if (node.fixed) {
      const anchor = layout.anchors.find((x) => x.id === nodeId);
      if (!anchor) return undefined;
      return pushBehind({
        x: anchor.position.x - 0.02,
        y: anchor.position.y - 0.02,
        z: anchor.position.z + 0.012,
      });
    }
    const idx = layout.solution[nodeId];
    const socket = layout.sockets[idx];
    return socket ? pushBehind(socket.position) : undefined;
  };

  /** World midpoint of a connection, for its spatial note. */
  const linkMidpoint = (id: string): { x: number; y: number; z: number } | null => {
    const c = linkCurvesById.get(id);
    if (!c) return null;
    const p = new Vector3();
    c.getPoint(0.5, p);
    const w = structure.object3D.localToWorld(p);
    return { x: w.x, y: w.y, z: w.z };
  };

  const ensureLinks = (): void => {
    for (const link of pack.links) {
      const id = linkIdOf(link.from, link.to);
      if (linksById.has(id)) continue;
      if (!posByNodeId.has(link.from)) {
        const p = endpointAnchorPos(link.from);
        if (p) posByNodeId.set(link.from, p);
      }
      if (!posByNodeId.has(link.to)) {
        const p = endpointAnchorPos(link.to);
        if (p) posByNodeId.set(link.to, p);
      }
      if (posByNodeId.has(link.from) && posByNodeId.has(link.to)) {
        buildLink(link);
      }
    }
  };

  // --- dashed drag-preview arc (spec: short dashed blue line to the target) ---
  const previewMat = new MeshBasicMaterial({
    color: 0x4da6ff,
    transparent: true,
    opacity: 0.75,
    depthWrite: false,
  });
  sharedMaterials.push(previewMat);
  const previewGeom = new BoxGeometry(0.005, 0.005, 0.028);
  sharedGeometries.push(previewGeom);
  const previewSegments: Mesh[] = [];
  for (let i = 0; i < 18; i++) {
    const seg = new Mesh(previewGeom, previewMat);
    seg.raycast = () => {};
    seg.visible = false;
    const segEntity = track(world.createTransformEntity(seg, { parent: structure }));
    previewSegments.push(seg);
    void segEntity;
  }
  const previewUp = new Vector3(0, 1, 0);

  const setDragPreview = (from: Vec3 | null, to: Vec3): void => {
    if (!from) {
      for (const seg of previewSegments) seg.visible = false;
      return;
    }
    const aV = new Vector3(from.x, from.y, from.z);
    const bV = new Vector3(to.x, to.y, to.z);
    const chord = aV.distanceTo(bV);
    const mid = aV.clone().add(bV).multiplyScalar(0.5);
    const outward = mid.clone().sub(bowCenter);
    if (outward.lengthSq() < 1e-8) outward.set(0, -1, 0);
    outward.normalize();
    const control = mid.addScaledVector(outward, chord * 0.18);
    const curve = new QuadraticBezierCurve3(aV, control, bV);
    const n = previewSegments.length;
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const p = curve.getPoint(t);
      const tangent = curve.getTangent(t).normalize();
      const seg = previewSegments[i];
      seg.visible = true;
      seg.position.copy(p);
      seg.quaternion.copy(new Quaternion().setFromUnitVectors(previewUp, tangent));
    }
  };

  // ---- UI/UX polish layer (spec §5) ----
  // Placement ripple, iOS-style: a soft ring that blooms OUT OF THE CARD'S
  // PLANE, facing the player (a ground-plane ring reads edge-on from the
  // viewing angle — invisible). Expands once, fades, done.
  const RIPPLE_S = 0.5;
  const rippleGeometry = new RingGeometry(0.8, 0.9, 48);
  sharedGeometries.push(rippleGeometry);
  const ripples: Array<{ mesh: Mesh; mat: MeshBasicMaterial; t: number; active: boolean }> = [];
  for (let i = 0; i < 4; i++) {
    const mat = new MeshBasicMaterial({
      color: 0xa8dcff,
      transparent: true,
      opacity: 0,
      side: DoubleSide,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    sharedMaterials.push(mat);
    const mesh = new Mesh(rippleGeometry, mat);
    mesh.raycast = () => {};
    mesh.visible = false;
    track(world.createTransformEntity(mesh, { parent: structure }));
    ripples.push({ mesh, mat, t: 0, active: false });
  }
  const rippleAt = (pos: Vec3): void => {
    const r = ripples.find((x) => !x.active) ?? ripples[0];
    // Face the head exactly like the cards do, and sit a touch behind the
    // card plane (away from the head) so the ring blooms around the card.
    const facing = yawFacingHead(pos);
    r.mesh.rotation.set(0, facing, 0);
    r.mesh.position.set(
      pos.x - Math.sin(facing) * 0.02,
      pos.y,
      pos.z - Math.cos(facing) * 0.02,
    );
    r.t = 0;
    r.active = true;
    r.mesh.visible = true;
  };

  // Traveling lights: small glows that ride a newly satisfied connection.
  // One per link so the completion wave can light every connection.
  const dots: Array<{ sprite: Sprite; busy: boolean }> = [];
  for (let i = 0; i < 8; i++) {
    const mat = new SpriteMaterial({
      map: haloTexture,
      color: 0xcdeaff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    sharedMaterials.push(mat);
    const sprite = new Sprite(mat);
    sprite.raycast = () => {};
    sprite.scale.set(0.032, 0.032, 1);
    sprite.visible = false;
    track(world.createTransformEntity(sprite, { parent: structure }));
    dots.push({ sprite, busy: false });
  }

  // Link material animations: progressive "drawing" on new placements and a
  // brightness wave across all connections on completion (spec §5C/§8).
  const LINK_DRAW_S = 0.5;
  interface LinkAnim {
    startAt: number | null; // null = start on the next tickMotion
    delay: number;
    duration: number;
    coreFrom: number;
    corePeak: number;
    coreBase: number;
    glowFrom: number;
    glowPeak: number;
    glowBase: number;
    oneWay: boolean; // draw settles at peak; wave returns to base
    dot: { sprite: Sprite; busy: boolean } | null;
    curve: QuadraticBezierCurve3 | null;
    /** Fat additive tube that swells while the comet crosses this link. */
    waveGlow?: Mesh;
  }
  const linkAnims = new Map<string, LinkAnim>();

  const isLinkAnimating = (id: string): boolean => linkAnims.has(id);

  const playLinkDraw = (id: string): void => {
    const mats = linkMaterialsById.get(id);
    const entity = linksById.get(id);
    if (!mats || !entity) return;
    const hidden = entity.getValue(LinkLine, 'hidden') as boolean;
    const strength = entity.getValue(LinkLine, 'strength') as number;
    // Final opacities match refreshFeedback's lit state exactly, so handing
    // control back at the end of the draw is seamless.
    const coreTo = hidden ? 1 : 0.35 + 0.65 * strength;
    const glowTo = 0.18 + 0.42 * coreTo;
    const dot = dots.find((d) => !d.busy) ?? null;
    if (dot) dot.busy = true;
    linkAnims.set(id, {
      startAt: null,
      delay: 0,
      duration: LINK_DRAW_S,
      coreFrom: mats.core.opacity,
      corePeak: coreTo,
      coreBase: coreTo,
      glowFrom: mats.glow.opacity,
      glowPeak: glowTo,
      glowBase: glowTo,
      oneWay: true,
      dot,
      curve: linkCurvesById.get(id) ?? null,
    });
  };

  // Completion: the reward moment (user: "the whole point of the program").
  // A bloom swells out of the cycle centre behind the structure while the
  // connections pulse through in flow order with traveling lights — calm,
  // earned, no fireworks (spec §8).
  const harmonyMaterial = new SpriteMaterial({
    map: haloTexture,
    color: 0x8fb8ff,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: AdditiveBlending,
  });
  sharedMaterials.push(harmonyMaterial);
  const harmony = new Sprite(harmonyMaterial);
  harmony.raycast = () => {};
  harmony.visible = false;
  harmony.userData.isBloom = true;
  harmony.position.set(LINK_BOW_CENTER.x, LINK_BOW_CENTER.y, LINK_BOW_CENTER.z);
  track(world.createTransformEntity(harmony, { parent: structure }));
  let harmonyStart: number | null = null;

  // Completion shockwave: BIG head-facing rings expanding from the cycle
  // centre — grand-scale ripples, the beat the eye cannot miss. Two rings,
  // staggered, for a rolling double wave.
  const shockGeometry = new RingGeometry(0.7, 1.0, 64);
  sharedGeometries.push(shockGeometry);
  const ringMaterial = new MeshBasicMaterial({
    color: 0x9fd8ff,
    transparent: true,
    opacity: 0,
    side: DoubleSide,
    depthWrite: false,
    blending: AdditiveBlending,
  });
  const ring2Material = ringMaterial.clone();
  sharedMaterials.push(ringMaterial, ring2Material);
  const ring = new Mesh(shockGeometry, ringMaterial);
  ring.raycast = () => {};
  ring.visible = false;
  ring.position.set(LINK_BOW_CENTER.x, LINK_BOW_CENTER.y, LINK_BOW_CENTER.z);
  ring.rotation.y = yawFacingHead(LINK_BOW_CENTER);
  track(world.createTransformEntity(ring, { parent: structure }));
  const ring2 = new Mesh(shockGeometry, ring2Material);
  ring2.raycast = () => {};
  ring2.visible = false;
  ring2.position.copy(ring.position);
  ring2.rotation.y = ring.rotation.y;
  track(world.createTransformEntity(ring2, { parent: structure }));
  let ringStart: number | null = null;
  let ring2Start: number | null = null;
  let sunFlareArmed = false;
  let sunFlareStart: number | null = null;
  /** Per-link lit opacities — the final chord settles back onto these. */
  const litBases = new Map<string, { core: number; glow: number }>();
  /** Fat pulse tubes, one per link, lazily built at completion time. */
  const waveGlows = new Map<string, Mesh>();
  let chordStart: number | null = null;
  let chordDone = false;
  let chordVoicesFired = false;

  const playCompletionWave = (): void => {
    let i = 0;
    for (const link of pack.links) {
      const id = linkIdOf(link.from, link.to);
      const mats = linkMaterialsById.get(id);
      if (!mats) continue;
      // The wave pulses around the LIT state, not whatever opacity the link
      // happens to carry this frame — a completion wave that returns the
      // structure to its ghost state reads as broken, not rewarding.
      const entity = linksById.get(id);
      const hidden = entity ? (entity.getValue(LinkLine, 'hidden') as boolean) : false;
      const strength = entity ? (entity.getValue(LinkLine, 'strength') as number) : 1;
      const coreBase = hidden ? 1 : 0.35 + 0.65 * strength;
      const glowBase = 0.18 + 0.42 * coreBase;
      litBases.set(id, { core: coreBase, glow: glowBase });
      const dot = dots.find((d) => !d.busy) ?? null;
      if (dot) {
        dot.busy = true;
        // The comet: one BIG bright light the eye tracks around the loop.
        dot.sprite.scale.set(0.09, 0.09, 1);
      }
      // The comet plays the loop as a melody: each link sounds its note as
      // the light crosses it (sample-accurate Web Audio scheduling).
      const mid = linkCurvesById.get(id);
      if (mid) {
        const p = new Vector3();
        mid.getPoint(0.45, p);
        const w = structure.object3D.localToWorld(p);
        sfx.cometNote(i, i * 0.22 + 0.38, { x: w.x, y: w.y, z: w.z });
      }
      // Fat glowing pulse: a wide additive tube swells around the thin core
      // as the comet crosses — the beat that makes the loop read as ALIVE.
      let waveGlow = waveGlows.get(id);
      if (!waveGlow) {
        const geo = linkGlowGeometries.get(id);
        if (geo) {
          const wm = new MeshBasicMaterial({
            color: 0x66c4ff,
            transparent: true,
            opacity: 0,
            depthWrite: false,
            blending: AdditiveBlending,
          });
          sharedMaterials.push(wm);
          waveGlow = new Mesh(geo, wm);
          waveGlow.raycast = () => {};
          waveGlow.visible = false;
          track(world.createTransformEntity(waveGlow, { parent: structure }));
          waveGlows.set(id, waveGlow);
        }
      }
      if (waveGlow) waveGlow.visible = true;
      linkAnims.set(id, {
        startAt: null,
        delay: i * 0.22,
        duration: 0.85,
        coreFrom: mats.core.opacity,
        corePeak: 1, // flash to full as the comet passes
        coreBase,
        glowFrom: mats.glow.opacity,
        glowPeak: 1,
        glowBase,
        oneWay: false,
        dot,
        curve: linkCurvesById.get(id) ?? null,
        waveGlow,
      });
      i++;
    }
    harmonyStart = null; // bloom, begins on the next tickMotion
    harmony.visible = true;
    ringStart = null; // double shockwave, delayed 0.5s inside tickMotion
    ring.visible = true;
    ring2.visible = true;
    sunFlareArmed = true; // the sun answers, delayed 0.3s
    sunFlareStart = null;
    chordStart = null; // the unified final flash, once the comet is done
    chordDone = false;
    chordVoicesFired = false;
  };

  // Ambient motes: barely-there drifting dust for depth (spec §5E). Pure
  // decoration — never raycastable.
  const motes: Array<{
    sprite: Sprite;
    mat: SpriteMaterial;
    baseX: number;
    baseY: number;
    baseZ: number;
    baseOpacity: number;
    phase: number;
  }> = [];
  for (let i = 0; i < 12; i++) {
    const mat = new SpriteMaterial({
      map: haloTexture,
      color: 0xbfe3ff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    sharedMaterials.push(mat);
    const sprite = new Sprite(mat);
    sprite.raycast = () => {};
    const s = 0.018 + ((i * 7) % 5) * 0.006;
    sprite.scale.set(s, s, 1);
    const baseX = (Math.sin(i * 12.9898) * 0.5 + 0.5 - 0.5) * 0.9;
    const baseY = -0.1 + (Math.sin(i * 78.233) * 0.5 + 0.5) * 0.55;
    const baseZ = -0.55 - (Math.sin(i * 43.71) * 0.5 + 0.5) * 0.5;
    sprite.position.set(baseX, baseY, baseZ);
    track(world.createTransformEntity(sprite, { parent: root }));
    motes.push({
      sprite,
      mat,
      baseX,
      baseY,
      baseZ,
      baseOpacity: 0.05 + ((i * 11) % 4) * 0.02,
      phase: i * 1.31,
    });
  }

  // Completion light transition: the room gently brightens, nothing flashes.
  let completionGlowOn = false;
  const setCompletionGlow = (on: boolean): void => {
    completionGlowOn = on;
  };

  // Per-frame scratch point for the traveling lights (no per-frame allocs).
  const curvePointTmp = new Vector3();

  const tickMotion = (dt: number, t: number): void => {
    // The whole structure breathes — a barely-there float that keeps the
    // hologram feeling alive at rest (spec §5E, restrained).
    structure.object3D.position.y = 0.004 * Math.sin(t * 0.5);
    for (const [id, anim] of linkAnims) {
      const mats = linkMaterialsById.get(id);
      if (!mats) {
        linkAnims.delete(id);
        continue;
      }
      if (anim.startAt === null) anim.startAt = t;
      const lt = (t - anim.startAt - anim.delay) / anim.duration;
      if (lt < 0) continue;
      if (lt >= 1) {
        mats.core.opacity = anim.coreBase;
        mats.glow.opacity = anim.glowBase;
        if (anim.dot) {
          anim.dot.busy = false;
          (anim.dot.sprite.material as SpriteMaterial).opacity = 0;
          anim.dot.sprite.visible = false;
          anim.dot.sprite.scale.set(0.032, 0.032, 1);
        }
        if (anim.waveGlow) {
          (anim.waveGlow.material as MeshBasicMaterial).opacity = 0;
          anim.waveGlow.visible = false;
        }
        linkAnims.delete(id);
        continue;
      }
      if (anim.oneWay) {
        const e = easeOutCubic(lt);
        mats.core.opacity = anim.coreFrom + (anim.corePeak - anim.coreFrom) * e;
        mats.glow.opacity = anim.glowFrom + (anim.glowPeak - anim.glowFrom) * e;
        if (anim.dot && anim.curve) {
          anim.curve.getPoint(easeInOutCubic(lt), curvePointTmp);
          anim.dot.sprite.visible = true;
          anim.dot.sprite.position.copy(curvePointTmp);
          (anim.dot.sprite.material as SpriteMaterial).opacity = 0.85 * (1 - lt * 0.35);
        }
      } else {
        // Brightness wave: rise, then settle back to the calm lit state.
        const env = Math.sin(Math.PI * clamp01(lt));
        mats.core.opacity = anim.coreBase + (anim.corePeak - anim.coreBase) * env;
        mats.glow.opacity = anim.glowBase + (anim.glowPeak - anim.glowBase) * env;
        if (anim.waveGlow) {
          (anim.waveGlow.material as MeshBasicMaterial).opacity = 0.85 * env;
        }
        if (anim.dot && anim.curve) {
          anim.curve.getPoint(easeInOutCubic(clamp01(lt * 1.25)), curvePointTmp);
          anim.dot.sprite.visible = true;
          anim.dot.sprite.position.copy(curvePointTmp);
          (anim.dot.sprite.material as SpriteMaterial).opacity = env;
        }
      }
    }
    for (const r of ripples) {
      if (!r.active) continue;
      r.t += dt;
      const k = r.t / RIPPLE_S;
      if (k >= 1) {
        r.active = false;
        r.mesh.visible = false;
        continue;
      }
      const e = easeOutCubic(k);
      r.mesh.scale.setScalar(0.09 + 0.17 * e);
      r.mat.opacity = 0.38 * (1 - k);
    }
    // Harmony bloom: one broad swell of light behind the cycle — the
    // "visually harmonious" beat of the completion sequence.
    if (harmonyStart === null && harmony.visible) {
      harmonyStart = t;
    }
    if (harmonyStart !== null) {
      const lt = (t - harmonyStart) / 2;
      if (lt >= 1) {
        harmony.visible = false;
        harmonyMaterial.opacity = 0;
        harmonyStart = null;
      } else {
        harmonyMaterial.opacity = 0.5 * Math.sin(Math.PI * clamp01(lt));
        const s = 0.5 + 2.9 * easeOutCubic(clamp01(lt * 1.4));
        harmony.scale.set(0.9 * s, 0.62 * s, 1);
      }
    }
    // Double shockwave: two big rings roll outward from the cycle centre,
    // staggered so the wave keeps rolling (starts 0.5s into the sequence).
    if (ringStart === null && ring.visible) {
      ringStart = t + 0.5;
    }
    if (ringStart !== null) {
      const lt = (t - ringStart) / 1.2;
      if (lt >= 1) {
        ring.visible = false;
        ringMaterial.opacity = 0;
        ringStart = null;
      } else if (lt >= 0) {
        ring.scale.setScalar(0.4 + 1.3 * easeOutCubic(lt));
        ringMaterial.opacity = 0.55 * (1 - lt);
      }
    }
    // Ring 2 runs on its own timer — sharing ring 1’s froze it mid-flight
    // and left a giant ring hanging around the player after the celebration.
    if (ring2Start === null && ring2.visible) {
      ring2Start = t + 0.75;
    }
    if (ring2Start !== null) {
      const lt = (t - ring2Start) / 1.2;
      if (lt >= 1) {
        ring2.visible = false;
        ring2Material.opacity = 0;
        ring2Start = null;
      } else if (lt >= 0) {
        ring2.scale.setScalar(0.4 + 1.1 * easeOutCubic(lt));
        ring2Material.opacity = 0.4 * (1 - lt);
      }
    }
    // Sun flare: the orb swells once and settles — the source answers
    // (starts 0.3 s into the sequence, one shot per completion).
    if (sunFlareArmed && sunFlareStart === null) {
      sunFlareStart = t + 0.3;
    }
    if (sunFlareStart !== null) {
      const lt = (t - sunFlareStart) / 1;
      if (lt >= 1) {
        sunFlareArmed = false;
        sunFlareStart = null;
        for (const orb of sunOrbs) {
          orb.glow.object3D.scale.set(0.34, 0.34, 1);
          orb.core.object3D.scale.set(0.15, 0.15, 1);
        }
      } else if (lt >= 0) {
        const f = 1 + 0.4 * Math.sin(Math.PI * clamp01(lt));
        for (const orb of sunOrbs) {
          orb.glow.object3D.scale.set(0.34 * f, 0.34 * f, 1);
          orb.core.object3D.scale.set(0.15 * f, 0.15 * f, 1);
        }
      }
    }
    // The final chord: once every link has had its pass, the whole structure
    // flashes TOGETHER for half a second, then settles into its calm glow.
    if (!chordDone && chordStart === null && litBases.size > 0 && linkAnims.size === 0) {
      chordStart = t + 0.1;
    }
    if (chordStart !== null) {
      const lt = (t - chordStart) / 0.6;
      if (!chordVoicesFired && lt >= 0 && lt < 1) {
        sfx.finalChord(0); // the literal chord: all eight notes together
        chordVoicesFired = true;
      }
      if (lt >= 1) {
        for (const [id, base] of litBases) {
          const mats = linkMaterialsById.get(id);
          if (mats) {
            mats.core.opacity = base.core;
            mats.glow.opacity = base.glow;
          }
        }
        chordDone = true;
        chordStart = null;
      } else if (lt >= 0) {
        const env = Math.sin(Math.PI * clamp01(lt));
        for (const [id, base] of litBases) {
          const mats = linkMaterialsById.get(id);
          if (mats) {
            mats.core.opacity = Math.min(1, base.core + 0.4 * env);
            mats.glow.opacity = Math.min(1, base.glow + 0.3 * env);
          }
        }
      }
    }
    for (const m of motes) {
      m.sprite.position.y = m.baseY + 0.035 * Math.sin(t * 0.18 + m.phase);
      m.sprite.position.x = m.baseX + 0.025 * Math.sin(t * 0.11 + m.phase * 1.7);
      m.mat.opacity = m.baseOpacity * (0.7 + 0.3 * Math.sin(t * 0.27 + m.phase));
    }
    if (completionGlowOn) {
      ambientLight.intensity = damp(ambientLight.intensity, 1.78, 2.2, dt);
      holoLight.intensity = damp(holoLight.intensity, 6.4, 2.0, dt);
    }
  };


  // Structure base position (rotation-pivot compensation); XR adds a pull
  // toward the player on top of it.
  const structureBaseZ = structure.object3D.position.z;
  // Where the cycle ring lives in structure-local space (layout.ts keeps the
  // whole ring in a ~-0.8 m band; LINK_BOW_CENTER.z agrees at -0.85).
  const cycleCenterZ =
    layout.sockets.reduce((acc, s) => acc + s.position.z, 0) / layout.sockets.length;

  // Near-physical XR framing: shrink the ring and solve the structure offset
  // so the ring centre lands XR_CYCLE_DEPTH_M in FRONT of the head
  // (root-local z of the ring = offset + scale * cycleCenterZ, and negative
  // z is in front). Deriving the offset keeps it correct even if the layout
  // depths change — a hard-coded one silently pushed the ring behind the
  // player when the layout moved from a deep ring to the current ~0.8 m one.
  const XR_SCALE = 0.75;
  // Comfortable seated viewing distance, with clearance for the hands: any
  // closer and the player's controllers sweep THROUGH the cycle when they
  // turn left/right or reach across the ring.
  const XR_CYCLE_DEPTH_M = 0.75;

  const applyXRLayout = (isXR: boolean): void => {
    // Shrink to near-physical size and sit the ring at the comfortable depth
    // above the table — close enough to study, far enough that the hands and
    // controllers never clip through a socket or card.
    structure.object3D.scale.setScalar(isXR ? XR_SCALE : 1);
    structure.object3D.position.z = structureBaseZ + (isXR
      ? -XR_CYCLE_DEPTH_M - XR_SCALE * cycleCenterZ
      : 0);
    // The tray framing was retired by user request: the cards keep their
    // original arc positions in both modes, exactly as they always sat.
  };

  return {
    cardsByNodeId,
    socketsByIndex,
    linksById,
    linkMaterialsById,
    traySpawnSlots,
    floatItems,
    applyXRLayout,
    sharedGeometries,
    sharedMaterials,
    sharedTextures,
    entities,
    pulseItems,
    tickPulse: (t: number): void => {
      for (const item of pulseItems) {
        item.mat.opacity = item.base + item.amp * (0.5 + 0.5 * Math.sin(t * item.speed + item.phase));
      }
    },
    setDragPreview,
    tickMotion,
    rippleAt,
    playLinkDraw,
    isLinkAnimating,
    playCompletionWave,
    setCompletionGlow,
    ensureLinks,
    linkMidpoint: (id: string) => linkMidpoint(id),
    completionDebug: () => ({
      waveLinks: linkAnims.size,
      ringVisible: ring.visible,
      ringScale: +ring.scale.x.toFixed(2),
      bloomVisible: harmony.visible,
      bloomOpacity: +harmonyMaterial.opacity.toFixed(2),
      flareArmed: sunFlareArmed,
      flareActive: sunFlareStart !== null,
      chordFired: chordVoicesFired,
      dotsBusy: dots.filter((d) => d.busy).length,
    }),
    root,
    structure,
    baseHead: {
      position: { x: head.position.x, y: head.position.y, z: head.position.z },
      yaw: head.yaw,
    },
    rotRad,
  };
}

/** Destroy a spawned structure's entities and free its GPU resources. */
export function disposeSpawn(handles: SpawnHandles): void {
  for (const e of handles.entities) {
    try {
      e.dispose({ disposeResources: false });
    } catch {
      // Already destroyed.
    }
  }
  for (const g of handles.sharedGeometries) g.dispose();
  for (const m of handles.sharedMaterials) m.dispose();
  for (const t of handles.sharedTextures) t.dispose();
}