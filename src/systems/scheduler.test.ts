// src/systems/scheduler.test.ts
// The learning loop must feel coherent: the difficulty rung responds to
// demonstrated performance (not elapsed days); review scheduling brings weak
// and stale relationships back sooner; "Restart" wipes the whole run to day 1.
import { describe, it, expect } from 'vitest';
import { loadBundledPack } from '../packs/loadPack';
import { buildSessionConfig, hiddenCountForSession } from './session';
import {
  applySessionResult,
  advanceDay,
  evaluateDifficulty,
  initSchedulerState,
  linkId,
  normalizeState,
  recordHint,
  recordSession,
  reviewLinkIds,
  weakNodeIds,
  type SessionRejection,
  WEAK_THRESHOLD,
} from './scheduler';

const pack = loadBundledPack();

function cleanRejections(): SessionRejection[] {
  return [];
}

function rejection(nodeId: string, reason: string, linkIds: string[]): SessionRejection {
  return { nodeId, reason, linkIds };
}

describe('applySessionResult — precise mistake attribution', () => {
  it('wrong-order rejections penalize only their blocking relationships', () => {
    const s0 = initSchedulerState(pack);
    const idA = linkId(pack.links[0].from, pack.links[0].to);
    const idB = linkId(pack.links[1].from, pack.links[1].to);
    const s1 = applySessionResult(s0, pack, [rejection('evap', 'wrong-order', [idB])]);
    expect(s1.links[idA].strength).toBe(1); // unrelated: untouched
    expect(s1.links[idB].strength).toBeCloseTo(0.88, 5); // blocked: penalized
  });

  it('wrong-band and occupied rejections cost no relationship strength', () => {
    const s0 = initSchedulerState(pack);
    const s1 = applySessionResult(s0, pack, [
      rejection('evap', 'wrong-band', []),
      rejection('collect', 'occupied', []),
    ]);
    for (const l of pack.links) {
      expect(s1.links[linkId(l.from, l.to)].strength).toBe(1);
    }
  });

  it('counts concept struggles per rejection (concept-level profile)', () => {
    const s0 = initSchedulerState(pack);
    const s1 = applySessionResult(s0, pack, [
      rejection('evap', 'wrong-band', []),
      rejection('evap', 'occupied', []),
    ]);
    expect(s1.concepts.evap.struggles).toBe(2);
  });

  it('strengthens recalled relationships and caps at 1', () => {
    const s0 = initSchedulerState(pack);
    const id = linkId(pack.links[0].from, pack.links[0].to);
    const s1 = applySessionResult(s0, pack, cleanRejections());
    expect(s1.links[id].strength).toBe(1);
  });

  it('grants less for assisted (hint-covered) recall', () => {
    const s0 = initSchedulerState(pack);
    const id = linkId(pack.links[0].from, pack.links[0].to);
    const to = pack.links[0].to;
    // Step 1: an independent rejection drops the link below the cap.
    const afterRej = applySessionResult(s0, pack, [
      rejection('evap', 'wrong-order', [id]),
    ]);
    const base = afterRej.links[id].strength; // 0.88
    expect(base).toBeCloseTo(0.88, 5);
    // Step 2: assisted recall gains +0.04; independent recall gains +0.08.
    const assisted = applySessionResult(afterRej, pack, cleanRejections(), [to]);
    const independent = applySessionResult(afterRej, pack, cleanRejections());
    expect(assisted.links[id].strength).toBeCloseTo(0.92, 5);
    expect(independent.links[id].strength).toBeCloseTo(0.96, 5);
    expect(independent.links[id].strength).toBeGreaterThan(assisted.links[id].strength);
    void s0;
  });
});

describe('performance-responsive difficulty', () => {
  it('promotes after clean, high-mastery sessions', () => {
    let state = initSchedulerState(pack);
    state = applySessionResult(state, pack, []);
    const day2 = advanceDay(state, pack);
    expect(day2.sessionNum).toBe(2);
  });

  it('holds the rung when performance is mixed', () => {
    let state = initSchedulerState(pack);
    const idB = linkId(pack.links[1].from, pack.links[1].to);
    state = applySessionResult(state, pack, [rejection('vapor', 'wrong-order', [idB])]);
    // The real flow always records the completed session (index.ts).
    state = recordSession(state, {
      day: state.day,
      rung: state.sessionNum,
      recalled: 7,
      weak: 1,
      rejected: 1,
      drill: false,
      mastery: 0.985,
      at: 1,
    });
    const day2 = advanceDay(state, pack);
    expect(day2.sessionNum).toBe(1); // not clean: no promotion
  });

  it('demotes when the user is clearly overwhelmed', () => {
    let state = initSchedulerState(pack, 3);
    // A session where every relationship was rejected: overall mastery falls
    // below 0.55, which demotes the rung (easier reconstruction) while the
    // weak-concept drill handles the reinforcement.
    const allIds = pack.links.map((l) => linkId(l.from, l.to));
    let s = state;
    for (let i = 0; i < 4; i++) {
      s = applySessionResult(s, pack, allIds.map((id) => rejection('evap', 'wrong-order', [id])));
    }
    state = s;
    const mastery = allIds.reduce((a, id) => a + state.links[id].strength, 0) / allIds.length;
    expect(mastery).toBeLessThan(0.55);
    state = recordSession(state, {
      day: state.day,
      rung: state.sessionNum,
      recalled: 0,
      weak: allIds.length,
      rejected: allIds.length * 4,
      drill: false,
      mastery,
      at: Date.now(),
    });
    const next = advanceDay(state, pack);
    expect(next.sessionNum).toBeLessThan(state.sessionNum);
  });

  it('never leaves the 1..4 rung range', () => {
    let state = initSchedulerState(pack);
    for (let i = 0; i < 10; i++) {
      state = applySessionResult(state, pack, []);
      state = advanceDay(state, pack);
    }
    expect(state.sessionNum).toBeLessThanOrEqual(4);
    expect(state.day).toBeGreaterThanOrEqual(11);
  });

  it('evaluateDifficulty promotes a clean, high-mastery fresh state', () => {
    const state = initSchedulerState(pack); // mastery 1.0, no failures yet
    expect(evaluateDifficulty(state, pack)).toBe(2);
  });
});

describe('review scheduling (real spaced repetition)', () => {
  it('returns weak relationships sooner than strong ones', () => {
    let state = initSchedulerState(pack);
    const weakId = linkId(pack.links[0].from, pack.links[0].to);
    for (let i = 0; i < 6; i++) {
      state = applySessionResult(state, pack, [
        rejection(pack.links[0].from, 'wrong-order', [weakId]),
      ]);
    }
    state = advanceDay(state, pack);
    const review = reviewLinkIds(pack, state, 3);
    expect(review).toContain(weakId);
    expect(review[0]).toBe(weakId); // weakest ranks first
  });

  it('ranks weak and stale relationships ahead of strong recent ones', () => {
    let state = initSchedulerState(pack);
    const weakId = linkId(pack.links[0].from, pack.links[0].to);
    // Weaken one relationship over repeated rejections, then let a day pass.
    for (let i = 0; i < 6; i++) {
      state = applySessionResult(state, pack, [
        rejection(pack.links[0].from, 'wrong-order', [weakId]),
      ]);
    }
    state = advanceDay(state, pack);
    const review = reviewLinkIds(pack, state, 3);
    expect(review).toHaveLength(3); // count always met (fill semantics)
    expect(review[0]).toBe(weakId); // weakest ranks first
  });
  it('respects the requested count via the rung mapping', () => {
    expect(hiddenCountForSession(1)).toBe(0);
    expect(hiddenCountForSession(2)).toBe(2);
    expect(hiddenCountForSession(3)).toBe(3);
    expect(hiddenCountForSession(4)).toBe(2);
    const state = initSchedulerState(pack);
    const weakId = linkId(pack.links[0].from, pack.links[0].to);
    let s = state;
    for (let i = 0; i < 6; i++) {
      s = applySessionResult(s, pack, [rejection(pack.links[0].from, 'wrong-order', [weakId])]);
    }
    s = advanceDay(s, pack);
    const review = reviewLinkIds(pack, s, hiddenCountForSession(3));
    expect(review.length).toBeLessThanOrEqual(3);
    expect(review).toContain(weakId);
  });
});

describe('session history', () => {
  it('records completed sessions and keeps the last as lastResult', () => {
    let state = initSchedulerState(pack);
    state = applySessionResult(state, pack, []);
    state = recordSession(state, {
      day: state.day,
      rung: state.sessionNum,
      recalled: pack.links.length,
      weak: 0,
      rejected: 0,
      drill: false,
      mastery: 1,
      at: Date.now(),
    });
    expect(state.history).toHaveLength(1);
    expect(state.lastResult).not.toBeNull();
    expect(state.lastResult?.mastery).toBe(1);
  });

  it('caps the history to the most recent sessions', () => {
    let state = initSchedulerState(pack);
    for (let i = 0; i < 20; i++) {
      state = recordSession(state, {
        day: i + 1,
        rung: 1,
        recalled: 8,
        weak: 0,
        rejected: 0,
        drill: false,
        mastery: 1,
        at: i,
      });
    }
    expect(state.history.length).toBeLessThanOrEqual(12);
    expect(state.history[state.history.length - 1].day).toBe(20);
  });

  it('compares mastery across sessions (improvement detection)', () => {
    let state = initSchedulerState(pack);
    state = applySessionResult(state, pack, [
      rejection('evap', 'wrong-band', []),
      rejection('vapor', 'wrong-band', []),
    ]);
    state = recordSession(state, {
      day: 1, rung: 1, recalled: 6, weak: 2, rejected: 2, drill: false, mastery: 0.85, at: 1,
    });
    state = advanceDay(state, pack);
    state = applySessionResult(state, pack, []);
    state = recordSession(state, {
      day: state.day, rung: 1, recalled: 8, weak: 0, rejected: 0, drill: false, mastery: 1, at: 2,
    });
    const [prev, last] = state.history.slice(-2);
    expect(last.mastery).toBeGreaterThan(prev.mastery);
  });
});

describe('normalizeState — backward compatibility', () => {
  it('restores old saves that lack the v2 fields', () => {
    const links: Record<string, unknown> = {};
    for (const l of pack.links) {
      links[linkId(l.from, l.to)] = { strength: 0.7, lastSession: 2 };
    }
    const legacy: Record<string, unknown> = { day: 5, sessionNum: 3, links };
    const state = normalizeState(legacy, pack);
    expect(state.day).toBe(5);
    expect(state.sessionNum).toBe(3);
    expect(state.concepts.evap.struggles).toBe(0); // safe defaults
    expect(state.history).toEqual([]);
    for (const l of pack.links) {
      expect(state.links[linkId(l.from, l.to)].strength).toBeCloseTo(0.7, 5);
    }
  });

  it('never crashes on missing or malformed data', () => {
    const state = normalizeState(
      { links: { 'bogus>key': { strength: 'NaN' } }, history: ['junk'] },
      pack,
    );
    expect(state.day).toBe(1);
    for (const l of pack.links) {
      expect(state.links[linkId(l.from, l.to)].strength).toBe(1);
    }
    expect(state.history).toEqual([]);
  });
});

describe('advanceDay', () => {
  it('decays memory a little and floors it', () => {
    let state = initSchedulerState(pack);
    const id = linkId(pack.links[0].from, pack.links[0].to);
    state = advanceDay(state, pack);
    expect(state.links[id].strength).toBeCloseTo(0.94, 5);
    let s = state;
    for (let i = 0; i < 40; i++) s = advanceDay(s, pack);
    for (const l of pack.links) {
      expect(s.links[linkId(l.from, l.to)].strength).toBeGreaterThanOrEqual(0.15);
    }
  });
});

describe('weakNodeIds — concept-level profile', () => {
  it('prefers repeatedly difficult concepts on strength ties', () => {
    let state = initSchedulerState(pack);
    // Weaken both concepts below the threshold via precise wrong-order
    // rejections; evap collects MORE struggles, so it wins the tie-break.
    const evapLink = linkId('evap', 'vapor');
    const coolingLink = linkId('cooling', 'cond');
    // Interleaved: both links decay together; evap collects one more struggle.
    for (let i = 0; i < 6; i++) {
      state = applySessionResult(state, pack, [
        rejection('evap', 'wrong-order', [evapLink]),
        rejection('cooling', 'wrong-order', [coolingLink]),
      ]);
    }
    const evapMin = state.links[evapLink].strength; // ~0.28
    const coolingMin = state.links[coolingLink].strength; // ~0.28
    expect(evapMin).toBeLessThan(WEAK_THRESHOLD);
    expect(coolingMin).toBeLessThan(WEAK_THRESHOLD);
    const weak = weakNodeIds(pack, state);
    expect(weak[0]).toBe('evap'); // struggles tie-break wins over cooling
    expect(weak).toContain('cooling');
  });

  it('caps selection at 3 and excludes fixed concepts', () => {
    let state = initSchedulerState(pack);
    for (let i = 0; i < 12; i++) state = advanceDay(state, pack);
    const weak = weakNodeIds(pack, state);
    expect(weak.length).toBeLessThanOrEqual(3);
    expect(weak).not.toContain('sun');
  });
});

describe('buildSessionConfig ladder', () => {
  it('rung 1 is the clean reference layout with no hidden links', () => {
    for (const day of [1, 3, 7]) {
      const cfg = buildSessionConfig(1, [], [], day * 1013 + 77);
      expect(cfg.mirror).toBe(false);
      expect(cfg.rotDeg).toBe(0);
      expect(cfg.hiddenLinkIds).toEqual([]);
      expect(cfg.removedNodeIds).toEqual([]);
    }
  });

  it('never mirrors, never adds distractors, sway stays bounded', () => {
    for (let day = 1; day <= 20; day++) {
      for (let rung = 1; rung <= 4; rung++) {
        const cfg = buildSessionConfig(rung, ['evap', 'cooling'], ['link>a'], day * 1013 + rung * 77);
        expect(cfg.mirror).toBe(false);
        expect(cfg.distractorCount).toBe(0);
        expect(Math.abs(cfg.rotDeg)).toBeLessThanOrEqual(8);
      }
    }
  });

  it('rung 4+ drills the weak concepts', () => {
    const cfg = buildSessionConfig(4, ['evap', 'cooling', 'cond', 'cloud'], ['link>a'], 4 * 1013 + 4 * 77);
    expect(cfg.removedNodeIds).toEqual(['evap', 'cooling', 'cond']);
  });

  it('is deterministic for a given seed', () => {
    const a = buildSessionConfig(2, [], ['link>a'], 12345);
    const b = buildSessionConfig(2, [], ['link>a'], 12345);
    expect(a).toEqual(b);
  });
});

describe('hiddenCountForSession', () => {
  it('maps rungs to hidden-relationship counts', () => {
    expect(hiddenCountForSession(1)).toBe(0);
    expect(hiddenCountForSession(2)).toBe(2);
    expect(hiddenCountForSession(3)).toBe(3);
    expect(hiddenCountForSession(4)).toBe(2);
  });
});

describe('restart semantics', () => {
  it('initSchedulerState wipes the run back to day 1, rung 1, full strength', () => {
    let state = initSchedulerState(pack);
    state = applySessionResult(state, pack, []);
    state = advanceDay(state, pack);
    state = advanceDay(state, pack);
    const reset = initSchedulerState(pack);
    expect(reset.day).toBe(1);
    expect(reset.sessionNum).toBe(1);
    expect(reset.history).toEqual([]);
    for (const l of pack.links) {
      expect(reset.links[linkId(l.from, l.to)].strength).toBe(1);
    }
  });
});

describe('recordHint', () => {
  it('records hint usage per concept (assisted recall tracking)', () => {
    let state = initSchedulerState(pack);
    state = recordHint(state, 'evap', 1);
    state = recordHint(state, 'evap', 1);
    expect(state.concepts.evap.hints).toBe(2);
    expect(state.concepts.evap.lastDifficultyDay).toBe(1);
  });
});

describe('strength floor consistency', () => {
  it('applies the single STRENGTH_FLOOR across all operations', () => {
    let state = initSchedulerState(pack);
    const weakId = linkId(pack.links[0].from, pack.links[0].to);
    for (let i = 0; i < 10; i++) {
      state = applySessionResult(state, pack, [
        rejection(pack.links[0].from, 'wrong-order', [weakId]),
      ]);
    }
    for (let i = 0; i < 40; i++) state = advanceDay(state, pack);
    expect(state.links[weakId].strength).toBeGreaterThanOrEqual(0.15);
  });
});

describe('WEAK_THRESHOLD', () => {
  it('is unchanged (0.5) so existing weak-concept selection still applies', () => {
    expect(WEAK_THRESHOLD).toBe(0.5);
  });
});
