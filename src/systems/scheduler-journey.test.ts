// A realistic 6-day journey — 2 mistakes on day 1, clean after, 1 slip on
// day 4. Documents what the player actually experiences day to day: the
// review rotation must vary which links are hidden, not repeat one set.
import { describe, it } from 'vitest';
import { loadBundledPack } from '../packs/loadPack';
import {
  applySessionResult, advanceDay, normalizeState, recordSession, reviewLinkIds,
} from './scheduler';
import { buildSessionConfig, hiddenCountForSession } from './session';
import { linkId, type Placed } from './validator';

describe('journey', () => {
  it('simulates 6 days', () => {
    const pack = loadBundledPack();
    let state = normalizeState(null, pack);
    const linkIds = pack.links.map((l) => linkId(l.from, l.to));
    const placed: Placed = {};
    for (let d = 1; d <= 6; d++) {
      const hidden = reviewLinkIds(pack, state, hiddenCountForSession(state.sessionNum));
      // Day 1: two wrong-order slips (evap tried early); day 4: one slip.
      const rejCount = d === 1 ? 2 : d === 4 ? 1 : 0;
      const rej = [] as Array<{ nodeId: string; reason: string; linkIds: string[] }>;
      const evapLinks = pack.links.filter((l) => l.to === 'evap');
      for (let i = 0; i < rejCount && i < evapLinks.length; i++) {
        rej.push({ nodeId: 'evap', reason: 'wrong-order', linkIds: [linkId(evapLinks[i].from, evapLinks[i].to)] });
      }
      const config = buildSessionConfig(state.sessionNum, [], hidden, d * 977);
      state = applySessionResult(state, pack, rej, [], hidden);
      const strengths = linkIds.map((id) => state.links[id]?.strength ?? 1);
      const mastery = (strengths.reduce((a, b) => a + b, 0) / strengths.length) * 100;
      console.log(
        `day ${d}: rung=${state.sessionNum} hidden=${hidden.length} [${hidden.join(',')}] mastery=${mastery.toFixed(0)}% drill=${config.removedNodeIds.length ? config.removedNodeIds.join('+') : 'none'}`,
      );
      state = advanceDay(state, pack);
      state = recordSession(state, {
        day: d, rung: state.sessionNum, recalled: linkIds.length - rej.length,
        weak: strengths.filter((v) => v < 0.5).length, rejected: rej.length,
        drill: false, mastery: mastery / 100, at: Date.now(),
      });
    }
  });
});
