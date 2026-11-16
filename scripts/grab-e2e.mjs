// scripts/grab-e2e.mjs
// Real-input end-to-end pass inside the IWER emulator:
//   1. Launch XR, aim the LEFT controller ray at a tray card via the devui
//      transform handles (the emulator syncs them to the device every frame).
//   2. Fire a REAL trigger press by clicking the devui Controller [L] "Trig"
//      cell -> IWER gamepad edge -> session selectstart -> IWSDK pointer
//      pipeline -> DistanceGrabbable grab.
//   3. Re-aim at the card's solution socket, release -> snap -> 'placed'.
//   4. Aim the RIGHT controller at the HUD Restart button and click its Trig
//      cell -> verifies HUD buttons are reachable by XR rays.
// Run: node scripts/grab-e2e.mjs   (dev server on :8081)
import { chromium } from 'playwright';

const URL = 'https://localhost:8081/';
const browser = await chromium.launch({
  headless: true,
  args: ['--enable-unsafe-swiftshader', '--ignore-certificate-errors'],
});
// RECORD=1 node scripts/<this>.mjs  → also saves a WebM video of the run
// (deterministic demo footage for the Devpost video; no OBS needed).
const recordVideo = process.env.RECORD
  ? { recordVideo: { dir: '.verify/videos', size: { width: 1600, height: 900 } } }
  : {};
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 900 }, ...recordVideo });
const page = await context.newPage();
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text().slice(0, 180)}`));

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

// Fresh session state.
await page.evaluate(() => new Promise((res) => {
  const req = indexedDB.deleteDatabase('recall-store');
  req.onsuccess = () => res(true);
  req.onerror = () => res(false);
  req.onblocked = () => res(false);
}));
await page.reload({ waitUntil: 'domcontentloaded' });
const app = await findApp();

// Wait for the rebuild phase (cards scrambled into the tray).
for (let i = 0; i < 30; i++) {
  const st = await app.evaluate(() => window.__recall.state());
  if (st.phase === 'rebuild') break;
  await page.waitForTimeout(500);
}
console.log('phase:', await app.evaluate(() => window.__recall.state().phase));

// Enter XR.
await app.evaluate(() => window.__recall.launch());
await page.waitForTimeout(3000);

// ---- Helpers (run inside the app frame) ----
// Aim an emulated controller's ray at a world point: place the devui handle
// HOLD_DIST before the target along the head->target direction, oriented so
// its local -Z looks at the target. DistanceGrabMoveTowardsTarget floats the
// held card HOLD_DIST metres along the ray (XR offset), so the card lands on
// the target. The emulator copies handle transforms to the device every frame.
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
    const handles = window.transformHandles;
    if (!handles) throw new Error('devui handles unavailable');
    const handle = handles.get(h);
    window.__aimGlobal(handle, new handle.position.constructor(p[0], p[1], p[2]));
  }, [handedness, [worldPoint.x, worldPoint.y, worldPoint.z]]);
};

// ---- Pick a free tray card and its solution socket ----
const plan = await app.evaluate(() => {
  const it = window.__recall.interaction();
  const ids = [...it.spawn.cardsByNodeId.keys()].filter(
    (id) => it.getCardState(id) === 'free' && !id.startsWith('distractor-'),
  );
  const id = ids[0];
  const cardObj = it.spawn.cardsByNodeId.get(id).object3D;
  const V = cardObj.position.constructor;
  const wp = new V();
  cardObj.getWorldPosition(wp);
  const socketIdx = it.layout.solution[id];
  const socketObj = it.spawn.socketsByIndex.get(socketIdx).object3D;
  const sp = new V();
  socketObj.getWorldPosition(sp);
  const round = (v) => ({ x: +v.x.toFixed(3), y: +v.y.toFixed(3), z: +v.z.toFixed(3) });
  return { id, card: round(wp), socket: round(sp), socketIdx };
});
console.log('plan:', JSON.stringify(plan));
if (!plan?.id) throw new Error('no free card to grab');

// ---- Aim LEFT controller at the card ----
await aimController('left', plan.card);
await page.waitForTimeout(400);

// ---- Click the devui LEFT controller Trig cell (real trigger press) ----
// The devui panels are React DOM inside shadow roots; pierce them to find the
// Trig scrub cell of the left/right controller panel.
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
  // scrub Row: [RowLabel, Cell, pips] — the Cell is the 2nd child
  const cellEl = label?.el.parentElement?.children[1];
  if (!cellEl) return null;
  const r = cellEl.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
}, side);

const box = await findTrigCell('left');
console.log('left Trig cell at:', JSON.stringify(box));
if (!box) throw new Error('left Trig cell not found');

await page.mouse.move(box.x, box.y);
await page.mouse.down();
await page.waitForTimeout(300);

const held = await app.evaluate((id) => window.__recall.interaction().getCardState(id), plan.id);
console.log('after trigger press, state:', held);
await page.screenshot({ path: '.verify/e2e-xr-held.png' });

// ---- Carry: re-aim at the solution socket, then release ----
await aimController('left', plan.socket);
await page.waitForTimeout(1200);
// Where is the card right before the release?
const preRelease = await app.evaluate(() => {
  const it = window.__recall.interaction();
  const out = {};
  for (const [id, e] of it.spawn.cardsByNodeId) {
    if (it.getCardState(id) !== 'held') continue;
    const V = e.object3D.position.constructor;
    const wp = new V();
    e.object3D.getWorldPosition(wp);
    out[id] = { x: +wp.x.toFixed(3), y: +wp.y.toFixed(3), z: +wp.z.toFixed(3) };
  }
  return out;
});
console.log('card world pos before release:', JSON.stringify(preRelease));
await page.mouse.up();
await page.waitForTimeout(1000);

const dropped = await app.evaluate((id) => window.__recall.interaction().getCardState(id), plan.id);
console.log('after release, state:', dropped);
console.log('interaction logs:', logs.filter((l) => l.includes('[Recall/interaction]')).slice(-6).join(' | '));
await page.screenshot({ path: '.verify/e2e-xr-placed.png' });

// ---- HUD button in XR: aim RIGHT controller at the Restart button ----
const restartPos = await app.evaluate(() => {
  const root = window.__recall.interaction().spawn.root.object3D;
  let target = null;
  root.traverse((o) => {
    if (o.isMesh && !target && o.geometry?.parameters?.width === 0.18) {
      const p = o.position;
      // menu Restart is the topmost left-column button
      if (p.x < -0.4 && p.y > -0.14) {
        const V = o.position.constructor;
        const wp = new V();
        o.getWorldPosition(wp);
        target = { x: +wp.x.toFixed(3), y: +wp.y.toFixed(3), z: +wp.z.toFixed(3) };
      }
    }
  });
  return target;
});
console.log('restart button world:', JSON.stringify(restartPos));
const rightBox = await findTrigCell('right');
if (restartPos && rightBox) {
  const logsBefore = logs.length;
  await aimController('right', restartPos);
  await page.waitForTimeout(400);
  // Report the right controller pose + where the HUD buttons actually are, to
  // confirm the aim points at the Restart button.
  const hitCheck = await app.evaluate(() => {
    const r = window.__recall.renderer();
    const scene = window.__recall.scene();
    const controller = r.xr.getController(1);
    const origin = new (scene.position.constructor)();
    const quat = new (scene.quaternion.constructor)();
    controller.updateMatrixWorld(true);
    controller.getWorldPosition(origin);
    controller.getWorldQuaternion(quat);
    const dir = new (scene.position.constructor)(0, 0, -1).applyQuaternion(quat);
    const buttons = [];
    scene.traverse((o) => {
      if (o.isMesh && o.geometry?.parameters?.width === 0.18) {
        const V = o.position.constructor;
        const wp = new V();
        o.getWorldPosition(wp);
        buttons.push({
          pos: { x: +wp.x.toFixed(2), y: +wp.y.toFixed(2), z: +wp.z.toFixed(2) },
          visible: o.visible,
        });
      }
    });
    return {
      origin: { x: +origin.x.toFixed(2), y: +origin.y.toFixed(2), z: +origin.z.toFixed(2) },
      dir: { x: +dir.x.toFixed(2), y: +dir.y.toFixed(2), z: +dir.z.toFixed(2) },
      buttons,
    };
  });
  console.log('right controller pose + buttons:', JSON.stringify(hitCheck));
  // Live IWSDK pointer state: what is the right ray pointer hovering?
  const pointerState = await app.evaluate(() => {
    const world = (window).__recallWorld;
    if (!world) {
      // dig it out via the interaction system's world ref
    }
    const it = window.__recall.interaction();
    const w = it.world;
    const xr = w?.input?.xr;
    if (!xr) return { err: 'no input.xr' };
    const ray = xr.multiPointers.right.getPointer('ray');
    const inter = ray.getIntersection();
    return {
      hasIntersection: !!inter,
      object: inter?.object?.name || inter?.object?.type || null,
      distance: inter ? +inter.distance.toFixed(2) : null,
      rayDescendants: (w.scene.rayDescendants ?? []).map((o) => o.name || o.type).slice(0, 20),
      enabled: ray.getEnabled?.() ?? null,
    };
  }).catch((e) => ({ err: String(e).slice(0, 120) }));
  console.log('right ray pointer state:', JSON.stringify(pointerState));
  // Probe listener on every HUD button mesh so we can see which events arrive.
  await app.evaluate(() => {
    const it = window.__recall.interaction();
    const w = it.world;
    const session = w.renderer.xr.getSession();
    if (session && !session.__e2ePatched) {
      session.__e2ePatched = true;
      session.addEventListener('selectstart', (e) => console.log(`[E2E] session selectstart ${e.inputSource?.handedness}`));
      session.addEventListener('selectend', (e) => console.log(`[E2E] session selectend ${e.inputSource?.handedness}`));
    }
    const rayPtr = w.input.xr.multiPointers.right.getPointer('ray');
    if (!rayPtr.__e2ePatched) {
      rayPtr.__e2ePatched = true;
      const origDown = rayPtr.down.bind(rayPtr);
      const origUp = rayPtr.up.bind(rayPtr);
      rayPtr.down = (e) => { console.log(`[E2E] rayPtr.down btn=${e.button} ts=${e.timeStamp?.toFixed?.(0)} intersection=${!!rayPtr.getIntersection()}`); return origDown(e); };
      rayPtr.up = (e) => { console.log(`[E2E] rayPtr.up btn=${e.button} ts=${e.timeStamp?.toFixed?.(0)} intersection=${!!rayPtr.getIntersection()}`); return origUp(e); };
    }
    w.scene.traverse((o) => {
      if (o.isMesh && o.geometry?.parameters?.width === 0.18 && !o.userData.__e2eProbe) {
        o.userData.__e2eProbe = true;
        for (const ev of ['pointermove', 'pointerenter', 'pointerdown', 'pointerup', 'click', 'pointercancel', 'pointerleave']) {
          o.addEventListener(ev, () => console.log(`[E2E] btn ${o.position.y.toFixed(3)} ${ev}`));
        }
      }
    });
  });
  await page.mouse.move(rightBox.x, rightBox.y);
  await page.mouse.down();
  await page.waitForTimeout(80);
  await page.mouse.up();
  await page.waitForTimeout(1500);
  const restartLogs = logs.slice(logsBefore).filter((l) => l.includes('[Recall] session') || l.includes('[Recall/spawn]'));
  console.log('restart clicked, session logs:', restartLogs.length > 0 ? restartLogs[0] : '(none)');
  console.log('E2E probe logs:', logs.slice(logsBefore).filter((l) => l.includes('[E2E]')).join(' | '));
  const phaseAfter = await app.evaluate(() => window.__recall.state().phase);
  console.log('phase after restart:', phaseAfter);
  await page.screenshot({ path: '.verify/e2e-xr-restart.png' });
}

const result = { grabbed: held === 'held', placed: dropped === 'placed' };
console.log('RESULT:', JSON.stringify(result));
await browser.close();
if (!result.grabbed || !result.placed) process.exit(1);
console.log('e2e done');
