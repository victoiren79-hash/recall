// src/components.ts
// Component declarations only. No system, DOM, or renderer imports.

import { createComponent, defineComponents } from '@iwsdk/core';

/**
 * Card — a movable concept card (or distractor) placed by the player.
 */
export const Card = createComponent('Card', {
  nodeId: { type: 'String' as const, default: '' },
  label: { type: 'String' as const, default: '' },
  band: { type: 'Int32' as const, default: 0 },
  fixed: { type: 'Boolean' as const, default: false },
  kind: { type: 'String' as const, default: 'card' },
  state: { type: 'String' as const, default: 'free' },
  socketIndex: { type: 'Int32' as const, default: -1 },
});

/**
 * Socket — an empty slot on the arc, one per movable concept.
 */
export const Socket = createComponent('Socket', {
  index: { type: 'Int32' as const, default: 0 },
  band: { type: 'Int32' as const, default: 0 },
  order: { type: 'Int32' as const, default: 0 },
  occupant: { type: 'String' as const, default: '' },
});

/**
 * LinkLine — a line between two concept positions.
 */
export const LinkLine = createComponent('LinkLine', {
  linkId: { type: 'String' as const, default: '' },
  strength: { type: 'Float32' as const, default: 1 },
  lit: { type: 'Boolean' as const, default: false },
  hidden: { type: 'Boolean' as const, default: false },
});

export default defineComponents([Card, Socket, LinkLine]);