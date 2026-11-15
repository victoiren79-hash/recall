const fs = require('fs');
let s = fs.readFileSync('src/systems/interaction.ts', 'utf8');

// 1. Capture the halo sprite alongside the raycast meshes.
const capOld = "      this.cardRaycast.set(nodeId, (() => {\n        const meshes: Array<{ mesh: any; native: any }> = [];\n        obj.traverse((o: any) => {\n          if (o.isMesh) meshes.push({ mesh: o, native: o.raycast });\n        });\n        return meshes;\n      })());";
const capNew = "      this.cardRaycast.set(nodeId, (() => {\n        const meshes: Array<{ mesh: any; native: any }> = [];\n        let halo: any = null;\n        obj.traverse((o: any) => {\n          if (o.isMesh) meshes.push({ mesh: o, native: o.raycast });\n          if (o.isSprite) halo = o;\n        });\n        if (halo) this.cardHalos.set(nodeId, halo);\n        return meshes;\n      })());";
if (!s.includes(capOld)) { console.error('capture block not found'); process.exit(1); }
s = s.replace(capOld, capNew);

// 2. Field for the halos.
s = s.replace(
  '  private cardRaycast: Map<string, Array<{ mesh: any; native: any }>> = new Map();',
  '  private cardRaycast: Map<string, Array<{ mesh: any; native: any }>> = new Map();\n  /** Per-card halo sprites \u2014 shrunk when placed so the glow hugs the card. */\n  private cardHalos: Map<string, any> = new Map();'
);

// 3. Clear at configure.
s = s.replace(
  '    this.cardRaycast.clear();',
  '    this.cardRaycast.clear();\n    this.cardHalos.clear();'
);

// 4. Toggle in applyCardFx: halo hugs placed cards.
s = s.replace(
  '    const blockRay = !held && this.phase === \'rebuild\' &&\n      entity.getValue(Card, \'state\') === \'placed\';',
  "    const blockRay = !held && this.phase === 'rebuild' &&\n      entity.getValue(Card, 'state') === 'placed';\n    const state = entity.getValue(Card, 'state') as string;\n    const halo = this.cardHalos.get(nodeId);\n    if (halo) {\n      // Placed: the glow hugs the card \u2014 no second outline past the border\n      // (user: double borders when placed). Free/held: the full halo.\n      const s = state === 'placed' ? 0.6 : 1;\n      halo.scale.set(0.24 * s, 0.195 * s, 1);\n    }"
);
fs.writeFileSync('src/systems/interaction.ts', s);
console.log('halo fix applied');
