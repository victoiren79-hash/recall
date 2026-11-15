import { describe, it } from 'vitest';
import { loadBundledPack } from '../packs/loadPack';
import { applySessionResult, initSchedulerState, linkId } from './scheduler';

const pack = loadBundledPack();

describe('debug', () => {
  it('traces repeated rejections', () => {
    let state = initSchedulerState(pack);
    const id = linkId('evap', 'vapor');
    for (let i = 0; i < 6; i++) {
      const before = state.links[id].strength;
      state = applySessionResult(state, pack, [
        { nodeId: 'evap', reason: 'wrong-order', linkIds: [id] },
      ]);
      console.log(i, before.toFixed(3), '->', state.links[id].strength.toFixed(3));
    }
    console.log('pack link exists:', pack.links.some((l) => linkId(l.from, l.to) === id));
  });
});
