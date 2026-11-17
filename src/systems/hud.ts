// src/systems/hud.ts
// Canvas-textured HUD panels, parented to the spawn root (head-relative, same
// coordinate contract as spawn.ts). 2x canvas resolution for crispness.
//
// Panels — styled to match the reference mockup exactly:
//  - Recall logo (glass cube + wordmark + tagline), top left.
//  - Instruction card, top right: phase-aware copy + "1 / 4" + session dots.
//  - Progress card, right: label + blue bar + "N / M Links".
//  - Menu column, left: ONE dark panel with Restart / Next Day / Settings
//    rows (implemented as three flush button meshes for per-row clicks).
//  - Summary modal, centre: end-of-session report + Replay / Next Day.
//  - Toast, bottom centre: transient success / error pill with icon.
//
// Buttons take pointer 'click' events from the pmndrs pointer system, with a
// canvas-click raycast fallback for desktop.

import {
  Mesh,
  PlaneGeometry,
  MeshBasicMaterial,
  CanvasTexture,
  SRGBColorSpace,
  DoubleSide,
  Raycaster,
  RayInteractable,
  Vector2,
  type Texture,
  type Material,
  type BufferGeometry,
} from '@iwsdk/core';
import { SpringValue, damp } from './motion';
import { sfx } from './audio';

export type HudPhase = 'see' | 'rebuild' | 'summary';

const FONT_STACK =
  '600 {S}px system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';

const TOAST_SHOW_MS = 2600;
const TOAST_FADE_MS = 400;
const TOAST_ENTRANCE_MS = 220;
// Top-centre: the only clear band (the tray owns the bottom; title/instruction
// own the upper corners) — feedback sits in the attention field without
// covering the tray cards or the learning structure (spec §6).
const TOAST_Y = 0.4;
const CLICK_LOCKOUT_MS = 250;

export interface SummaryInfo {
  sessionNum: number;
  strong: number;
  total: number;
  weakLinks: string[];
  /** Average relationship strength, 0-100. */
  masteryPct: number;
  /** Mastery change vs the previous session, in points (null on day 1). */
  masteryDelta: number | null;
  /** True when the next session adapts into a weak-concept drill. */
  nextDrill: boolean;
  /** Rejected placements this session (drives the honest closing line). */
  rejected: number;
  /** Concept the slips clustered on, if any. */
  slipFocus?: string;
}

export interface HudHandles {
  setPhase(phase: HudPhase, sessionNum: number): void;
  setProgress(litCount: number, total: number): void;
  showToast(main: string, sub: string, tone: 'success' | 'error' | 'info'): void;
  /** First-session study cue during SEE (auto-fades; never repeats). */
  showIntroCue(text: string): void;
  showSummary(info: SummaryInfo): void;
  hideSummary(): void;
  /** Drive the toast fade. Call once per frame with the frame delta in seconds. */
  tickToast(delta: number): void;
  /** Drive the polish layer: button hover/press, progress fill, modal fade. */
  tickFx(delta: number): void;
  /** Destroy every HUD entity (called on session teardown). */
  dispose(): void;
  /** Wired by index.ts. */
  onRestart: () => void;
  onNextDay: () => void;
  /** High-contrast palette toggle (accessibility). */
  onToggleContrast: () => void;
  /** User-requested hint for the highest-need concept (rebuild phase). */
  onHint: () => void;
  /** XR framing: panels wrap around the player instead of the front spread. */
  setXRMode: (isXR: boolean) => void;
  /**
   * Head-follow for the whole HUD: the anchor (and every panel on it) keeps
   * the user's head yaw, so side options live at the user's left and right —
   * they turn to bring them into view, and the panels never drift farther
   * away. `yaw` is the head's yaw relative to the spawn root.
   */
  setHeadYaw: (yaw: number) => void;
}

interface Canvas2D {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
}

function makeCanvas(widthPx: number, heightPx: number): Canvas2D {
  const canvas = document.createElement('canvas');
  canvas.width = widthPx;
  canvas.height = heightPx;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('hud: 2D canvas context unavailable');
  return { canvas, ctx };
}

function toTexture(canvas: HTMLCanvasElement, maxAnisotropy: number): CanvasTexture {
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = maxAnisotropy;
  // Repeat stays at the default (1, 1). Scaling it by 1/mesh-size used to
  // "fix" blur but actually tiled the UVs (e.g. ×5.6/×7.7 on the instruction
  // panel): with ClampToEdge wrapping the canvas's left/top sliver stretched
  // across the whole panel and the rest smeared — unreadable, warped panels.
  // Sharpness comes from canvas resolution vs mesh size, not from repeat.
  texture.needsUpdate = true;
  return texture;
}

/**
 * Shared dark-glass panel base, per the spec: translucent dark navy
 * (#141a2b @ ~82%), thin glowing blue border (#3b82f6/#60a5fa) with a soft
 * outer glow.
 */
function panelBase(ctx: CanvasRenderingContext2D, w: number, h: number, radii: number | number[]): void {
  ctx.clearRect(0, 0, w, h);
  // Spec §2 materials: quiet glass — a soft glow under a gentle border,
  // hierarchy from contrast instead of neon.
  ctx.shadowColor = 'rgba(59, 130, 246, 0.32)';
  ctx.shadowBlur = 18;
  ctx.fillStyle = 'rgba(20, 26, 43, 0.82)';
  ctx.beginPath();
  if (Array.isArray(radii)) {
    ctx.roundRect(8, 8, w - 16, h - 16, radii as [number, number, number, number]);
  } else {
    ctx.roundRect(8, 8, w - 16, h - 16, radii);
  }
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(96, 165, 250, 0.5)';
  ctx.stroke();
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/);
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

function yawFacing(local: { x: number; z: number }): number {
  return Math.atan2(-local.x, -local.z);
}

/** Glass cube logo, as in the reference. */
function drawCubeLogo(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  ctx.save();
  ctx.translate(cx, cy);
  // top face
  let g = ctx.createLinearGradient(0, -r, 0, 0);
  g.addColorStop(0, '#9cc8ff');
  g.addColorStop(1, '#5a8fe0');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(0, -r); ctx.lineTo(r * 0.87, -r * 0.5); ctx.lineTo(0, 0); ctx.lineTo(-r * 0.87, -r * 0.5); ctx.closePath();
  ctx.fill();
  // right face
  g = ctx.createLinearGradient(0, 0, r * 0.87, r * 0.5);
  g.addColorStop(0, '#2c56a8');
  g.addColorStop(1, '#1c3a78');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(0, 0); ctx.lineTo(r * 0.87, -r * 0.5); ctx.lineTo(r * 0.87, r * 0.5); ctx.lineTo(0, r); ctx.closePath();
  ctx.fill();
  // left face
  g = ctx.createLinearGradient(-r * 0.87, 0, 0, r);
  g.addColorStop(0, '#5a8fe0');
  g.addColorStop(1, '#3a68c0');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(0, 0); ctx.lineTo(-r * 0.87, -r * 0.5); ctx.lineTo(-r * 0.87, r * 0.5); ctx.lineTo(0, r); ctx.closePath();
  ctx.fill();
  // glass highlight
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.beginPath();
  ctx.moveTo(0, -r); ctx.lineTo(r * 0.4, -r * 0.77); ctx.lineTo(r * 0.2, -r * 0.3); ctx.lineTo(-r * 0.1, -r * 0.5); ctx.closePath();
  ctx.fill();
  ctx.restore();
}

export function createHud(world: any, root: any): HudHandles {
  const geometries: BufferGeometry[] = [];
  const materials: Material[] = [];
  const textures: Texture[] = [];

  const maxAnisotropy =
    typeof world?.renderer?.capabilities?.getMaxAnisotropy === 'function'
      ? world.renderer.capabilities.getMaxAnisotropy()
      : 1;

  const buttonMeshes: Mesh[] = [];
  /** Per-button motion state for hover/press feedback (spec §5A/§7). */
  const buttonFxList: Array<{
    mesh: Mesh;
    mat: MeshBasicMaterial;
    hoverT: boolean;
    hoverVal: number;
    press: SpringValue;
  }> = [];
  const entities: any[] = [];
  let lastClickAt = 0;

  // Head-follow anchor: every HUD panel hangs off this entity, which tracks
  // the user's head yaw (setHeadYaw). Panels placed at the left/right bearings
  // stay AT the user's sides at a constant radius — turning brings them into
  // view, and they are never farther away for having turned.
  const anchor = world.createTransformEntity(undefined, { parent: root });
  entities.push(anchor);
  anchor.object3D.name = 'hud-anchor';

  // Side panels that move between the flat front-spread and the XR
  // around-the-player bearings. The XR pose is either polar (bearing/radius)
  // or absolute cartesian — the summary stack needs the exact top-centre band
  // above the cycle, which polar bearings express awkwardly.
  interface SidePanelSpec {
    entity: any;
    flat: { x: number; y: number; z: number };
    xr?: { bearing: number; radius: number; y: number } | { x: number; y: number; z: number };
  }
  const sidePanels: SidePanelSpec[] = [];

  /** Local position at a bearing (deg, 0 = forward/-Z, positive = left). */
  const bearingPosition = (bearingDeg: number, radius: number, y: number) => {
    const a = (bearingDeg * Math.PI) / 180;
    return { x: -Math.sin(a) * radius, y, z: -Math.cos(a) * radius };
  };

  const addPanel = (
    canvas2d: Canvas2D,
    widthM: number,
    heightM: number,
    x: number,
    y: number,
    z: number,
    interactive = false,
  ): { material: MeshBasicMaterial; texture: CanvasTexture; mesh: Mesh; entity: any } => {
    const texture = toTexture(canvas2d.canvas, maxAnisotropy);
    textures.push(texture);

    const material = new MeshBasicMaterial({
      transparent: true,
      side: DoubleSide,
      map: texture,
      depthWrite: false,
    });
    materials.push(material);

    const geometry = new PlaneGeometry(widthM, heightM);
    geometries.push(geometry);

    const mesh = new Mesh(geometry, material);
    const entity = world.createTransformEntity(mesh, { parent: anchor });
    entities.push(entity);
    entity.object3D.position.set(x, y, z);
    entity.object3D.rotation.set(0, yawFacing({ x, z }), 0);
    if (interactive) {
      // Without RayInteractable the panel never enters IWSDK's XR pointer
      // raycast list (scene.rayDescendants), so controller rays can't reach
      // its click listener — the menu was dead in immersive sessions.
      entity.addComponent(RayInteractable);
    }
    return { material, texture, mesh, entity };
  };


  // --- Title panel (static, top left — logo + wordmark + tagline) ---
  {
    const { canvas, ctx } = makeCanvas(1024, 260);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    drawCubeLogo(ctx, 92, 128, 74);

    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#ffffff';
    ctx.font = '800 136px system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';
    ctx.fillText('Recall', 206, 148);
    ctx.fillStyle = 'rgba(165, 195, 230, 0.95)';
    ctx.font = FONT_STACK.replace('{S}', '52');
    ctx.fillText('Rebuild what you know.', 208, 226);

    const titlePanelHolder = addPanel({ canvas, ctx }, 0.32, 0.0813, -0.48, 0.41, -0.75);
    sidePanels.push({
      entity: titlePanelHolder.entity,
      flat: { x: -0.48, y: 0.41, z: -0.75 },
      xr: { bearing: 55, radius: 0.64, y: 0.3 },
    });
  }

  // --- Instruction panel (redrawn per phase / session) ---
  let instruction: Canvas2D;
  let instructionPanel: { material: MeshBasicMaterial; texture: CanvasTexture };
  {
    instruction = makeCanvas(1024, 742);
    instructionPanel = addPanel(instruction, 0.27, 0.1956, 0.5, 0.42, -0.75);
    (instructionPanel as any).redraw = (phase: HudPhase, sessionNum: number) => {
      const { canvas, ctx } = instruction;
      panelBase(ctx, canvas.width, canvas.height, 56);

      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = '#ffffff';
      ctx.font = FONT_STACK.replace('{S}', '74');
      const title = phase === 'see' ? 'Study the structure' : 'Rebuild the Structure';
      ctx.fillText(title, 60, 148);

      ctx.fillStyle = 'rgba(200, 220, 245, 0.9)';
      ctx.font = FONT_STACK.replace('{S}', '60');
      const body =
        phase === 'see'
          ? 'Memorize how the concepts connect — it scrambles in a moment.'
          : 'Drag the concepts and place them in the right positions.';
      let by = 250;
      for (const line of wrapText(ctx, body, canvas.width - 150)) {
        ctx.fillText(line, 60, by);
        by += 84;
      }

      // "1 / 4" + session dots on the bottom row.
      const label = `${Math.min(sessionNum, 4)} / 4`;
      ctx.fillStyle = '#ffffff';
      ctx.font = FONT_STACK.replace('{S}', '68');
      ctx.fillText(label, 60, canvas.height - 82);

      for (let i = 0; i < 4; i++) {
        ctx.beginPath();
        ctx.arc(700 + i * 74, canvas.height - 106, 16, 0, Math.PI * 2);
        if (i < Math.min(sessionNum, 4)) {
          ctx.fillStyle = '#3b82f6';
          ctx.fill();
        } else {
          // Hollow dim step-dot (spec).
          ctx.lineWidth = 4;
          ctx.strokeStyle = 'rgba(58, 66, 86, 0.95)';
          ctx.stroke();
        }
      }
      instructionPanel.texture.needsUpdate = true;
    };
  }

  // --- Progress panel (bar eases toward its target — spec §7) ---
  let progress: Canvas2D;
  let progressPanel: { material: MeshBasicMaterial; texture: CanvasTexture };
  let progressLit = 0;
  let progressTotal = 8;
  let progressTargetFrac = 0;
  let progressShownFrac = 0;
  const redrawProgress = (): void => {
    const { canvas, ctx } = progress;
    panelBase(ctx, canvas.width, canvas.height, 56);

    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#ffffff';
    ctx.font = FONT_STACK.replace('{S}', '56');
    ctx.fillText('Progress', 56, 110);

    const trackW = canvas.width - 112;
    ctx.fillStyle = '#2a3142';
    ctx.beginPath();
    ctx.roundRect(56, 152, trackW, 38, 19);
    ctx.fill();
    if (progressShownFrac > 0) {
      ctx.fillStyle = '#3b82f6';
      ctx.beginPath();
      ctx.roundRect(56, 152, Math.max(38, trackW * progressShownFrac), 38, 19);
      ctx.fill();
    }

    ctx.fillStyle = 'rgba(210, 225, 245, 0.95)';
    ctx.font = FONT_STACK.replace('{S}', '52');
    ctx.fillText(`${progressLit} / ${progressTotal} Links`, 56, 290);
    progressPanel.texture.needsUpdate = true;
  };
  {
    // Canvas trimmed to the content (title, bar, count) — the old 625-px
    // canvas left the bottom half of the panel as dead empty space.
    progress = makeCanvas(1024, 340);
    progressPanel = addPanel(progress, 0.24, 0.0797, 0.5, -0.24, -0.75);
    redrawProgress();
  }
  sidePanels.push({
    entity: (instructionPanel as any).entity,
    flat: { x: 0.5, y: 0.42, z: -0.75 },
    xr: { bearing: -95, radius: 0.8, y: 0.14 },
  });
  sidePanels.push({
    entity: (progressPanel as any).entity,
    flat: { x: 0.5, y: -0.24, z: -0.75 },
    xr: { bearing: -122, radius: 0.8, y: -0.02 },
  });

  // --- Menu column: one panel, three rows (flush button meshes) ---
  const buttonHandlers = new Map<Mesh, () => void>();
  const ICON_PAINTERS_HUD: Record<string, (ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number) => void> = {
    contrast(ctx, cx, cy, s) {
      // Half-filled circle: the classic contrast glyph.
      ctx.strokeStyle = '#7cb5ff';
      ctx.lineWidth = s * 0.14;
      ctx.beginPath();
      ctx.arc(cx, cy, s * 0.5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = '#7cb5ff';
      ctx.beginPath();
      ctx.arc(cx, cy, s * 0.5, Math.PI * 1.5, Math.PI * 0.5);
      ctx.fill();
    },
    hint(ctx, cx, cy, s) {
      // Question-mark glyph: open arc, dot, soft glow.
      ctx.strokeStyle = '#7cb5ff';
      ctx.lineWidth = s * 0.14;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(cx, cy - s * 0.05, s * 0.52, 0.55 * Math.PI, 1.75 * Math.PI);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx - s * 0.12, cy + s * 0.05);
      ctx.quadraticCurveTo(cx + s * 0.28, cy + s * 0.12, cx + s * 0.02, cy + s * 0.42);
      ctx.stroke();
      ctx.fillStyle = '#7cb5ff';
      ctx.beginPath();
      ctx.arc(cx, cy + s * 0.62, s * 0.09, 0, Math.PI * 2);
      ctx.fill();
    },
    restart(ctx, cx, cy, s) {
      ctx.strokeStyle = '#7cb5ff';
      ctx.lineWidth = s * 0.13;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(cx, cy, s * 0.62, -0.4 * Math.PI, 0.9 * Math.PI);
      ctx.stroke();
      // arrowhead
      const ax = cx + Math.cos(-0.4 * Math.PI) * s * 0.62;
      const ay = cy + Math.sin(-0.4 * Math.PI) * s * 0.62;
      ctx.fillStyle = '#7cb5ff';
      ctx.beginPath();
      ctx.moveTo(ax - s * 0.3, ay - s * 0.08);
      ctx.lineTo(ax + s * 0.28, ay - s * 0.1);
      ctx.lineTo(ax - s * 0.02, ay + s * 0.38);
      ctx.closePath();
      ctx.fill();
    },
    play(ctx, cx, cy, s) {
      // Fast-forward / skip: double triangle (spec).
      ctx.fillStyle = '#7cb5ff';
      for (const off of [-s * 0.28, s * 0.28]) {
        ctx.beginPath();
        ctx.moveTo(cx + off - s * 0.34, cy - s * 0.48);
        ctx.lineTo(cx + off + s * 0.38, cy);
        ctx.lineTo(cx + off - s * 0.34, cy + s * 0.48);
        ctx.closePath();
        ctx.fill();
      }
    },
    gear(ctx, cx, cy, s) {
      ctx.fillStyle = '#7cb5ff';
      ctx.save();
      ctx.translate(cx, cy);
      for (let k = 0; k < 8; k++) {
        const a = (k * Math.PI) / 4;
        ctx.save();
        ctx.rotate(a);
        ctx.fillRect(-s * 0.09, -s * 0.82, s * 0.18, s * 0.34);
        ctx.restore();
      }
      ctx.beginPath();
      ctx.arc(0, 0, s * 0.52, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(20, 26, 43, 0.82)';
      ctx.beginPath();
      ctx.arc(0, 0, s * 0.24, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    },
  };
  const makeMenuButton = (
    label: string,
    icon: string,
    corner: 'top' | 'mid' | 'bottom' | 'full',
    x: number,
    y: number,
    z: number,
    onClick: () => void,
    widthM = 0.18,
  ): { entity: any; mesh: Mesh; material: MeshBasicMaterial } => {
    const { canvas, ctx } = makeCanvas(768, 290);
    const radii =
      corner === 'top'
        ? [56, 56, 0, 0]
        : corner === 'bottom'
          ? [0, 0, 56, 56]
          : corner === 'full'
            ? 44
            : 0;
    panelBase(ctx, canvas.width, canvas.height, radii);

    ICON_PAINTERS_HUD[icon](ctx, 118, 145, 82);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    // Long labels ('Study again') step down a size instead of clipping.
    ctx.font = FONT_STACK.replace('{S}', label.length > 8 ? '72' : '92');
    ctx.fillStyle = '#ffffff';
    ctx.fillText(label, 232, 150);

    // Buttons need pointer rays (desktop + XR), so they are interactive panels.
    // Height preserves the canvas aspect (768x290) for undistorted text.
    const panel = addPanel({ canvas, ctx }, widthM, widthM * (290 / 768), x, y, z, true);
    if (z === -0.75) {
      // Front-line menu buttons in the flat spread; around the player in XR
      // (left column at the user's left, right panels at their right).
      sidePanels.push({
        entity: panel.entity,
        flat: { x, y, z },
        xr: { bearing: x < 0 ? 95 : -95, radius: 0.68, y: y + 0.1 },
      });
    }
    buttonMeshes.push(panel.mesh);
    buttonHandlers.set(panel.mesh, onClick);
    // Hover + press feedback (spec §7): a quiet lift and a gentle press dip,
    // driven per-frame in tickFx.
    const fx = {
      mesh: panel.mesh,
      mat: panel.material,
      hoverT: false,
      hoverVal: 0,
      press: new SpringValue(1, 260, 16),
    };
    buttonFxList.push(fx);
    panel.mesh.addEventListener('pointerenter', () => {
      fx.hoverT = true;
    });
    panel.mesh.addEventListener('pointerleave', () => {
      fx.hoverT = false;
    });
    // Actuate on release. 'click' alone drops long XR trigger presses: the
    // pointer system only emits 'click' when the press is shorter than its
    // click threshold (800 ms) — a slow frame or a deliberate hold silently
    // swallows it. 'pointerup' fires whenever the press ends on this button;
    // the click lockout keeps the pair from double-firing.
    const activate = (e: any): void => {
      if (e?.button != null && e.button !== 0) return;
      const now = performance.now();
      if (now - lastClickAt < CLICK_LOCKOUT_MS) return;
      lastClickAt = now;
      fx.press.setValueKeepTarget(0.94); // dip, then spring back to 1
      sfx.button();
      onClick();
    };
    panel.mesh.addEventListener('click', activate);
    panel.mesh.addEventListener('pointerup', activate);
    return { entity: panel.entity, mesh: panel.mesh, material: panel.material };
  };

  // --- Summary modal (hidden until session completes; fades + settles in) ---
  // Top-centre in BOTH modes, clear of the learning structure: the completion
  // wave plays on the cycle, and a centre modal would sit in front of it and
  // hide the reward moment (user: overlaps = bad UX).
  let summary: Canvas2D;
  let summaryPanel: { material: MeshBasicMaterial; texture: CanvasTexture };
  let summaryMesh: Mesh;
  let summaryTargetOpacity = 0;
  let summaryOpacity = 0;
  {
    summary = makeCanvas(1024, 640);
    const sp = addPanel(summary, 0.3, 0.1875, 0, 0.28, -0.52);
    summaryPanel = { material: sp.material, texture: sp.texture };
    summaryMesh = sp.mesh;
    sidePanels.push({
      entity: sp.entity,
      flat: { x: 0, y: 0.28, z: -0.52 },
      xr: { x: 0, y: 0.44, z: -0.55 },
    });
    (summaryPanel as any).redraw = (info: SummaryInfo) => {
      const { canvas, ctx } = summary;
      panelBase(ctx, canvas.width, canvas.height, 56);

      // Auto-fit: long lines (the slip note, actionable hints) shrink until
      // they sit inside the panel instead of clipping at the right edge.
      const fitLine = (text: string, size: number, maxRight = canvas.width - 60): number => {
        let px = size;
        ctx.font = FONT_STACK.replace('{S}', String(px));
        while (ctx.measureText(text).width + 60 > maxRight && px > 30) {
          px -= 2;
          ctx.font = FONT_STACK.replace('{S}', String(px));
        }
        return px;
      };

      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = '#ffffff';
      ctx.font = FONT_STACK.replace('{S}', '80');
      ctx.fillText(`Session ${info.sessionNum} complete!`, 60, 152);

      ctx.fillStyle = 'rgba(210, 225, 245, 0.95)';
      ctx.font = FONT_STACK.replace('{S}', '62');
      ctx.fillText(`${info.strong} of ${info.total} links strong`, 60, 256);

      // Mastery trend (session-history comparison).
      ctx.font = FONT_STACK.replace('{S}', '52');
      const trend = info.masteryDelta === null
        ? ''
        : info.masteryDelta >= 0
          ? `▲ ${info.masteryDelta}`
          : `▼ ${Math.abs(info.masteryDelta)}`;
      ctx.fillStyle = 'rgba(140, 208, 255, 0.95)';
      ctx.fillText(
        `Mastery ${info.masteryPct}%${trend ? `  ${trend}` : ''}`,
        60,
        324,
      );

      if (info.weakLinks.length > 0) {
        ctx.fillStyle = 'rgba(255, 196, 120, 0.95)';
        ctx.font = FONT_STACK.replace('{S}', '56');
        ctx.fillText('Next time:', 60, 396);
        ctx.fillStyle = 'rgba(210, 225, 245, 0.85)';
        let y = 462;
        for (const line of info.weakLinks.slice(0, 2)) {
          const text = `• ${line}`;
          ctx.font = FONT_STACK.replace('{S}', String(fitLine(text, 52)));
          ctx.fillText(text, 80, y);
          y += 62;
        }
      } else if (info.rejected > 0) {
        // Slips with no relationship evidence (occupied/out-of-band drops):
        // acknowledge them honestly instead of claiming a perfect run — and
        // name where tomorrow's mix shifts, because those slips were recorded.
        ctx.fillStyle = 'rgba(170, 196, 235, 0.9)';
        const slipText = `${info.rejected} slip${info.rejected === 1 ? '' : 's'} — relationships intact, tomorrow watches ${info.slipFocus ?? 'you'}`;
        ctx.font = FONT_STACK.replace('{S}', String(fitLine(slipText, 52)));
        ctx.fillText(slipText, 60, 396);
      } else {
        ctx.fillStyle = 'rgba(126, 240, 192, 0.95)';
        ctx.font = FONT_STACK.replace('{S}', '52');
        ctx.fillText('Perfect recall — see you tomorrow!', 60, 396);
      }
      // Adapting to performance: the next session's shape, stated simply.
      if (info.nextDrill) {
        ctx.fillStyle = 'rgba(170, 196, 235, 0.9)';
        ctx.font = FONT_STACK.replace('{S}', '44');
        ctx.fillText('Next session: weak-concept drill', 60, canvas.height - 44);
      }
      summaryPanel.texture.needsUpdate = true;
    };
    summaryPanel.material.visible = false;
    summaryPanel.material.opacity = 0;
  }

  // Summary's own action buttons (user: "put these on the table") — a compact
  // row floating just above the table surface, in front of the tray, directly
  // in the downward glance: zero overlap with the cycle above, and no head
  // tilt needed. Registered with the side-panel system like every panel.
  const replayBtn = makeMenuButton('Study again', 'restart', 'full', -0.16, 0.075, -0.52, () => {
    hud.onRestart();
  }, 0.13);
  const nextDayBtn = makeMenuButton('Next Day', 'play', 'full', 0, 0.075, -0.52, () => {
    hud.onNextDay();
  }, 0.13);
  const closeBtn = makeMenuButton('Close', 'gear', 'full', 0.16, 0.075, -0.52, () => {
    hud.hideSummary();
  }, 0.13);
  sidePanels.push(
    // XR: the ring rotates a few degrees per session, so dodging it laterally
    // can never be reliable — the row instead sits clearly BELOW the card
    // band (the lowest card bottoms out ~0.13 above this line), still inside
    // the frontal glance.
    { entity: replayBtn.entity, flat: { x: -0.16, y: 0.075, z: -0.52 }, xr: { x: -0.32, y: -0.27, z: -0.45 } },
    { entity: nextDayBtn.entity, flat: { x: 0, y: 0.075, z: -0.52 }, xr: { x: -0.1, y: -0.27, z: -0.45 } },
    { entity: closeBtn.entity, flat: { x: 0.16, y: 0.075, z: -0.52 }, xr: { x: 0.12, y: -0.27, z: -0.45 } },
  );
  // Replay / Next Day / Close start hidden with the modal.
  for (const m of buttonMeshes.slice(0, 3)) m.visible = false;

  // Menu column (left, one panel of three flush rows — reference layout with
  // Hint in the middle; Settings was removed: it had no function behind it).
  makeMenuButton('Restart', 'restart', 'top', -0.48, -0.12, -0.75, () => {
    hud.onRestart();
  });
  const hintBtn = makeMenuButton('Hint', 'hint', 'mid', -0.48, -0.188, -0.75, () => {
    hud.onHint();
  });
  makeMenuButton('Next Day', 'play', 'bottom', -0.48, -0.256, -0.75, () => {
    hud.onNextDay();
  });
  // High-contrast toggle (accessibility, additive): swaps cards/sockets/links
  // to the WCAG-AA palette on demand. Default look untouched until pressed.
  makeMenuButton('Contrast', 'contrast', 'full', -0.48, -0.34, -0.75, () => {
    hud.onToggleContrast();
  });

  // Desktop fallback: canvas click + raycast against button meshes (in case
  // the pointer-event object listeners don't fire in a given setup).
  try {
    const canvas = world?.renderer?.domElement as HTMLCanvasElement | undefined;
    if (canvas) {
      const raycaster = new Raycaster();
      const ndc = new Vector2();
      const onCanvasClick = (e: PointerEvent): void => {
        const now = performance.now();
        if (now - lastClickAt < CLICK_LOCKOUT_MS || buttonMeshes.length === 0) return;
        const rect = canvas.getBoundingClientRect();
        ndc.set(
          ((e.clientX - rect.left) / rect.width) * 2 - 1,
          -((e.clientY - rect.top) / rect.height) * 2 + 1,
        );
        raycaster.setFromCamera(ndc, world.camera);
        const hits = raycaster.intersectObjects(buttonMeshes, false);
        if (hits.length > 0) {
          lastClickAt = now;
          buttonHandlers.get(hits[0].object as Mesh)?.();
        }
      };
      canvas.addEventListener('click', onCanvasClick as EventListener);
    }
  } catch {
    // Fallback unavailable; object listeners are the primary path.
  }

  // --- Toast (transient) — reference: dark pill, green check, two lines ---
  const toast = makeCanvas(1536, 360);
  const toastPanel = addPanel({ ...toast }, 0.3, 0.0703, 0, TOAST_Y, -0.62);
  toastPanel.material.visible = false;
  toastPanel.material.opacity = 0;

  let toastElapsed = 0;
  let toastActive = false;

  // --- Intro cue (first session only) — one skippable line during SEE ---
  // Teaches the single interaction verb ("rebuild"). It fades on its own
  // well before Scramble and vanishes instantly if the player grabs early —
  // no modal, no click-through, never shown again (skipIntro flag).
  const introCue = makeCanvas(1200, 200);
  const introCuePanel = addPanel({ ...introCue }, 0.42, 0.42 * (200 / 1200), 0, 0.4, -0.62);
  introCuePanel.material.visible = false;
  introCuePanel.material.opacity = 0;
  let introCueElapsed = 0;
  let introCueActive = false;
  const drawIntroCue = (text: string): void => {
    const { canvas, ctx } = introCue;
    panelBase(ctx, canvas.width, canvas.height, 96);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(214, 232, 252, 0.96)';
    ctx.font = FONT_STACK.replace('{S}', '52');
    ctx.fillText(text, canvas.width / 2, canvas.height / 2 + 4);
    introCuePanel.texture.needsUpdate = true;
  };

  const drawToast = (main: string, sub: string, tone: 'success' | 'error' | 'info'): void => {
    const { canvas, ctx } = toast;
    panelBase(ctx, canvas.width, canvas.height, 110);

    // Icon: filled circle + white check/cross. Errors stay warm amber —
    // guidance, not alarm (spec §5D/§6). Info is a calm sky-blue dot —
    // neutral day-briefing framing, neither praise nor correction.
    const cx = 170;
    const cy = canvas.height / 2;
    ctx.beginPath();
    ctx.arc(cx, cy, 78, 0, Math.PI * 2);
    ctx.fillStyle = tone === 'success' ? '#22c55e' : tone === 'info' ? '#60a5fa' : '#e8a13c';
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 18;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    if (tone === 'success') {
      ctx.moveTo(cx - 36, cy + 4);
      ctx.lineTo(cx - 8, cy + 32);
      ctx.lineTo(cx + 38, cy - 28);
    } else if (tone === 'info') {
      // A bold "i": dot over a bar.
      ctx.moveTo(cx, cy - 34);
      ctx.lineTo(cx + 0.1, cy - 34);
      ctx.moveTo(cx, cy - 6);
      ctx.lineTo(cx, cy + 32);
    } else {
      ctx.moveTo(cx - 30, cy - 30);
      ctx.lineTo(cx + 30, cy + 30);
      ctx.moveTo(cx + 30, cy - 30);
      ctx.lineTo(cx - 30, cy + 30);
    }
    ctx.stroke();

    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#ffffff';
    ctx.font = FONT_STACK.replace('{S}', '86');
    ctx.fillText(main, 300, canvas.height / 2 - 20);
    ctx.fillStyle = 'rgba(170, 200, 235, 0.95)';
    ctx.font = FONT_STACK.replace('{S}', '60');
    ctx.fillText(sub, 300, canvas.height / 2 + 64);

    toastPanel.texture.needsUpdate = true;
  };

  const hud: HudHandles = {
    onRestart: () => {},
    onNextDay: () => {},
    onHint: () => {},
    onToggleContrast: () => {},

    setPhase(phase: HudPhase, sessionNum: number): void {
      // Any phase past SEE retires the intro cue immediately (early grab).
      if (phase !== 'see' && introCueActive) {
        introCueActive = false;
        introCuePanel.material.visible = false;
        introCuePanel.material.opacity = 0;
      }
      (instructionPanel as any).redraw(phase, sessionNum);
      instructionPanel.material.visible = phase !== 'summary';
      // The Hint control only makes sense while rebuilding.
      if (hintBtn) hintBtn.mesh.visible = phase === 'rebuild';
    },

    setProgress(litCount: number, total: number): void {
      progressLit = litCount;
      progressTotal = total;
      progressTargetFrac = total === 0 ? 0 : Math.max(0, Math.min(1, litCount / total));
    },

    showToast(main: string, sub: string, tone: 'success' | 'error' | 'info'): void {
      drawToast(main, sub, tone);
      toastPanel.material.visible = true;
      toastPanel.material.opacity = 0; // entrance ramps it in (tickToast)
      toastElapsed = 0;
      toastActive = true;
    },

    showIntroCue(text: string): void {
      drawIntroCue(text);
      introCuePanel.material.visible = true;
      introCuePanel.material.opacity = 0;
      introCueElapsed = 0;
      introCueActive = true;
    },

    showSummary(info: SummaryInfo): void {
      (summaryPanel as any).redraw(info);
      summaryPanel.material.visible = true;
      summaryTargetOpacity = 1;
      // Reveal the summary buttons (they were hidden with the modal at boot);
      // their opacity follows the modal in tickFx.
      for (const m of buttonMeshes.slice(0, 3)) m.visible = true;
    },

    hideSummary(): void {
      // Fade out; tickFx hides the meshes once the fade lands.
      summaryTargetOpacity = 0;
    },

    tickToast(delta: number): void {
      if (!toastActive) return;
      toastElapsed += delta * 1000;
      const total = TOAST_SHOW_MS + TOAST_FADE_MS;
      if (toastElapsed >= total) {
        toastActive = false;
        toastPanel.material.visible = false;
        toastPanel.material.opacity = 0;
        return;
      }
      // Entrance: quick fade rising up into place (spec §6) — in before you
      // notice it, out before it wears out its welcome.
      let opacity = 1;
      let rise = 0;
      if (toastElapsed < TOAST_ENTRANCE_MS) {
        const k = toastElapsed / TOAST_ENTRANCE_MS;
        opacity = k;
        rise = -(1 - k) * 0.02;
      }
      if (toastElapsed > TOAST_SHOW_MS) {
        const t = (toastElapsed - TOAST_SHOW_MS) / TOAST_FADE_MS;
        opacity = 1 - t;
      }
      toastPanel.material.opacity = opacity;
      toastPanel.entity.object3D.position.y = TOAST_Y + rise;
    },

    tickFx(delta: number): void {
      // Button hover lift + press dip (spec §7).
      for (const b of buttonFxList) {
        b.hoverVal = damp(b.hoverVal, b.hoverT ? 1 : 0, 16, delta);
        const press = b.press.update(delta);
        b.mesh.scale.setScalar((1 + 0.035 * b.hoverVal) * press);
        b.mat.color.setScalar(1 + 0.14 * b.hoverVal);
      }
      // Progress bar eases toward its target; the count updates with it.
      if (Math.abs(progressTargetFrac - progressShownFrac) > 0.0012) {
        progressShownFrac = damp(progressShownFrac, progressTargetFrac, 8, delta);
        redrawProgress();
      } else if (progressShownFrac !== progressTargetFrac) {
        progressShownFrac = progressTargetFrac;
        redrawProgress();
      }
      // Intro cue fade: in quickly, hold, gone before Scramble (SEE runs
      // ~5 s on the first session; the cue lives ~0.3-4.2 s of it).
      if (introCueActive) {
        introCueElapsed += delta * 1000;
        const hold = 3600;
        const fade = 600;
        if (introCueElapsed >= hold + fade) {
          introCueActive = false;
          introCuePanel.material.visible = false;
          introCuePanel.material.opacity = 0;
        } else {
          const fadeIn = Math.min(1, introCueElapsed / 300);
          const fadeOut = introCueElapsed > hold ? 1 - (introCueElapsed - hold) / fade : 1;
          introCuePanel.material.opacity = Math.min(fadeIn, fadeOut);
        }
      }
      // Summary modal fade + gentle scale settle (spec §5A/§8).
      if (Math.abs(summaryTargetOpacity - summaryOpacity) > 0.001) {
        summaryOpacity = damp(summaryOpacity, summaryTargetOpacity, 11, delta);
        summaryPanel.material.opacity = summaryOpacity;
        summaryMesh.scale.setScalar(0.94 + 0.06 * summaryOpacity);
        for (const m of buttonMeshes.slice(0, 3)) {
          (m.material as MeshBasicMaterial).opacity = summaryOpacity;
        }
        if (summaryTargetOpacity === 0 && summaryOpacity < 0.02) {
          summaryOpacity = 0;
          summaryPanel.material.visible = false;
          summaryPanel.material.opacity = 0;
          summaryMesh.scale.setScalar(1);
          for (const m of buttonMeshes.slice(0, 3)) m.visible = false;
        }
      }
    },

    setXRMode(isXR: boolean): void {
      // Flat: panels spread across the front (all inside the 2D view). XR:
      // panels move onto a ring around the player — menu at their LEFT,
      // instruction/progress at their RIGHT — so turning brings them into
      // view at a constant, close radius.
      for (const p of sidePanels) {
        const pos = isXR && p.xr
          ? ('bearing' in p.xr
              ? bearingPosition(p.xr.bearing, p.xr.radius, p.xr.y)
              : p.xr)
          : p.flat;
        p.entity.object3D.position.set(pos.x, pos.y, pos.z);
        p.entity.object3D.rotation.set(0, yawFacing({ x: pos.x, z: pos.z }), 0);
      }
    },

    setHeadYaw(yaw: number): void {
      // Intentionally unused: side panels are WORLD-ANCHORED around the
      // player (fixed bearings at their left/right). Rotating them with the
      // head would glue them to the edge of the gaze — unreachable. Turning
      // the head brings the world-fixed panels into view instead.
      void yaw;
    },

    dispose(): void {
      for (const e of entities) {
        try {
          e.dispose({ disposeResources: false });
        } catch {
          // Already destroyed.
        }
      }
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
      for (const t of textures) t.dispose();
    },
  };

  return hud;
}
