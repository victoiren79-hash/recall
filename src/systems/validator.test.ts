// src/systems/validator.test.ts
// Regression tests for placement rules. The key invariant: the validator must
// never accept a placement that dead-ends the rebuild. Band-mates used to be
// swappable (vapor/precip share band 2, cooling/cond share band 3), which let
// a locally-legal move (precipitation into water vapor's slot) permanently
// block water vapor AND clouds — the puzzle became unwinnable mid-session.
import { describe, it, expect } from 'vitest';
import { loadBundledPack } from '../packs/loadPack';
import { buildLayout } from './layout';
import { checkPlacement, getLitLinks, isComplete, type Placed } from './validator';

const pack = loadBundledPack();
const layout = buildLayout(pack);
const sockets = layout.sockets.map((s) => ({ index: s.index, band: s.band, order: s.order }));

/** Movable node ids in flow order (socket order === this rank). */
const flowOrder = Object.entries(layout.solution)
  .sort((a, b) => a[1] - b[1])
  .map(([id]) => id);

function placedFrom(pairs: Array<[string, number]>): Placed {
  const placed: Placed = {};
  for (const [id, idx] of pairs) placed[id] = idx;
  return placed;
}

describe('checkPlacement', () => {
  it('rejects the precipitation-into-vapor-slot trap that dead-ended the rebuild', () => {
    // Mid-game state the user hit: everything placed canonically except
    // vapor + precip. Precipitation into vapor's slot (band 2) used to be
    // accepted here — and left vapor and clouds with no legal spot forever.
    const placed = placedFrom([
      ['evap', 0],
      ['cooling', 2],
      ['cond', 3],
      ['cloud', 4],
      ['collect', 6],
    ]);
    expect(checkPlacement(pack, sockets, placed, 'precip', 1)).toMatchObject({
      valid: false,
      reason: 'wrong-order',
    });
    expect(checkPlacement(pack, sockets, placed, 'vapor', 5)).toMatchObject({
      valid: false,
      reason: 'wrong-order',
    });
    // The canonical slots stay open.
    expect(checkPlacement(pack, sockets, placed, 'precip', 5).valid).toBe(true);
    expect(checkPlacement(pack, sockets, placed, 'vapor', 1).valid).toBe(true);
  });

  it('rejects band-mate swaps even on an empty board', () => {
    // The earliest trap entry: vapor (band 2) into precip's slot with nothing
    // placed used to pass, poisoning the board from the first move.
    expect(checkPlacement(pack, sockets, {}, 'vapor', 5)).toMatchObject({
      valid: false,
      reason: 'wrong-order',
    });
    expect(checkPlacement(pack, sockets, {}, 'precip', 1)).toMatchObject({
      valid: false,
      reason: 'wrong-order',
    });
    expect(checkPlacement(pack, sockets, {}, 'cond', 2)).toMatchObject({
      valid: false,
      reason: 'wrong-order',
    });
  });

  it('keeps band feedback for cross-band attempts', () => {
    expect(checkPlacement(pack, sockets, {}, 'vapor', 0)).toMatchObject({
      valid: false,
      reason: 'wrong-band',
    });
    expect(checkPlacement(pack, sockets, {}, 'collect', 4)).toMatchObject({
      valid: false,
      reason: 'wrong-band',
    });
  });

  it('reports occupied sockets before anything else', () => {
    const placed = placedFrom([['cooling', 2]]);
    expect(checkPlacement(pack, sockets, placed, 'cond', 2)).toMatchObject({
      valid: false,
      reason: 'occupied',
    });
  });

  it('every node is placeable ONLY in its canonical flow socket', () => {
    const placed: Placed = {};
    for (const nodeId of flowOrder) {
      const canonical = layout.solution[nodeId];
      for (const s of sockets) {
        const check = checkPlacement(pack, sockets, placed, nodeId, s.index);
        expect(check.valid).toBe(s.index === canonical);
      }
      placed[nodeId] = canonical;
    }
  });
});

describe('rebuild flow', () => {
  it('accepts the full canonical rebuild and completes it', () => {
    let placed: Placed = {};
    for (const nodeId of flowOrder) {
      const idx = layout.solution[nodeId];
      const check = checkPlacement(pack, sockets, placed, nodeId, idx);
      expect(check.valid, `${nodeId} -> socket ${idx}`).toBe(true);
      placed = { ...placed, [nodeId]: idx };
      // No accepted move may ever make the remaining moves illegal.
      for (const rest of flowOrder) {
        if (placed[rest] !== undefined) continue;
        const restIdx = layout.solution[rest];
        expect(
          checkPlacement(pack, sockets, placed, rest, restIdx).valid,
          `after placing ${nodeId}, ${rest} must still fit its slot`,
        ).toBe(true);
      }
    }
    expect(isComplete(pack, sockets, placed)).toBe(true);
    expect(getLitLinks(pack, sockets, placed).length).toBe(pack.links.length);
  });

  it('never completes with band-mates swapped', () => {
    const swapped: Placed = {
      evap: 0,
      vapor: 5,
      cooling: 2,
      cond: 3,
      cloud: 4,
      precip: 1,
      collect: 6,
    };
    expect(isComplete(pack, sockets, swapped)).toBe(false);
  });
});
