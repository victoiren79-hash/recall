// src/packs/loadPack.ts
// Pure module: no IWSDK imports, no DOM, no renderer.

import type { Band, Distractor, LinkType, Pack, PackLink, PackNode } from './types';
import waterCycleRaw from './water-cycle.json';

const VALID_BANDS: ReadonlySet<number> = new Set([0, 1, 2, 3, 4, 5]);
const VALID_LINK_TYPES: ReadonlySet<string> = new Set(['strong', 'medium', 'weak']);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function requireString(obj: Record<string, unknown>, key: string, path: string): string {
  const v = obj[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`loadPack: field "${path}.${key}" must be a non-empty string.`);
  }
  return v;
}

function parseNode(raw: unknown, i: number): PackNode {
  if (!isObject(raw)) {
    throw new Error(`loadPack: nodes[${i}] must be an object.`);
  }
  const id = requireString(raw, 'id', `nodes[${i}]`);
  const label = requireString(raw, 'label', `nodes[${i}]`);
  const bandRaw = raw['band'];
  if (typeof bandRaw !== 'number' || !Number.isInteger(bandRaw) || !VALID_BANDS.has(bandRaw)) {
    throw new Error(
      `loadPack: nodes[${i}] ("${id}").band must be an integer 0..5, got ${String(bandRaw)}.`,
    );
  }
  const node: PackNode = { id, label, band: bandRaw as Band };
  if (raw['fixed'] !== undefined) {
    if (typeof raw['fixed'] !== 'boolean') {
      throw new Error(`loadPack: nodes[${i}] ("${id}").fixed must be a boolean if present.`);
    }
    node.fixed = raw['fixed'];
  }
  if (raw['icon'] !== undefined) {
    if (typeof raw['icon'] !== 'string' || raw['icon'].length === 0) {
      throw new Error(
        `loadPack: nodes[${i}] ("${id}").icon must be a non-empty string if present.`,
      );
    }
    node.icon = raw['icon'];
  }
  return node;
}

function parseLink(raw: unknown, i: number, ids: ReadonlySet<string>): PackLink {
  if (!isObject(raw)) {
    throw new Error(`loadPack: links[${i}] must be an object.`);
  }
  const from = requireString(raw, 'from', `links[${i}]`);
  const to = requireString(raw, 'to', `links[${i}]`);
  const typeRaw = raw['type'];
  if (typeof typeRaw !== 'string' || !VALID_LINK_TYPES.has(typeRaw)) {
    throw new Error(
      `loadPack: links[${i}].type must be one of strong|medium|weak, got ${String(typeRaw)}.`,
    );
  }
  if (!ids.has(from)) {
    throw new Error(`loadPack: links[${i}].from "${from}" does not name a node.`);
  }
  if (!ids.has(to)) {
    throw new Error(`loadPack: links[${i}].to "${to}" does not name a node.`);
  }
  return { from, to, type: typeRaw as LinkType };
}

function parseDistractor(raw: unknown, i: number): Distractor {
  if (!isObject(raw)) {
    throw new Error(`loadPack: distractors[${i}] must be an object.`);
  }
  const label = requireString(raw, 'label', `distractors[${i}]`);
  const why = requireString(raw, 'why', `distractors[${i}]`);
  return { label, why };
}

/** Validate an untrusted object and return a typed Pack. Throws on the first bad field. */
export function loadPack(raw: unknown): Pack {
  if (!isObject(raw)) {
    throw new Error('loadPack: pack must be an object.');
  }
  const id = requireString(raw, 'id', 'pack');

  const nodesRaw = raw['nodes'];
  if (!Array.isArray(nodesRaw) || nodesRaw.length === 0) {
    throw new Error('loadPack: "nodes" must be a non-empty array.');
  }
  const nodes: PackNode[] = [];
  const ids = new Set<string>();
  for (let i = 0; i < nodesRaw.length; i++) {
    const node = parseNode(nodesRaw[i], i);
    if (ids.has(node.id)) {
      throw new Error(`loadPack: duplicate node id "${node.id}" at nodes[${i}].`);
    }
    ids.add(node.id);
    nodes.push(node);
  }

  const linksRaw = raw['links'];
  if (!Array.isArray(linksRaw)) {
    throw new Error('loadPack: "links" must be an array.');
  }
  const links: PackLink[] = linksRaw.map((l, i) => parseLink(l, i, ids));

  const distractorsRaw = raw['distractors'];
  if (!Array.isArray(distractorsRaw)) {
    throw new Error('loadPack: "distractors" must be an array.');
  }
  const distractors: Distractor[] = distractorsRaw.map((d, i) => parseDistractor(d, i));

  return { id, nodes, links, distractors };
}

/** Load the bundled water-cycle pack through the validator. */
export function loadBundledPack(): Pack {
  return loadPack(waterCycleRaw);
}