// src/systems/layout.test.ts
import { describe, it, expect } from 'vitest';
import { loadBundledPack } from '../packs/loadPack';
import {
  buildLayout,
  distanceFromHead,
  fitsGlassesFov,
  shuffleTray,
  CARD_WIDTH,
  CARD_HEIGHT,
  FOV_HALF_X_DEG,
  FOV_UP_DEG,
  FOV_DOWN_DEG,
  MAX_REACH,
  type Layout,
  type Vec3,
} from './layout';

const pack = loadBundledPack();
const cardSize = { width: CARD_WIDTH, height: CARD_HEIGHT };

function nonFixedIds(): string[] {
  return pack.nodes.filter((n) => !n.fixed).map((n) => n.id);
}

interface NamedPos {
  name: string;
  p: Vec3;
}

function allNamedPositions(layout: Layout): NamedPos[] {
  const out: NamedPos[] = [];
  for (const s of layout.sockets) out.push({ name: `socket[${s.index}] order=${s.order} band=${s.band}`, p: s.position });
  for (const a of layout.anchors) out.push({ name: `anchor "${a.id}" band=${a.band}`, p: a.position });
  for (const t of layout.tray) out.push({ name: `tray[${t.index}]`, p: t.position });
  return out;
}

function angleX(p: Vec3): number { return Math.atan2(p.x, -p.z); }
function angleY(p: Vec3): number { return Math.atan2(p.y, -p.z); }
function deg(r: number): number { return (r * 180) / Math.PI; }

/** Angular AABB of a card, in radians, from the head. */
interface AngRect { x0: number; x1: number; y0: number; y1: number; }

function angRect(p: Vec3): AngRect {
  const hw = cardSize.width / 2;
  const hh = cardSize.height / 2;
  const corners: Vec3[] = [
    { x: p.x - hw, y: p.y + hh, z: p.z },
    { x: p.x + hw, y: p.y + hh, z: p.z },
    { x: p.x - hw, y: p.y - hh, z: p.z },
    { x: p.x + hw, y: p.y - hh, z: p.z },
  ];
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const c of corners) {
    const ax = angleX(c);
    const ay = angleY(c);
    if (ax < x0) x0 = ax;
    if (ax > x1) x1 = ax;
    if (ay < y0) y0 = ay;
    if (ay > y1) y1 = ay;
  }
  return { x0, x1, y0, y1 };
}

function angOverlap(a: AngRect, b: AngRect): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

describe('layout', () => {
  it('has one socket per movable node, in canonical flow order', () => {
    const layout = buildLayout(pack);
    const movable = pack.nodes.filter((n) => !n.fixed);
    expect(layout.sockets.length, 'socket count vs movable count').toBe(movable.length);
    for (let i = 0; i < movable.length; i++) {
      expect(layout.sockets[i].order, `socket[${i}].order`).toBe(i);
      expect(layout.sockets[i].band, `socket[${i}].band vs node "${movable[i].id}"`).toBe(movable[i].band);
    }
  });

  it('solution maps each movable node to its socket index', () => {
    const layout = buildLayout(pack);
    for (const node of pack.nodes) {
      if (node.fixed) continue;
      const idx = layout.solution[node.id];
      expect(idx, `solution["${node.id}"] is a number`).toBeTypeOf('number');
      expect(layout.sockets[idx].band, `solution["${node.id}"] socket band vs node band`).toBe(node.band);
    }
  });

  it('anchors contain exactly the fixed nodes', () => {
    const layout = buildLayout(pack);
    const fixed = pack.nodes.filter((n) => n.fixed);
    expect(layout.anchors.length, 'anchor count').toBe(fixed.length);
    for (let i = 0; i < fixed.length; i++) {
      expect(layout.anchors[i].id, `anchor[${i}].id vs "${fixed[i].id}"`).toBe(fixed[i].id);
      expect(layout.anchors[i].band, `anchor[${i}].band`).toBe(fixed[i].band);
    }
  });

  it('tray has one slot per movable node plus 2 extra for distractors', () => {
    const layout = buildLayout(pack);
    expect(layout.tray.length, 'tray slot count = movable + 2').toBe(nonFixedIds().length + 2);
    for (let i = 0; i < layout.tray.length; i++) {
      expect(layout.tray[i].index, `tray[${i}].index`).toBe(i);
    }
  });

  it('every socket, anchor and tray slot fits the glasses FoV and reach', () => {
    const layout = buildLayout(pack);
    for (const { name, p } of allNamedPositions(layout)) {
      const isAnchor = name.startsWith('anchor');
      const okFov = fitsGlassesFov(p, cardSize, isAnchor ? { upDeg: 38 } : undefined);
      const okReach = distanceFromHead(p) <= MAX_REACH;
      expect(okFov, `FoV failed at ${name} -> (x=${p.x.toFixed(3)}, y=${p.y.toFixed(3)}, z=${p.z.toFixed(3)}), card corners beyond ±${FOV_HALF_X_DEG}° / ${FOV_UP_DEG}° up / ${FOV_DOWN_DEG}° down`).toBe(true);
      expect(okReach, `reach failed at ${name} -> d=${distanceFromHead(p).toFixed(3)} m > ${MAX_REACH} m`).toBe(true);
    }
  });

  it('cards are at least 0.10 m wide', () => {
    expect(CARD_WIDTH, `CARD_WIDTH=${CARD_WIDTH}`).toBeGreaterThanOrEqual(0.10);
  });

  it('no two cards overlap in the player view (angular AABB check)', () => {
    const layout = buildLayout(pack);
    const positions = allNamedPositions(layout);
    for (let i = 0; i < positions.length; i++) {
      const a = angRect(positions[i].p);
      for (let j = i + 1; j < positions.length; j++) {
        const b = angRect(positions[j].p);
        const overlap = angOverlap(a, b);
        expect(
          overlap,
          `angular overlap between ${positions[i].name} and ${positions[j].name} ` +
          `(xA ${deg(a.x0).toFixed(1)}..${deg(a.x1).toFixed(1)}° vs xB ${deg(b.x0).toFixed(1)}..${deg(b.x1).toFixed(1)}°, ` +
          `yA ${deg(a.y0).toFixed(1)}..${deg(a.y1).toFixed(1)}° vs yB ${deg(b.y0).toFixed(1)}..${deg(b.y1).toFixed(1)}°)`,
        ).toBe(false);
      }
    }
  });

  it('cycle sockets progress monotonically around the ring (flow order)', () => {
    const layout = buildLayout(pack);
    const cx = 0.02;
    const cy = 0.03;
    let prev: number | null = null;
    for (const sck of layout.sockets) {
      const ang = Math.atan2(sck.position.y - cy, sck.position.x - cx);
      if (prev !== null) {
        // Unwrapped angle must keep decreasing (clockwise on screen).
        let unwrapped = ang;
        while (prev !== null && unwrapped > prev) unwrapped -= Math.PI * 2;
        expect(
          unwrapped,
          `socket ${sck.index} breaks the clockwise flow (${prev?.toFixed(2)} -> ${unwrapped.toFixed(2)})`,
        ).toBeLessThan(prev!);
        prev = unwrapped;
      } else {
        prev = ang;
      }
    }
  });

  it('mirror flips x only and leaves order unchanged', () => {
    const normal = buildLayout(pack);
    const mirrored = buildLayout(pack, { mirror: true });
    expect(mirrored.sockets.length, 'socket count unchanged under mirror').toBe(normal.sockets.length);
    for (let i = 0; i < normal.sockets.length; i++) {
      expect(mirrored.sockets[i].order, `mirror socket[${i}].order`).toBe(normal.sockets[i].order);
      expect(mirrored.sockets[i].band, `mirror socket[${i}].band`).toBe(normal.sockets[i].band);
      expect(mirrored.sockets[i].index, `mirror socket[${i}].index`).toBe(normal.sockets[i].index);
      expect(mirrored.sockets[i].position.x, `mirror socket[${i}].x`).toBeCloseTo(-normal.sockets[i].position.x, 6);
      expect(mirrored.sockets[i].position.y, `mirror socket[${i}].y`).toBeCloseTo(normal.sockets[i].position.y, 6);
      expect(mirrored.sockets[i].position.z, `mirror socket[${i}].z`).toBeCloseTo(normal.sockets[i].position.z, 6);
    }
  });

  it('mirrored layout still fits the FoV', () => {
    const mirrored = buildLayout(pack, { mirror: true });
    for (const { name, p } of allNamedPositions(mirrored)) {
      const isAnchor = name.startsWith('anchor');
      const okFov = fitsGlassesFov(p, cardSize, isAnchor ? { upDeg: 38 } : undefined);
      expect(okFov, `mirrored FoV failed at ${name} -> (x=${p.x.toFixed(3)}, y=${p.y.toFixed(3)}, z=${p.z.toFixed(3)})`).toBe(true);
    }
  });

  it('shuffleTray is deterministic for the same seed and uses all ids', () => {
    const ids = nonFixedIds();
    const a = shuffleTray(ids, 1234);
    const b = shuffleTray(ids, 1234);
    expect(a, 'same seed -> identical order').toEqual(b);
    expect(a.slice().sort(), 'shuffle uses every id exactly once').toEqual(ids.slice().sort());
  });

  it('shuffleTray with different seeds usually differs', () => {
    const ids = nonFixedIds();
    const a = shuffleTray(ids, 1);
    const b = shuffleTray(ids, 999);
    expect(a, 'seeds 1 vs 999 should produce different orders').not.toEqual(b);
  });
});