// src/systems/scheduler.ts
// Per-relationship spaced-repetition state + performance-responsive difficulty.
// Pure module: no IWSDK imports, no DOM.
//
// Every link carries a strength in 0..1. Satisfied links gain strength,
// rejected placements cost a little, and each simulated day lets strength
// decay — weak links fade to ghosts and come back as the next session's
// challenge (README §8).
//
// Learning upgrades (v2 state):
//  - Review scheduling: each link tracks the day of its last rebuild, and
//    `reviewLinkIds` ranks the connections that should be hidden (recalled)
//    next — weak and stale links return sooner, strong and recent ones later.
//  - Performance-responsive difficulty: `evaluateDifficulty` moves the
//    session rung up/down based on demonstrated mastery, not elapsed days.
//  - Session history: the last completed sessions are recorded for progress
//    comparison (kept lightweight, capped).
//  - Concept-level profile: rejection and hint counts per concept feed the
//    weak-node selection and the summary.

import type { Pack } from '../packs/types';

export const WEAK_THRESHOLD = 0.5;
/** Links at or above this count as "strong" in summaries. */
export const MASTERED_THRESHOLD = 0.75;
const MAX_WEAK_PER_SESSION = 3;
const MAX_HISTORY = 12;
/** Single consistent floor for every strength operation. */
export const STRENGTH_FLOOR = 0.15;
export const STATE_VERSION = 2;

export interface LinkProgress {
  /** 0..1. Ghost brightness and "weak" selection derive from this. */
  strength: number;
  /** Simulated day of the last rebuild covering this link. */
  lastSession: number;
  /** Simulated day this link was actually hidden for recall (a real test).
   * 0 = never tested. Drives the review rotation — without it every link
   * shares `lastSession` and the same weak links get hidden every day. */
  lastTested: number;
}

export interface ConceptProgress {
  /** Rejected placements involving this concept. */
  struggles: number;
  /** Hints requested about this concept. */
  hints: number;
  /** Simulated day of the last difficulty. */
  lastDifficultyDay: number;
}

export interface SessionRecord {
  /** Simulated day of the session. */
  day: number;
  /** Difficulty rung (1..4). */
  rung: number;
  /** Links successfully recalled (lit at completion). */
  recalled: number;
  /** Links below the strong cutoff. */
  weak: number;
  /** Rejected placements during the session. */
  rejected: number;
  /** True when the session was a personalized weak-concept drill. */
  drill: boolean;
  /** Average relationship strength at completion. */
  mastery: number;
  /** Completion timestamp (Date.now). */
  at: number;
}

/** One rejected placement, with precise attribution. */
export interface SessionRejection {
  /** The concept that was misplaced. */
  nodeId: string;
  /** Rejection reason ('wrong-band' | 'wrong-order' | 'occupied' | ...). */
  reason: string;
  /** Only the relationships the mistake actually contradicts. */
  linkIds: string[];
}

export interface SchedulerState {
  version: typeof STATE_VERSION;
  /** Simulated day counter (fast-forwarded by the "Next Day" control). */
  day: number;
  /** Difficulty rung (1..4) — performance-responsive, see evaluateDifficulty. */
  sessionNum: number;
  links: Record<string, LinkProgress>;
  concepts: Record<string, ConceptProgress>;
  /** Recent completed sessions, oldest first, capped. */
  history: SessionRecord[];
  /** The most recent completed session (also the last history entry). */
  lastResult: SessionRecord | null;
}

export function linkId(from: string, to: string): string {
  return from + '>' + to;
}

function clampStrength(v: number): number {
  return Math.min(1, Math.max(STRENGTH_FLOOR, v));
}

function emptyLink(): LinkProgress {
  return { strength: 1, lastSession: 0, lastTested: 0 };
}

function emptyConcept(): ConceptProgress {
  return { struggles: 0, hints: 0, lastDifficultyDay: 0 };
}

/** Fill missing/corrupt optional fields on a loaded state (backward compat). */
function normalizeLink(raw: unknown): LinkProgress {
  const r = (raw ?? {}) as Partial<LinkProgress>;
  const strength = typeof r.strength === 'number' && Number.isFinite(r.strength)
    ? Math.min(1, Math.max(STRENGTH_FLOOR, r.strength))
    : 1;
  const lastSession = typeof r.lastSession === 'number' && Number.isFinite(r.lastSession)
    ? Math.max(0, Math.floor(r.lastSession))
    : 0;
  const lastTested = typeof r.lastTested === 'number' && Number.isFinite(r.lastTested)
    ? Math.max(0, Math.floor(r.lastTested))
    : 0;
  return { strength, lastSession, lastTested };
}

function normalizeConcept(raw: unknown): ConceptProgress {
  const r = (raw ?? {}) as Partial<ConceptProgress>;
  const int = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
  return {
    struggles: int(r.struggles),
    hints: int(r.hints),
    lastDifficultyDay: typeof r.lastDifficultyDay === 'number'
      ? Math.max(0, Math.floor(r.lastDifficultyDay))
      : 0,
  };
}

function normalizeRecord(raw: unknown): SessionRecord | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Partial<SessionRecord>;
  const int = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : fallback;
  return {
    day: int(r.day, 1),
    rung: Math.min(4, Math.max(1, int(r.rung, 1))),
    recalled: int(r.recalled, 0),
    weak: int(r.weak, 0),
    rejected: int(r.rejected, 0),
    drill: r.drill === true,
    mastery: typeof r.mastery === 'number' && Number.isFinite(r.mastery) ? r.mastery : 0,
    at: typeof r.at === 'number' && Number.isFinite(r.at) ? r.at : 0,
  };
}

/**
 * Validate/fill a loaded (possibly old-format) state against the current pack.
 * Never resets progress: missing or malformed optional fields get safe
 * defaults, and links missing from old saves are restored at full strength.
 */
export function normalizeState(raw: unknown, pack: Pack): SchedulerState {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<SchedulerState>;
  const state = initSchedulerState(pack);
  const day = typeof r.day === 'number' && Number.isFinite(r.day) && r.day >= 1
    ? Math.floor(r.day)
    : 1;
  state.day = day;
  state.sessionNum = typeof r.sessionNum === 'number'
    ? Math.min(4, Math.max(1, Math.floor(r.sessionNum)))
    : 1;
  const rawLinks = (typeof r.links === 'object' && r.links !== null ? r.links : {}) as Record<string, unknown>;
  for (const l of pack.links) {
    const id = linkId(l.from, l.to);
    state.links[id] = normalizeLink(rawLinks[id]);
  }
  const rawConcepts = (typeof r.concepts === 'object' && r.concepts !== null ? r.concepts : {}) as Record<string, unknown>;
  for (const node of pack.nodes) {
    state.concepts[node.id] = normalizeConcept(rawConcepts[node.id]);
  }
  if (Array.isArray(r.history)) {
    const records = r.history
      .slice(-MAX_HISTORY)
      .map((h) => normalizeRecord(h))
      .filter((h): h is SessionRecord => h !== null);
    state.history = records;
    state.lastResult = records.length > 0 ? records[records.length - 1] : null;
  }
  if (r.lastResult) {
    const last = normalizeRecord(r.lastResult);
    if (last && !state.lastResult) state.lastResult = last;
  }
  return state;
}

export function initSchedulerState(pack: Pack, startSession = 1): SchedulerState {
  const links: Record<string, LinkProgress> = {};
  for (const l of pack.links) {
    links[linkId(l.from, l.to)] = emptyLink();
  }
  return {
    version: STATE_VERSION,
    day: 1,
    sessionNum: startSession,
    links,
    concepts: {},
    history: [],
    lastResult: null,
  };
}

/**
 * Apply one completed rebuild. `rejections` carry precise attribution:
 * only the relationships each mistake actually contradicted lose strength
 * (wrong-order rejections name their blocking links; band/occupied
 * rejections provide no relationship evidence and cost none).
 * Links assisted by hints gain less than independently recalled ones.
 * `testedLinkIds` names the links that were hidden for recall this session —
 * they alone get a `lastTested` stamp, which drives the review rotation.
 */
export function applySessionResult(
  state: SchedulerState,
  pack: Pack,
  rejections: SessionRejection[],
  hintedConcepts: string[] = [],
  testedLinkIds: string[] = [],
): SchedulerState {
  const rejected = new Set<string>();
  for (const r of rejections) {
    for (const id of r.linkIds) rejected.add(id);
  }
  const tested = new Set(testedLinkIds);
  const assisted = new Set(hintedConcepts);
  const links: Record<string, LinkProgress> = {};
  for (const l of pack.links) {
    const id = linkId(l.from, l.to);
    const prev = state.links[id] ?? emptyLink();
    // Assisted recall (a hint covered one of this link's concepts) earns less.
    const isAssisted = assisted.has(l.from) || assisted.has(l.to);
    const delta = rejected.has(id) ? -0.12 : isAssisted ? 0.04 : 0.08;
    links[id] = {
      strength: clampStrength(prev.strength + delta),
      lastSession: state.day,
      lastTested: tested.has(id) ? state.day : prev.lastTested,
    };
  }
  const concepts: Record<string, ConceptProgress> = {};
  for (const node of pack.nodes) {
    const prev = state.concepts[node.id] ?? emptyConcept();
    concepts[node.id] = { ...prev };
  }
  for (const r of rejections) {
    const c = concepts[r.nodeId] ?? emptyConcept();
    c.struggles += 1;
    c.lastDifficultyDay = state.day;
    concepts[r.nodeId] = c;
  }
  return { ...state, links, concepts };
}

/** Concepts a hint was requested about this session. */
export function recordHint(state: SchedulerState, nodeId: string, day: number): SchedulerState {
  const concepts: Record<string, ConceptProgress> = { ...state.concepts };
  const c = { ...(concepts[nodeId] ?? emptyConcept()) };
  c.hints += 1;
  c.lastDifficultyDay = day;
  concepts[nodeId] = c;
  return { ...state, concepts };
}

/** Record a completed session into the (capped) history. */
export function recordSession(
  state: SchedulerState,
  record: SessionRecord,
): SchedulerState {
  const history = [...state.history, record].slice(-MAX_HISTORY);
  return { ...state, history, lastResult: record };
}

/**
 * Performance-responsive difficulty: move the session rung up when the user
 * demonstrates mastery, hold it otherwise, and drop it when the user is
 * clearly overwhelmed. Deliberately insensitive to any single action — the
 * evaluation uses aggregate mastery, weak counts, and the last session.
 */
export function evaluateDifficulty(state: SchedulerState, pack: Pack): number {
  const strengths = pack.links.map((l) => state.links[linkId(l.from, l.to)]?.strength ?? 1);
  const mastery = strengths.length > 0
    ? strengths.reduce((a, b) => a + b, 0) / strengths.length
    : 1;
  const weakLinks = strengths.filter((s) => s < WEAK_THRESHOLD).length;
  const weakConcepts = weakNodeIds(pack, state).length;
  const last = state.lastResult;
  const prev = state.history.length >= 2 ? state.history[state.history.length - 2] : null;
  const lastClean = last ? last.rejected === 0 : true;
  const improving = Boolean(
    last && prev && last.mastery >= prev.mastery + 0.05,
  );

  let rung = state.sessionNum;
  const promote =
    (mastery >= 0.8 && weakLinks <= 1 && lastClean) ||
    (improving && mastery >= 0.7 && weakConcepts <= 1);
  const demote = mastery < 0.55 || weakLinks >= 4 || (last !== null && last.rejected >= 3);
  if (promote) rung += 1;
  else if (demote) rung -= 1;
  return Math.min(4, Math.max(1, rung));
}

/**
 * Simulate the passage of one day: strengths decay a little and the next
 * session's difficulty rung follows demonstrated performance — never the
 * calendar alone.
 */
export function advanceDay(state: SchedulerState, pack: Pack): SchedulerState {
  const links: Record<string, LinkProgress> = {};
  for (const l of pack.links) {
    const id = linkId(l.from, l.to);
    const prev = state.links[id] ?? emptyLink();
    links[id] = {
      strength: Math.max(STRENGTH_FLOOR, prev.strength - 0.06),
      lastSession: prev.lastSession,
      lastTested: prev.lastTested,
    };
  }
  return {
    ...state,
    day: state.day + 1,
    sessionNum: evaluateDifficulty({ ...state, links }, pack),
    links,
  };
}

/**
 * Weak concepts: minimum incident link strength below the threshold, with
 * repeatedly difficult concepts winning ties (concept-level profile).
 */
export function weakNodeIds(pack: Pack, state: SchedulerState): string[] {
  const scored: Array<{ id: string; min: number; struggles: number }> = [];
  for (const node of pack.nodes) {
    if (node.fixed) continue;
    let min = 1;
    for (const l of pack.links) {
      if (l.from !== node.id && l.to !== node.id) continue;
      const s = state.links[linkId(l.from, l.to)]?.strength ?? 1;
      if (s < min) min = s;
    }
    if (min < WEAK_THRESHOLD) {
      scored.push({ id: node.id, min, struggles: state.concepts[node.id]?.struggles ?? 0 });
    }
  }
  scored.sort((a, b) => b.struggles - a.struggles || a.min - b.min);
  return scored.slice(0, MAX_WEAK_PER_SESSION).map((s) => s.id);
}

export function linkStrengthMap(state: SchedulerState): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id in state.links) out[id] = state.links[id].strength;
  return out;
}

/**
 * Real review scheduling: rank the connections that should be recalled
 * (hidden) next. Weak relationships return sooner; strong and recently
 * rebuilt ones receive progressively longer intervals. Deterministic.
 */
export function reviewLinkIds(
  pack: Pack,
  state: SchedulerState,
  count: number,
): string[] {
  interface Scored { id: string; score: number; last: number; strength: number }
  const scored: Scored[] = [];
  for (const l of pack.links) {
    const id = linkId(l.from, l.to);
    const p = state.links[id] ?? emptyLink();
    const base = 1 - p.strength;
    // Recency counts REAL recall tests (days since this link was hidden),
    // not rebuilds — otherwise every link shares lastSession and the same
    // links get re-hidden day after day. Fresh states (lastTested 0) start
    // stale, so the first review pass spreads across the whole set.
    const daysSince = Math.max(0, state.day - p.lastTested);
    const recency = Math.min(1, daysSince / 5);
    // A connection the user has repeatedly struggled with returns sooner.
    const difficult = [l.from, l.to].some(
      (n) => (state.concepts[n]?.struggles ?? 0) > 0,
    );
    const score = 0.6 * base + 0.3 * recency + (difficult ? 0.15 : 0);
    scored.push({ id, score, last: p.lastTested, strength: p.strength });
  }
  // Priority: weak/stale/difficult relationships first, then the least
  // recently rebuilt fill the remainder — so the requested count is always
  // met while the weakest connections are guaranteed a front slot.
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.last - b.last ||
      a.strength - b.strength ||
      (a.id < b.id ? -1 : 1),
  );
  return scored.slice(0, Math.max(0, count)).map((s) => s.id);
}
