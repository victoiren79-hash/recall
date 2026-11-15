// src/systems/session.ts
// Session variety per the README progression table (§7). Pure module.
//
// Difficulty is performance-responsive (scheduler.ts evaluateDifficulty moves
// the rung), and the hidden-relationship selection comes from the scheduler's
// review priority — weak and stale connections return sooner (upgrade: real
// spaced repetition). Distractor cards stay off (their visuals are disabled
// in spawn).
//
//   rung 1 : complete structure, all links visible — the reference layout
//   rung 2 : the ring sways ±8°, 2 hidden relationships
//   rung 3 : 3 hidden relationships
//   rung 4 : the weakest concepts start unplaced — the daily drill

export interface SessionConfig {
  number: number;
  mirror: boolean;
  rotDeg: number;
  distractorCount: number;
  hiddenLinkIds: string[];
  /** Movable nodes that start in the tray (weak-link challenge, rung 4+). */
  removedNodeIds: string[];
}

/** Deterministic small PRNG (mulberry32) so a given day always replays. */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

/** Hidden-relationship count for a difficulty rung (0 on the reference rung). */
export function hiddenCountForSession(sessionNum: number): number {
  if (sessionNum <= 1) return 0;
  if (sessionNum === 2) return 2;
  return sessionNum === 3 ? 3 : 2;
}

export function buildSessionConfig(
  sessionNum: number,
  weakNodes: string[],
  hiddenLinkIds: string[],
  seed: number,
): SessionConfig {
  const rng = mulberry32(seed);
  const config: SessionConfig = {
    number: sessionNum,
    mirror: false,
    rotDeg: 0,
    distractorCount: 0,
    hiddenLinkIds,
    removedNodeIds: [],
  };

  // Weak-concept drill: engages at every rung — reinforcement follows the
  // weakness; the rung controls reconstruction difficulty (hidden links).
  config.removedNodeIds = weakNodes.slice(0, 3);

  if (sessionNum === 1) return config;

  // Each rung is a VISIBLE step (user: next day must not feel like a reset):
  // a clearly swayed ring, more hidden connections, then the weak drill.
  if (sessionNum === 2) {
    config.rotDeg = rng() < 0.5 ? -8 : 8;
  } else if (sessionNum === 3) {
    config.rotDeg = rng() < 0.5 ? -8 : 8;
  } else {
    config.rotDeg = Math.round((rng() * 2 - 1) * 8);
    config.removedNodeIds = weakNodes.slice(0, 3);
  }
  return config;
}
