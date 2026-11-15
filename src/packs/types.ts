// src/packs/types.ts
// Pure module: no IWSDK imports, no DOM, no renderer.

/** Height band a concept lives in. Band 0 is lowest, band 5 is highest. */
export type Band = 0 | 1 | 2 | 3 | 4 | 5;

/** Link strength as authored in the pack. */
export type LinkType = 'strong' | 'medium' | 'weak';

/** A concept node. `fixed` nodes are anchors placed by the app (e.g. the Sun). */
export interface PackNode {
  id: string;
  label: string;
  band: Band;
  fixed?: boolean;
  /** Optional emoji icon shown on the card face (e.g. "💧"). */
  icon?: string;
}

/** A directed link between two nodes. */
export interface PackLink {
  from: string;
  to: string;
  type: LinkType;
}

/** A decoy label that must be rejected with an explanation. */
export interface Distractor {
  label: string;
  why: string;
}

/**
 * The authored pack. The order of `nodes` is the canonical flow order:
 * a link whose target appears earlier in `nodes` than its source is a
 * "wrap link" and is exempt from the order check.
 */
export interface Pack {
  id: string;
  nodes: PackNode[];
  links: PackLink[];
  distractors: Distractor[];
}