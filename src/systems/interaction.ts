// src/systems/interaction.ts
// Pinch/ray grab, move, snap-or-return, plus the feedback wiring: link ghost
// states, progress, toasts. Grab goes through IWSDK's GrabSystem via the
// DistanceGrabbable component: the pointer ray hits the card meshes, the
// trigger press starts the distance grab, and the transient Grabbed tag drives
// the gameplay feedback below. (A former hand-rolled selectstart raycast path
// was removed — it duplicated this pipeline and fought it over the held card
// once the card meshes became raycastable again.)
//
// Coordinate contract: cards are children of the spawn root, and every position
// in this file is root-LOCAL (head at the local origin, looking toward -z).

import {
  Vector3,
  Quaternion,
  Matrix4,
  Raycaster,
  Vector2,
  createSystem,
  DistanceGrabbable,
  Grabbed,
  GrabSystem,
  MovementMode,
} from '@iwsdk/core';

import type { Pack } from '../packs/types';
import type { Layout, Vec3 } from './layout';
import type { SpawnHandles } from './spawn';
import type { HudHandles, HudPhase } from './hud';
import { Card, Socket, LinkLine } from '../components';
import { checkPlacement, getLitLinks, isComplete, linkId, type Placed, type Socket as ValidatorSocket } from './validator';
import { SpringValue, damp, easeOutCubic } from './motion';
import { sfx } from './audio';

/** Raycast passthrough for cards that must not steal the pointer ray. */
const NO_RAYCAST = (): void => {};

/** Snap radius, metres (pointer-ray distance to a socket centre). Generous
 * by design — comfort over precision (spec §4). */
export const SNAP_RADIUS_M = 0.3;

/** Return-glide duration, seconds. */
export const RETURN_DURATION_S = 0.4;

/** Spring settle into a socket on a successful placement — quick and decisive;
 * the iOS-style ripple that blooms out of the card carries the moment. */
const SNAP_TWEEN_S = 0.26;

/** Scramble glide + per-card stagger ("watch it break", relaxed). */
const SCRAMBLE_TWEEN_S = 0.36;
const SCRAMBLE_STAGGER_S = 0.04;

/** Per-card motion state for the polish layer (spec §3/§5). */
interface CardFx {
  /** Smoothed 0..1 hover response. */
  hover: number;
  /** Grab compression: 1 → 0.96 → settles at 1.02 while held, back to 1. */
  grab: SpringValue;
  /** Snap pop: starts at 1.055 on placement, springs back to rest. */
  pop: SpringValue;
  /** Border illumination flash on a successful placement, decays. */
  flash: number;
  /** Warm amber tint on a rejected placement, decays. */
  amber: number;
  /** Pulse-clock time when the compression settles into the held pose. */
  grabSettleAt: number;
}

export const InteractionSystem = createSystem({
  allCards: { required: [Card] },
});

export class InteractionSystemImpl extends InteractionSystem {
  private pack!: Pack;
  private layout!: Layout;
  private spawn!: SpawnHandles;
  private hud!: HudHandles;
  private validatorSockets: ValidatorSocket[] = [];
  private configured = false;

  /** 'see' drops never snap (the structure is on display); 'summary' ignores input. */
  private phase: HudPhase = 'see';

  /** Fired when the structure is fully rebuilt and valid. */
  onComplete: (() => void) | null = null;

  private returning: ReturningCard[] = [];
  private traySlotOfCard: Map<string, number> = new Map();
  private traySlotOccupant: Map<number, string> = new Map();
  private heldNodeIds: Set<string> = new Set();
  /** Precise rejection records (attribution upgrade). */
  private sessionRejections: Array<{ nodeId: string; reason: string; linkIds: string[] }> = [];
  private hintedConcepts = new Set<string>();
  private hintLevels = new Map<string, number>();
  /** Currently satisfied link ids — drives the draw-in of new connections. */
  private litLinks: Set<string> = new Set();
  /** Hover state per card (pointer events from IWSDK's pointer system). */
  private hoverTargets: Map<string, boolean> = new Map();
  /** Per-card motion state: hover ease, grab compression, snap pop, tints. */
  private cardFx: Map<string, CardFx> = new Map();
  /** Entities with an active tween — the idle bob must not fight them. */
  private tweenEntities: Set<any> = new Set();
  /** Scramble stagger counter — each card leaves a beat after the last. */
  private scrambleIndex = 0;
  /** Scheduled completion-flourish pops: cards breathe in flow order. */
  private cardWaveQueue: Array<{ nodeId: string; at: number }> = [];
  /** Card meshes + their native raycast, for the placed-card ray passthrough. */
  private cardRaycast: Map<string, Array<{ mesh: any; native: any }>> = new Map();
  /**
   * Hand ('left'/'right') that grabbed the current card, captured at grab
   * start. By the time the release runs, the grab handle has already let go,
   * so the hand must be remembered to know which cursor ray to aim with.
   */
  private xrHolderHand: 'left' | 'right' | null = null;

  private readonly tmpWorld = new Vector3();
  private readonly tmpLocal = new Vector3();
  private readonly tmpSocket = new Vector3();
  private readonly tmpClosest = new Vector3();
  private readonly tmpOrigin = new Vector3();
  private readonly tmpDir = new Vector3();
  private readonly tmpMat = new Matrix4();
  private readonly raycaster = new Raycaster();
  private pointerNDC: Vector2 | null = null;
  private pointerTrackingWired = false;
  private pulseClock = 0;
  private readonly yAxis = new Vector3(0, 1, 0);

  configure(opts: {
    pack: Pack;
    layout: Layout;
    spawn: SpawnHandles;
    hud: HudHandles;
  }): void {
    // Re-runs on every new session (each session spawns a fresh structure).
    if (this.configured && this.spawn === opts.spawn) return;
    this.pack = opts.pack;
    this.layout = opts.layout;
    this.spawn = opts.spawn;
    this.hud = opts.hud;
    this.validatorSockets = this.layout.sockets.map((s) => ({
      index: s.index,
      band: s.band,
      order: s.order,
    }));
    this.returning.length = 0;
    this.heldNodeIds.clear();
    this.traySlotOfCard.clear();
    this.traySlotOccupant.clear();
    this.hoverTargets.clear();
    this.cardFx.clear();
    this.tweenEntities.clear();
    this.litLinks.clear();
    this.cardWaveQueue.length = 0;
    this.cardRaycast.clear();
    this.sessionRejections.length = 0;
    this.hintedConcepts.clear();
    this.hintLevels.clear();

    // Every spawned interactive card gets a DistanceGrabbable (movable nodes
    // AND distractors — distractors are grabbable so their "not part of it"
    // bounce can run). Fixed anchors are excluded.
    for (const [, entity] of this.spawn.cardsByNodeId) {
      const isFixed = entity.getValue(Card, 'fixed') as boolean;
      const kind = entity.getValue(Card, 'kind') as string;
      if (isFixed || kind === 'anchor') continue;
      if (entity.hasComponent(DistanceGrabbable)) continue;
      try {
        entity.addComponent(DistanceGrabbable, {
          movementMode: MovementMode.MoveTowardsTarget,
          returnToOrigin: false,
          detachOnGrab: false,
          translate: true,
          // Spec §4: no forced rotation — cards keep a stable, readable
          // orientation while carried instead of wobbling with the hand.
          rotate: false,
          scale: false,
          moveSpeedFactor: 0.6,
          // Float the card ahead of the hand (mockup: card at the fingertips)
          // so it can reach socket depth — sockets live ~0.8-0.9 m out at the
          // desk-distance composition, beyond a bare controller's ~0.28 m.
          // Updated per-mode in setXRMode().
          targetPositionOffset: [0, 0, -0.75],
        });
      } catch (err) {
        console.error('[Recall/interaction] addComponent(DistanceGrabbable) failed', err);
      }
    }

    // Hover response (spec §3): pointer events from IWSDK's pointer system
    // (ray pointers in XR, the desktop pointer on the flat page). Wired once
    // per mesh — meshes are rebuilt every session.
    for (const [nodeId, entity] of this.spawn.cardsByNodeId) {
      const kind = entity.getValue(Card, 'kind') as string;
      if (kind === 'anchor') continue;
      const obj = entity.object3D;
      if (!obj?.addEventListener || obj.userData?.recallHoverWired) continue;
      obj.userData.recallHoverWired = true;
      obj.addEventListener('pointerenter', () => {
        this.hoverTargets.set(nodeId, true);
      });
      obj.addEventListener('pointerleave', () => {
        this.hoverTargets.set(nodeId, false);
      });
      // Native raycast per card mesh — placed cards swap to a passthrough
      // during the rebuild so they never steal the pointer ray from the tray
      // cards behind them (the "one card won't drop" bug).
      this.cardRaycast.set(nodeId, (() => {
        const meshes: Array<{ mesh: any; native: any }> = [];
        obj.traverse((o: any) => {
          if (o.isMesh) meshes.push({ mesh: o, native: o.raycast });
        });
        return meshes;
      })());
    }

    // Tray bookkeeping: cards spawned outside sockets (weak / distractors)
    // already own slots; everything else scrambles into the remaining ones.
    const movable = this.pack.nodes.filter((n) => !n.fixed);
    let nextFree = 0;
    for (const node of movable) {
      const spawnedSlot = this.spawn.traySpawnSlots.get(node.id);
      if (spawnedSlot !== undefined) {
        this.traySlotOfCard.set(node.id, spawnedSlot);
        this.traySlotOccupant.set(spawnedSlot, node.id);
      }
    }
    for (const node of movable) {
      if (this.traySlotOfCard.has(node.id)) continue;
      while (this.traySlotOccupant.has(nextFree)) nextFree++;
      this.traySlotOfCard.set(node.id, nextFree);
      nextFree++;
    }
    for (const [nodeId, slot] of this.spawn.traySpawnSlots) {
      if (nodeId.startsWith('distractor-')) this.traySlotOccupant.set(slot, nodeId);
    }

    // Track the desktop pointer over the canvas for the ray-snap fallback.
    // Wired once — the canvas outlives individual sessions.
    if (!this.pointerTrackingWired) {
      try {
        const canvas = (this.world as any).renderer?.domElement as
          | HTMLCanvasElement
          | undefined;
        if (canvas) {
          const onPointerMove = (e: PointerEvent): void => {
            const rect = canvas.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return;
            const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
            const y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
            if (!this.pointerNDC) this.pointerNDC = new Vector2();
            this.pointerNDC.set(x, y);
          };
          canvas.addEventListener('pointermove', onPointerMove);
          this.pointerTrackingWired = true;
        }
      } catch (err) {
        console.warn('[Recall/interaction] pointer tracking unavailable', err);
      }
    }

    this.configured = true;
    this.refreshFeedback();
  }

  /** True while the player holds any card (starts the scramble early). */
  hasHeldCards(): boolean {
    return this.heldNodeIds.size > 0;
  }

  /**
   * Completion flourish: a quick, soft scale wave sweeps through the cards in
   * flow order while the connections light up. Called by the conductor at the
   * same moment as the link wave and the bloom (user: the reward moment).
   */
  playCompletionCardWave(): void {
    if (!this.configured) return;
    let delay = 0.2;
    for (const node of this.pack.nodes) {
      if (node.fixed) continue;
      if (this.spawn.cardsByNodeId.has(node.id)) {
        this.cardWaveQueue.push({ nodeId: node.id, at: this.pulseClock + delay });
        delay += 0.12;
      }
    }
  }

  /** Dev/test: current lifecycle state of a card ('free' | 'held' | 'placed'). */
  getCardState(nodeId: string): string {
    const entity = this.spawn.cardsByNodeId.get(nodeId);
    return entity ? (entity.getValue(Card, 'state') as string) : 'missing';
  }

  /** XR framing: shorten the held-card float so drops reach the sockets. */
  setXRMode(isXR: boolean): void {
    const z = isXR ? -0.45 : -0.75;
    for (const [, entity] of this.spawn.cardsByNodeId) {
      if (!entity.hasComponent(DistanceGrabbable)) continue;
      // DistanceGrabHandle snapshots targetPositionOffset into its own Vector3
      // at creation, so writing the component's vector view never reaches the
      // live grab. Update the handle instance itself (Handle is IWSDK-internal;
      // found by name on the entity's component list).
      const handleComp = (entity.getComponents() as Array<{ id?: string } | null>).find(
        (c) => c?.id === 'Handle',
      ) as { data: { instance: Array<{ targetPosOffset?: { set: (x: number, y: number, z: number) => void } }> } } | undefined;
      const handle = handleComp?.data?.instance?.[entity.index];
      if (handle?.targetPosOffset) {
        handle.targetPosOffset.set(0, 0, z);
      } else {
        // Fallback: write the component view (an SDK that reads live component
        // data would pick this up).
        try {
          const view = entity.getVectorView(DistanceGrabbable, 'targetPositionOffset');
          view[0] = 0;
          view[1] = 0;
          view[2] = z;
        } catch (err) {
          console.warn('[Recall/interaction] grab offset update failed', err);
        }
      }
    }
  }

  /**
   * Dev-only: place every movable card at its solution socket and fire the
   * completion path. Used by automated verification (never in production).
   */
  debugPlaceAll(): void {
    if (!this.configured) return;
    this.returning.length = 0; // dev path snaps directly — no tweens fighting it
    for (const node of this.pack.nodes) {
      if (node.fixed) continue;
      const entity = this.spawn.cardsByNodeId.get(node.id);
      const idx = this.layout.solution[node.id];
      if (!entity || idx === undefined) continue;
      const prev = entity.getValue(Card, 'socketIndex') as number;
      if (prev >= 0) {
        const s = this.spawn.socketsByIndex.get(prev);
        if (s) s.setValue(Socket, 'occupant', '');
      }
      const socket = this.layout.sockets[idx];
      entity.object3D.position.set(socket.position.x, socket.position.y, socket.position.z);
      entity.object3D.rotation.set(0, this.cardYawFacingHead(socket.position), 0);
      entity.setValue(Card, 'state', 'placed');
      entity.setValue(Card, 'socketIndex', idx);
      const socketEntity = this.spawn.socketsByIndex.get(idx);
      if (socketEntity) socketEntity.setValue(Socket, 'occupant', node.id);
      this.traySlotOccupant.delete(this.traySlotOfCard.get(node.id) ?? -1);
    }
    this.spawn.ensureLinks();
    this.refreshFeedback();
    if (isComplete(this.pack, this.validatorSockets, this.currentPlacedMap())) {
      this.onComplete?.();
    }
  }

  setPhase(phase: HudPhase): void {
    this.phase = phase;
  }

  /** Precise rejection records for the scheduler (attribution upgrade). */
  getSessionRejections(): Array<{ nodeId: string; reason: string; linkIds: string[] }> {
    return this.sessionRejections.map((r) => ({ ...r }));
  }

  /** Concepts a hint was requested about this session (assisted recall). */
  getHintedConcepts(): string[] {
    return [...this.hintedConcepts];
  }

  /**
   * User-requested hint for the highest-need concept (rebuild phase only).
   * Escalates per repeated request for the same concept: L1 highlights the
   * target socket, L2 flashes the card with a relationship clue, L3 states
   * the placement outright. Hint use is recorded for assisted recall.
   */
  hint(nodeId: string): void {
    if (!this.configured || this.phase !== 'rebuild') return;
    const entity = this.spawn.cardsByNodeId.get(nodeId);
    if (!entity || this.getCardState(nodeId) !== 'free') return;
    const level = Math.min(3, (this.hintLevels.get(nodeId) ?? 0) + 1);
    this.hintLevels.set(nodeId, level);
    this.hintedConcepts.add(nodeId);
    const idx = this.layout.solution[nodeId];
    const socket = this.layout.sockets[idx];
    if (socket) {
      this.spawn.rippleAt(socket.position);
      if (level >= 3) this.spawn.rippleAt(socket.position);
    }
    if (level >= 2) {
      const fx = this.fxFor(nodeId);
      fx.flash = 0.8;
    }
    const label = (entity.getValue(Card, 'label') as string) ?? nodeId;
    this.hud.showToast('Hint', this.hintClue(nodeId, level, label), 'success');
  }

  private hintClue(nodeId: string, level: number, label: string): string {
    if (level >= 3) return `Place ${label} at the highlighted socket.`;
    const link = this.pack.links.find((l) => l.from === nodeId || l.to === nodeId);
    if (!link || level < 2) return `Start with ${label}.`;
    const labelOf = (id: string): string =>
      this.pack.nodes.find((n) => n.id === id)?.label ?? id;
    return link.from === nodeId
      ? `Remember: ${labelOf(link.from)} leads to ${labelOf(link.to)}.`
      : `Remember: ${labelOf(link.from)} leads to ${labelOf(nodeId)}.`;
  }

  /**
   * Move cards to free tray slots. Without arguments every movable card goes
   * (the "watch it break" scramble); with ids only those cards move (weak-link
   * sessions challenge a subset).
   */
  scrambleToTray(ids?: string[]): void {
    sfx.scramble();
    this.scrambleIndex = 0;
    const target = ids
      ? new Set(ids)
      : new Set(this.pack.nodes.filter((n) => !n.fixed).map((n) => n.id));

    for (const node of this.pack.nodes) {
      if (node.fixed || !target.has(node.id)) continue;
      const entity = this.spawn.cardsByNodeId.get(node.id);
      if (!entity) continue;

      const prev = entity.getValue(Card, 'socketIndex') as number;
      if (prev >= 0) {
        const s = this.spawn.socketsByIndex.get(prev);
        if (s) s.setValue(Socket, 'occupant', '');
      }

      let traySlot = this.traySlotOfCard.get(node.id);
      if (traySlot === undefined || this.traySlotOccupant.has(traySlot)) {
        traySlot = this.findFreeTraySlot();
        this.traySlotOfCard.set(node.id, traySlot);
      }
      this.traySlotOccupant.set(traySlot, node.id);

      if (!this.layout.tray[traySlot]) continue;
      const trayTarget = this.traySlotTarget(traySlot);
      // Spec §5A: the scramble is a performance, not a teleport — cards
      // glide to the tray with a gentle stagger (bookkeeping stays instant,
      // only the visuals animate).
      entity.object3D.getWorldPosition(this.tmpWorld);
      const rootObj = this.spawn.root.object3D;
      if (entity.object3D.parent !== rootObj) rootObj.add(entity.object3D);
      this.tmpLocal.copy(this.tmpWorld);
      rootObj.worldToLocal(this.tmpLocal);
      this.returning.push({
        entity,
        fromLocal: this.tmpLocal.clone(),
        toLocal: new Vector3(trayTarget.x, trayTarget.y, trayTarget.z),
        fromQuat: entity.object3D.quaternion.clone(),
        toQuat: new Quaternion().setFromAxisAngle(
          this.yAxis,
          this.cardYawFacingHead(trayTarget),
        ),
        elapsed: 0,
        kind: 'scramble',
        duration: SCRAMBLE_TWEEN_S,
        delay: this.scrambleIndex * SCRAMBLE_STAGGER_S,
      });
      this.scrambleIndex++;
      entity.setValue(Card, 'state', 'free');
      entity.setValue(Card, 'socketIndex', -1);
    }
    this.refreshFeedback();
  }

  update(delta: number): void {
    if (!this.configured) return;
    this.hud.tickToast(delta);
    this.hud.tickFx(delta);
    this.pulseClock += delta;
    this.spawn.tickPulse(this.pulseClock);
    this.spawn.tickMotion(delta, this.pulseClock);

    const entities = this.queries.allCards.entities;
    for (const entity of entities) {
      const nodeId = entity.getValue(Card, 'nodeId') as string;
      if (!nodeId) continue;
      const isHeld = entity.hasComponent(Grabbed);
      const wasHeld = this.heldNodeIds.has(nodeId);
      if (isHeld && !wasHeld) {
        this.heldNodeIds.add(nodeId);
        this.onGrabStart(entity, nodeId);
      } else if (!isHeld && wasHeld) {
        this.heldNodeIds.delete(nodeId);
        this.onGrabRelease(entity, nodeId);
      }
    }

    // Per-frame polish: scale + color response for every card (hover ease,
    // grab compression, snap pop, flash/amber tints — spec §3/§5).
    for (const [nodeId, entity] of this.spawn.cardsByNodeId) {
      const kind = entity.getValue(Card, 'kind') as string;
      if (kind === 'anchor') continue;
      this.applyCardFx(entity, nodeId, this.heldNodeIds.has(nodeId), delta);
    }

    // Completion flourish: scheduled pops fire in flow order — the finished
    // structure breathes once, card by card, each with a border flash
    // (user: the reward moment must be noticeable).
    if (this.cardWaveQueue.length > 0) {
      const remaining: Array<{ nodeId: string; at: number }> = [];
      for (const item of this.cardWaveQueue) {
        if (this.pulseClock >= item.at) {
          const fx = this.fxFor(item.nodeId);
          fx.pop.setValueKeepTarget(1.12);
          fx.pop.target = 1;
          fx.flash = 1;
          // Each card sends out its own ripple as the wave passes — the whole
          // cycle ripples outward, card by card (the reward moment).
          const idx = this.layout.solution[item.nodeId];
          const socket = this.layout.sockets[idx];
          if (socket) this.spawn.rippleAt(socket.position);
        } else {
          remaining.push(item);
        }
      }
      this.cardWaveQueue = remaining;
    }

    // Tweens: tray returns, socket snaps, scramble glides.
    const list = this.returning;
    this.tweenEntities.clear();
    let w = 0;
    for (let r = 0; r < list.length; r++) {
      const rc = list[r];
      rc.elapsed += delta;
      const duration = rc.duration ?? RETURN_DURATION_S;
      const t = Math.min(1, Math.max(0, (rc.elapsed - (rc.delay ?? 0)) / duration));
      // Smooth approach for every motion; the snap's "settle" comes from the
      // small scale pop, not from positional overshoot (clean + solid).
      const e = easeOutCubic(t);
      rc.entity.object3D.position.copy(rc.fromLocal).lerp(rc.toLocal, e);
      rc.entity.object3D.quaternion.copy(rc.fromQuat).slerp(rc.toQuat, e);
      this.tweenEntities.add(rc.entity);
      if (t < 1) {
        list[w++] = rc;
      }
    }
    list.length = w;

    // Idle hover: EVERY free tray card bobs and sways gently so the tray
    // reads as alive and grabbable (spec §3 idle state). Placed, held and
    // tweening cards stay put.
    const tSec = this.pulseClock;
    for (const [nodeId, entity] of this.spawn.cardsByNodeId) {
      const kind = entity.getValue(Card, 'kind') as string;
      if (kind === 'anchor') continue;
      if ((entity.getValue(Card, 'state') as string) !== 'free') continue;
      if (entity.hasComponent(Grabbed)) continue;
      if (this.tweenEntities.has(entity)) continue;
      const slot = this.traySlotOfCard.get(nodeId);
      if (slot === undefined) continue;
      if (!this.layout.tray[slot]) continue;
      const target = this.traySlotTarget(slot);
      const fx = this.cardFx.get(nodeId);
      const hover = fx ? fx.hover : 0;
      const phase = slot * 1.7;
      entity.object3D.position.y =
        target.y + 0.012 * Math.sin(tSec * 1.8 + phase) + 0.008 * hover;
      entity.object3D.position.x =
        target.x + 0.006 * Math.sin(tSec * 1.1 + phase * 1.3);
      entity.object3D.position.z = target.z;
      entity.object3D.rotation.y =
        this.cardYawFacingHead(target) + 0.07 * Math.sin(tSec * 0.8 + phase);
    }
  }

  /** Per-card motion state, created lazily. */
  private fxFor(nodeId: string): CardFx {
    let fx = this.cardFx.get(nodeId);
    if (!fx) {
      // Compression is quick and firm; the pop springs back with one soft
      // overshoot. Stiffness/damping tuned to the spec §9 feel targets.
      fx = {
        hover: 0,
        grab: new SpringValue(1, 210, 18),
        // Near-critical spring: presses in on placement and springs back
        // solidly — no wobble.
        pop: new SpringValue(1, 170, 17),
        flash: 0,
        amber: 0,
        grabSettleAt: 0,
      };
      this.cardFx.set(nodeId, fx);
    }
    return fx;
  }

  /**
   * Apply scale + color response for one card. Composition:
   *   scale = (1 + 5% hover) × grab compression × snap pop
   * Colors: held brightens, snap flashes the border, rejections warm amber.
   */
  private applyCardFx(entity: any, nodeId: string, held: boolean, dt: number): void {
    const blockRay = !held && this.phase === 'rebuild' &&
      entity.getValue(Card, 'state') === 'placed';

    const fx = this.fxFor(nodeId);
    if (held && fx.grab.target === 0.96 && this.pulseClock >= fx.grabSettleAt) {
      fx.grab.target = 1.02; // settle into the held pose
    }
    fx.hover = damp(fx.hover, !held && this.hoverTargets.get(nodeId) === true ? 1 : 0, 14, dt);
    // Placed cards pass rays through during the rebuild (see blockRay above).
    const meshes = this.cardRaycast.get(nodeId);
    if (meshes) {
      for (const entry of meshes) {
        entry.mesh.raycast = blockRay ? NO_RAYCAST : entry.native;
      }
    }
    fx.flash = damp(fx.flash, 0, 5, dt);
    fx.amber = damp(fx.amber, 0, 3.2, dt);
    const grabS = fx.grab.update(dt);
    const popS = fx.pop.update(dt);
    entity.object3D.scale.setScalar((1 + 0.05 * fx.hover) * grabS * popS);

    const mats = entity.cardMats as
      | { face: { color: { setRGB: (r: number, g: number, b: number) => void } }; body: { color: { setRGB: (r: number, g: number, b: number) => void } } }
      | undefined;
    if (!mats) return;
    const bright = held ? 1.38 : 1 + 0.5 * fx.flash + 0.18 * fx.hover;
    const amber = fx.amber;
    // Face is a white-multiplied texture; body keeps its blue channels.
    mats.face.color.setRGB(bright, bright * (1 - 0.22 * amber), bright * (1 - 0.42 * amber));
    mats.body.color.setRGB(0.61 * bright, 0.78 * bright, 1.0 * bright);
  }

  private findFreeTraySlot(): number {
    for (let i = 0; i < this.layout.tray.length; i++) {
      if (!this.traySlotOccupant.has(i)) return i;
    }
    return 0;
  }

  private onGrabStart(entity: any, nodeId: string): void {
    entity.setValue(Card, 'state', 'held');
    entity.object3D.getWorldPosition(this.tmpWorld);
    sfx.grab(this.tmpWorld);
    // Selection feedback (spec §3): tiny compression that settles into the
    // held pose, plus the brightened material handled per-frame in
    // applyCardFx.
    const fx = this.fxFor(nodeId);
    fx.grab.setValueKeepTarget(1);
    fx.grab.target = 0.96;
    fx.grabSettleAt = this.pulseClock + 0.12;
    this.hoverTargets.delete(nodeId);

    // Remember which hand grabbed it (the cursor ray that drives aim-based
    // placement on release). Querying at release is too late — the handle
    // has already let go by then.
    try {
      const grab = (this.world as any).getSystem?.(GrabSystem) as
        | { getHolderHand?: (e: any) => string | null }
        | undefined;
      const hand = grab?.getHolderHand?.(entity);
      this.xrHolderHand = hand === 'left' || hand === 'right' ? hand : null;
    } catch {
      this.xrHolderHand = null;
    }

    for (let i = this.returning.length - 1; i >= 0; i--) {
      if (this.returning[i].entity === entity) this.returning.splice(i, 1);
    }

    const prevIndex = entity.getValue(Card, 'socketIndex') as number;
    if (prevIndex >= 0) {
      const socketEntity = this.spawn.socketsByIndex.get(prevIndex);
      if (socketEntity) socketEntity.setValue(Socket, 'occupant', '');
      entity.setValue(Card, 'socketIndex', -1);
    }

    const traySlot = this.traySlotOfCard.get(nodeId);
    if (traySlot !== undefined && this.traySlotOccupant.get(traySlot) === nodeId) {
      this.traySlotOccupant.delete(traySlot);
    }
    this.refreshFeedback();
  }

  private onGrabRelease(entity: any, nodeId: string): void {
    // Compression springs back to rest (applyCardFx drives the pose).
    const fx = this.fxFor(nodeId);
    fx.grab.target = 1;
    this.handleRelease(entity, nodeId);
    this.xrHolderHand = null;
  }

  /** Placed map (nodeId -> socketIndex) from current socket occupants. */
  private currentPlacedMap(): Placed {
    const placed: Placed = {};
    for (const [, socketEntity] of this.spawn.socketsByIndex) {
      const occ = socketEntity.getValue(Socket, 'occupant') as string;
      if (occ) placed[occ] = socketEntity.getValue(Socket, 'index') as number;
    }
    return placed;
  }

  /**
   * The world-space ray that should drive aim-based placement: while
   * presenting, the live pointer ray of the controller holding the card (the
   * cursor the player aims with); on desktop, the camera ray through the
   * canvas cursor. Null when neither is available.
   */
  private aimRay(entity: any): { origin: Vector3; direction: Vector3 } | null {
    if (this.isPresenting()) {
      const hand = this.xrHolderHand;
      if (hand !== 'left' && hand !== 'right') return null;
      const pointer = (this.world as any).input?.xr?.multiPointers?.[hand]?.getPointer?.('ray');
      const raycaster = pointer?.intersector?.raycaster;
      if (!raycaster?.ray) return null;
      return { origin: raycaster.ray.origin, direction: raycaster.ray.direction };
    }
    if (!this.pointerNDC) return null;
    const camera = (this.world as any).camera;
    if (!camera) return null;
    this.raycaster.setFromCamera(this.pointerNDC, camera);
    return { origin: this.raycaster.ray.origin, direction: this.raycaster.ray.direction };
  }

  /**
   * Empty socket closest to the AIM ray, in root-local space. This is what
   * makes drops land where the player points: the held card floats at a fixed
   * offset from the controller, so it rarely reaches socket depth — but the
   * cursor ray it hangs on does. Works in XR (controller ray of the holding
   * hand) and on desktop (camera ray through the cursor).
   */
  private raySnapCandidate(entity: any): number {
    const ray = this.aimRay(entity);
    if (!ray) return -1;

    let best = -1;
    let bestDist = SNAP_RADIUS_M;

    const root3D = this.spawn.structure.object3D;
    root3D.updateWorldMatrix(true, false);
    this.tmpMat.copy(root3D.matrixWorld).invert();

    this.tmpOrigin.copy(ray.origin);
    root3D.worldToLocal(this.tmpOrigin);
    this.tmpDir.copy(ray.direction).transformDirection(this.tmpMat);

    for (const s of this.layout.sockets) {
      const occ = this.spawn.socketsByIndex.get(s.index)?.getValue(Socket, 'occupant') as
        | string
        | undefined;
      if (occ) continue;
      this.tmpSocket.set(s.position.x, s.position.y, s.position.z);
      this.tmpClosest.copy(this.tmpSocket).sub(this.tmpOrigin);
      const t = this.tmpClosest.dot(this.tmpDir);
      if (t <= 0) continue; // socket behind the pointer
      this.tmpClosest.copy(this.tmpDir).multiplyScalar(t).add(this.tmpOrigin);
      const d = this.tmpClosest.distanceTo(this.tmpSocket);
      if (d < bestDist) {
        bestDist = d;
        best = s.index;
      }
    }
    return best;
  }

  private isPresenting(): boolean {
    const r = (this.world as any).renderer;
    if (r?.xr && typeof r.xr.isPresenting === 'boolean') return r.xr.isPresenting;
    const s = (this.world as any).session;
    return s !== undefined && s !== null;
  }

  /** Recompute ghost/lit link visuals + progress from the current placement. */
  private refreshFeedback(): void {
    if (!this.configured) return;
    const placed = this.currentPlacedMap();
    const lit = new Set(getLitLinks(this.pack, this.validatorSockets, placed));
    // Newly satisfied connections draw themselves in (spec §5C); at boot the
    // whole structure flows in the same way, which doubles as the welcome.
    for (const id of lit) {
      if (!this.litLinks.has(id)) {
        this.spawn.playLinkDraw(id);
        // The connection sounds its note — the rebuild becomes a melody.
        const rank = this.pack.links.findIndex((l) => linkId(l.from, l.to) === id);
        const mid = this.spawn.linkMidpoint(id);
        if (rank >= 0) sfx.linkNote(rank, mid ?? undefined);
      }
    }
    this.litLinks = lit;
    for (const [id, mats] of this.spawn.linkMaterialsById) {
      if (this.spawn.isLinkAnimating(id)) continue; // polish layer owns it
      const on = lit.has(id);
      const linkEntity = this.spawn.linksById.get(id);
      const hidden = linkEntity ? (linkEntity.getValue(LinkLine, 'hidden') as boolean) : false;
      const strength = linkEntity ? (linkEntity.getValue(LinkLine, 'strength') as number) : 1;
      if (on) {
        // Brightness follows recall strength; hidden links light at full power.
        const glow = hidden ? 1 : 0.35 + 0.65 * strength;
        mats.core.opacity = glow;
        mats.glow.opacity = 0.18 + 0.42 * glow;
      } else {
        // Faint ghost skeleton — hidden links stay readable as a dimmer line
        // so a hidden connection never reads as "not connected at all".
        mats.core.opacity = hidden ? 0.15 : 0.26;
        mats.glow.opacity = hidden ? 0.06 : 0.1;
      }
      if (linkEntity) linkEntity.setValue(LinkLine, 'lit', on);
    }
    // Socket rings mark empty targets only — occupied sockets stay clean.
    for (const socketEntity of this.spawn.socketsByIndex.values()) {
      const occ = socketEntity.getValue(Socket, 'occupant') as string;
      socketEntity.object3D.visible = occ === '';
    }
    this.hud.setProgress(lit.size, this.pack.links.length);
  }

  /** Toast copy for a rejected placement — friendly guidance, not scolding. */
  private rejectToast(reason: string, label: string): { main: string; sub: string } {
    switch (reason) {
      case 'wrong-band':
        return { main: 'Not quite', sub: `${label} belongs at a different height.` };
      case 'wrong-order':
        return { main: 'Not quite', sub: `${label} breaks the flow here.` };
      case 'occupied':
        return { main: 'Not quite', sub: 'That spot is already taken.' };
      default:
        return { main: 'Not quite', sub: `${label} doesn't fit here.` };
    }
  }

  private handleRelease(entity: any, nodeId: string): void {
    // Summary: the round is over; nothing snaps.
    if (this.phase === 'summary') return;

    const kind = entity.getValue(Card, 'kind') as string;

    // Distractors never fit — explain and bounce.
    if (kind === 'distractor') {
      const idx = parseInt(nodeId.replace('distractor-', ''), 10);
      const d = this.pack.distractors[idx];
      this.hud.showToast('Not part of it', d ? d.why : 'That piece does not belong.', 'error');
      this.glideToTray(entity, nodeId);
      return;
    }

    entity.object3D.getWorldPosition(this.tmpWorld);
    this.tmpLocal.copy(this.tmpWorld);
    this.spawn.structure.object3D.worldToLocal(this.tmpLocal);

    // During the "see" phase the structure is on display — nothing places yet.
    if (this.phase === 'see') {
      this.glideToTray(entity, nodeId);
      return;
    }

    const placed = this.currentPlacedMap();

    let bestIndex = -1;
    let bestDistSq = SNAP_RADIUS_M * SNAP_RADIUS_M;
    for (const s of this.layout.sockets) {
      const occ = this.spawn.socketsByIndex.get(s.index)?.getValue(Socket, 'occupant') as
        | string
        | undefined;
      if (occ) continue;
      const dx = this.tmpLocal.x - s.position.x;
      const dy = this.tmpLocal.y - s.position.y;
      const dz = this.tmpLocal.z - s.position.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < bestDistSq) {
        bestDistSq = d2;
        bestIndex = s.index;
      }
    }

    // Position match first (the card physically lands in a socket), ray aim
    // second (the cursor points at a socket the card can't reach on its own).
    if (bestIndex < 0) {
      bestIndex = this.raySnapCandidate(entity);
    }

    if (bestIndex >= 0) {
      const check = checkPlacement(this.pack, this.validatorSockets, placed, nodeId, bestIndex);
      if (check.valid) {
        this.snapToSocket(entity, nodeId, bestIndex);
        return;
      }
      const blocking = check.blockingLinkIds ?? [];
      this.sessionRejections.push({ nodeId, reason: check.reason ?? 'unknown-node', linkIds: blocking });
      // Spec §5D: mistakes guide gently — a warm amber response while the
      // card glides home. Never red, never punishing.
      this.fxFor(nodeId).amber = 1;
      sfx.reject(this.tmpWorld); // release world position, captured above
      const label = entity.getValue(Card, 'label') as string;
      const toast = this.rejectToast(check.reason ?? 'unknown-node', label);
      this.hud.showToast(toast.main, toast.sub, 'error');
    } else {
    }

    this.glideToTray(entity, nodeId);
  }

  private snapToSocket(entity: any, nodeId: string, socketIndex: number): void {
    const socket = this.layout.sockets[socketIndex];
    if (!socket) return;
    // Socket cards live in the (rotated) structure frame. Carry the world
    // position over so the spring starts exactly where the card was released
    // (re-parenting alone would teleport it).
    const structureObj = this.spawn.structure.object3D;
    entity.object3D.getWorldPosition(this.tmpWorld);
    if (entity.object3D.parent !== structureObj) structureObj.add(entity.object3D);
    this.tmpLocal.copy(this.tmpWorld);
    structureObj.worldToLocal(this.tmpLocal);

    // Bookkeeping lands immediately — validator/state never wait on motion.
    entity.setValue(Card, 'state', 'placed');
    entity.setValue(Card, 'socketIndex', socketIndex);
    const socketEntity = this.spawn.socketsByIndex.get(socketIndex);
    if (socketEntity) socketEntity.setValue(Socket, 'occupant', nodeId);

    const traySlot = this.traySlotOfCard.get(nodeId);
    if (traySlot !== undefined && this.traySlotOccupant.get(traySlot) === nodeId) {
      this.traySlotOccupant.delete(traySlot);
    }

    // Spec §5C, refined per user feedback: a short decisive glide, then the
    // card PRESSES into its socket — a tiny compression that springs back —
    // with a border flash and an iOS-style ripple blooming out of the card
    // plane. The connection then draws itself in via refreshFeedback. No
    // success toast: the visuals say it; repeated notifications get noisy.
    this.returning.push({
      entity,
      fromLocal: this.tmpLocal.clone(),
      toLocal: new Vector3(socket.position.x, socket.position.y, socket.position.z),
      fromQuat: entity.object3D.quaternion.clone(),
      toQuat: new Quaternion().setFromAxisAngle(
        this.yAxis,
        this.cardYawFacingHead(socket.position),
      ),
      elapsed: 0,
      kind: 'snap',
      duration: SNAP_TWEEN_S,
    });
    const fx = this.fxFor(nodeId);
    fx.pop.setValueKeepTarget(0.97);
    fx.pop.target = 1;
    fx.flash = 0.6;
    this.spawn.rippleAt(socket.position);
    this.tmpWorld.set(socket.position.x, socket.position.y, socket.position.z);
    this.spawn.structure.object3D.localToWorld(this.tmpWorld);
    sfx.place(this.tmpWorld);

    // Weak-card links don't exist until both endpoints are placed — build
    // them now so the connection appears (and draws itself in) with the
    // placement, instead of leaving the structure visually disconnected.
    this.spawn.ensureLinks();

    this.refreshFeedback();

    if (isComplete(this.pack, this.validatorSockets, this.currentPlacedMap())) {
      this.onComplete?.();
    }
  }

  private glideToTray(entity: any, nodeId: string): void {
    let targetSlot = this.traySlotOfCard.get(nodeId);
    if (targetSlot === undefined || this.traySlotOccupant.has(targetSlot)) {
      // Find a free slot and clear any previous occupant
      targetSlot = this.findFreeTraySlot();
      this.traySlotOfCard.set(nodeId, targetSlot);
      // Clear the old occupant from the slot we're taking
      const oldOccupant = this.traySlotOccupant.get(targetSlot);
      if (oldOccupant && oldOccupant !== nodeId) {
        this.traySlotOfCard.delete(oldOccupant);
      }
    }
    this.traySlotOccupant.set(targetSlot, nodeId);

    const slot = this.layout.tray[targetSlot];
    if (!slot) return;

    // Tray cards are head-stable: re-parent into the root frame, carrying the
    // world position over so the glide starts exactly where the card is.
    entity.object3D.getWorldPosition(this.tmpWorld);
    const rootObj = this.spawn.root.object3D;
    if (entity.object3D.parent !== rootObj) rootObj.add(entity.object3D);
    this.tmpLocal.copy(this.tmpWorld);
    rootObj.worldToLocal(this.tmpLocal);

    const from = this.tmpLocal.clone();
    const target = this.traySlotTarget(targetSlot);
    const to = new Vector3(target.x, target.y, target.z);
    const fromQ = entity.object3D.quaternion.clone();
    const toQ = new Quaternion().setFromAxisAngle(
      this.yAxis,
      this.cardYawFacingHead(target),
    );

    this.returning.push({
      entity,
      fromLocal: from,
      toLocal: to,
      fromQuat: fromQ,
      toQuat: toQ,
      elapsed: 0,
      kind: 'return',
    });
    entity.setValue(Card, 'state', 'free');
    entity.setValue(Card, 'socketIndex', -1);
    this.refreshFeedback();
  }

  private cardYawFacingHead(local: Vec3): number {
    return Math.atan2(-local.x, -local.z);
  }

  /**
   * Tray slot target in root-local space. In XR the tray settles ON THE
   * TABLE below the cycle (lower and closer than the flat arc) so the tray
   * cards never overlap the socket band — a tray card floating in front of
   * a socket blocked placements (user bug report). Flat mode keeps the
   * natural arc positions.
   */
  private traySlotTarget(slotIndex: number): Vec3 {
    const slot = this.layout.tray[slotIndex].position;
    if (!this.isPresenting()) return slot;
    // Below the cycle's lowest socket band (the sway can dip it to ~-23 deg),
    // slightly closer in depth, same arc width — the tray as it always sat.
    return {
      x: slot.x * 0.85,
      y: slot.y,
      z: slot.z * 0.85,
    };
  }
}

interface ReturningCard {
  entity: any;
  fromLocal: Vector3;
  toLocal: Vector3;
  fromQuat: Quaternion;
  toQuat: Quaternion;
  elapsed: number;
  /** Motion profile: tray return (cubic), socket snap (soft overshoot), scramble. */
  kind?: 'return' | 'snap' | 'scramble';
  duration?: number;
  /** Seconds to wait before the tween starts (scramble stagger). */
  delay?: number;
}

export default InteractionSystemImpl;
