// End-to-end verification of the v9 fixes, with REAL emulator input:
//   1. Flat HUD screenshot — panels must render undistorted (texture repeat
//      fix) and enlarged.
//   2. XR: replay the user's dead-end — grab precipitation, drop it into
//      water vapor's slot → must be REJECTED (was the unwinnable move).
//   3. Place vapor / precipitation / clouds in their canonical sockets with
//      real trigger grabs → must snap 'placed' (the cards the user could not
//      place anywhere).
//   4. HUD readability probe: subtended text size of every side panel.
// Run: node scripts/verify-v9-fixes.mjs   (dev server on :8081)
import { chromium } from 'playwright';

const browser = await chromium.launch({
  headless: true,
  args: ['--enable-unsafe-swiftshader', '--ignore-certificate-errors'],
});
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 900 } });
const page = await context.newPage();
const logs = [];
page.on('console', (m) => logs.push(m.text()));

await page.goto('https://localhost:8081/', { waitUntil: 'domcontentloaded', timeout: 60000 });

// Fresh session state (session 1: no mirror/rotation/hidden links).
await page.evaluate(() => new Promise((res) => {
  const req = indexedDB.deleteDatabase('recall-store');
  req.onsuccess = () => res(true);
  req.onerror = () => res(false);
  req.onblocked = () => res(false);
}));
await page.reload({ waitUntil: 'domcontentloaded' });

const findApp = async () => {
  for (let i = 0; i < 30; i++) {
    for (const f of page.frames()) {
      try { if (await f.evaluate(() => Boolean(window.__recall))) return f; } catch {}
    }
    await page.waitForTimeout(500);
  }
  throw new Error('no app frame');
};
const app = await findApp();

// Wait for spawn + the rebuild phase (scramble), so cards are in the tray.
let st = null;
for (let i = 0; i < 60; i++) {
  st = await app.evaluate(() => window.__recall.state());
  if (st.spawned && st.phase === 'rebuild') break;
  await page.waitForTimeout(500);
}
if (!st?.spawned) throw new Error('app never spawned');
console.log('phase:', st.phase);

await page.screenshot({ path: '.verify/v9-flat-hud.png' });

// Enter XR.
await app.evaluate(() => window.__recall.launch());
await page.waitForTimeout(4000);
await page.screenshot({ path: '.verify/v9-xr-hud.png' });

// ---- Aim helpers (same mechanism as grab-e2e: devui handle transforms) ----
await app.evaluate(() => {
  window.__HOLD_DIST = 0.45;
  window.__aimGlobal = (handle, target) => {
    const V = handle.position.constructor;
    const Q = handle.quaternion.constructor;
    const rig = handle.parent;
    const head = rig.getWorldPosition(new V());
    const dir = target.clone().sub(head).normalize();
    const pos = target.clone().addScaledVector(dir, -window.__HOLD_DIST);
    pos.y += 0.02;
    handle.position.copy(rig.worldToLocal(pos.clone()));
    const rigQ = rig.getWorldQuaternion(new Q());
    const localDir = dir.clone().applyQuaternion(rigQ.clone().invert());
    handle.quaternion.copy(new Q().setFromUnitVectors(new V(0, 0, -1), localDir));
    handle.updateMatrixWorld(true);
  };
});

const aimController = async (handedness, worldPoint) => {
  await app.evaluate(([h, p]) => {
    const handle = window.transformHandles.get(h);
    window.__aimGlobal(handle, new handle.position.constructor(p[0], p[1], p[2]));
  }, [handedness, [worldPoint.x, worldPoint.y, worldPoint.z]]);
};

const findTrigCell = (side) => app.evaluate((side) => {
  const cells = [];
  const walk = (root) => {
    for (const el of root.querySelectorAll('*')) {
      if (el.childElementCount === 0 && el.textContent?.trim() === 'Trig') {
        const r = el.getBoundingClientRect();
        cells.push({ el, x: r.x, half: r.x < window.innerWidth / 2 ? 'left' : 'right' });
      }
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(document);
  const label = cells.find((c) => c.half === side);
  const cellEl = label?.el.parentElement?.children[1];
  if (!cellEl) return null;
  const r = cellEl.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
}, side);

// Grab a card by node id, carry it to a target point, release. Returns the
// card state after the release.
const grabAndDrop = async (nodeId, target) => {
  const cardPos = await app.evaluate((id) => {
    const it = window.__recall.interaction();
    const obj = it.spawn.cardsByNodeId.get(id).object3D;
    const V = obj.position.constructor;
    const wp = new V();
    obj.getWorldPosition(wp);
    return { x: +wp.x.toFixed(3), y: +wp.y.toFixed(3), z: +wp.z.toFixed(3) };
  }, nodeId);
  await aimController('left', cardPos);
  await page.waitForTimeout(400);
  await page.mouse.move(boxLeft.x, boxLeft.y);
  await page.mouse.down();
  await page.waitForTimeout(300);
  const held = await app.evaluate((id) => window.__recall.interaction().getCardState(id), nodeId);
  if (held !== 'held') throw new Error(`grab failed for ${nodeId}: state=${held}`);
  await aimController('left', target);
  await page.waitForTimeout(1200);
  await page.mouse.up();
  await page.waitForTimeout(1000);
  return app.evaluate((id) => window.__recall.interaction().getCardState(id), nodeId);
};

const boxLeft = await findTrigCell('left');
if (!boxLeft) throw new Error('left Trig cell not found');

// World-space targets for sockets / tray cards.
const socketPos = (idx) => app.evaluate((i) => {
  const it = window.__recall.interaction();
  const obj = it.spawn.socketsByIndex.get(i).object3D;
  const V = obj.position.constructor;
  const wp = new V();
  obj.getWorldPosition(wp);
  return { x: +wp.x.toFixed(3), y: +wp.y.toFixed(3), z: +wp.z.toFixed(3) };
}, idx);

const results = {};

// 1) THE TRAP: precipitation into water vapor's slot (socket 1) — the move
//    that used to pass and unwinnable the board. Must be rejected.
const trapSocket = await socketPos(1);
results.trapRejected = await grabAndDrop('precip', trapSocket);
await page.screenshot({ path: '.verify/v9-trap-rejected.png' });
console.log('precip -> socket 1 (trap):', results.trapRejected, '(expect free — rejected)');

// 2) The card the user could not place anywhere: water vapor -> socket 1.
const vaporSocket = await socketPos(1);
results.vaporPlaced = await grabAndDrop('vapor', vaporSocket);
console.log('vapor -> socket 1:', results.vaporPlaced, '(expect placed)');

// 3) precipitation -> its canonical socket 5.
const precipSocket = await socketPos(5);
results.precipPlaced = await grabAndDrop('precip', precipSocket);
console.log('precip -> socket 5:', results.precipPlaced, '(expect placed)');

// 4) clouds -> its canonical socket 4.
const cloudSocket = await socketPos(4);
results.cloudPlaced = await grabAndDrop('cloud', cloudSocket);
console.log('cloud -> socket 4:', results.cloudPlaced, '(expect placed)');
await page.screenshot({ path: '.verify/v9-placed.png' });

// 5) Complete the board and confirm the session completes.
await app.evaluate(() => window.__recall.placeAll());
await page.waitForTimeout(1500);
results.phaseAfterComplete = await app.evaluate(() => window.__recall.state().phase);
console.log('phase after placeAll:', results.phaseAfterComplete, '(expect summary)');

// 6) HUD readability: subtended size of each side panel from the head.
const panels = await app.evaluate(() => {
  const r = window.__recall.renderer();
  const scene = window.__recall.scene();
  const cam = r.xr.getCamera();
  const V = cam.position.constructor;
  const head = cam.getWorldPosition(new V());
  const out = [];
  scene.traverse((o) => {
    if (!o.isMesh) return;
    const w = o.geometry?.parameters?.width;
    if (![0.32, 0.27, 0.24, 0.18].includes(w)) return;
    const wp = o.getWorldPosition(new V());
    const dist = wp.distanceTo(head);
    out.push({
      widthM: w,
      distM: +dist.toFixed(2),
      degWidth: +((2 * Math.atan(w / 2 / dist) * 180) / Math.PI).toFixed(1),
    });
  });
  return out;
});
console.log('panel readability (deg):', JSON.stringify(panels));

const rejectedLogs = logs.filter((l) => l.includes('[Recall/interaction] rejected') || l.includes('reason'));
console.log('reject logs:', rejectedLogs.slice(-4).join(' | '));

await browser.close();

const pass =
  results.trapRejected === 'free' &&
  results.vaporPlaced === 'placed' &&
  results.precipPlaced === 'placed' &&
  results.cloudPlaced === 'placed' &&
  results.phaseAfterComplete === 'summary';
console.log(pass ? 'PASS: trap rejected, vapor/precip/cloud placeable, session completes' : 'FAIL: ' + JSON.stringify(results));
process.exit(pass ? 0 : 1);
