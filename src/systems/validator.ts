// src/systems/validator.ts
// Pure module: no IWSDK imports, no DOM, no renderer.

import type { Pack, PackNode } from '../packs/types';

/** A rebuild slot. `order` is the canonical flow position (0 = earliest in the arc). */
export interface Socket {
  index: number;
  band: number;
  order: number;
}

/** Map from nodeId to the socketIndex it currently occupies. Missing = not placed. */
export type Placed = Record<string, number>;

/** Result of asking "may this node go in this socket right now?". */
export interface PlacementCheck {
  valid: boolean;
  reason: null | 'occupied' | 'wrong-band' | 'wrong-order' | 'unknown-node';
  blockingLinkIds: string[];
}

/** Stable link id used everywhere else in the app. */
export function linkId(from: string, to: string): string {
  return from + '>' + to;
}

function nodeById(pack: Pack, id: string): PackNode | undefined {
  return pack.nodes.find((n) => n.id === id);
}

function orderById(pack: Pack): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < pack.nodes.length; i++) {
    m.set(pack.nodes[i].id, i);
  }
  return m;
}

/** A link is a wrap link if its target appears earlier in pack.nodes than its source. */
function isWrapLink(pack: Pack, fromId: string, toId: string): boolean {
  const ord = orderById(pack);
  const a = ord.get(fromId);
  const b = ord.get(toId);
  if (a === undefined || b === undefined) return false;
  return b < a;
}

/** A link touches the anchor if either endpoint is a fixed node. */
function touchesAnchor(pack: Pack, fromId: string, toId: string): boolean {
  const a = nodeById(pack, fromId);
  const b = nodeById(pack, toId);
  return Boolean(a?.fixed) || Boolean(b?.fixed);
}

function socketByIndex(sockets: Socket[], index: number): Socket | undefined {
  return sockets.find((s) => s.index === index);
}

/**
 * The node's flow rank among the pack's non-fixed nodes. buildLayout assigns
 * sockets in the same order (socket.order === flow rank), so this is the
 * canonical slot for the node.
 */
function flowRankOf(pack: Pack, nodeId: string): number | undefined {
  let rank = 0;
  for (const n of pack.nodes) {
    if (n.fixed) continue;
    if (n.id === nodeId) return rank;
    rank++;
  }
  return undefined;
}

function isSocketOccupied(placed: Placed, socketIndex: number, byNodeId: string): boolean {
  for (const id in placed) {
    if (id === byNodeId) continue;
    if (placed[id] === socketIndex) return true;
  }
  return false;
}

/** Try to place `nodeId` into `socketIndex` given the current `placed` map. */
export function checkPlacement(
  pack: Pack,
  sockets: Socket[],
  placed: Placed,
  nodeId: string,
  socketIndex: number,
): PlacementCheck {
  const node = nodeById(pack, nodeId);
  if (!node) {
    return { valid: false, reason: 'unknown-node', blockingLinkIds: [] };
  }

  if (isSocketOccupied(placed, socketIndex, nodeId)) {
    return { valid: false, reason: 'occupied', blockingLinkIds: [] };
  }

  const socket = socketByIndex(sockets, socketIndex);
  if (!socket) {
    return { valid: false, reason: 'unknown-node', blockingLinkIds: [] };
  }

  if (socket.band !== node.band) {
    return { valid: false, reason: 'wrong-band', blockingLinkIds: [] };
  }

  // Anchor every node to its flow slot (socket.order === the node's flow
  // rank). The band + order rules admit exactly ONE full solution — the
  // canonical one — so letting band-mates swap sockets only ever creates
  // dead ends the player discovers at the end: precipitation parked in
  // water vapor's slot passes the local check while clouds is unplaced,
  // then blocks water vapor (its remaining band-mate socket always
  // violates vapor→cooling) and clouds (cloud→precip) forever.
  const rank = flowRankOf(pack, nodeId);
  if (rank !== undefined && socket.order !== rank) {
    return { valid: false, reason: 'wrong-order', blockingLinkIds: [] };
  }

  // Simulate the placement and check order for every non-wrap, non-anchor link
  // whose BOTH ends are placed after this move.
  const hypothetical: Placed = { ...placed, [nodeId]: socketIndex };
  const blocking: string[] = [];

  for (const link of pack.links) {
    if (isWrapLink(pack, link.from, link.to)) continue;
    if (touchesAnchor(pack, link.from, link.to)) continue;

    const fromIdx = hypothetical[link.from];
    const toIdx = hypothetical[link.to];
    if (fromIdx === undefined || toIdx === undefined) continue;

    const fromSocket = socketByIndex(sockets, fromIdx);
    const toSocket = socketByIndex(sockets, toIdx);
    if (!fromSocket || !toSocket) continue;

    if (fromSocket.order >= toSocket.order) {
      blocking.push(linkId(link.from, link.to));
    }
  }

  if (blocking.length > 0) {
    return { valid: false, reason: 'wrong-order', blockingLinkIds: blocking };
  }

  return { valid: true, reason: null, blockingLinkIds: [] };
}

/**
 * Links that are currently satisfied. For a normal link: both ends placed and
 * ordered correctly. For a wrap link or an anchor-touching link: the non-anchor
 * end is validly placed in its own band.
 */
export function getLitLinks(pack: Pack, sockets: Socket[], placed: Placed): string[] {
  const lit: string[] = [];
  for (const link of pack.links) {
    const id = linkId(link.from, link.to);
    const fromIdx = placed[link.from];
    const toIdx = placed[link.to];

    const anchor = touchesAnchor(pack, link.from, link.to);
    const wrap = isWrapLink(pack, link.from, link.to);

    if (anchor || wrap) {
      // Lit once at least one endpoint (for anchor) or both (for wrap) are placed
      // in the right bands. For anchor: the non-anchor side must be placed.
      if (anchor) {
        const fromNode = nodeById(pack, link.from);
        const toNode = nodeById(pack, link.to);
        const nonAnchorId = fromNode?.fixed ? link.to : toNode?.fixed ? link.from : null;
        if (nonAnchorId !== null) {
          if (placed[nonAnchorId] === undefined) continue;
          lit.push(id);
          continue;
        }
        // Both ends anchor (unexpected) — require both placed.
        if (fromIdx !== undefined && toIdx !== undefined) lit.push(id);
        continue;
      }
      // Wrap: both ends placed in any order.
      if (fromIdx !== undefined && toIdx !== undefined) lit.push(id);
      continue;
    }

    if (fromIdx === undefined || toIdx === undefined) continue;
    const fromSocket = socketByIndex(sockets, fromIdx);
    const toSocket = socketByIndex(sockets, toIdx);
    if (!fromSocket || !toSocket) continue;
    if (fromSocket.order < toSocket.order) lit.push(id);
  }
  return lit;
}

/** True when every non-fixed node is placed in a socket of its own band and all rules hold. */
export function isComplete(pack: Pack, sockets: Socket[], placed: Placed): boolean {
  for (const node of pack.nodes) {
    if (node.fixed) continue;
    const idx = placed[node.id];
    if (idx === undefined) return false;
    const socket = socketByIndex(sockets, idx);
    if (!socket) return false;
    if (socket.band !== node.band) return false;
  }
  // Full order check across all non-wrap, non-anchor links.
  for (const link of pack.links) {
    if (isWrapLink(pack, link.from, link.to)) continue;
    if (touchesAnchor(pack, link.from, link.to)) continue;
    const fromIdx = placed[link.from];
    const toIdx = placed[link.to];
    if (fromIdx === undefined || toIdx === undefined) return false;
    const fromSocket = socketByIndex(sockets, fromIdx);
    const toSocket = socketByIndex(sockets, toIdx);
    if (!fromSocket || !toSocket) return false;
    if (fromSocket.order >= toSocket.order) return false;
  }
  return true;
}