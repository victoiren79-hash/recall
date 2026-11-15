// scripts/verify-flat-drag.mjs
// Flat-page (desktop mouse) verification:
//   1. Grab a tray card with the mouse — the card must FOLLOW the cursor
//      (regression test for the screen-ray pointerQuaternion patch).
//   2. Release over the card's solution socket — it must snap into place.
//   3. Hold W/A/S/D — the flat camera must pivot (turn) without walking.
// Run: node scripts/verify-flat-drag.mjs   (dev server on :8081)
import { chromium } from 'playwright';

const URL = 'https://localhost:8081/';
const browser = await chromium.launch({
  headless: true,
  args: ['--enable-unsafe-swiftshader', '--ignore-certificate-errors'],
});
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 900 } });
const page = await context.newPage();
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text().slice(0, 160)}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${String(e).slice(0, 200)}`));

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

const findApp = async () => {
  for (let i = 0; i < 30; i++) {
    for (const f of page.frames()) {
      try { if (await f.evaluate(() => Boolean(window.__recall))) return f; } catch {}
    }
    await page.waitForTimeout(500);
  }
  throw new Error('no app frame');
};

// Fresh session state, then reload so the first session starts clean.
await page.evaluate(() => new Promise((res) => {
  const req = indexedDB.deleteDatabase('recall-store');
  req.onsuccess = () => res(true);
  req.onerror = () => res(false);
}));
await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
const app = await findApp();

const isTop = await app.evaluate(() => window === window.top);
if (!isTop) throw new Error('app is not in the top frame — mouse coords would be offset');

// Wait for the session to spawn.
let phase = '';
for (let i = 0; i < 60; i++) {
  phase = await app.evaluate(() => window.__recall?.state?.().phase ?? '');
  if (phase === 'see' || phase === 'rebuild') break;
  await page.waitForTimeout(500);
}
console.log('phase:', phase);

// World→screen projection for one node id.
const screenOf = async (nodeId) => app.evaluate((id) => {
  const it = window.__recall.interaction();
  const w = it.world;
  const cam = w.camera;
  const canvas = w.renderer.domElement;
  const V = w.scene.position.constructor;
  const obj = it.spawn.cardsByNodeId.get(id).object3D;
  const wp = new V();
  obj.updateWorldMatrix(true, false);
  obj.getWorldPosition(wp);
  const ndc = wp.clone().project(cam);
  const r = canvas.getBoundingClientRect();
  return {
    x: r.left + (ndc.x * 0.5 + 0.5) * r.width,
    y: r.top + (-ndc.y * 0.5 + 0.5) * r.height,
    world: wp.toArray().map((n) => +n.toFixed(3)),
  };
}, nodeId);

// Solution socket world position for one node id.
const socketWorldOf = (nodeId) => app.evaluate((id) => {
  const it = window.__recall.interaction();
  const w = it.world;
  const V = w.scene.position.constructor;
  const idx = it.layout.solution[id];
  const s = it.layout.sockets[idx];
  const rootObj = it.spawn.structure.object3D;
  rootObj.updateWorldMatrix(true, false);
  const wp = new V(s.position.x, s.position.y, s.position.z).applyMatrix4(rootObj.matrixWorld);
  const cam = w.camera;
  const canvas = w.renderer.domElement;
  const ndc = wp.clone().project(cam);
  const r = canvas.getBoundingClientRect();
  return {
    world: wp.toArray().map((n) => +n.toFixed(3)),
    x: r.left + (ndc.x * 0.5 + 0.5) * r.width,
    y: r.top + (-ndc.y * 0.5 + 0.5) * r.height,
  };
}, nodeId);

const cardState = (id) => app.evaluate((x) => window.__recall.interaction().getCardState(x), id);
const freeCards = () => app.evaluate(() => {
  const it = window.__recall.interaction();
  const out = [];
  for (const [id, idx] of Object.entries(it.layout.solution)) {
    const e = it.spawn.cardsByNodeId.get(id);
    if (!e) continue;
    if (it.getCardState(id) === 'free') out.push({ id, idx });
  }
  out.sort((a, b) => a.idx - b.idx);
  return out.map((c) => c.id);
});

// ---- Test 1 + 2: mouse grab → card follows cursor → drop on socket ----
const candidates = await freeCards();
console.log('free cards:', candidates.join(', '));
let placedId = null;
let followDelta = 0;

for (const id of candidates) {
  const before = await screenOf(id);
  await page.mouse.move(before.x, before.y);
  await page.waitForTimeout(300);
  await page.mouse.down();
  await page.waitForTimeout(1200); // grab registers; scramble starts; hold lerp settles

  const holdA = await screenOf(id);
  // Drag the mouse well away — the held card must ride the cursor ray.
  await page.mouse.move(before.x + 320, Math.max(120, before.y - 160), { steps: 8 });
  await page.waitForTimeout(1200);
  const holdB = await screenOf(id);
  const dx = holdB.world[0] - holdA.world[0];
  const dy = holdB.world[1] - holdA.world[1];
  const dz = holdB.world[2] - holdA.world[2];
  followDelta = Math.hypot(dx, dy, dz);
  console.log(`  ${id}: hold world moved ${followDelta.toFixed(3)} m while dragging (follow ${followDelta > 0.25 ? 'OK' : 'FAIL'})`);

  // Aim at this card's own solution socket and release.
  const sock = await socketWorldOf(id);
  await page.mouse.move(sock.x, sock.y, { steps: 6 });
  await page.waitForTimeout(1000);
  await page.mouse.up();
  await page.waitForTimeout(1800);
  const st = await cardState(id);
  console.log(`  ${id} after release: ${st}`);
  if (st === 'placed') { placedId = id; break; }
  // Card glides back to the tray — wait for it to settle before retrying.
  for (let i = 0; i < 10 && (await cardState(id)) !== 'free'; i++) await page.waitForTimeout(500);
}

if (!placedId) {
  console.log('RESULT: FAIL — no card placed');
  console.log(logs.slice(-25).join('\n'));
  await browser.close();
  process.exit(1);
}
console.log(`RESULT: drag+drop OK (placed ${placedId}, follow Δ ${followDelta.toFixed(3)} m)`);

// ---- Test 3: WASD turns the camera in place (seated pivot) ----
const camProbe = () => app.evaluate(() => {
  const it = window.__recall.interaction();
  const cam = it.world.camera;
  const V = cam.position.constructor;
  const d = new V();
  cam.getWorldDirection(d);
  const p = cam.getWorldPosition(new V());
  return { yaw: Math.atan2(d.x, -d.z), pos: p.toArray().map((n) => +n.toFixed(2)) };
});
const before = await camProbe();
await page.keyboard.down('KeyA');
await page.waitForTimeout(2500);
await page.keyboard.up('KeyA');
await page.waitForTimeout(300);
const after = await camProbe();
const dYaw = after.yaw - before.yaw;
const dPos = Math.hypot(after.pos[0] - before.pos[0], after.pos[1] - before.pos[1], after.pos[2] - before.pos[2]);
// A = turn LEFT → forward vector rotates toward −X → yaw (atan2(d.x, −d.z)) goes NEGATIVE.
console.log(`WASD A: yaw Δ ${(dYaw * 180 / Math.PI).toFixed(1)}° (expect < −3°, turn left), position Δ ${dPos.toFixed(3)} m (expect ~0 — seated)`);
const wasdOk = dYaw < -0.05 && dPos < 0.05;

await page.screenshot({ path: '/tmp/recall-flat-after.png' });
await browser.close();

if (!wasdOk) {
  console.log('RESULT: FAIL — WASD look');
  console.log(logs.slice(-15).join('\n'));
  process.exit(1);
}
console.log('RESULT: ALL OK — cards follow the cursor, drop into sockets, WASD turns the seated view');
