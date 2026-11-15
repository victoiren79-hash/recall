// Day-2 placement diagnostic: complete day 1, click Next Day, then place all
// 7 cards with REAL emulator grabs and report exactly which placements fail.
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

await page.evaluate(() => new Promise((res) => {
  const req = indexedDB.deleteDatabase('recall-store');
  req.onsuccess = () => res(true);
  req.onerror = () => res(false);
  req.onblocked = () => res(false);
}));
await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });

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
for (let i = 0; i < 60; i++) {
  const st = await app.evaluate(() => window.__recall.state());
  if (st.spawned && st.phase === 'rebuild') break;
  await page.waitForTimeout(500);
}
await app.evaluate(() => window.__recall.launch());
await page.waitForTimeout(3500);
await app.evaluate(() => window.__recall.placeAll()); // finish day 1
await page.waitForTimeout(1200);
const DAYS = Number(process.env.DAYS || 1);
for (let d = 0; d < DAYS; d++) await app.evaluate(() => window.__recall.interaction().hud.onNextDay()); // -> day N
await page.waitForTimeout(1500);

// Skip the see phase: force the scramble so all cards are grabbable now.
const st2 = await app.evaluate(() => {
  const it = window.__recall.interaction();
  return {
    day: window.__recall.state().day,
    sessionNum: window.__recall.state().sessionNum,
    rotDeg: it.session ? it.session.rotDeg : null,
    layout0: it.layout.sockets[0].position,
    free: it.pack.nodes.filter((n) => !n.fixed && it.getCardState(n.id) === 'free').map((n) => n.id),
  };
});
console.log('day 2 state:', JSON.stringify(st2));
// Force beginRebuild if still in see (grab poll would do it on first grab).
await app.evaluate(() => window.__recall.interaction().hud.onNextDay === undefined);
await page.waitForTimeout(4500); // let the see timer scramble naturally

// Aim helpers (same as grab-e2e).
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
const boxLeft = await findTrigCell('left');

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
  if (held !== 'held') {
    const probe = await app.evaluate((id) => {
      const it = window.__recall.interaction();
      const w = it.world;
      const obj = it.spawn.cardsByNodeId.get(id).object3D;
      const V = obj.position.constructor;
      const wp = new V();
      obj.updateWorldMatrix(true, false);
      obj.getWorldPosition(wp);
      const mp = w.input.xr.multiPointers.left.getPointer('ray');
      const inter = mp.getIntersection();
      const cam = w.renderer.xr.getCamera();
      const cp = cam.getWorldPosition(new V());
      const origin = new V();
      const ray = mp.intersector?.raycaster?.ray;
      if (ray) origin.copy(ray.origin);
      return {
        cardPos: wp.toArray().map((n) => +n.toFixed(2)),
        cardVisible: obj.visible,
        rayOrigin: origin.toArray().map((n) => +n.toFixed(2)),
        hitObject: inter ? (inter.object.name || inter.object.type) : null,
        hitGeometry: inter ? inter.object.geometry?.type : null,
        hitParams: inter ? JSON.stringify(inter.object.geometry?.parameters || {}).slice(0, 80) : null,
        hitParent: inter ? (inter.object.parent?.type + '/' + (inter.object.parent?.name || '')) : null,
        hitMaterial: inter ? (inter.object.material?.type + ' op=' + (+inter.object.material?.opacity).toFixed(2)) : null,
        hitDistance: inter ? +inter.distance.toFixed(2) : null,
      };
    }, nodeId);
    return 'grab-failed: ' + JSON.stringify(probe);
  }
  await aimController('left', target);
  await page.waitForTimeout(1200);
  await page.mouse.up();
  await page.waitForTimeout(1000);
  return app.evaluate((id) => window.__recall.interaction().getCardState(id), nodeId);
};

const socketPos = (idx) => app.evaluate((i) => {
  const it = window.__recall.interaction();
  const obj = it.spawn.socketsByIndex.get(i).object3D;
  const V = obj.position.constructor;
  const wp = new V();
  obj.getWorldPosition(wp);
  return { x: +wp.x.toFixed(3), y: +wp.y.toFixed(3), z: +wp.z.toFixed(3) };
}, idx);

// Place every free card at its solution socket, one at a time.
const results = {};
for (let round = 0; round < 3; round++) {
  const free = await app.evaluate(() => {
    const it = window.__recall.interaction();
    return it.pack.nodes.filter((n) => !n.fixed && it.getCardState(n.id) === 'free').map((n) => n.id);
  });
  if (free.length === 0) break;
  for (const nodeId of free) {
    const idx = await app.evaluate((id) => window.__recall.interaction().layout.solution[id], nodeId);
    const target = await socketPos(idx);
    const outcome = await grabAndDrop(nodeId, target);
    results[nodeId] = outcome;
    console.log(`round ${round}: ${nodeId} -> socket ${idx}: ${outcome}`);
    if (outcome !== 'placed') {
      const rej = logs.filter((l) => l.includes('[Recall/interaction] rejected')).slice(-2);
      console.log('  reject logs:', rej.join(' | '));
    }
  }
}
console.log('final results:', JSON.stringify(results, null, 1));
await browser.close();
